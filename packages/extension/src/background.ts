import type { ConsoleEntry, Locator } from '@bak/protocol';
import { isSupportedAutomationUrl } from './url-policy.js';

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

const DEFAULT_PORT = 17373;
const STORAGE_KEY_TOKEN = 'pairToken';
const STORAGE_KEY_PORT = 'cliPort';
const STORAGE_KEY_DEBUG_RICH_TEXT = 'debugRichText';

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let lastError: string | null = null;

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

function sendResponse(payload: CliResponse): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function toError(code: string, message: string, data?: Record<string, unknown>): CliResponse['error'] {
  return { code, message, data };
}

async function withTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const validate = (tab: chrome.tabs.Tab): chrome.tabs.Tab => {
    if (!tab.id) {
      throw toError('E_NOT_FOUND', 'Tab missing id');
    }
    if (!isSupportedAutomationUrl(tab.url)) {
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

async function sendToContent<TResponse>(tabId: number, message: Record<string, unknown>): Promise<TResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as TResponse;
  } catch (error) {
    throw toError('E_NOT_READY', 'Content script unavailable', {
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleRequest(request: CliRequest): Promise<unknown> {
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
    case 'tabs.focus': {
      const tabId = Number(request.params?.tabId);
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    case 'tabs.new': {
      const tab = await chrome.tabs.create({ url: (request.params?.url as string | undefined) ?? 'about:blank' });
      return { tabId: tab.id };
    }
    case 'tabs.close': {
      const tabId = Number(request.params?.tabId);
      await chrome.tabs.remove(tabId);
      return { ok: true };
    }
    case 'page.goto': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      await chrome.tabs.update(tab.id!, { url: String(request.params?.url ?? 'about:blank') });
      return { ok: true };
    }
    case 'page.back': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      await chrome.tabs.goBack(tab.id!);
      return { ok: true };
    }
    case 'page.forward': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      await chrome.tabs.goForward(tab.id!);
      return { ok: true };
    }
    case 'page.reload': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      await chrome.tabs.reload(tab.id!);
      return { ok: true };
    }
    case 'page.snapshot': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      if (!tab.id || !tab.windowId) {
        throw toError('E_NOT_FOUND', 'Tab missing id');
      }
      const config = await getConfig();
      const elements = await sendToContent<{ elements: unknown[] }>(tab.id, {
        type: 'bak.collectElements',
        debugRichText: config.debugRichText
      });
      const imageData = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return {
        imageBase64: imageData.replace(/^data:image\/png;base64,/, ''),
        elements: elements.elements,
        tabId: tab.id,
        url: tab.url ?? ''
      };
    }
    case 'element.click': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
        type: 'bak.performAction',
        action: 'click',
        locator: request.params?.locator as Locator,
        requiresConfirm: request.params?.requiresConfirm === true
      });
      if (!response.ok) {
        throw response.error ?? toError('E_INTERNAL', 'element.click failed');
      }
      return { ok: true };
    }
    case 'element.type': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
        type: 'bak.performAction',
        action: 'type',
        locator: request.params?.locator as Locator,
        text: String(request.params?.text ?? ''),
        clear: Boolean(request.params?.clear),
        requiresConfirm: request.params?.requiresConfirm === true
      });
      if (!response.ok) {
        throw response.error ?? toError('E_INTERNAL', 'element.type failed');
      }
      return { ok: true };
    }
    case 'element.scroll': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
        type: 'bak.performAction',
        action: 'scroll',
        locator: request.params?.locator as Locator,
        dx: Number(request.params?.dx ?? 0),
        dy: Number(request.params?.dy ?? 320)
      });
      if (!response.ok) {
        throw response.error ?? toError('E_INTERNAL', 'element.scroll failed');
      }
      return { ok: true };
    }
    case 'page.wait': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      const response = await sendToContent<{ ok: boolean; error?: CliResponse['error'] }>(tab.id!, {
        type: 'bak.waitFor',
        mode: String(request.params?.mode ?? 'selector'),
        value: String(request.params?.value ?? ''),
        timeoutMs: Number(request.params?.timeoutMs ?? 5000)
      });
      if (!response.ok) {
        throw response.error ?? toError('E_TIMEOUT', 'page.wait failed');
      }
      return { ok: true };
    }
    case 'debug.getConsole': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      const response = await sendToContent<{ entries: ConsoleEntry[] }>(tab.id!, {
        type: 'bak.getConsole',
        limit: Number(request.params?.limit ?? 50)
      });
      return { entries: response.entries };
    }
    case 'ui.selectCandidate': {
      const tab = await withTab(request.params?.tabId as number | undefined);
      const response = await sendToContent<{ ok: boolean; selectedEid?: string; error?: CliResponse['error'] }>(
        tab.id!,
        {
          type: 'bak.selectCandidate',
          candidates: request.params?.candidates
        }
      );
      if (!response.ok || !response.selectedEid) {
        throw response.error ?? toError('E_PERMISSION', 'User did not confirm candidate');
      }
      return { selectedEid: response.selectedEid };
    }
    default:
      throw toError('E_NOT_FOUND', `Unsupported method from CLI bridge: ${request.method}`);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(() => {
    void connectWebSocket();
  }, 1500) as unknown as number;
}

async function connectWebSocket(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const config = await getConfig();
  if (!config.token) {
    lastError = 'Pair token is empty';
    return;
  }

  const url = `ws://127.0.0.1:${config.port}/extension?token=${encodeURIComponent(config.token)}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
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
          const normalized =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as CliResponse['error'])
              : toError('E_INTERNAL', error instanceof Error ? error.message : String(error));
          sendResponse({ id: request.id, ok: false, error: normalized });
        });
    } catch (error) {
      sendResponse({
        id: 'parse-error',
        ok: false,
        error: toError('E_INTERNAL', error instanceof Error ? error.message : String(error))
      });
    }
  });

  ws.addEventListener('close', () => {
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    lastError = 'Cannot connect to bak cli';
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
        lastError
      });
    });
    return true;
  }

  if (message?.type === 'bak.disconnect') {
    ws?.close();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
