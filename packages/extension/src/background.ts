import type { ConsoleEntry, Locator } from '@flrande/bak-protocol';
import { isSupportedAutomationUrl } from './url-policy.js';
import { computeReconnectDelayMs } from './reconnect.js';
import {
  DEFAULT_WORKSPACE_ID,
  type WorkspaceBrowser,
  type WorkspaceColor,
  type WorkspaceRecord,
  type WorkspaceTab,
  type WorkspaceWindow,
  WorkspaceManager
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
const STORAGE_KEY_WORKSPACE = 'agentWorkspace';
const DEFAULT_TAB_LOAD_TIMEOUT_MS = 40_000;

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
  if (lower.includes('invalid url') || lower.includes('url is invalid')) {
    return toError('E_INVALID_PARAMS', message);
  }
  if (lower.includes('cannot access contents of url') || lower.includes('permission denied')) {
    return toError('E_PERMISSION', message);
  }

  return toError('E_INTERNAL', message);
}

function toTabInfo(tab: chrome.tabs.Tab): WorkspaceTab {
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

async function loadWorkspaceState(): Promise<WorkspaceRecord | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_WORKSPACE);
  const state = stored[STORAGE_KEY_WORKSPACE];
  if (!state || typeof state !== 'object') {
    return null;
  }
  return state as WorkspaceRecord;
}

async function saveWorkspaceState(state: WorkspaceRecord | null): Promise<void> {
  if (state === null) {
    await chrome.storage.local.remove(STORAGE_KEY_WORKSPACE);
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEY_WORKSPACE]: state });
}

const workspaceBrowser: WorkspaceBrowser = {
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
      } satisfies WorkspaceWindow;
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
        color: group.color as WorkspaceColor,
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
      color: updated.color as WorkspaceColor,
      collapsed: Boolean(updated.collapsed)
    };
  }
};

const workspaceManager = new WorkspaceManager(
  {
    load: loadWorkspaceState,
    save: saveWorkspaceState
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
  opened: Awaited<ReturnType<WorkspaceManager['openTab']>>,
  expectedUrl?: string
): Promise<Awaited<ReturnType<WorkspaceManager['openTab']>>> {
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
  const refreshedWorkspace = (await workspaceManager.getWorkspaceInfo(opened.workspace.id)) ?? {
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

  const resolved = await workspaceManager.resolveTarget({
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
    'context.enterFrame',
    'context.exitFrame',
    'context.enterShadow',
    'context.exitShadow',
    'context.reset',
    'network.list',
    'network.get',
    'network.waitFor',
    'network.clear',
    'debug.dumpState'
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
      if (typeof params.workspaceId === 'string' || params.windowId === undefined) {
        const expectedUrl = (params.url as string | undefined) ?? 'about:blank';
        const opened = await preserveHumanFocus(true, async () => {
          return await workspaceManager.openTab({
            workspaceId: typeof params.workspaceId === 'string' ? params.workspaceId : DEFAULT_WORKSPACE_ID,
            url: expectedUrl,
            active: params.active === true,
            focus: false
          });
        });
        const stabilized = await finalizeOpenedWorkspaceTab(opened, expectedUrl);
        return {
          tabId: stabilized.tab.id,
          windowId: stabilized.tab.windowId,
          groupId: stabilized.workspace.groupId,
          workspaceId: stabilized.workspace.id
        };
      }
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
        return await workspaceManager.ensureWorkspace({
          workspaceId: typeof params.workspaceId === 'string' ? params.workspaceId : undefined,
          focus: params.focus === true,
          initialUrl: typeof params.url === 'string' ? params.url : undefined
        });
      });
    }
    case 'workspace.info': {
      return {
        workspace: await workspaceManager.getWorkspaceInfo(typeof params.workspaceId === 'string' ? params.workspaceId : undefined)
      };
    }
    case 'workspace.openTab': {
      const expectedUrl = typeof params.url === 'string' ? params.url : undefined;
      const opened = await preserveHumanFocus(params.focus !== true, async () => {
        return await workspaceManager.openTab({
          workspaceId: typeof params.workspaceId === 'string' ? params.workspaceId : undefined,
          url: expectedUrl,
          active: params.active === true,
          focus: params.focus === true
        });
      });
      return await finalizeOpenedWorkspaceTab(opened, expectedUrl);
    }
    case 'workspace.listTabs': {
      return await workspaceManager.listTabs(typeof params.workspaceId === 'string' ? params.workspaceId : undefined);
    }
    case 'workspace.getActiveTab': {
      return await workspaceManager.getActiveTab(typeof params.workspaceId === 'string' ? params.workspaceId : undefined);
    }
    case 'workspace.setActiveTab': {
      return await workspaceManager.setActiveTab(Number(params.tabId), typeof params.workspaceId === 'string' ? params.workspaceId : undefined);
    }
    case 'workspace.focus': {
      return await workspaceManager.focus(typeof params.workspaceId === 'string' ? params.workspaceId : undefined);
    }
    case 'workspace.reset': {
      return await preserveHumanFocus(params.focus !== true, async () => {
        return await workspaceManager.reset({
          workspaceId: typeof params.workspaceId === 'string' ? params.workspaceId : undefined,
          focus: params.focus === true,
          initialUrl: typeof params.url === 'string' ? params.url : undefined
        });
      });
    }
    case 'workspace.close': {
      return await workspaceManager.close(typeof params.workspaceId === 'string' ? params.workspaceId : undefined);
    }
    case 'page.goto': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target, {
          requireSupportedAutomationUrl: false
        });
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
        await chrome.tabs.goBack(tab.id!);
        await waitForTabComplete(tab.id!);
        return { ok: true };
      });
    }
    case 'page.forward': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
        await chrome.tabs.goForward(tab.id!);
        await waitForTabComplete(tab.id!);
        return { ok: true };
      });
    }
    case 'page.reload': {
      return await preserveHumanFocus(typeof target.tabId !== 'number', async () => {
        const tab = await withTab(target);
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
      version: '0.1.0',
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
  void loadWorkspaceState().then(async (state) => {
    if (!state || !state.tabIds.includes(tabId)) {
      return;
    }
    const nextTabIds = state.tabIds.filter((id) => id !== tabId);
    await saveWorkspaceState({
      ...state,
      tabIds: nextTabIds,
      activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
      primaryTabId: state.primaryTabId === tabId ? null : state.primaryTabId
    });
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void loadWorkspaceState().then(async (state) => {
    if (!state || state.windowId !== activeInfo.windowId || !state.tabIds.includes(activeInfo.tabId)) {
      return;
    }
    await saveWorkspaceState({
      ...state,
      activeTabId: activeInfo.tabId
    });
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void loadWorkspaceState().then(async (state) => {
    if (!state || state.windowId !== windowId) {
      return;
    }
    await saveWorkspaceState({
      ...state,
      windowId: null,
      groupId: null,
      tabIds: [],
      activeTabId: null,
      primaryTabId: null
    });
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


