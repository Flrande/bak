import type {
  ConsoleEntry,
  DebugDumpSection,
  Locator,
  NetworkEntry,
  PageExecutionScope,
  PageFetchResponse,
  PageFrameResult,
  PageFreshnessResult,
  TableHandle,
  TableSchema
} from '@flrande/bak-protocol';
import {
  clearNetworkEntries,
  dropNetworkCapture,
  ensureNetworkDebugger,
  exportHar,
  getNetworkEntry,
  latestNetworkTimestamp,
  listNetworkEntries,
  recentNetworkSampleIds,
  searchNetworkEntries,
  waitForNetworkEntry
} from './network-debugger.js';
import { isSupportedAutomationUrl } from './url-policy.js';
import { computeReconnectDelayMs } from './reconnect.js';
import { resolveSessionBindingStateMap, STORAGE_KEY_SESSION_BINDINGS } from './session-binding-storage.js';
import { containsRedactionMarker } from './privacy.js';
import {
  type SessionBindingBrowser,
  type SessionBindingColor,
  type SessionBindingRecord,
  type SessionBindingTab,
  type SessionBindingWindow,
  SessionBindingManager
} from './session-binding.js';

interface CliRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface CliResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    data?: Record<string, unknown>;
  };
}

interface ExtensionConfig {
  token: string;
  port: number;
  debugRichText: boolean;
}

interface RuntimeErrorDetails {
  message: string;
  context: 'config' | 'socket' | 'request' | 'parse';
  at: number;
}

const DEFAULT_PORT = 17373;
const STORAGE_KEY_TOKEN = 'pairToken';
const STORAGE_KEY_PORT = 'cliPort';
const STORAGE_KEY_DEBUG_RICH_TEXT = 'debugRichText';
const DEFAULT_TAB_LOAD_TIMEOUT_MS = 40_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DATA_TIMESTAMP_CONTEXT_PATTERN =
  /\b(updated|update|updatedat|asof|timestamp|generated|generatedat|refresh|freshness|latest|last|quote|trade|price|flow|market|time|snapshot|signal)\b/i;
const CONTRACT_TIMESTAMP_CONTEXT_PATTERN =
  /\b(expiry|expiration|expires|option|contract|strike|maturity|dte|call|put|exercise)\b/i;
const EVENT_TIMESTAMP_CONTEXT_PATTERN = /\b(earnings|event|report|dividend|split|meeting|fomc|release|filing)\b/i;

interface TimestampEvidenceCandidate {
  value: string;
  source: 'visible' | 'inline' | 'page-data' | 'network';
  context?: string;
  path?: string;
  category?: 'data' | 'contract' | 'event' | 'unknown';
}

interface PageDataCandidateProbe {
  name: string;
  resolver: 'globalThis' | 'lexical';
  sample: unknown;
  timestamps: Array<{
    path: string;
    value: string;
    category: 'data' | 'contract' | 'event' | 'unknown';
  }>;
}
const REPLAY_FORBIDDEN_HEADER_NAMES = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'referer',
  'set-cookie'
]);

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let nextReconnectInMs: number | null = null;
let reconnectAttempt = 0;
let lastError: RuntimeErrorDetails | null = null;
let manualDisconnect = false;
let sessionBindingStateMutationQueue: Promise<void> = Promise.resolve();

async function getConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get([STORAGE_KEY_TOKEN, STORAGE_KEY_PORT, STORAGE_KEY_DEBUG_RICH_TEXT]);
  return {
    token: typeof stored[STORAGE_KEY_TOKEN] === 'string' ? stored[STORAGE_KEY_TOKEN] : '',
    port: typeof stored[STORAGE_KEY_PORT] === 'number' ? stored[STORAGE_KEY_PORT] : DEFAULT_PORT,
    debugRichText: stored[STORAGE_KEY_DEBUG_RICH_TEXT] === true
  };
}

async function setConfig(config: Partial<ExtensionConfig>): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (typeof config.token === 'string') {
    payload[STORAGE_KEY_TOKEN] = config.token;
  }
  if (typeof config.port === 'number') {
    payload[STORAGE_KEY_PORT] = config.port;
  }
  if (typeof config.debugRichText === 'boolean') {
    payload[STORAGE_KEY_DEBUG_RICH_TEXT] = config.debugRichText;
  }
  if (Object.keys(payload).length > 0) {
    await chrome.storage.local.set(payload);
  }
}

function setRuntimeError(message: string, context: RuntimeErrorDetails['context']): void {
  lastError = {
    message,
    context,
    at: Date.now()
  };
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  nextReconnectInMs = null;
}

function sendResponse(payload: CliResponse): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function toError(code: string, message: string, data?: Record<string, unknown>): CliResponse['error'] {
  return { code, message, data };
}

function normalizeUnhandledError(error: unknown): CliResponse['error'] {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error as CliResponse['error'];
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('no tab with id') || lower.includes('no window with id')) {
    return toError('E_NOT_FOUND', message);
  }
  if (lower.includes('binding') && lower.includes('does not exist')) {
    return toError('E_NOT_FOUND', message);
  }
  if (lower.includes('does not belong to binding') || lower.includes('is missing from binding')) {
    return toError('E_NOT_FOUND', message);
  }
  if (lower.includes('invalid url') || lower.includes('url is invalid')) {
    return toError('E_INVALID_PARAMS', message);
  }
  if (lower.includes('cannot access contents of url') || lower.includes('permission denied')) {
    return toError('E_PERMISSION', message);
  }

  return toError('E_INTERNAL', message);
}

function toTabInfo(tab: chrome.tabs.Tab): SessionBindingTab {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
    throw new Error('Tab is missing runtime identifiers');
  }
  return {
    id: tab.id,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: Boolean(tab.active),
    windowId: tab.windowId,
    groupId: typeof tab.groupId === 'number' && tab.groupId >= 0 ? tab.groupId : null
  };
}

async function readSessionBindingStateMap(): Promise<Record<string, SessionBindingRecord>> {
  const stored = await chrome.storage.local.get([STORAGE_KEY_SESSION_BINDINGS]);
  return resolveSessionBindingStateMap(stored);
}

async function flushSessionBindingStateMap(stateMap: Record<string, SessionBindingRecord>): Promise<void> {
  if (Object.keys(stateMap).length === 0) {
    await chrome.storage.local.remove([STORAGE_KEY_SESSION_BINDINGS]);
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEY_SESSION_BINDINGS]: stateMap });
}

async function runSessionBindingStateMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = sessionBindingStateMutationQueue.then(operation, operation);
  sessionBindingStateMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function mutateSessionBindingStateMap<T>(mutator: (stateMap: Record<string, SessionBindingRecord>) => Promise<T> | T): Promise<T> {
  return await runSessionBindingStateMutation(async () => {
    const stateMap = await readSessionBindingStateMap();
    const result = await mutator(stateMap);
    await flushSessionBindingStateMap(stateMap);
    return result;
  });
}

async function loadSessionBindingStateMap(): Promise<Record<string, SessionBindingRecord>> {
  await sessionBindingStateMutationQueue;
  return await readSessionBindingStateMap();
}

async function loadSessionBindingState(bindingId: string): Promise<SessionBindingRecord | null> {
  const stateMap = await loadSessionBindingStateMap();
  return stateMap[bindingId] ?? null;
}

async function listSessionBindingStates(): Promise<SessionBindingRecord[]> {
  return Object.values(await loadSessionBindingStateMap());
}

async function saveSessionBindingState(state: SessionBindingRecord): Promise<void> {
  await mutateSessionBindingStateMap((stateMap) => {
    stateMap[state.id] = state;
  });
}

async function deleteSessionBindingState(bindingId: string): Promise<void> {
  await mutateSessionBindingStateMap((stateMap) => {
    delete stateMap[bindingId];
  });
}

const sessionBindingBrowser: SessionBindingBrowser = {
  async getTab(tabId) {
    try {
      return toTabInfo(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  },
  async getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab) {
      return null;
    }
    return toTabInfo(tab);
  },
  async listTabs(filter) {
    const tabs = await chrome.tabs.query(filter?.windowId ? { windowId: filter.windowId } : {});
    return tabs
      .filter((tab): tab is chrome.tabs.Tab => typeof tab.id === 'number' && typeof tab.windowId === 'number')
      .map((tab) => toTabInfo(tab));
  },
  async createTab(options) {
    const createdTab = await chrome.tabs.create({
      windowId: options.windowId,
      url: options.url ?? 'about:blank',
      active: options.active
    });
    if (!createdTab) {
      throw new Error('Tab creation returned no tab');
    }
    return toTabInfo(createdTab);
  },
  async updateTab(tabId, options) {
    const updatedTab = await chrome.tabs.update(tabId, {
      active: options.active,
      url: options.url
    });
    if (!updatedTab) {
      throw new Error(`Tab update returned no tab for ${tabId}`);
    }
    return toTabInfo(updatedTab);
  },
  async closeTab(tabId) {
    await chrome.tabs.remove(tabId);
  },
  async getWindow(windowId) {
    try {
      const window = await chrome.windows.get(windowId);
      return {
        id: window.id!,
        focused: Boolean(window.focused)
    } satisfies SessionBindingWindow;
    } catch {
      return null;
    }
  },
  async createWindow(options) {
    const previouslyFocusedWindow =
      options.focused === true
        ? null
        : (await chrome.windows.getAll()).find((window) => window.focused === true && typeof window.id === 'number') ?? null;
    const previouslyFocusedTab =
      previouslyFocusedWindow?.id !== undefined
        ? (await chrome.tabs.query({ windowId: previouslyFocusedWindow.id, active: true })).find((tab) => typeof tab.id === 'number') ?? null
        : null;
    const created = await chrome.windows.create({
      url: options.url ?? 'about:blank',
      focused: true
    });
    if (!created || typeof created.id !== 'number') {
      throw new Error('Window missing id');
    }
    if (options.focused !== true && previouslyFocusedWindow?.id && previouslyFocusedWindow.id !== created.id) {
      await chrome.windows.update(previouslyFocusedWindow.id, { focused: true });
      if (typeof previouslyFocusedTab?.id === 'number') {
        await chrome.tabs.update(previouslyFocusedTab.id, { active: true });
      }
    }
    const finalWindow = await chrome.windows.get(created.id);
    return {
      id: finalWindow.id!,
      focused: Boolean(finalWindow.focused)
    };
  },
  async updateWindow(windowId, options) {
    const updated = await chrome.windows.update(windowId, {
      focused: options.focused
    });
    if (!updated || typeof updated.id !== 'number') {
      throw new Error('Window missing id');
    }
    return {
      id: updated.id,
      focused: Boolean(updated.focused)
    };
  },
  async closeWindow(windowId) {
    await chrome.windows.remove(windowId);
  },
  async getGroup(groupId) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      return {
        id: group.id,
        windowId: group.windowId,
        title: group.title ?? '',
      color: group.color as SessionBindingColor,
        collapsed: Boolean(group.collapsed)
      };
    } catch {
      return null;
    }
  },
  async groupTabs(tabIds, groupId) {
    return await chrome.tabs.group({
      tabIds: tabIds as [number, ...number[]],
      groupId
    });
  },
  async updateGroup(groupId, options) {
    const updated = await chrome.tabGroups.update(groupId, {
      title: options.title,
      color: options.color,
      collapsed: options.collapsed
    });
    if (!updated) {
      throw new Error(`Tab group update returned no group for ${groupId}`);
    }
    return {
      id: updated.id,
      windowId: updated.windowId,
      title: updated.title ?? '',
      color: updated.color as SessionBindingColor,
      collapsed: Boolean(updated.collapsed)
    };
  }
};

const bindingManager = new SessionBindingManager(
  {
    load: loadSessionBindingState,
    save: saveSessionBindingState,
    delete: deleteSessionBindingState,
    list: listSessionBindingStates
  },
  sessionBindingBrowser
);

async function waitForTabComplete(tabId: number, timeoutMs = DEFAULT_TAB_LOAD_TIMEOUT_MS): Promise<void> {
  try {
    const current = await chrome.tabs.get(tabId);
    if (current.status === 'complete') {
      return;
    }
  } catch {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const probeStatus = (): void => {
      void chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.status === 'complete') {
            finish();
          }
        })
        .catch(() => {
          finish(new Error(`tab removed before load complete: ${tabId}`));
        });
    };

    const finish = (error?: Error): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeoutTimer);
      clearInterval(pollTimer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }): void => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status === 'complete') {
        finish();
      }
    };

    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) {
        finish(new Error(`tab removed before load complete: ${tabId}`));
      }
    };

    const pollTimer = setInterval(probeStatus, 250);
    const timeoutTimer = setTimeout(() => {
      finish(new Error(`tab load timeout: ${tabId}`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    probeStatus();
  });
}

async function waitForTabUrl(tabId: number, expectedUrl: string, timeoutMs = 10_000): Promise<void> {
  const normalizedExpectedUrl = normalizeComparableTabUrl(expectedUrl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url ?? '';
      const pendingUrl = 'pendingUrl' in tab && typeof tab.pendingUrl === 'string' ? tab.pendingUrl : '';
      if (
        normalizeComparableTabUrl(currentUrl) === normalizedExpectedUrl ||
        normalizeComparableTabUrl(pendingUrl) === normalizedExpectedUrl
      ) {
        return;
      }
    } catch {
      // Ignore transient lookup failures while the tab is navigating.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`tab url timeout: ${tabId} -> ${expectedUrl}`);
}

function normalizeComparableTabUrl(url: string): string {
  const raw = url.trim();
  if (!raw) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return raw;
  }
}

async function finalizeOpenedSessionBindingTab(
  opened: Awaited<ReturnType<SessionBindingManager['openTab']>>,
  expectedUrl?: string
): Promise<Awaited<ReturnType<SessionBindingManager['openTab']>>> {
  if (expectedUrl && expectedUrl !== 'about:blank') {
    await waitForTabUrl(opened.tab.id, expectedUrl).catch(() => undefined);
  }
  let refreshedTab = opened.tab;
  try {
    const rawTab = await chrome.tabs.get(opened.tab.id);
    const pendingUrl = 'pendingUrl' in rawTab && typeof rawTab.pendingUrl === 'string' ? rawTab.pendingUrl : '';
    const currentUrl = rawTab.url ?? '';
    const effectiveUrl =
      currentUrl && currentUrl !== 'about:blank'
        ? currentUrl
        : pendingUrl && pendingUrl !== 'about:blank'
          ? pendingUrl
          : currentUrl || pendingUrl || opened.tab.url;
    refreshedTab = {
      ...toTabInfo(rawTab),
      url: effectiveUrl
    };
  } catch {
    refreshedTab = (await sessionBindingBrowser.getTab(opened.tab.id)) ?? opened.tab;
  }
  const refreshedBinding = (await bindingManager.getBindingInfo(opened.binding.id)) ?? {
    ...opened.binding,
    tabs: opened.binding.tabs.map((tab) => (tab.id === refreshedTab.id ? refreshedTab : tab))
  };

  return {
    binding: refreshedBinding,
    tab: refreshedTab
  };
}

interface WithTabOptions {
  requireSupportedAutomationUrl?: boolean;
}

async function withTab(target: { tabId?: number; bindingId?: string } = {}, options: WithTabOptions = {}): Promise<chrome.tabs.Tab> {
  const requireSupportedAutomationUrl = options.requireSupportedAutomationUrl !== false;
  const validate = (tab: chrome.tabs.Tab): chrome.tabs.Tab => {
    if (!tab.id) {
      throw toError('E_NOT_FOUND', 'Tab missing id');
    }
    const pendingUrl = 'pendingUrl' in tab && typeof tab.pendingUrl === 'string' ? tab.pendingUrl : '';
    if (requireSupportedAutomationUrl && !isSupportedAutomationUrl(tab.url) && !isSupportedAutomationUrl(pendingUrl)) {
      throw toError('E_PERMISSION', 'Unsupported tab URL: only http/https pages can be automated', {
        url: tab.url ?? pendingUrl ?? ''
      });
    }
    return tab;
  };

  if (typeof target.tabId === 'number') {
    const tab = await chrome.tabs.get(target.tabId);
    return validate(tab);
  }

  const resolved = await bindingManager.resolveTarget({
    tabId: target.tabId,
    bindingId: typeof target.bindingId === 'string' ? target.bindingId : undefined,
    createIfMissing: false
  });
  const tab = await chrome.tabs.get(resolved.tab.id);
  return validate(tab);
}

async function captureAlignedTabScreenshot(tab: chrome.tabs.Tab): Promise<string> {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
    throw toError('E_NOT_FOUND', 'Tab screenshot requires tab id and window id');
  }

  const activeTabs = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  const activeTab = activeTabs[0];
  const shouldSwitch = activeTab?.id !== tab.id;

  if (shouldSwitch) {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    if (shouldSwitch && typeof activeTab?.id === 'number') {
      try {
        await chrome.tabs.update(activeTab.id, { active: true });
      } catch {
        // Ignore restore errors if the original tab no longer exists.
      }
    }
  }
}

async function sendToContent<TResponse>(tabId: number, message: Record<string, unknown>): Promise<TResponse> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (typeof response === 'undefined') {
        throw new Error('Content script returned undefined response');
      }
      return response as TResponse;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const retriable =
        detail.includes('Receiving end does not exist') ||
        detail.includes('Could not establish connection') ||
        detail.includes('No tab with id') ||
        detail.includes('message port closed before a response was received') ||
        detail.includes('Content script returned undefined response');
      if (!retriable || attempt >= maxAttempts) {
        throw toError('E_NOT_READY', 'Content script unavailable', { detail });
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }

  throw toError('E_NOT_READY', 'Content script unavailable');
}

interface FocusContext {
  windowId: number | null;
  tabId: number | null;
}

async function captureFocusContext(): Promise<FocusContext> {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = activeTabs.find((tab) => typeof tab.id === 'number' && typeof tab.windowId === 'number') ?? null;
  return {
    windowId: activeTab?.windowId ?? null,
    tabId: activeTab?.id ?? null
  };
}

async function restoreFocusContext(context: FocusContext): Promise<void> {
  if (context.windowId !== null) {
    try {
      await chrome.windows.update(context.windowId, { focused: true });
    } catch {
      // Ignore restore errors if the original window no longer exists.
    }
  }
  if (context.tabId !== null) {
    try {
      await chrome.tabs.update(context.tabId, { active: true });
    } catch {
      // Ignore restore errors if the original tab no longer exists.
    }
  }
}

async function preserveHumanFocus<T>(enabled: boolean, action: () => Promise<T>): Promise<T> {
  if (!enabled) {
    return action();
  }

  const focusContext = await captureFocusContext();
  try {
    return await action();
  } finally {
    await restoreFocusContext(focusContext);
  }
}

function requireRpcEnvelope(
  method: string,
  value: unknown
): { ok: boolean; result?: unknown; error?: CliResponse['error'] } {
  if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    throw toError('E_NOT_READY', `Content script returned malformed response for ${method}`);
  }
  return value as { ok: boolean; result?: unknown; error?: CliResponse['error'] };
}

async function forwardContentRpc(
  tabId: number,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const raw = await sendToContent<unknown>(tabId, {
    type: 'bak.rpc',
    method,
    params
  });
  const response = requireRpcEnvelope(method, raw);

  if (!response.ok) {
    throw response.error ?? toError('E_INTERNAL', `${method} failed`);
  }

  return response.result;
}

async function ensureTabNetworkCapture(tabId: number): Promise<void> {
  try {
    await ensureNetworkDebugger(tabId);
  } catch (error) {
    throw toError('E_DEBUGGER_NOT_ATTACHED', 'Debugger-backed network capture unavailable', {
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

function normalizePageExecutionScope(value: unknown): PageExecutionScope {
  return value === 'main' || value === 'all-frames' ? value : 'current';
}

async function currentContextFramePath(tabId: number): Promise<string[]> {
  try {
    const context = (await forwardContentRpc(tabId, 'context.get', { tabId })) as { framePath?: string[] };
    return Array.isArray(context.framePath) ? context.framePath.map(String) : [];
  } catch {
    return [];
  }
}

async function executePageWorld<T>(
  tabId: number,
  action: 'eval' | 'extract' | 'fetch',
  params: Record<string, unknown>
): Promise<{ scope: PageExecutionScope; result?: PageFrameResult<T>; results?: Array<PageFrameResult<T>> }> {
  const scope = normalizePageExecutionScope(params.scope);
  const framePath = scope === 'current' ? await currentContextFramePath(tabId) : [];
  const target: chrome.scripting.InjectionTarget =
    scope === 'all-frames'
      ? { tabId, allFrames: true }
      : {
          tabId,
          frameIds: [0]
        };

  const results = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    args: [
      {
        action,
        scope,
        framePath,
        expr: typeof params.expr === 'string' ? params.expr : '',
        path: typeof params.path === 'string' ? params.path : '',
        resolver: typeof params.resolver === 'string' ? params.resolver : undefined,
        url: typeof params.url === 'string' ? params.url : '',
        method: typeof params.method === 'string' ? params.method : 'GET',
        headers: typeof params.headers === 'object' && params.headers !== null ? params.headers : undefined,
        body: typeof params.body === 'string' ? params.body : undefined,
        contentType: typeof params.contentType === 'string' ? params.contentType : undefined,
        mode: params.mode === 'json' ? 'json' : 'raw',
        maxBytes: typeof params.maxBytes === 'number' ? params.maxBytes : undefined,
        timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined
      }
    ],
    func: async (payload) => {
      const serializeValue = (value: unknown, maxBytes?: number) => {
        let cloned: unknown;
        try {
          cloned = typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
        } catch (error) {
          throw {
            code: 'E_NOT_SERIALIZABLE',
            message: error instanceof Error ? error.message : String(error)
          };
        }
        const json = JSON.stringify(cloned);
        const bytes = typeof json === 'string' ? json.length : 0;
        if (typeof maxBytes === 'number' && maxBytes > 0 && bytes > maxBytes) {
          throw {
            code: 'E_BODY_TOO_LARGE',
            message: 'serialized value exceeds max-bytes',
            details: { bytes, maxBytes }
          };
        }
        return { value: cloned, bytes };
      };

      const parsePath = (path: string): Array<string | number> => {
        if (typeof path !== 'string' || !path.trim()) {
          throw { code: 'E_INVALID_PARAMS', message: 'path is required' };
        }
        const normalized = path.replace(/^globalThis\.?/, '').replace(/^window\.?/, '').trim();
        if (!normalized) {
          return [];
        }
        const segments: Array<string | number> = [];
        let index = 0;
        while (index < normalized.length) {
          if (normalized[index] === '.') {
            index += 1;
            continue;
          }
          if (normalized[index] === '[') {
            const bracket = normalized.slice(index).match(/^\[(\d+)\]/);
            if (!bracket) {
              throw { code: 'E_INVALID_PARAMS', message: 'Only numeric bracket paths are supported' };
            }
            segments.push(Number(bracket[1]));
            index += bracket[0].length;
            continue;
          }
          const identifier = normalized.slice(index).match(/^[A-Za-z_$][\w$]*/);
          if (!identifier) {
            throw { code: 'E_INVALID_PARAMS', message: `Unsupported path token near: ${normalized.slice(index, index + 16)}` };
          }
          segments.push(identifier[0]);
          index += identifier[0].length;
        }
        return segments;
      };

      const resolveFrameWindow = (frameSelectors: string[]) => {
        let currentWindow: Window = window;
        let currentDocument: Document = document;
        for (const selector of frameSelectors) {
          const frame = currentDocument.querySelector(selector);
          if (!frame || !('contentWindow' in frame)) {
            throw { code: 'E_NOT_FOUND', message: `frame not found: ${selector}` };
          }
          const nextWindow = (frame as HTMLIFrameElement).contentWindow;
          if (!nextWindow) {
            throw { code: 'E_NOT_READY', message: `frame window unavailable: ${selector}` };
          }
          currentWindow = nextWindow;
          currentDocument = nextWindow.document;
        }
        return currentWindow;
      };

      const buildPathExpression = (path: string): string =>
        parsePath(path)
          .map((segment, index) => {
            if (typeof segment === 'number') {
              return `[${segment}]`;
            }
            if (index === 0) {
              return segment;
            }
            return `.${segment}`;
          })
          .join('');

      const readPath = (targetWindow: Window, path: string): unknown => {
        const segments = parsePath(path);
        let current: unknown = targetWindow;
        for (const segment of segments) {
          if (current === null || current === undefined || !(segment in (current as Record<string | number, unknown>))) {
            throw { code: 'E_NOT_FOUND', message: `path not found: ${path}` };
          }
          current = (current as Record<string | number, unknown>)[segment];
        }
        return current;
      };

      const resolveExtractValue = (
        targetWindow: Window & { eval: (expr: string) => unknown },
        path: string,
        resolver: unknown
      ): { resolver: 'globalThis' | 'lexical'; value: unknown } => {
        const strategy = resolver === 'globalThis' || resolver === 'lexical' ? resolver : 'auto';
        const lexicalExpression = buildPathExpression(path);
        const readLexical = (): unknown => {
          try {
            return targetWindow.eval(lexicalExpression);
          } catch (error) {
            if (error instanceof ReferenceError) {
              throw { code: 'E_NOT_FOUND', message: `path not found: ${path}` };
            }
            throw error;
          }
        };
        if (strategy === 'globalThis') {
          return { resolver: 'globalThis', value: readPath(targetWindow, path) };
        }
        if (strategy === 'lexical') {
          return { resolver: 'lexical', value: readLexical() };
        }
        try {
          return { resolver: 'globalThis', value: readPath(targetWindow, path) };
        } catch (error) {
          if (typeof error !== 'object' || error === null || (error as { code?: string }).code !== 'E_NOT_FOUND') {
            throw error;
          }
        }
        return { resolver: 'lexical', value: readLexical() };
      };

      try {
        const targetWindow = payload.scope === 'main' ? window : payload.scope === 'current' ? resolveFrameWindow(payload.framePath ?? []) : window;
        if (payload.action === 'eval') {
          const evaluator = (targetWindow as Window & { eval: (expr: string) => unknown }).eval;
          const serialized = serializeValue(evaluator(payload.expr), payload.maxBytes);
          return { url: targetWindow.location.href, framePath: payload.scope === 'current' ? payload.framePath ?? [] : [], value: serialized.value, bytes: serialized.bytes };
        }
        if (payload.action === 'extract') {
          const extracted = resolveExtractValue(targetWindow as Window & { eval: (expr: string) => unknown }, payload.path, payload.resolver);
          const serialized = serializeValue(extracted.value, payload.maxBytes);
          return {
            url: targetWindow.location.href,
            framePath: payload.scope === 'current' ? payload.framePath ?? [] : [],
            value: serialized.value,
            bytes: serialized.bytes,
            resolver: extracted.resolver
          };
        }
        if (payload.action === 'fetch') {
          const headers = { ...(payload.headers ?? {}) } as Record<string, string>;
          if (payload.contentType && !headers['Content-Type']) {
            headers['Content-Type'] = payload.contentType;
          }
          const controller = typeof AbortController === 'function' ? new AbortController() : null;
          const timeoutId =
            controller && typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
              ? window.setTimeout(() => controller.abort(), payload.timeoutMs)
              : null;
          let response: Response;
          try {
            response = await targetWindow.fetch(payload.url, {
              method: payload.method || 'GET',
              headers,
              body: typeof payload.body === 'string' ? payload.body : undefined,
              signal: controller ? controller.signal : undefined
            });
          } finally {
            if (timeoutId !== null) {
              window.clearTimeout(timeoutId);
            }
          }
          const bodyText = await response.text();
          const headerMap: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headerMap[key] = value;
          });
          return {
            url: targetWindow.location.href,
            framePath: payload.scope === 'current' ? payload.framePath ?? [] : [],
            value: (() => {
              const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
              const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
              const previewLimit = typeof payload.maxBytes === 'number' && payload.maxBytes > 0 ? payload.maxBytes : 8192;
              const encodedBody = encoder ? encoder.encode(bodyText) : null;
              const bodyBytes = encodedBody ? encodedBody.byteLength : bodyText.length;
              const truncated = bodyBytes > previewLimit;
              if (payload.mode === 'json' && truncated) {
                throw {
                  code: 'E_BODY_TOO_LARGE',
                  message: 'JSON response exceeds max-bytes',
                  details: {
                    bytes: bodyBytes,
                    maxBytes: previewLimit
                  }
                };
              }
              const previewText =
                encodedBody && decoder
                  ? decoder.decode(encodedBody.subarray(0, Math.min(encodedBody.byteLength, previewLimit)))
                  : truncated
                    ? bodyText.slice(0, previewLimit)
                    : bodyText;
              return {
                url: response.url,
                status: response.status,
                ok: response.ok,
                headers: headerMap,
                contentType: response.headers.get('content-type') ?? undefined,
                bodyText: payload.mode === 'json' ? undefined : previewText,
                json: payload.mode === 'json' && bodyText ? JSON.parse(bodyText) : undefined,
                bytes: bodyBytes,
                truncated
              };
            })()
          };
        }
        throw { code: 'E_NOT_FOUND', message: `Unsupported page world action: ${payload.action}` };
      } catch (error) {
        return {
          url: window.location.href,
          framePath: payload.scope === 'current' ? payload.framePath ?? [] : [],
          error:
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as { code: string; message: string; details?: Record<string, unknown> })
              : { code: 'E_EXECUTION', message: error instanceof Error ? error.message : String(error) }
        };
      }
    }
  });

  if (scope === 'all-frames') {
    return {
      scope,
      results: results.map((item) => (item.result ?? { url: '', framePath: [] }) as PageFrameResult<T>)
    };
  }

  return {
    scope,
    result: (results[0]?.result ?? { url: '', framePath }) as PageFrameResult<T>
  };
}

function truncateNetworkEntry(entry: NetworkEntry, bodyBytes?: number): NetworkEntry {
  if (typeof bodyBytes !== 'number' || !Number.isFinite(bodyBytes) || bodyBytes <= 0) {
    return entry;
  }
  const maxBytes = Math.max(1, Math.floor(bodyBytes));
  const clone: NetworkEntry = { ...entry };
  if (typeof clone.requestBodyPreview === 'string') {
    const requestBytes = textEncoder.encode(clone.requestBodyPreview);
    if (requestBytes.byteLength > maxBytes) {
      clone.requestBodyPreview = textDecoder.decode(requestBytes.subarray(0, maxBytes));
      clone.requestBodyTruncated = true;
      clone.truncated = true;
    }
  }
  if (typeof clone.responseBodyPreview === 'string') {
    const responseBytes = textEncoder.encode(clone.responseBodyPreview);
    if (responseBytes.byteLength > maxBytes) {
      clone.responseBodyPreview = textDecoder.decode(responseBytes.subarray(0, maxBytes));
      clone.responseBodyTruncated = true;
      clone.truncated = true;
    }
  }
  return clone;
}

function filterNetworkEntrySections(entry: NetworkEntry, include: unknown): NetworkEntry {
  if (!Array.isArray(include)) {
    return entry;
  }
  const sections = new Set(
    include
      .map(String)
      .filter((section): section is 'request' | 'response' => section === 'request' || section === 'response')
  );
  if (sections.size === 0 || sections.size === 2) {
    return entry;
  }
  const clone: NetworkEntry = { ...entry };
  if (!sections.has('request')) {
    delete clone.requestHeaders;
    delete clone.requestBodyPreview;
    delete clone.requestBodyTruncated;
  }
  if (!sections.has('response')) {
    delete clone.responseHeaders;
    delete clone.responseBodyPreview;
    delete clone.responseBodyTruncated;
    delete clone.binary;
  }
  return clone;
}

function replayHeadersFromEntry(entry: NetworkEntry): Record<string, string> | undefined {
  if (!entry.requestHeaders) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.requestHeaders)) {
    const normalizedName = name.toLowerCase();
    if (REPLAY_FORBIDDEN_HEADER_NAMES.has(normalizedName) || normalizedName.startsWith('sec-')) {
      continue;
    }
    if (containsRedactionMarker(value)) {
      continue;
    }
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function collectTimestampMatchesFromText(text: string, source: TimestampEvidenceCandidate['source'], patterns?: string[]): TimestampEvidenceCandidate[] {
  const regexes = (
    patterns ?? [
      String.raw`\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b`,
      String.raw`\b20\d{2}-\d{2}-\d{2}\b`,
      String.raw`\b20\d{2}\/\d{2}\/\d{2}\b`
    ]
  ).map((pattern) => new RegExp(pattern, 'gi'));
  const collected = new Map<string, TimestampEvidenceCandidate>();
  for (const regex of regexes) {
    for (const match of text.matchAll(regex)) {
      const value = match[0];
      if (!value) {
        continue;
      }
      const index = match.index ?? text.indexOf(value);
      const start = Math.max(0, index - 28);
      const end = Math.min(text.length, index + value.length + 28);
      const context = text.slice(start, end).replace(/\s+/g, ' ').trim();
      const key = `${value}::${context}`;
      if (!collected.has(key)) {
        collected.set(key, { value, source, context });
      }
    }
  }
  return [...collected.values()];
}

function parseTimestampCandidate(value: string, now = Date.now()): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'today') {
    return now;
  }
  if (normalized === 'yesterday') {
    return now - 24 * 60 * 60 * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function nearestPatternDistance(text: string, anchor: string, pattern: RegExp): number | null {
  const normalizedText = text.toLowerCase();
  const normalizedAnchor = anchor.toLowerCase();
  const anchorIndex = normalizedText.indexOf(normalizedAnchor);
  if (anchorIndex < 0) {
    return null;
  }
  const regex = new RegExp(pattern.source, 'gi');
  let match: RegExpExecArray | null;
  let best: number | null = null;
  while ((match = regex.exec(normalizedText)) !== null) {
    best = best === null ? Math.abs(anchorIndex - match.index) : Math.min(best, Math.abs(anchorIndex - match.index));
  }
  return best;
}

function classifyTimestampCandidate(candidate: TimestampEvidenceCandidate, now = Date.now()): PageFreshnessResult['evidence']['classifiedTimestamps'][number]['category'] {
  const normalizedPath = (candidate.path ?? '').toLowerCase();
  if (DATA_TIMESTAMP_CONTEXT_PATTERN.test(normalizedPath)) {
    return 'data';
  }
  if (CONTRACT_TIMESTAMP_CONTEXT_PATTERN.test(normalizedPath)) {
    return 'contract';
  }
  if (EVENT_TIMESTAMP_CONTEXT_PATTERN.test(normalizedPath)) {
    return 'event';
  }

  const context = candidate.context ?? '';
  const distances = [
    { category: 'data' as const, distance: nearestPatternDistance(context, candidate.value, DATA_TIMESTAMP_CONTEXT_PATTERN) },
    { category: 'contract' as const, distance: nearestPatternDistance(context, candidate.value, CONTRACT_TIMESTAMP_CONTEXT_PATTERN) },
    { category: 'event' as const, distance: nearestPatternDistance(context, candidate.value, EVENT_TIMESTAMP_CONTEXT_PATTERN) }
  ].filter((entry): entry is { category: 'data' | 'contract' | 'event'; distance: number } => typeof entry.distance === 'number');
  if (distances.length > 0) {
    distances.sort((left, right) => left.distance - right.distance);
    return distances[0]!.category;
  }
  const parsed = parseTimestampCandidate(candidate.value, now);
  return typeof parsed === 'number' && parsed > now + 36 * 60 * 60 * 1000 ? 'contract' : 'unknown';
}

function normalizeTimestampCandidates(
  candidates: TimestampEvidenceCandidate[],
  now = Date.now()
): PageFreshnessResult['evidence']['classifiedTimestamps'] {
  return candidates.map((candidate) => ({
    value: candidate.value,
    source: candidate.source,
    category: candidate.category ?? classifyTimestampCandidate(candidate, now),
    context: candidate.context,
    path: candidate.path
  }));
}

function latestTimestampFromCandidates(
  candidates: Array<{ value: string; category: PageFreshnessResult['evidence']['classifiedTimestamps'][number]['category'] }>,
  now = Date.now()
): number | null {
  let latest: number | null = null;
  for (const candidate of candidates) {
    if (candidate.category === 'contract' || candidate.category === 'event') {
      continue;
    }
    const parsed = parseTimestampCandidate(candidate.value, now);
    if (parsed === null) {
      continue;
    }
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

function computeFreshnessAssessment(input: {
  latestInlineDataTimestamp: number | null;
  latestPageDataTimestamp: number | null;
  latestNetworkDataTimestamp: number | null;
  latestNetworkTimestamp: number | null;
  domVisibleTimestamp: number | null;
  lastMutationAt: number | null;
  freshWindowMs: number;
  staleWindowMs: number;
}): PageFreshnessResult['assessment'] {
  const now = Date.now();
  const latestPageVisibleTimestamp = [input.latestPageDataTimestamp, input.latestInlineDataTimestamp, input.domVisibleTimestamp]
    .filter((value): value is number => typeof value === 'number')
    .sort((left, right) => right - left)[0] ?? null;
  if (latestPageVisibleTimestamp !== null && now - latestPageVisibleTimestamp <= input.freshWindowMs) {
    return 'fresh';
  }
  const networkHasFreshData =
    typeof input.latestNetworkDataTimestamp === 'number' && now - input.latestNetworkDataTimestamp <= input.freshWindowMs;
  if (networkHasFreshData) {
    return 'lagged';
  }
  const recentSignals = [input.latestNetworkTimestamp, input.lastMutationAt]
    .filter((value): value is number => typeof value === 'number')
    .some((value) => now - value <= input.freshWindowMs);
  if (recentSignals && latestPageVisibleTimestamp !== null && now - latestPageVisibleTimestamp > input.freshWindowMs) {
    return 'lagged';
  }
  const staleSignals = [
    input.latestNetworkTimestamp,
    input.lastMutationAt,
    latestPageVisibleTimestamp,
    input.latestNetworkDataTimestamp
  ]
    .filter((value): value is number => typeof value === 'number');
  if (staleSignals.length > 0 && staleSignals.every((value) => now - value > input.staleWindowMs)) {
    return 'stale';
  }
  return 'unknown';
}

async function collectPageInspection(tabId: number, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return (await forwardContentRpc(tabId, 'bak.internal.inspectState', params)) as Record<string, unknown>;
}

async function probePageDataCandidatesForTab(tabId: number, inspection: Record<string, unknown>): Promise<PageDataCandidateProbe[]> {
  const candidateNames = [
    ...(Array.isArray(inspection.suspiciousGlobals) ? inspection.suspiciousGlobals.map(String) : []),
    ...(Array.isArray(inspection.globalsPreview) ? inspection.globalsPreview.map(String) : [])
  ]
    .filter((name, index, array) => /^[A-Za-z_$][\w$]*$/.test(name) && array.indexOf(name) === index)
    .slice(0, 16);
  if (candidateNames.length === 0) {
    return [];
  }

  const expr = `(() => {
    const candidates = ${JSON.stringify(candidateNames)};
    const dataPattern = /\\b(updated|update|updatedat|asof|timestamp|generated|generatedat|refresh|latest|last|quote|trade|price|flow|market|time|snapshot|signal)\\b/i;
    const contractPattern = /\\b(expiry|expiration|expires|option|contract|strike|maturity|dte|call|put|exercise)\\b/i;
    const eventPattern = /\\b(earnings|event|report|dividend|split|meeting|fomc|release|filing)\\b/i;
    const isTimestampString = (value) => typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value.trim()));
    const classify = (path, value) => {
      const normalized = String(path || '').toLowerCase();
      if (dataPattern.test(normalized)) return 'data';
      if (contractPattern.test(normalized)) return 'contract';
      if (eventPattern.test(normalized)) return 'event';
      const parsed = Date.parse(String(value || '').trim());
      return Number.isFinite(parsed) && parsed > Date.now() + 36 * 60 * 60 * 1000 ? 'contract' : 'unknown';
    };
    const sampleValue = (value, depth = 0) => {
      if (depth >= 2 || value == null || typeof value !== 'object') {
        if (typeof value === 'string') {
          return value.length > 160 ? value.slice(0, 160) : value;
        }
        if (typeof value === 'function') {
          return '[Function]';
        }
        return value;
      }
      if (Array.isArray(value)) {
        return value.slice(0, 3).map((item) => sampleValue(item, depth + 1));
      }
      const sampled = {};
      for (const key of Object.keys(value).slice(0, 8)) {
        try {
          sampled[key] = sampleValue(value[key], depth + 1);
        } catch {
          sampled[key] = '[Unreadable]';
        }
      }
      return sampled;
    };
    const collectTimestamps = (value, path, depth, collected) => {
      if (collected.length >= 16) return;
      if (isTimestampString(value)) {
        collected.push({ path, value: String(value), category: classify(path, value) });
        return;
      }
      if (depth >= 3) return;
      if (Array.isArray(value)) {
        value.slice(0, 3).forEach((item, index) => collectTimestamps(item, path + '[' + index + ']', depth + 1, collected));
        return;
      }
      if (value && typeof value === 'object') {
        Object.keys(value)
          .slice(0, 8)
          .forEach((key) => {
            try {
              collectTimestamps(value[key], path ? path + '.' + key : key, depth + 1, collected);
            } catch {
              // Ignore unreadable nested properties.
            }
          });
      }
    };
    const readCandidate = (name) => {
      if (name in globalThis) {
        return { resolver: 'globalThis', value: globalThis[name] };
      }
      return { resolver: 'lexical', value: globalThis.eval(name) };
    };
    const results = [];
    for (const name of candidates) {
      try {
        const resolved = readCandidate(name);
        const timestamps = [];
        collectTimestamps(resolved.value, name, 0, timestamps);
        results.push({
          name,
          resolver: resolved.resolver,
          sample: sampleValue(resolved.value),
          timestamps
        });
      } catch {
        // Ignore inaccessible candidates.
      }
    }
    return results;
  })()`;

  try {
    const evaluated = await executePageWorld<PageDataCandidateProbe[]>(tabId, 'eval', {
      expr,
      scope: 'current',
      maxBytes: 64 * 1024
    });
    const frameResult = evaluated.result ?? evaluated.results?.find((candidate) => candidate.value || candidate.error);
    return Array.isArray(frameResult?.value) ? frameResult.value : [];
  } catch {
    return [];
  }
}

async function buildFreshnessForTab(tabId: number, params: Record<string, unknown> = {}): Promise<PageFreshnessResult> {
  const inspection = await collectPageInspection(tabId, params);
  const probedPageDataCandidates = await probePageDataCandidatesForTab(tabId, inspection);
  const now = Date.now();
  const freshWindowMs = typeof params.freshWindowMs === 'number' ? Math.max(1, Math.floor(params.freshWindowMs)) : 15 * 60 * 1000;
  const staleWindowMs = typeof params.staleWindowMs === 'number' ? Math.max(freshWindowMs, Math.floor(params.staleWindowMs)) : 24 * 60 * 60 * 1000;
  const visibleCandidates = normalizeTimestampCandidates(
    Array.isArray(inspection.visibleTimestampCandidates)
      ? inspection.visibleTimestampCandidates
          .filter((candidate): candidate is Record<string, unknown> => typeof candidate === 'object' && candidate !== null)
          .map((candidate) => ({
            value: String(candidate.value ?? ''),
            context: typeof candidate.context === 'string' ? candidate.context : undefined,
            source: 'visible' as const
          }))
      : Array.isArray(inspection.visibleTimestamps)
        ? inspection.visibleTimestamps.map((value) => ({ value: String(value), source: 'visible' as const }))
        : [],
    now
  );
  const inlineCandidates = normalizeTimestampCandidates(
    Array.isArray(inspection.inlineTimestampCandidates)
      ? inspection.inlineTimestampCandidates
          .filter((candidate): candidate is Record<string, unknown> => typeof candidate === 'object' && candidate !== null)
          .map((candidate) => ({
            value: String(candidate.value ?? ''),
            context: typeof candidate.context === 'string' ? candidate.context : undefined,
            source: 'inline' as const
          }))
      : Array.isArray(inspection.inlineTimestamps)
        ? inspection.inlineTimestamps.map((value) => ({ value: String(value), source: 'inline' as const }))
        : [],
    now
  );
  const pageDataCandidates = probedPageDataCandidates.flatMap((candidate) =>
    Array.isArray(candidate.timestamps)
      ? candidate.timestamps.map((timestamp) => ({
          value: String(timestamp.value ?? ''),
          source: 'page-data' as const,
          path: typeof timestamp.path === 'string' ? timestamp.path : candidate.name,
          category:
            timestamp.category === 'data' ||
            timestamp.category === 'contract' ||
            timestamp.category === 'event' ||
            timestamp.category === 'unknown'
              ? timestamp.category
              : 'unknown'
        }))
      : []
  );
  const networkEntries = listNetworkEntries(tabId, { limit: 25 });
  const networkCandidates = normalizeTimestampCandidates(
    networkEntries.flatMap((entry) => {
      const previews = [entry.responseBodyPreview, entry.requestBodyPreview].filter((value): value is string => typeof value === 'string');
      return previews.flatMap((preview) => collectTimestampMatchesFromText(preview, 'network', Array.isArray(params.patterns) ? params.patterns.map(String) : undefined));
    }),
    now
  );
  const latestInlineDataTimestamp = latestTimestampFromCandidates(inlineCandidates, now);
  const latestPageDataTimestamp = latestTimestampFromCandidates(pageDataCandidates, now);
  const latestNetworkDataTimestamp = latestTimestampFromCandidates(networkCandidates, now);
  const domVisibleTimestamp = latestTimestampFromCandidates(visibleCandidates, now);
  const latestNetworkTs = latestNetworkTimestamp(tabId);
  const lastMutationAt = typeof inspection.lastMutationAt === 'number' ? inspection.lastMutationAt : null;
  const allCandidates = [...visibleCandidates, ...inlineCandidates, ...pageDataCandidates, ...networkCandidates];
  return {
    pageLoadedAt: typeof inspection.pageLoadedAt === 'number' ? inspection.pageLoadedAt : null,
    lastMutationAt,
    latestNetworkTimestamp: latestNetworkTs,
    latestInlineDataTimestamp,
    latestPageDataTimestamp,
    latestNetworkDataTimestamp,
    domVisibleTimestamp,
    assessment: computeFreshnessAssessment({
      latestInlineDataTimestamp,
      latestPageDataTimestamp,
      latestNetworkDataTimestamp,
      latestNetworkTimestamp: latestNetworkTs,
      domVisibleTimestamp,
      lastMutationAt,
      freshWindowMs,
      staleWindowMs
    }),
    evidence: {
      visibleTimestamps: visibleCandidates.map((candidate) => candidate.value),
      inlineTimestamps: inlineCandidates.map((candidate) => candidate.value),
      pageDataTimestamps: pageDataCandidates.map((candidate) => candidate.value),
      networkDataTimestamps: networkCandidates.map((candidate) => candidate.value),
      classifiedTimestamps: allCandidates,
      networkSampleIds: recentNetworkSampleIds(tabId)
    }
  };
}

function summarizeNetworkCadence(entries: NetworkEntry[]): Record<string, unknown> {
  const relevant = entries
    .filter((entry) => entry.kind === 'fetch' || entry.kind === 'xhr')
    .slice()
    .sort((left, right) => left.ts - right.ts);
  if (relevant.length === 0) {
    return {
      sampleCount: 0,
      classification: 'none',
      averageIntervalMs: null,
      medianIntervalMs: null,
      latestGapMs: null,
      endpoints: []
    };
  }
  const intervals: number[] = [];
  for (let index = 1; index < relevant.length; index += 1) {
    intervals.push(Math.max(0, relevant[index]!.ts - relevant[index - 1]!.ts));
  }
  const sortedIntervals = intervals.slice().sort((left, right) => left - right);
  const averageIntervalMs =
    intervals.length > 0 ? Math.round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length) : null;
  const medianIntervalMs =
    sortedIntervals.length > 0 ? sortedIntervals[Math.floor(sortedIntervals.length / 2)] ?? null : null;
  const latestGapMs = Math.max(0, Date.now() - relevant[relevant.length - 1]!.ts);
  const classification =
    relevant.length >= 3 && medianIntervalMs !== null && medianIntervalMs <= 30_000
      ? 'polling'
      : relevant.length >= 2
        ? 'bursty'
        : 'single-request';
  return {
    sampleCount: relevant.length,
    classification,
    averageIntervalMs,
    medianIntervalMs,
    latestGapMs,
    endpoints: [...new Set(relevant.slice(-5).map((entry) => entry.url))].slice(0, 5)
  };
}

function extractReplayRowsCandidate(json: unknown): { rows: unknown[]; source: string } | null {
  if (Array.isArray(json)) {
    return { rows: json, source: '$' };
  }
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const record = json as Record<string, unknown>;
  const preferredKeys = ['data', 'rows', 'results', 'items'];
  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) {
      return { rows: record[key] as unknown[], source: `$.${key}` };
    }
  }
  return null;
}

async function enrichReplayWithSchema(tabId: number, response: PageFetchResponse): Promise<PageFetchResponse> {
  const candidate = extractReplayRowsCandidate(response.json);
  if (!candidate || candidate.rows.length === 0) {
    return response;
  }

  const firstRow = candidate.rows[0];
  const tablesResult = (await forwardContentRpc(tabId, 'table.list', {})) as { tables?: TableHandle[] };
  const tables = Array.isArray(tablesResult.tables) ? tablesResult.tables : [];
  if (tables.length === 0) {
    return response;
  }

  const schemas: Array<{ table: TableHandle; schema: TableSchema }> = [];
  for (const table of tables) {
    const schemaResult = (await forwardContentRpc(tabId, 'table.schema', { table: table.id })) as {
      table?: TableHandle;
      schema?: TableSchema;
    };
    if (schemaResult.schema && Array.isArray(schemaResult.schema.columns)) {
      schemas.push({ table: schemaResult.table ?? table, schema: schemaResult.schema });
    }
  }

  if (schemas.length === 0) {
    return response;
  }

  if (Array.isArray(firstRow)) {
    const matchingSchema = schemas.find(({ schema }) => schema.columns.length === firstRow.length) ?? schemas[0];
    if (!matchingSchema) {
      return response;
    }
    const mappedRows = candidate.rows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => {
        const mapped: Record<string, unknown> = {};
        matchingSchema.schema.columns.forEach((column, index) => {
          mapped[column.label] = row[index];
        });
        return mapped;
      });
    return {
      ...response,
      table: matchingSchema.table,
      schema: matchingSchema.schema,
      mappedRows,
      mappingSource: candidate.source
    };
  }

  if (typeof firstRow === 'object' && firstRow !== null) {
    return {
      ...response,
      mappedRows: candidate.rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null),
      mappingSource: candidate.source
    };
  }

  return response;
}

async function handleRequest(request: CliRequest): Promise<unknown> {
  const params = request.params ?? {};
  const target = {
    tabId: typeof params.tabId === 'number' ? params.tabId : undefined,
    bindingId: typeof params.bindingId === 'string' ? params.bindingId : undefined
  };

  const rpcForwardMethods = new Set([
    'page.title',
    'page.url',
    'page.text',
    'page.dom',
    'page.accessibilityTree',
    'page.scrollTo',
    'page.metrics',
    'element.hover',
    'element.doubleClick',
    'element.rightClick',
    'element.dragDrop',
    'element.select',
    'element.check',
    'element.uncheck',
    'element.scrollIntoView',
    'element.focus',
    'element.blur',
    'element.get',
    'keyboard.press',
    'keyboard.type',
    'keyboard.hotkey',
    'mouse.move',
    'mouse.click',
    'mouse.wheel',
    'file.upload',
    'context.get',
    'context.set',
    'context.enterFrame',
    'context.exitFrame',
    'context.enterShadow',
    'context.exitShadow',
    'context.reset',
    'table.list',
    'table.schema',
    'table.rows',
    'table.export'
  ]);

  switch (request.method) {
    case 'session.ping': {
      return { ok: true, ts: Date.now() };
    }
    case 'tabs.list': {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs
          .filter((tab): tab is chrome.tabs.Tab => typeof tab.id === 'number' && typeof tab.windowId === 'number')
          .map((tab) => toTabInfo(tab))
      };
    }
    case 'tabs.getActive': {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab || typeof tab.id !== 'number') {
        return { tab: null };
      }
      return {
        tab: toTabInfo(tab)
      };
    }
    case 'tabs.get': {
      const tabId = Number(params.tabId);
      const tab = await chrome.tabs.get(tabId);
      if (typeof tab.id !== 'number') {
        throw toError('E_NOT_FOUND', 'Tab missing id');
      }
      return {
        tab: toTabInfo(tab)
      };
    }
    case 'tabs.focus': {
      const tabId = Number(params.tabId);
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    case 'tabs.new': {
      const tab = await chrome.tabs.create({
        url: (params.url as string | undefined) ?? 'about:blank',
        windowId: typeof params.windowId === 'number' ? params.windowId : undefined,
        active: params.active === true
      });
      if (params.addToGroup === true && typeof tab.id === 'number') {
        const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
        return {
          tabId: tab.id,
          windowId: tab.windowId,
          groupId
        };
      }
      return {
        tabId: tab.id,
        windowId: tab.windowId
      };
    }
    case 'tabs.close': {
      const tabId = Number(params.tabId);
      await chrome.tabs.remove(tabId);
      return { ok: true };
    }
    case 'sessionBinding.ensure': {
      return preserveHumanFocus(params.focus !== true, async () => {
        const result = await bindingManager.ensureBinding({
          bindingId: String(params.bindingId ?? ''),
          focus: params.focus === true,
          initialUrl: typeof params.url === 'string' ? params.url : undefined
        });
        for (const tab of result.binding.tabs) {
          void ensureNetworkDebugger(tab.id).catch(() => undefined);
        }
        return {
          browser: result.binding,
          created: result.created,
          repaired: result.repaired,
          repairActions: result.repairActions
        };
      });
    }
    case 'sessionBinding.info': {
      return {
        browser: await bindingManager.getBindingInfo(String(params.bindingId ?? ''))
      };
    }
    case 'sessionBinding.openTab': {
      const expectedUrl = typeof params.url === 'string' ? params.url : undefined;
      const opened = await preserveHumanFocus(params.focus !== true, async () => {
        return await bindingManager.openTab({
          bindingId: String(params.bindingId ?? ''),
          url: expectedUrl,
          active: params.active === true,
          focus: params.focus === true
        });
      });
      const finalized = await finalizeOpenedSessionBindingTab(opened, expectedUrl);
      void ensureNetworkDebugger(finalized.tab.id).catch(() => undefined);
      return {
        browser: finalized.binding,
        tab: finalized.tab
      };
    }
    case 'sessionBinding.listTabs': {
      const listed = await bindingManager.listTabs(String(params.bindingId ?? ''));
      return {
        browser: listed.binding,
        tabs: listed.tabs
      };
    }
    case 'sessionBinding.getActiveTab': {
      const active = await bindingManager.getActiveTab(String(params.bindingId ?? ''));
      return {
        browser: active.binding,
        tab: active.tab
      };
    }
    case 'sessionBinding.setActiveTab': {
      const result = await bindingManager.setActiveTab(Number(params.tabId), String(params.bindingId ?? ''));
      void ensureNetworkDebugger(result.tab.id).catch(() => undefined);
      return {
        browser: result.binding,
        tab: result.tab
      };
    }
    case 'sessionBinding.focus': {
      const result = await bindingManager.focus(String(params.bindingId ?? ''));
      return {
        ok: true,
        browser: result.binding
      };
    }
    case 'sessionBinding.reset': {
      return await preserveHumanFocus(params.focus !== true, async () => {
        const result = await bindingManager.reset({
          bindingId: String(params.bindingId ?? ''),
          focus: params.focus === true,
          initialUrl: typeof params.url === 'string' ? params.url : undefined
        });
        return {
          browser: result.binding,
          created: result.created,
          repaired: result.repaired,
          repairActions: result.repairActions
        };
      });
    }
    case 'sessionBinding.close': {
      return await bindingManager.close(String(params.bindingId ?? ''));
    }
    case 'page.goto': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target, {
          requireSupportedAutomationUrl: false
        });
        void ensureNetworkDebugger(tab.id!).catch(() => undefined);
        const url = String(params.url ?? 'about:blank');
        await chrome.tabs.update(tab.id!, { url });
        await waitForTabUrl(tab.id!, url);
        await forwardContentRpc(tab.id!, 'page.url', { tabId: tab.id }).catch(() => undefined);
        await waitForTabComplete(tab.id!, 5_000).catch(() => undefined);
        return { ok: true };
      });
    }
    case 'page.back': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        void ensureNetworkDebugger(tab.id!).catch(() => undefined);
        await chrome.tabs.goBack(tab.id!);
        await waitForTabComplete(tab.id!);
        return { ok: true };
      });
    }
    case 'page.forward': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        void ensureNetworkDebugger(tab.id!).catch(() => undefined);
        await chrome.tabs.goForward(tab.id!);
        await waitForTabComplete(tab.id!);
        return { ok: true };
      });
    }
    case 'page.reload': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        void ensureNetworkDebugger(tab.id!).catch(() => undefined);
        await chrome.tabs.reload(tab.id!);
        await waitForTabComplete(tab.id!);
        return { ok: true };
      });
    }
    case 'page.viewport': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target, {
          requireSupportedAutomationUrl: false
        });
        if (typeof tab.windowId !== 'number') {
          throw toError('E_NOT_FOUND', 'Tab window unavailable');
        }

        const width = typeof params.width === 'number' ? Math.max(320, Math.floor(params.width)) : undefined;
        const height = typeof params.height === 'number' ? Math.max(320, Math.floor(params.height)) : undefined;
        if (width || height) {
          await chrome.windows.update(tab.windowId, {
            width,
            height
          });
        }

        const viewport = (await forwardContentRpc(tab.id!, 'page.viewport', {})) as {
          width: number;
          height: number;
          devicePixelRatio: number;
        };
        const viewWidth = typeof width === 'number' ? width : viewport.width ?? tab.width ?? 0;
        const viewHeight = typeof height === 'number' ? height : viewport.height ?? tab.height ?? 0;
        return {
          width: viewWidth,
          height: viewHeight,
          devicePixelRatio: viewport.devicePixelRatio
        };
      });
    }
    case 'page.eval': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        return await executePageWorld(tab.id!, 'eval', params);
      });
    }
    case 'page.extract': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        return await executePageWorld(tab.id!, 'extract', params);
      });
    }
    case 'page.fetch': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        return await executePageWorld<PageFetchResponse>(tab.id!, 'fetch', params);
      });
    }
    case 'page.snapshot': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
          throw toError('E_NOT_FOUND', 'Tab missing id');
        }
        const includeBase64 = params.includeBase64 !== false;
        const config = await getConfig();
        const elements = await sendToContent<{ elements: unknown[] }>(tab.id, {
          type: 'bak.collectElements',
          debugRichText: config.debugRichText
        });
        const imageData = await captureAlignedTabScreenshot(tab);
        return {
          imageBase64: includeBase64 ? imageData.replace(/^data:image\/png;base64,/, '') : '',
          elements: elements.elements,
          tabId: tab.id,
          url: tab.url ?? ''
        };
      });
    }
    case 'element.click': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
          type: 'bak.performAction',
          action: 'click',
          locator: params.locator as Locator,
          requiresConfirm: params.requiresConfirm === true
        });
        if (!response.ok) {
          throw response.error ?? toError('E_INTERNAL', 'element.click failed');
        }
        return { ok: true };
      });
    }
    case 'element.type': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
          type: 'bak.performAction',
          action: 'type',
          locator: params.locator as Locator,
          text: String(params.text ?? ''),
          clear: Boolean(params.clear),
          requiresConfirm: params.requiresConfirm === true
        });
        if (!response.ok) {
          throw response.error ?? toError('E_INTERNAL', 'element.type failed');
        }
        return { ok: true };
      });
    }
    case 'element.scroll': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
          type: 'bak.performAction',
          action: 'scroll',
          locator: params.locator as Locator,
          dx: Number(params.dx ?? 0),
          dy: Number(params.dy ?? 320)
        });
        if (!response.ok) {
          throw response.error ?? toError('E_INTERNAL', 'element.scroll failed');
        }
        return { ok: true };
      });
    }
    case 'page.wait': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
          type: 'bak.waitFor',
          mode: String(params.mode ?? 'selector'),
          value: String(params.value ?? ''),
          timeoutMs: Number(params.timeoutMs ?? 5000)
        });
        if (!response.ok) {
          throw response.error ?? toError('E_TIMEOUT', 'page.wait failed');
        }
        return { ok: true };
      });
    }
    case 'debug.getConsole': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        const response = await sendToContent<{ entries: ConsoleEntry[] }>(tab.id!, {
          type: 'bak.getConsole',
          limit: Number(params.limit ?? 50)
        });
        return { entries: response.entries };
      });
    }
    case 'network.list': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        try {
          await ensureTabNetworkCapture(tab.id!);
          return {
            entries: listNetworkEntries(tab.id!, {
              limit: typeof params.limit === 'number' ? params.limit : undefined,
              urlIncludes: typeof params.urlIncludes === 'string' ? params.urlIncludes : undefined,
              status: typeof params.status === 'number' ? params.status : undefined,
              method: typeof params.method === 'string' ? params.method : undefined
            })
          };
        } catch {
          return await forwardContentRpc(tab.id!, 'network.list', params);
        }
      });
    }
    case 'network.get': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        try {
          await ensureTabNetworkCapture(tab.id!);
          const entry = getNetworkEntry(tab.id!, String(params.id ?? ''));
          if (!entry) {
            throw toError('E_NOT_FOUND', `network entry not found: ${String(params.id ?? '')}`);
          }
          const filtered = filterNetworkEntrySections(
            truncateNetworkEntry(entry, typeof params.bodyBytes === 'number' ? params.bodyBytes : undefined),
            params.include
          );
          return { entry: filtered };
        } catch (error) {
          if ((error as { code?: string } | undefined)?.code === 'E_NOT_FOUND') {
            throw error;
          }
          return await forwardContentRpc(tab.id!, 'network.get', params);
        }
      });
    }
    case 'network.search': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureTabNetworkCapture(tab.id!);
        return {
          entries: searchNetworkEntries(
            tab.id!,
            String(params.pattern ?? ''),
            typeof params.limit === 'number' ? params.limit : 50
          )
        };
      });
    }
    case 'network.waitFor': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        try {
          await ensureTabNetworkCapture(tab.id!);
        } catch {
          return await forwardContentRpc(tab.id!, 'network.waitFor', params);
        }
        return {
          entry: await waitForNetworkEntry(tab.id!, {
            limit: 1,
            urlIncludes: typeof params.urlIncludes === 'string' ? params.urlIncludes : undefined,
            status: typeof params.status === 'number' ? params.status : undefined,
            method: typeof params.method === 'string' ? params.method : undefined,
            timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined
          })
        };
      });
    }
    case 'network.clear': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        clearNetworkEntries(tab.id!);
        await forwardContentRpc(tab.id!, 'network.clear', params).catch(() => undefined);
        return { ok: true };
      });
    }
    case 'network.replay': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureTabNetworkCapture(tab.id!);
        const entry = getNetworkEntry(tab.id!, String(params.id ?? ''));
        if (!entry) {
          throw toError('E_NOT_FOUND', `network entry not found: ${String(params.id ?? '')}`);
        }
        if (entry.requestBodyTruncated === true) {
          throw toError('E_BODY_TOO_LARGE', 'captured request body was truncated and cannot be replayed safely', {
            requestId: entry.id,
            requestBytes: entry.requestBytes
          });
        }
        if (containsRedactionMarker(entry.requestBodyPreview)) {
          throw toError('E_EXECUTION', 'captured request body was redacted and cannot be replayed safely', {
            requestId: entry.id
          });
        }
        const replayed = await executePageWorld<PageFetchResponse>(tab.id!, 'fetch', {
          url: entry.url,
          method: entry.method,
          headers: replayHeadersFromEntry(entry),
          body: entry.requestBodyPreview,
          contentType: (() => {
            const requestHeaders = entry.requestHeaders ?? {};
            const contentTypeHeader = Object.keys(requestHeaders).find((name) => name.toLowerCase() === 'content-type');
            return contentTypeHeader ? requestHeaders[contentTypeHeader] : undefined;
          })(),
          mode: params.mode,
          timeoutMs: params.timeoutMs,
          maxBytes: params.maxBytes,
          scope: 'current'
        });
        const frameResult = replayed.result ?? replayed.results?.find((candidate) => candidate.value || candidate.error);
        if (frameResult?.error) {
          throw toError(frameResult.error.code ?? 'E_EXECUTION', frameResult.error.message, frameResult.error.details);
        }
        const first = frameResult?.value;
        if (!first) {
          throw toError('E_EXECUTION', 'network replay returned no response payload');
        }
        return params.withSchema === 'auto' && params.mode === 'json' ? await enrichReplayWithSchema(tab.id!, first) : first;
      });
    }
    case 'page.freshness': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureNetworkDebugger(tab.id!).catch(() => undefined);
        return await buildFreshnessForTab(tab.id!, params);
      });
    }
    case 'debug.dumpState': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureNetworkDebugger(tab.id!).catch(() => undefined);
        const dump = (await forwardContentRpc(tab.id!, 'debug.dumpState', params)) as Record<string, unknown>;
        const inspection = await collectPageInspection(tab.id!, params);
        const network = listNetworkEntries(tab.id!, {
          limit: typeof params.networkLimit === 'number' ? params.networkLimit : 80
        });
        const sections = Array.isArray(params.section) ? new Set(params.section.map(String) as DebugDumpSection[]) : null;
        const result: Record<string, unknown> = {
          ...dump,
          network,
          scripts: inspection.scripts,
          globalsPreview: inspection.globalsPreview,
          storage: inspection.storage,
          frames: inspection.frames,
          networkSummary: {
            total: network.length,
            recent: network.slice(0, Math.min(10, network.length))
          }
        };
        if (!sections || sections.size === 0) {
          return result;
        }
        const filtered: Record<string, unknown> = {
          url: result.url,
          title: result.title,
          context: result.context
        };
        if (sections.has('dom')) {
          filtered.dom = result.dom;
        }
        if (sections.has('visible-text')) {
          filtered.text = result.text;
          filtered.elements = result.elements;
        }
        if (sections.has('scripts')) {
          filtered.scripts = result.scripts;
        }
        if (sections.has('globals-preview')) {
          filtered.globalsPreview = result.globalsPreview;
        }
        if (sections.has('network-summary')) {
          filtered.networkSummary = result.networkSummary;
        }
        if (sections.has('storage')) {
          filtered.storage = result.storage;
        }
        if (sections.has('frames')) {
          filtered.frames = result.frames;
        }
        if (params.includeAccessibility === true && 'accessibility' in result) {
          filtered.accessibility = result.accessibility;
        }
        if ('snapshot' in result) {
          filtered.snapshot = result.snapshot;
        }
        return filtered;
      });
    }
    case 'inspect.pageData': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureNetworkDebugger(tab.id!).catch(() => undefined);
        const inspection = await collectPageInspection(tab.id!, params);
        const pageDataCandidates = await probePageDataCandidatesForTab(tab.id!, inspection);
        const network = listNetworkEntries(tab.id!, { limit: 10 });
        return {
          suspiciousGlobals: inspection.suspiciousGlobals ?? [],
          tables: inspection.tables ?? [],
          visibleTimestamps: inspection.visibleTimestamps ?? [],
          inlineTimestamps: inspection.inlineTimestamps ?? [],
          pageDataCandidates,
          recentNetwork: network,
          recommendedNextSteps: [
            'bak page extract --path table_data --resolver auto',
            'bak network search --pattern table_data',
            'bak page freshness'
          ]
        };
      });
    }
    case 'inspect.liveUpdates': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureNetworkDebugger(tab.id!).catch(() => undefined);
        const inspection = await collectPageInspection(tab.id!, params);
        const network = listNetworkEntries(tab.id!, { limit: 25 });
        return {
          lastMutationAt: inspection.lastMutationAt ?? null,
          timers: inspection.timers ?? { timeouts: 0, intervals: 0 },
          networkCount: network.length,
          networkCadence: summarizeNetworkCadence(network),
          recentNetwork: network.slice(0, 10)
        };
      });
    }
    case 'inspect.freshness': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        const freshness = await buildFreshnessForTab(tab.id!, params);
        return {
          ...freshness,
          lagMs:
            typeof freshness.latestNetworkTimestamp === 'number' &&
            typeof (freshness.latestPageDataTimestamp ?? freshness.latestInlineDataTimestamp) === 'number'
              ? Math.max(
                  0,
                  freshness.latestNetworkTimestamp -
                    (freshness.latestPageDataTimestamp ?? freshness.latestInlineDataTimestamp ?? freshness.latestNetworkTimestamp)
                )
              : null
        };
      });
    }
    case 'capture.snapshot': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureNetworkDebugger(tab.id!).catch(() => undefined);
        const inspection = await collectPageInspection(tab.id!, params);
        return {
          url: inspection.url ?? tab.url ?? '',
          title: inspection.title ?? tab.title ?? '',
          html: inspection.html ?? '',
          visibleText: inspection.visibleText ?? [],
          cookies: inspection.cookies ?? [],
          storage: inspection.storage ?? { localStorageKeys: [], sessionStorageKeys: [] },
          context: inspection.context ?? { tabId: tab.id, framePath: [], shadowPath: [] },
          freshness: await buildFreshnessForTab(tab.id!, params),
          network: listNetworkEntries(tab.id!, {
            limit: typeof params.networkLimit === 'number' ? params.networkLimit : 20
          }),
          capturedAt: Date.now()
        };
      });
    }
    case 'capture.har': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await ensureTabNetworkCapture(tab.id!);
        return {
          har: exportHar(tab.id!, typeof params.limit === 'number' ? params.limit : undefined)
        };
      });
    }
    case 'ui.selectCandidate': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        const response = await sendToContent<{ ok: boolean; selectedEid?: string; error?: CliResponse['error'] }>(
          tab.id!,
          {
            type: 'bak.selectCandidate',
            candidates: params.candidates
          }
        );
        if (!response.ok || !response.selectedEid) {
          throw response.error ?? toError('E_NEED_USER_CONFIRM', 'User did not confirm candidate');
        }
        return { selectedEid: response.selectedEid };
      });
    }
    default:
      if (rpcForwardMethods.has(request.method)) {
        return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
          const tab = await withTab(target);
          return await forwardContentRpc(tab.id!, request.method, {
            ...params,
            tabId: tab.id
          });
        });
      }
      throw toError('E_NOT_FOUND', `Unsupported method from CLI bridge: ${request.method}`);
  }
}

function scheduleReconnect(reason: string): void {
  if (manualDisconnect) {
    return;
  }
  if (reconnectTimer !== null) {
    return;
  }

  const delayMs = computeReconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  nextReconnectInMs = delayMs;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    nextReconnectInMs = null;
    void connectWebSocket();
  }, delayMs) as unknown as number;

  if (!lastError) {
    setRuntimeError(`Reconnect scheduled: ${reason}`, 'socket');
  }
}

async function connectWebSocket(): Promise<void> {
  clearReconnectTimer();
  if (manualDisconnect) {
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const config = await getConfig();
  if (!config.token) {
    setRuntimeError('Pair token is empty', 'config');
    return;
  }

  const url = `ws://127.0.0.1:${config.port}/extension?token=${encodeURIComponent(config.token)}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    manualDisconnect = false;
    reconnectAttempt = 0;
    lastError = null;
    ws?.send(JSON.stringify({
      type: 'hello',
      role: 'extension',
      version: '0.6.0',
      ts: Date.now()
    }));
  });

  ws.addEventListener('message', (event) => {
    try {
      const request = JSON.parse(String(event.data)) as CliRequest;
      if (!request.id || !request.method) {
        return;
      }
      void handleRequest(request)
        .then((result) => {
          sendResponse({ id: request.id, ok: true, result });
        })
        .catch((error: unknown) => {
          const normalized = normalizeUnhandledError(error);
          sendResponse({ id: request.id, ok: false, error: normalized });
        });
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error), 'parse');
      sendResponse({
        id: 'parse-error',
        ok: false,
        error: toError('E_INTERNAL', error instanceof Error ? error.message : String(error))
      });
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    scheduleReconnect('socket-closed');
  });

  ws.addEventListener('error', () => {
    setRuntimeError('Cannot connect to bak cli', 'socket');
    ws?.close();
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  dropNetworkCapture(tabId);
  void mutateSessionBindingStateMap((stateMap) => {
    for (const [bindingId, state] of Object.entries(stateMap)) {
      if (!state.tabIds.includes(tabId)) {
        continue;
      }
      const nextTabIds = state.tabIds.filter((id) => id !== tabId);
      stateMap[bindingId] = {
        ...state,
        tabIds: nextTabIds,
        activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
        primaryTabId: state.primaryTabId === tabId ? null : state.primaryTabId
      };
    }
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void mutateSessionBindingStateMap((stateMap) => {
    for (const [bindingId, state] of Object.entries(stateMap)) {
      if (state.windowId !== activeInfo.windowId || !state.tabIds.includes(activeInfo.tabId)) {
        continue;
      }
      stateMap[bindingId] = {
        ...state,
        activeTabId: activeInfo.tabId
      };
    }
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void mutateSessionBindingStateMap((stateMap) => {
    for (const [bindingId, state] of Object.entries(stateMap)) {
      if (state.windowId !== windowId) {
        continue;
      }
      stateMap[bindingId] = {
        ...state,
        windowId: null,
        groupId: null,
        tabIds: [],
        activeTabId: null,
        primaryTabId: null
      };
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void setConfig({ port: DEFAULT_PORT, debugRichText: false });
});

chrome.runtime.onStartup.addListener(() => {
  void connectWebSocket();
});

void connectWebSocket();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bak.updateConfig') {
    manualDisconnect = false;
    void setConfig({
      token: message.token,
      port: Number(message.port ?? DEFAULT_PORT),
      debugRichText: message.debugRichText === true
    }).then(() => {
      ws?.close();
      void connectWebSocket().then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  if (message?.type === 'bak.getState') {
    void getConfig().then((config) => {
      sendResponse({
        ok: true,
        connected: ws?.readyState === WebSocket.OPEN,
        hasToken: Boolean(config.token),
        port: config.port,
        debugRichText: config.debugRichText,
        lastError: lastError?.message ?? null,
        lastErrorAt: lastError?.at ?? null,
        lastErrorContext: lastError?.context ?? null,
        reconnectAttempt,
        nextReconnectInMs
      });
    });
    return true;
  }

  if (message?.type === 'bak.disconnect') {
    manualDisconnect = true;
    clearReconnectTimer();
    reconnectAttempt = 0;
    ws?.close();
    ws = null;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});


