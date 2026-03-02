import type { ConsoleEntry, Locator } from '@bak/protocol';
import { isSupportedAutomationUrl } from './url-policy.js';
import { computeReconnectDelayMs } from './reconnect.js';

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

async function waitForTabComplete(tabId: number, timeoutMs = 12_000): Promise<void> {
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
    const finish = (error?: Error): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
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

    const timer = setTimeout(() => {
      finish(new Error(`tab load timeout: ${tabId}`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

interface WithTabOptions {
  requireSupportedAutomationUrl?: boolean;
}

async function withTab(tabId?: number, options: WithTabOptions = {}): Promise<chrome.tabs.Tab> {
  const requireSupportedAutomationUrl = options.requireSupportedAutomationUrl !== false;
  const validate = (tab: chrome.tabs.Tab): chrome.tabs.Tab => {
    if (!tab.id) {
      throw toError('E_NOT_FOUND', 'Tab missing id');
    }
    if (requireSupportedAutomationUrl && !isSupportedAutomationUrl(tab.url)) {
      throw toError('E_PERMISSION', 'Unsupported tab URL: only http/https pages can be automated', {
        url: tab.url ?? ''
      });
    }
    return tab;
  };

  if (typeof tabId === 'number') {
    const tab = await chrome.tabs.get(tabId);
    return validate(tab);
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab) {
    throw toError('E_NOT_FOUND', 'No active tab');
  }
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
  const maxAttempts = 6;
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
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }

  throw toError('E_NOT_READY', 'Content script unavailable');
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
          .filter((tab) => typeof tab.id === 'number')
          .map((tab) => ({
            id: tab.id as number,
            title: tab.title ?? '',
            url: tab.url ?? '',
            active: tab.active
          }))
      };
    }
    case 'tabs.getActive': {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab || typeof tab.id !== 'number') {
        return { tab: null };
      }
      return {
        tab: {
          id: tab.id,
          title: tab.title ?? '',
          url: tab.url ?? '',
          active: Boolean(tab.active)
        }
      };
    }
    case 'tabs.get': {
      const tabId = Number(params.tabId);
      const tab = await chrome.tabs.get(tabId);
      if (typeof tab.id !== 'number') {
        throw toError('E_NOT_FOUND', 'Tab missing id');
      }
      return {
        tab: {
          id: tab.id,
          title: tab.title ?? '',
          url: tab.url ?? '',
          active: Boolean(tab.active)
        }
      };
    }
    case 'tabs.focus': {
      const tabId = Number(params.tabId);
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    case 'tabs.new': {
      const tab = await chrome.tabs.create({ url: (params.url as string | undefined) ?? 'about:blank' });
      return { tabId: tab.id };
    }
    case 'tabs.close': {
      const tabId = Number(params.tabId);
      await chrome.tabs.remove(tabId);
      return { ok: true };
    }
    case 'page.goto': {
      const tab = await withTab(params.tabId as number | undefined, {
        requireSupportedAutomationUrl: false
      });
      await chrome.tabs.update(tab.id!, { url: String(params.url ?? 'about:blank') });
      await waitForTabComplete(tab.id!);
      return { ok: true };
    }
    case 'page.back': {
      const tab = await withTab(params.tabId as number | undefined);
      await chrome.tabs.goBack(tab.id!);
      await waitForTabComplete(tab.id!);
      return { ok: true };
    }
    case 'page.forward': {
      const tab = await withTab(params.tabId as number | undefined);
      await chrome.tabs.goForward(tab.id!);
      await waitForTabComplete(tab.id!);
      return { ok: true };
    }
    case 'page.reload': {
      const tab = await withTab(params.tabId as number | undefined);
      await chrome.tabs.reload(tab.id!);
      await waitForTabComplete(tab.id!);
      return { ok: true };
    }
    case 'page.viewport': {
      const tab = await withTab(params.tabId as number | undefined, {
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
    }
    case 'page.snapshot': {
      const tab = await withTab(params.tabId as number | undefined);
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
    }
    case 'element.click': {
      const tab = await withTab(params.tabId as number | undefined);
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
    }
    case 'element.type': {
      const tab = await withTab(params.tabId as number | undefined);
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
    }
    case 'element.scroll': {
      const tab = await withTab(params.tabId as number | undefined);
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
    }
    case 'page.wait': {
      const tab = await withTab(params.tabId as number | undefined);
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
    }
    case 'debug.getConsole': {
      const tab = await withTab(params.tabId as number | undefined);
      const response = await sendToContent<{ entries: ConsoleEntry[] }>(tab.id!, {
        type: 'bak.getConsole',
        limit: Number(params.limit ?? 50)
      });
      return { entries: response.entries };
    }
    case 'ui.selectCandidate': {
      const tab = await withTab(params.tabId as number | undefined);
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
    }
    default:
      if (rpcForwardMethods.has(request.method)) {
        const tab = await withTab(params.tabId as number | undefined);
        return forwardContentRpc(tab.id!, request.method, params);
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
