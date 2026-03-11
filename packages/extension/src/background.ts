import type {
  ConsoleEntry,
  DebugDumpSection,
  Locator,
  NetworkEntry,
  PageExecutionScope,
  PageFetchResponse,
  PageFrameResult,
  PageFreshnessResult
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
import {
  LEGACY_STORAGE_KEY_WORKSPACE,
  LEGACY_STORAGE_KEY_WORKSPACES,
  resolveSessionBindingStateMap,
  STORAGE_KEY_SESSION_BINDINGS
} from './session-binding-storage.js';
import { containsRedactionMarker } from './privacy.js';
import {
  type WorkspaceBrowser as SessionBindingBrowser,
  type WorkspaceColor as SessionBindingColor,
  type WorkspaceRecord as SessionBindingRecord,
  type WorkspaceTab as SessionBindingTab,
  type WorkspaceWindow as SessionBindingWindow,
  WorkspaceManager as SessionBindingManager
} from './workspace.js';

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
  if (lower.includes('workspace') && lower.includes('does not exist')) {
    return toError('E_NOT_FOUND', message);
  }
  if (lower.includes('does not belong to workspace') || lower.includes('is missing from workspace')) {
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

async function loadWorkspaceStateMap(): Promise<Record<string, SessionBindingRecord>> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_SESSION_BINDINGS,
    LEGACY_STORAGE_KEY_WORKSPACES,
    LEGACY_STORAGE_KEY_WORKSPACE
  ]);
  return resolveSessionBindingStateMap(stored);
}

async function loadWorkspaceState(workspaceId: string): Promise<SessionBindingRecord | null> {
  const stateMap = await loadWorkspaceStateMap();
  return stateMap[workspaceId] ?? null;
}

async function listWorkspaceStates(): Promise<SessionBindingRecord[]> {
  return Object.values(await loadWorkspaceStateMap());
}

async function saveWorkspaceState(state: SessionBindingRecord): Promise<void> {
  const stateMap = await loadWorkspaceStateMap();
  stateMap[state.id] = state;
  await chrome.storage.local.set({ [STORAGE_KEY_SESSION_BINDINGS]: stateMap });
  await chrome.storage.local.remove([LEGACY_STORAGE_KEY_WORKSPACES, LEGACY_STORAGE_KEY_WORKSPACE]);
}

async function deleteWorkspaceState(workspaceId: string): Promise<void> {
  const stateMap = await loadWorkspaceStateMap();
  delete stateMap[workspaceId];
  if (Object.keys(stateMap).length === 0) {
    await chrome.storage.local.remove([STORAGE_KEY_SESSION_BINDINGS, LEGACY_STORAGE_KEY_WORKSPACES, LEGACY_STORAGE_KEY_WORKSPACE]);
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEY_SESSION_BINDINGS]: stateMap });
  await chrome.storage.local.remove([LEGACY_STORAGE_KEY_WORKSPACES, LEGACY_STORAGE_KEY_WORKSPACE]);
}

const workspaceBrowser: SessionBindingBrowser = {
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
    load: loadWorkspaceState,
    save: saveWorkspaceState,
    delete: deleteWorkspaceState,
    list: listWorkspaceStates
  },
  workspaceBrowser
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

async function finalizeOpenedWorkspaceTab(
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
    refreshedTab = (await workspaceBrowser.getTab(opened.tab.id)) ?? opened.tab;
  }
  const refreshedWorkspace = (await bindingManager.getWorkspaceInfo(opened.workspace.id)) ?? {
    ...opened.workspace,
    tabs: opened.workspace.tabs.map((tab) => (tab.id === refreshedTab.id ? refreshedTab : tab))
  };

  return {
    workspace: refreshedWorkspace,
    tab: refreshedTab
  };
}

interface WithTabOptions {
  requireSupportedAutomationUrl?: boolean;
}

async function withTab(target: { tabId?: number; workspaceId?: string } = {}, options: WithTabOptions = {}): Promise<chrome.tabs.Tab> {
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
    workspaceId: typeof target.workspaceId === 'string' ? target.workspaceId : undefined,
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

      try {
        const targetWindow = payload.scope === 'main' ? window : payload.scope === 'current' ? resolveFrameWindow(payload.framePath ?? []) : window;
        if (payload.action === 'eval') {
          const evaluator = (targetWindow as Window & { eval: (expr: string) => unknown }).eval;
          const serialized = serializeValue(evaluator(payload.expr), payload.maxBytes);
          return { url: targetWindow.location.href, framePath: payload.scope === 'current' ? payload.framePath ?? [] : [], value: serialized.value, bytes: serialized.bytes };
        }
        if (payload.action === 'extract') {
          const segments = parsePath(payload.path);
          let current: unknown = targetWindow;
          for (const segment of segments) {
            if (current === null || current === undefined || !(segment in (current as Record<string | number, unknown>))) {
              throw { code: 'E_NOT_FOUND', message: `path not found: ${payload.path}` };
            }
            current = (current as Record<string | number, unknown>)[segment];
          }
          const serialized = serializeValue(current, payload.maxBytes);
          return { url: targetWindow.location.href, framePath: payload.scope === 'current' ? payload.framePath ?? [] : [], value: serialized.value, bytes: serialized.bytes };
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

function extractLatestTimestamp(values: string[] | undefined, now = Date.now()): number | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  let latest: number | null = null;
  for (const value of values) {
    const parsed = parseTimestampCandidate(value, now);
    if (parsed === null) {
      continue;
    }
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

function computeFreshnessAssessment(input: {
  latestInlineDataTimestamp: number | null;
  latestNetworkTimestamp: number | null;
  domVisibleTimestamp: number | null;
  lastMutationAt: number | null;
  freshWindowMs: number;
  staleWindowMs: number;
}): PageFreshnessResult['assessment'] {
  const now = Date.now();
  const latestDataTimestamp = [input.latestInlineDataTimestamp, input.domVisibleTimestamp]
    .filter((value): value is number => typeof value === 'number')
    .sort((left, right) => right - left)[0] ?? null;
  if (latestDataTimestamp !== null && now - latestDataTimestamp <= input.freshWindowMs) {
    return 'fresh';
  }
  const recentSignals = [input.latestNetworkTimestamp, input.lastMutationAt]
    .filter((value): value is number => typeof value === 'number')
    .some((value) => now - value <= input.freshWindowMs);
  if (recentSignals && latestDataTimestamp !== null && now - latestDataTimestamp > input.freshWindowMs) {
    return 'lagged';
  }
  const staleSignals = [input.latestNetworkTimestamp, input.lastMutationAt, latestDataTimestamp]
    .filter((value): value is number => typeof value === 'number');
  if (staleSignals.length > 0 && staleSignals.every((value) => now - value > input.staleWindowMs)) {
    return 'stale';
  }
  return 'unknown';
}

async function collectPageInspection(tabId: number, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return (await forwardContentRpc(tabId, 'bak.internal.inspectState', params)) as Record<string, unknown>;
}

async function buildFreshnessForTab(tabId: number, params: Record<string, unknown> = {}): Promise<PageFreshnessResult> {
  const inspection = await collectPageInspection(tabId, params);
  const visibleTimestamps = Array.isArray(inspection.visibleTimestamps) ? inspection.visibleTimestamps.map(String) : [];
  const inlineTimestamps = Array.isArray(inspection.inlineTimestamps) ? inspection.inlineTimestamps.map(String) : [];
  const now = Date.now();
  const freshWindowMs = typeof params.freshWindowMs === 'number' ? Math.max(1, Math.floor(params.freshWindowMs)) : 15 * 60 * 1000;
  const staleWindowMs = typeof params.staleWindowMs === 'number' ? Math.max(freshWindowMs, Math.floor(params.staleWindowMs)) : 24 * 60 * 60 * 1000;
  const latestInlineDataTimestamp = extractLatestTimestamp(inlineTimestamps, now);
  const domVisibleTimestamp = extractLatestTimestamp(visibleTimestamps, now);
  const latestNetworkTs = latestNetworkTimestamp(tabId);
  const lastMutationAt = typeof inspection.lastMutationAt === 'number' ? inspection.lastMutationAt : null;
  return {
    pageLoadedAt: typeof inspection.pageLoadedAt === 'number' ? inspection.pageLoadedAt : null,
    lastMutationAt,
    latestNetworkTimestamp: latestNetworkTs,
    latestInlineDataTimestamp,
    domVisibleTimestamp,
    assessment: computeFreshnessAssessment({
      latestInlineDataTimestamp,
      latestNetworkTimestamp: latestNetworkTs,
      domVisibleTimestamp,
      lastMutationAt,
      freshWindowMs,
      staleWindowMs
    }),
    evidence: {
      visibleTimestamps,
      inlineTimestamps,
      networkSampleIds: recentNetworkSampleIds(tabId)
    }
  };
}

async function handleRequest(request: CliRequest): Promise<unknown> {
  const params = request.params ?? {};
  const target = {
    tabId: typeof params.tabId === 'number' ? params.tabId : undefined,
    workspaceId: typeof params.workspaceId === 'string' ? params.workspaceId : undefined
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
    case 'workspace.ensure': {
      return preserveHumanFocus(params.focus !== true, async () => {
        const result = await bindingManager.ensureWorkspace({
          workspaceId: String(params.workspaceId ?? ''),
          focus: params.focus === true,
          initialUrl: typeof params.url === 'string' ? params.url : undefined
        });
        for (const tab of result.workspace.tabs) {
          void ensureNetworkDebugger(tab.id).catch(() => undefined);
        }
        return result;
      });
    }
    case 'workspace.info': {
      return {
        workspace: await bindingManager.getWorkspaceInfo(String(params.workspaceId ?? ''))
      };
    }
    case 'workspace.openTab': {
      const expectedUrl = typeof params.url === 'string' ? params.url : undefined;
      const opened = await preserveHumanFocus(params.focus !== true, async () => {
        return await bindingManager.openTab({
          workspaceId: String(params.workspaceId ?? ''),
          url: expectedUrl,
          active: params.active === true,
          focus: params.focus === true
        });
      });
      const finalized = await finalizeOpenedWorkspaceTab(opened, expectedUrl);
      void ensureNetworkDebugger(finalized.tab.id).catch(() => undefined);
      return finalized;
    }
    case 'workspace.listTabs': {
      return await bindingManager.listTabs(String(params.workspaceId ?? ''));
    }
    case 'workspace.getActiveTab': {
      return await bindingManager.getActiveTab(String(params.workspaceId ?? ''));
    }
    case 'workspace.setActiveTab': {
      const result = await bindingManager.setActiveTab(Number(params.tabId), String(params.workspaceId ?? ''));
      void ensureNetworkDebugger(result.tab.id).catch(() => undefined);
      return result;
    }
    case 'workspace.focus': {
      return await bindingManager.focus(String(params.workspaceId ?? ''));
    }
    case 'workspace.reset': {
      return await preserveHumanFocus(params.focus !== true, async () => {
        return await bindingManager.reset({
          workspaceId: String(params.workspaceId ?? ''),
          focus: params.focus === true,
          initialUrl: typeof params.url === 'string' ? params.url : undefined
        });
      });
    }
    case 'workspace.close': {
      return await bindingManager.close(String(params.workspaceId ?? ''));
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
        return first;
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
        const network = listNetworkEntries(tab.id!, { limit: 10 });
        return {
          suspiciousGlobals: inspection.suspiciousGlobals ?? [],
          tables: inspection.tables ?? [],
          visibleTimestamps: inspection.visibleTimestamps ?? [],
          inlineTimestamps: inspection.inlineTimestamps ?? [],
          recentNetwork: network,
          recommendedNextSteps: [
            'bak page extract --path table_data',
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
            typeof freshness.latestNetworkTimestamp === 'number' && typeof freshness.latestInlineDataTimestamp === 'number'
              ? Math.max(0, freshness.latestNetworkTimestamp - freshness.latestInlineDataTimestamp)
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
  void listWorkspaceStates().then(async (states) => {
    for (const state of states) {
      if (!state.tabIds.includes(tabId)) {
        continue;
      }
      const nextTabIds = state.tabIds.filter((id) => id !== tabId);
      await saveWorkspaceState({
        ...state,
        tabIds: nextTabIds,
        activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
        primaryTabId: state.primaryTabId === tabId ? null : state.primaryTabId
      });
    }
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void listWorkspaceStates().then(async (states) => {
    for (const state of states) {
      if (state.windowId !== activeInfo.windowId || !state.tabIds.includes(activeInfo.tabId)) {
        continue;
      }
      await saveWorkspaceState({
        ...state,
        activeTabId: activeInfo.tabId
      });
    }
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void listWorkspaceStates().then(async (states) => {
    for (const state of states) {
      if (state.windowId !== windowId) {
        continue;
      }
      await saveWorkspaceState({
        ...state,
        windowId: null,
        groupId: null,
        tabIds: [],
        activeTabId: null,
        primaryTabId: null
      });
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


