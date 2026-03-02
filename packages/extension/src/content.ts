import type {
  AccessibilityNode,
  ConsoleEntry,
  ElementMapItem,
  Locator,
  NetworkEntry,
  PageDomSummary,
  PageMetrics,
  PageTextChunk
} from '@flrande/bak-protocol';
import { inferSafeName, redactElementText, type RedactTextOptions } from './privacy.js';
import { unsupportedLocatorHint } from './limitations.js';

type ActionName =
  | 'click'
  | 'type'
  | 'scroll'
  | 'hover'
  | 'doubleClick'
  | 'rightClick'
  | 'dragDrop'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'scrollIntoView'
  | 'focus'
  | 'blur';

interface ActionMessage {
  type: 'bak.performAction';
  action: ActionName;
  locator?: Locator;
  from?: Locator;
  to?: Locator;
  text?: string;
  clear?: boolean;
  requiresConfirm?: boolean;
  dx?: number;
  dy?: number;
  values?: string[];
}

interface WaitMessage {
  type: 'bak.waitFor';
  mode: 'selector' | 'text' | 'url';
  value: string;
  timeoutMs?: number;
}

interface CandidateMessage {
  type: 'bak.selectCandidate';
  candidates: ElementMapItem[];
}

interface CollectElementsMessage {
  type: 'bak.collectElements';
  debugRichText?: boolean;
}

interface RpcMessage {
  type: 'bak.rpc';
  method: string;
  params?: Record<string, unknown>;
}

interface ActionError {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

type ActionResult = { ok: true } | { ok: false; error: ActionError };
type ActionAssessment = { ok: true; point: { x: number; y: number } } | { ok: false; error: ActionError };
type RpcEnvelope = { ok: true; result: unknown } | { ok: false; error: ActionError };

const consoleEntries: ConsoleEntry[] = [];
const networkEntries: NetworkEntry[] = [];
const elementCache = new Map<string, HTMLElement>();
const contextState = {
  framePath: [] as string[],
  shadowPath: [] as string[]
};

let networkSequence = 0;
let longTaskCount = 0;
let longTaskDurationMs = 0;
let performanceBaselineMs = 0;

function isHtmlElement(node: Element | null): node is HTMLElement {
  if (!node) {
    return false;
  }
  const view = node.ownerDocument.defaultView;
  return Boolean(view && node instanceof view.HTMLElement);
}

function isInputElement(element: Element): element is HTMLInputElement {
  const view = element.ownerDocument.defaultView;
  return Boolean(view && element instanceof view.HTMLInputElement);
}

function isTextAreaElement(element: Element): element is HTMLTextAreaElement {
  const view = element.ownerDocument.defaultView;
  return Boolean(view && element instanceof view.HTMLTextAreaElement);
}

function isFrameElement(element: Element): element is HTMLIFrameElement | HTMLFrameElement {
  const view = element.ownerDocument.defaultView as
    | (Window & typeof globalThis & { HTMLFrameElement?: typeof HTMLFrameElement })
    | null;
  if (!view) {
    return false;
  }
  const iframeMatch = element instanceof view.HTMLIFrameElement;
  const frameCtor = view.HTMLFrameElement;
  const frameMatch = typeof frameCtor === 'function' ? element instanceof frameCtor : false;
  return iframeMatch || frameMatch;
}

function pushConsole(level: ConsoleEntry['level'], message: string, source?: string): void {
  consoleEntries.push({
    level,
    message,
    source,
    ts: Date.now()
  });
  if (consoleEntries.length > 1000) {
    consoleEntries.shift();
  }
}

function patchConsoleCapture(): void {
  const methods: Array<{ method: 'log' | 'debug' | 'info' | 'warn' | 'error'; level: ConsoleEntry['level'] }> = [
    { method: 'log', level: 'log' },
    { method: 'debug', level: 'debug' },
    { method: 'info', level: 'info' },
    { method: 'warn', level: 'warn' },
    { method: 'error', level: 'error' }
  ];

  for (const entry of methods) {
    const original = console[entry.method] as (...args: unknown[]) => void;
    (console as unknown as Record<string, (...args: unknown[]) => void>)[entry.method] = (...args: unknown[]) => {
      const message = args
        .map((item) => {
          if (item instanceof Error) {
            return item.message;
          }
          if (typeof item === 'string') {
            return item;
          }
          try {
            return JSON.stringify(item);
          } catch {
            return String(item);
          }
        })
        .join(' ');
      pushConsole(entry.level, message, 'isolated');
      original.apply(console, args);
    };
  }

  window.addEventListener('bak:console', (event: Event) => {
    const detail = (event as CustomEvent<{ level?: ConsoleEntry['level']; message?: string; source?: string; ts?: number }>).detail;
    if (!detail || typeof detail !== 'object') {
      return;
    }
    const level: ConsoleEntry['level'] =
      detail.level === 'debug' || detail.level === 'info' || detail.level === 'warn' || detail.level === 'error' ? detail.level : 'log';
    const message = typeof detail.message === 'string' ? detail.message : '';
    if (!message) {
      return;
    }
    pushConsole(level, message, detail.source ?? 'page');
  });

  try {
    const injector = document.createElement('script');
    injector.textContent = `
(() => {
  const g = window;
  if (g.__bakPageConsolePatched) return;
  g.__bakPageConsolePatched = true;
  const emit = (level, message, source) =>
    window.dispatchEvent(new CustomEvent('bak:console', { detail: { level, message, source, ts: Date.now() } }));
  const serialize = (value) => {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  ['log', 'debug', 'info', 'warn', 'error'].forEach((method) => {
    const original = console[method];
    console[method] = (...args) => {
      emit(method, args.map(serialize).join(' '), 'page');
      return original.apply(console, args);
    };
  });
  window.addEventListener('error', (event) => {
    emit('error', event.message || 'error event', event.filename || 'page');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    emit('error', 'unhandledrejection: ' + reason, 'page');
  });
})();
`;
    (document.documentElement ?? document.head ?? document.body).appendChild(injector);
    injector.remove();
  } catch {
    // Keep isolated-world capture if page-world injection is blocked.
  }

  window.addEventListener('error', (event) => {
    pushConsole('error', event.message, event.filename);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    pushConsole('error', `unhandledrejection: ${reason}`);
  });
}

function pushNetwork(entry: NetworkEntry): void {
  networkEntries.push(entry);
  if (networkEntries.length > 1000) {
    networkEntries.shift();
  }
}

function patchNetworkCapture(): void {
  window.addEventListener('bak:network', (event: Event) => {
    const detail = (event as CustomEvent<NetworkEntry>).detail;
    if (!detail || typeof detail !== 'object') {
      return;
    }
    pushNetwork({
      id: typeof detail.id === 'string' ? detail.id : `net_${Date.now()}_${networkSequence++}`,
      kind: detail.kind === 'xhr' ? 'xhr' : 'fetch',
      method: typeof detail.method === 'string' ? detail.method : 'GET',
      url: typeof detail.url === 'string' ? detail.url : window.location.href,
      status: typeof detail.status === 'number' ? detail.status : 0,
      ok: detail.ok === true,
      ts: typeof detail.ts === 'number' ? detail.ts : Date.now(),
      durationMs: typeof detail.durationMs === 'number' ? detail.durationMs : 0,
      requestBytes: typeof detail.requestBytes === 'number' ? detail.requestBytes : undefined,
      responseBytes: typeof detail.responseBytes === 'number' ? detail.responseBytes : undefined
    });
  });

  try {
    const injector = document.createElement('script');
    injector.textContent = `
(() => {
  const g = window;
  if (g.__bakPageNetworkPatched) return;
  g.__bakPageNetworkPatched = true;
  let seq = 0;
  const emit = (entry) => window.dispatchEvent(new CustomEvent('bak:network', { detail: entry }));
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init && init.method ? init.method : 'GET').toUpperCase();
    const started = performance.now();
    const requestBytes =
      init && typeof init.body === 'string'
        ? init.body.length
        : init && init.body instanceof URLSearchParams
          ? init.body.toString().length
          : undefined;
    try {
      const response = await nativeFetch(input, init);
      emit({
        id: 'net_' + Date.now() + '_' + seq++,
        kind: 'fetch',
        method,
        url,
        status: response.status,
        ok: response.ok,
        ts: Date.now(),
        durationMs: Math.max(0, performance.now() - started),
        requestBytes,
        responseBytes: Number(response.headers.get('content-length') || '0') || undefined
      });
      return response;
    } catch (error) {
      emit({
        id: 'net_' + Date.now() + '_' + seq++,
        kind: 'fetch',
        method,
        url,
        status: 0,
        ok: false,
        ts: Date.now(),
        durationMs: Math.max(0, performance.now() - started),
        requestBytes
      });
      throw error;
    }
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__bakMeta = {
      method: String(method || 'GET').toUpperCase(),
      url: typeof url === 'string' ? url : String(url),
      started: performance.now()
    };
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (typeof body === 'string') {
      this.__bakMeta = { ...(this.__bakMeta || {}), requestBytes: body.length };
    }
    this.addEventListener('loadend', () => {
      const meta = this.__bakMeta || {};
      emit({
        id: 'net_' + Date.now() + '_' + seq++,
        kind: 'xhr',
        method: meta.method || 'GET',
        url: meta.url || window.location.href,
        status: Number(this.status) || 0,
        ok: Number(this.status) >= 200 && Number(this.status) < 400,
        ts: Date.now(),
        durationMs: Math.max(0, performance.now() - (meta.started || performance.now())),
        requestBytes: typeof meta.requestBytes === 'number' ? meta.requestBytes : undefined
      });
    }, { once: true });
    return xhrSend.call(this, body ?? null);
  };
})();
`;
    (document.documentElement ?? document.head ?? document.body).appendChild(injector);
    injector.remove();
  } catch {
    // Ignore injection failures and keep isolated-world network patch as fallback.
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const started = performance.now();
    const requestBytes =
      typeof init?.body === 'string'
        ? init.body.length
        : init?.body instanceof URLSearchParams
          ? init.body.toString().length
          : undefined;
    try {
      const response = await originalFetch(input, init);
      const durationMs = Math.max(0, performance.now() - started);
      pushNetwork({
        id: `net_${Date.now()}_${networkSequence++}`,
        kind: 'fetch',
        method,
        url,
        status: response.status,
        ok: response.ok,
        ts: Date.now(),
        durationMs,
        requestBytes,
        responseBytes: Number(response.headers.get('content-length') ?? '0') || undefined
      });
      return response;
    } catch (error) {
      const durationMs = Math.max(0, performance.now() - started);
      pushNetwork({
        id: `net_${Date.now()}_${networkSequence++}`,
        kind: 'fetch',
        method,
        url,
        status: 0,
        ok: false,
        ts: Date.now(),
        durationMs,
        requestBytes
      });
      throw error;
    }
  }) as typeof window.fetch;

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(method: string, url: string | URL, ...rest: unknown[]) {
    const self = this as XMLHttpRequest & {
      __bakMeta?: {
        method: string;
        url: string;
        started: number;
        requestBytes?: number;
      };
    };
    self.__bakMeta = {
      method: method.toUpperCase(),
      url: typeof url === 'string' ? url : url.toString(),
      started: performance.now()
    };

    return (xhrOpen as (...args: unknown[]) => unknown).call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
    const self = this as XMLHttpRequest & {
      __bakMeta?: {
        method: string;
        url: string;
        started: number;
        requestBytes?: number;
      };
    };

    if (typeof body === 'string') {
      const current = self.__bakMeta ?? {
        method: 'GET',
        url: window.location.href,
        started: performance.now()
      };
      self.__bakMeta = {
        ...current,
        requestBytes: body.length
      };
    }

    self.addEventListener(
      'loadend',
      () => {
        pushNetwork({
          id: `net_${Date.now()}_${networkSequence++}`,
          kind: 'xhr',
          method: self.__bakMeta?.method ?? 'GET',
          url: self.__bakMeta?.url ?? window.location.href,
          status: self.status,
          ok: self.status >= 200 && self.status < 400,
          ts: Date.now(),
          durationMs: Math.max(0, performance.now() - (self.__bakMeta?.started ?? performance.now())),
          requestBytes: self.__bakMeta?.requestBytes
        });
      },
      { once: true }
    );

    return xhrSend.call(this, body ?? null);
  };
}

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskDurationMs += entry.duration;
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // ignore browser without longtask support
  }
}

patchConsoleCapture();
patchNetworkCapture();

const unsafeKeywords = /(submit|delete|remove|send|upload|付款|支付|删除|提交|发送|上传)/i;

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function inferRole(element: HTMLElement): string {
  if (element.getAttribute('role')) {
    return element.getAttribute('role') ?? 'generic';
  }
  switch (element.tagName.toLowerCase()) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'input': {
      const type = (element as HTMLInputElement).type;
      if (type === 'checkbox') {
        return 'checkbox';
      }
      if (type === 'radio') {
        return 'radio';
      }
      return 'textbox';
    }
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    default:
      return 'generic';
  }
}

function labelledByText(element: HTMLElement): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (!labelledBy) {
    return '';
  }
  return labelledBy
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function labelText(element: HTMLElement): string {
  const ownerDocument = element.ownerDocument;
  if (isInputElement(element) && element.id) {
    const explicit = ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (explicit?.textContent) {
      return explicit.textContent.trim();
    }
  }

  const wrapper = element.closest('label');
  return wrapper?.textContent?.trim() ?? '';
}

function inferName(element: HTMLElement, options: RedactTextOptions = {}): string {
  const inputType = isInputElement(element) ? element.type : null;
  return inferSafeName(
    {
      tag: element.tagName,
      role: inferRole(element),
      inputType,
      ariaLabel: element.getAttribute('aria-label'),
      labelledByText: labelledByText(element),
      labelText: labelText(element),
      placeholder: isInputElement(element) || isTextAreaElement(element) ? element.placeholder : '',
      text: element.innerText || element.textContent || '',
      nameAttr: element.getAttribute('name')
    },
    options
  );
}

function isElementVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number.parseFloat(style.opacity || '1') <= 0
  ) {
    return false;
  }

  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

function isInteractive(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) {
    return true;
  }
  if (role && ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox'].includes(role)) {
    return true;
  }
  if (element.hasAttribute('contenteditable')) {
    return true;
  }
  const tabIndex = element.getAttribute('tabindex');
  return tabIndex !== null && Number.parseInt(tabIndex, 10) >= 0;
}

function toCssSelector(element: HTMLElement): string | null {
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const name = element.getAttribute('name');
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }

  const classes = Array.from(element.classList).slice(0, 2);
  if (classes.length > 0) {
    return `${element.tagName.toLowerCase()}.${classes.map((item) => CSS.escape(item)).join('.')}`;
  }

  const parent = element.parentElement;
  if (!parent) {
    return element.tagName.toLowerCase();
  }

  const siblings = Array.from(parent.children).filter(
    (child) => child.tagName.toLowerCase() === element.tagName.toLowerCase()
  );
  const index = siblings.indexOf(element) + 1;
  return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
}

function buildEid(element: HTMLElement): string {
  const rect = element.getBoundingClientRect();
  const quantized = [
    Math.round(rect.x / 10) * 10,
    Math.round(rect.y / 10) * 10,
    Math.round(rect.width / 10) * 10,
    Math.round(rect.height / 10) * 10
  ].join(':');

  const payload = [
    window.location.hostname,
    window.location.pathname,
    inferRole(element),
    inferName(element),
    quantized
  ].join('|');

  return `eid_${fnv1a(payload)}`;
}

function splitShadowSelector(selector: string): string[] {
  return selector
    .split('>>>')
    .map((part) => part.trim())
    .filter(Boolean);
}

function querySelectorInTree(root: ParentNode, selector: string): HTMLElement | null {
  try {
    return root.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

function querySelectorAcrossOpenShadow(root: ParentNode, selector: string): HTMLElement | null {
  const direct = querySelectorInTree(root, selector);
  if (direct) {
    return direct;
  }

  const stack: ParentNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const hosts = Array.from(current.querySelectorAll<HTMLElement>('*')).filter((item) => item.shadowRoot);
    for (const host of hosts) {
      if (!host.shadowRoot) {
        continue;
      }
      const found = querySelectorInTree(host.shadowRoot, selector);
      if (found) {
        return found;
      }
      stack.push(host.shadowRoot);
    }
  }

  return null;
}

function querySelectorAllAcrossOpenShadow(root: ParentNode, selector: string): HTMLElement[] {
  const collected: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  const push = (element: HTMLElement): void => {
    if (seen.has(element)) {
      return;
    }
    seen.add(element);
    collected.push(element);
  };

  try {
    for (const found of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      push(found);
    }
  } catch {
    return [];
  }

  const stack: ParentNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const hosts = Array.from(current.querySelectorAll<HTMLElement>('*')).filter((item) => item.shadowRoot);
    for (const host of hosts) {
      if (!host.shadowRoot) {
        continue;
      }
      try {
        for (const found of Array.from(host.shadowRoot.querySelectorAll<HTMLElement>(selector))) {
          push(found);
        }
      } catch {
        continue;
      }
      stack.push(host.shadowRoot);
    }
  }

  return collected;
}

function resolveFrameDocument(framePath: string[]): { ok: true; document: Document } | { ok: false; error: ActionError } {
  let currentDocument = document;
  for (const selector of framePath) {
    const frame = currentDocument.querySelector(selector);
    if (!frame || !isFrameElement(frame)) {
      return { ok: false, error: { code: 'E_NOT_FOUND', message: `frame not found: ${selector}` } };
    }
    try {
      const childDocument = frame.contentDocument;
      if (!childDocument) {
        return { ok: false, error: { code: 'E_NOT_READY', message: `frame document unavailable: ${selector}` } };
      }
      currentDocument = childDocument;
    } catch {
      return {
        ok: false,
        error: {
          code: 'E_PERMISSION',
          message: `cross-origin frame is not accessible: ${selector}`
        }
      };
    }
  }

  return { ok: true, document: currentDocument };
}

function resolveShadowRoot(base: ParentNode, path: string[]): { ok: true; root: ParentNode } | { ok: false; error: ActionError } {
  let root = base;
  for (const selector of path) {
    const host = querySelectorAcrossOpenShadow(root, selector);
    if (!host) {
      return { ok: false, error: { code: 'E_NOT_FOUND', message: `shadow host not found: ${selector}` } };
    }
    if (!host.shadowRoot) {
      return { ok: false, error: { code: 'E_NOT_READY', message: `shadow root unavailable or closed: ${selector}` } };
    }
    root = host.shadowRoot;
  }
  return { ok: true, root };
}

function resolveRootForLocator(locator?: Locator): { ok: true; root: ParentNode } | { ok: false; error: ActionError } {
  const framePath = [...contextState.framePath, ...(Array.isArray(locator?.framePath) ? locator.framePath : [])];
  const frameResult = resolveFrameDocument(framePath);
  if (!frameResult.ok) {
    return frameResult;
  }

  const shadowPath = [...contextState.shadowPath];
  const shadowResult = resolveShadowRoot(frameResult.document, shadowPath);
  if (!shadowResult.ok) {
    return shadowResult;
  }
  return { ok: true, root: shadowResult.root };
}

function collectElements(options: RedactTextOptions = {}, locator?: Locator): ElementMapItem[] {
  const rootResult = resolveRootForLocator(locator);
  if (!rootResult.ok) {
    return [];
  }

  const root = rootResult.root;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('*'));
  const results: ElementMapItem[] = [];
  elementCache.clear();

  for (const element of nodes) {
    if (!isInteractive(element) || !isElementVisible(element)) {
      continue;
    }

    const rect = element.getBoundingClientRect();
    const name = inferName(element, options);
    const role = inferRole(element);
    const text = redactElementText(element.innerText || element.textContent || '', options);
    const eid = buildEid(element);
    const selectors = {
      css: toCssSelector(element),
      text: text || name ? (text || name).slice(0, 80) : null,
      aria: role && name ? `${role}:${name.slice(0, 80)}` : null
    };

    const combined = `${name} ${text}`;
    const risk = unsafeKeywords.test(combined) || (isInputElement(element) && element.type === 'file') ? 'high' : 'low';

    const item: ElementMapItem = {
      eid,
      tag: element.tagName.toLowerCase(),
      role,
      name,
      text,
      bbox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      selectors,
      risk
    };

    results.push(item);
    elementCache.set(eid, element);
  }

  return results;
}

function getInteractiveElements(root: ParentNode, includeShadow = true): HTMLElement[] {
  const results = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
    (element) => isInteractive(element) && isElementVisible(element)
  );
  if (!includeShadow) {
    return results;
  }

  const queue = [...Array.from(root.querySelectorAll<HTMLElement>('*')).filter((element) => element.shadowRoot)];
  while (queue.length > 0) {
    const host = queue.shift()!;
    if (!host.shadowRoot) {
      continue;
    }

    for (const element of Array.from(host.shadowRoot.querySelectorAll<HTMLElement>('*'))) {
      if (element.shadowRoot) {
        queue.push(element);
      }
      if (isInteractive(element) && isElementVisible(element)) {
        results.push(element);
      }
    }
  }
  return results;
}

function resolveLocator(locator?: Locator): HTMLElement | null {
  if (!locator) {
    return null;
  }

  if (locator.eid) {
    const refreshed = collectElements({}, locator);
    if (refreshed.length > 0) {
      const fromCache = elementCache.get(locator.eid);
      if (fromCache) {
        return fromCache;
      }
    }
  }

  const rootResult = resolveRootForLocator(locator);
  if (!rootResult.ok) {
    return null;
  }
  const root = rootResult.root;
  const interactive = getInteractiveElements(root, locator.shadow !== 'none');

  if (locator.role || locator.name) {
    const role = locator.role?.toLowerCase();
    const name = locator.name?.toLowerCase();
    const matches = interactive.filter((element) => {
      const roleMatch = role ? inferRole(element).toLowerCase() === role : true;
      const nameMatch = name ? inferName(element).toLowerCase().includes(name) : true;
      return roleMatch && nameMatch;
    });
    const found = indexedCandidate(matches, locator);
    if (found) {
      return found;
    }
  }

  if (locator.text) {
    const needle = locator.text.toLowerCase();
    const matches = interactive.filter((element) => {
      const text = (element.innerText || element.textContent || '').toLowerCase();
      return text.includes(needle);
    });
    const found = indexedCandidate(matches, locator);
    if (found) {
      return found;
    }
  }

  if (locator.css) {
    const parts = splitShadowSelector(locator.css);
    let currentRoot: ParentNode = root;
    for (let index = 0; index < parts.length; index += 1) {
      const selector = parts[index];
      const found =
        locator.shadow === 'none'
          ? querySelectorInTree(currentRoot, selector)
          : querySelectorAcrossOpenShadow(currentRoot, selector);
      if (!found) {
        return null;
      }
      if (index === parts.length - 1) {
        let matches: HTMLElement[] = [];
        if (locator.shadow === 'none') {
          try {
            matches = Array.from(currentRoot.querySelectorAll<HTMLElement>(selector));
          } catch {
            matches = [];
          }
        } else {
          matches = querySelectorAllAcrossOpenShadow(currentRoot, selector);
        }
        const visibleMatches = matches.filter((item) => isElementVisible(item));
        return indexedCandidate(visibleMatches, locator) ?? null;
      }
      if (!found.shadowRoot) {
        return null;
      }
      currentRoot = found.shadowRoot;
    }
  }

  if (locator.name) {
    const fallback = indexedCandidate(
      interactive.filter((element) => inferName(element).toLowerCase().includes(locator.name!.toLowerCase())),
      locator
    );
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

function ensureOverlayRoot(): HTMLDivElement {
  let root = document.getElementById('bak-overlay-root') as HTMLDivElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'bak-overlay-root';
    root.style.position = 'fixed';
    root.style.bottom = '12px';
    root.style.right = '12px';
    root.style.zIndex = '2147483647';
    root.style.fontFamily = 'ui-sans-serif, system-ui';
    document.body.appendChild(root);

    const badge = document.createElement('div');
    badge.textContent = 'BAK';
    badge.style.background = '#0f172a';
    badge.style.color = '#ffffff';
    badge.style.padding = '6px 10px';
    badge.style.borderRadius = '999px';
    badge.style.fontSize = '12px';
    badge.style.boxShadow = '0 6px 20px rgba(2, 6, 23, 0.35)';
    root.appendChild(badge);
  }
  return root;
}

async function askConfirm(message: string): Promise<boolean> {
  ensureOverlayRoot();

  return new Promise<boolean>((resolve) => {
    const panel = document.createElement('div');
    panel.style.position = 'fixed';
    panel.style.right = '12px';
    panel.style.bottom = '52px';
    panel.style.width = '320px';
    panel.style.background = '#fff';
    panel.style.border = '1px solid #e2e8f0';
    panel.style.borderRadius = '8px';
    panel.style.boxShadow = '0 12px 30px rgba(15, 23, 42, 0.22)';
    panel.style.padding = '12px';
    panel.style.zIndex = '2147483647';

    const title = document.createElement('div');
    title.textContent = 'High-risk action requires confirmation';
    title.style.fontSize = '13px';
    title.style.fontWeight = '600';

    const desc = document.createElement('div');
    desc.textContent = message;
    desc.style.marginTop = '8px';
    desc.style.fontSize = '12px';
    desc.style.color = '#334155';

    const row = document.createElement('div');
    row.style.marginTop = '12px';
    row.style.display = 'flex';
    row.style.gap = '8px';

    const approve = document.createElement('button');
    approve.textContent = 'Approve';
    approve.style.border = 'none';
    approve.style.background = '#16a34a';
    approve.style.color = '#fff';
    approve.style.padding = '8px 10px';
    approve.style.borderRadius = '6px';
    approve.style.cursor = 'pointer';

    const reject = document.createElement('button');
    reject.textContent = 'Reject';
    reject.style.border = '1px solid #cbd5e1';
    reject.style.background = '#fff';
    reject.style.color = '#0f172a';
    reject.style.padding = '8px 10px';
    reject.style.borderRadius = '6px';
    reject.style.cursor = 'pointer';

    const done = (value: boolean): void => {
      panel.remove();
      resolve(value);
    };

    approve.addEventListener('click', () => done(true));
    reject.addEventListener('click', () => done(false));

    row.appendChild(approve);
    row.appendChild(reject);
    panel.appendChild(title);
    panel.appendChild(desc);
    panel.appendChild(row);
    document.body.appendChild(panel);
  });
}

function highlightCandidates(candidates: ElementMapItem[]): Array<() => void> {
  const disposers: Array<() => void> = [];

  for (const candidate of candidates) {
    const element = elementCache.get(candidate.eid) ?? resolveLocator({ eid: candidate.eid });
    if (!element) {
      continue;
    }
    const oldOutline = element.style.outline;
    element.style.outline = '2px solid #f97316';
    disposers.push(() => {
      element.style.outline = oldOutline;
    });
  }

  return disposers;
}

async function pickCandidate(candidates: ElementMapItem[]): Promise<string | null> {
  collectElements();
  return new Promise<string | null>((resolve) => {
    const disposers = highlightCandidates(candidates);

    const panel = document.createElement('div');
    panel.style.position = 'fixed';
    panel.style.right = '12px';
    panel.style.bottom = '52px';
    panel.style.width = '340px';
    panel.style.maxHeight = '320px';
    panel.style.overflow = 'auto';
    panel.style.background = '#fff';
    panel.style.border = '1px solid #e2e8f0';
    panel.style.borderRadius = '8px';
    panel.style.boxShadow = '0 12px 30px rgba(15, 23, 42, 0.22)';
    panel.style.padding = '12px';
    panel.style.zIndex = '2147483647';

    const title = document.createElement('div');
    title.textContent = 'Action failed, choose a target to heal skill';
    title.style.fontWeight = '600';
    title.style.fontSize = '13px';
    panel.appendChild(title);

    const cleanup = (value: string | null): void => {
      panel.remove();
      for (const dispose of disposers) {
        dispose();
      }
      resolve(value);
    };

    for (const candidate of candidates.slice(0, 3)) {
      const btn = document.createElement('button');
      btn.textContent = `${candidate.role ?? candidate.tag}: ${candidate.name || candidate.text || candidate.eid}`;
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.style.marginTop = '8px';
      btn.style.textAlign = 'left';
      btn.style.border = '1px solid #cbd5e1';
      btn.style.borderRadius = '6px';
      btn.style.padding = '8px';
      btn.style.background = '#f8fafc';
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', () => cleanup(candidate.eid));
      panel.appendChild(btn);
    }

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.marginTop = '8px';
    cancel.style.border = 'none';
    cancel.style.background = '#e2e8f0';
    cancel.style.padding = '8px 10px';
    cancel.style.borderRadius = '6px';
    cancel.style.cursor = 'pointer';
    cancel.addEventListener('click', () => cleanup(null));
    panel.appendChild(cancel);

    document.body.appendChild(panel);
  });
}

function failAction(code: string, message: string, data?: Record<string, unknown>): ActionResult {
  return { ok: false, error: { code, message, data } };
}

function failAssessment(code: string, message: string, data?: Record<string, unknown>): ActionAssessment {
  return { ok: false, error: { code, message, data } };
}

function indexedCandidate<T>(candidates: T[], locator?: Locator): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const index = typeof locator?.index === 'number' ? Math.max(0, Math.floor(locator.index)) : 0;
  return candidates[index];
}

function notFoundForLocator(locator: Locator | undefined, message: string): ActionError {
  const hint = unsupportedLocatorHint(locator);
  return {
    code: 'E_NOT_FOUND',
    message,
    data: hint ? { hint } : undefined
  };
}

function describeNode(node: Element | null): string {
  if (!isHtmlElement(node)) {
    return 'unknown';
  }

  const id = node.id ? `#${node.id}` : '';
  const classes = node.classList.length > 0 ? `.${Array.from(node.classList).slice(0, 2).join('.')}` : '';
  return `${node.tagName.toLowerCase()}${id}${classes}`;
}

function centerPoint(rect: DOMRect): { x: number; y: number } {
  const minX = Math.max(1, Math.floor(rect.left + 1));
  const minY = Math.max(1, Math.floor(rect.top + 1));
  const maxX = Math.max(minX, Math.floor(rect.right - 1));
  const maxY = Math.max(minY, Math.floor(rect.bottom - 1));

  const x = Math.min(Math.max(Math.floor(rect.left + rect.width / 2), minX), maxX);
  const y = Math.min(Math.max(Math.floor(rect.top + rect.height / 2), minY), maxY);
  return { x, y };
}

function assessActionTarget(target: HTMLElement, action: ActionName): ActionAssessment {
  if (!isElementVisible(target)) {
    return failAssessment('E_NOT_FOUND', `${action} target is not visible`);
  }

  if ((target as HTMLButtonElement).disabled || target.getAttribute('aria-disabled') === 'true') {
    return failAssessment('E_PERMISSION', `${action} target is disabled`);
  }

  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  const rect = target.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) {
    return failAssessment('E_NOT_FOUND', `${action} target has invalid bounds`);
  }

  const ownerDocument = target.ownerDocument ?? document;
  const point = centerPoint(rect);
  const hit = ownerDocument.elementFromPoint(point.x, point.y);
  if (!hit) {
    return failAssessment('E_NOT_FOUND', `${action} target is outside viewport`);
  }

  let shadowHostBridge = false;
  const rootNode = target.getRootNode();
  if (rootNode instanceof ShadowRoot) {
    shadowHostBridge = hit === rootNode.host;
  }

  if (hit !== target && !target.contains(hit) && !shadowHostBridge) {
    return failAssessment('E_PERMISSION', `${action} target is obstructed by ${describeNode(hit)}`, {
      obstructedBy: describeNode(hit)
    });
  }

  return { ok: true, point };
}

function dispatchPointer(target: HTMLElement, type: string, point: { x: number; y: number }): void {
  if (typeof PointerEvent === 'undefined') {
    return;
  }

  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1
    })
  );
}

function dispatchMouse(target: HTMLElement, type: string, point: { x: number; y: number }): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: type === 'mouseup' || type === 'click' ? 0 : 1
    })
  );
}

function performClick(target: HTMLElement, point: { x: number; y: number }): void {
  target.focus({ preventScroll: true });
  dispatchPointer(target, 'pointerdown', point);
  dispatchMouse(target, 'mousedown', point);
  dispatchPointer(target, 'pointerup', point);
  dispatchMouse(target, 'mouseup', point);
  dispatchMouse(target, 'click', point);
}

function dispatchInputEvents(target: HTMLElement): void {
  try {
    target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  } catch {
    target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function setNativeValue(target: HTMLInputElement | HTMLTextAreaElement, nextValue: string): void {
  const proto = isInputElement(target)
    ? (target.ownerDocument.defaultView?.HTMLInputElement.prototype ?? HTMLInputElement.prototype)
    : (target.ownerDocument.defaultView?.HTMLTextAreaElement.prototype ?? HTMLTextAreaElement.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(target, nextValue);
    return;
  }
  target.value = nextValue;
}

function insertContentEditableText(target: HTMLElement, text: string, clear: boolean): void {
  target.focus({ preventScroll: true });

  if (clear) {
    target.textContent = '';
  }

  if (!text) {
    dispatchInputEvents(target);
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    target.append(document.createTextNode(text));
    dispatchInputEvents(target);
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);

  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchInputEvents(target);
}

function isEditable(target: HTMLElement): target is HTMLInputElement | HTMLTextAreaElement {
  return isInputElement(target) || isTextAreaElement(target);
}

function keyEvent(type: 'keydown' | 'keyup', key: string, extra?: Partial<KeyboardEventInit>): KeyboardEvent {
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ...extra
  });
}

function parseHotkey(keys: string[]): {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
} {
  const lowered = keys.map((item) => item.toLowerCase());
  const key = keys.find((item) => !['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd'].includes(item.toLowerCase())) ?? keys[0] ?? '';
  return {
    key,
    ctrlKey: lowered.includes('ctrl') || lowered.includes('control'),
    altKey: lowered.includes('alt'),
    shiftKey: lowered.includes('shift'),
    metaKey: lowered.includes('meta') || lowered.includes('cmd')
  };
}

function domSummary(): PageDomSummary {
  const allElements = Array.from(document.querySelectorAll('*'));
  const interactiveElements = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element) => isInteractive(element));
  const tags = new Map<string, number>();

  for (const element of allElements) {
    const tag = element.tagName.toLowerCase();
    tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }

  const tagHistogram = [...tags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  const shadowHosts = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element) => element.shadowRoot).length;

  return {
    url: window.location.href,
    title: document.title,
    totalElements: allElements.length,
    interactiveElements: interactiveElements.length,
    headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    links: document.querySelectorAll('a[href]').length,
    forms: document.querySelectorAll('form').length,
    iframes: document.querySelectorAll('iframe,frame').length,
    shadowHosts,
    tagHistogram
  };
}

function pageTextChunks(maxChunks = 24, chunkSize = 320): PageTextChunk[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,td,th,label,button,a,span,div'));
  const chunks: PageTextChunk[] = [];

  for (const node of nodes) {
    if (!isElementVisible(node)) {
      continue;
    }

    const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }

    chunks.push({
      chunkId: `chunk_${chunks.length + 1}`,
      text: text.slice(0, chunkSize),
      sourceTag: node.tagName.toLowerCase()
    });

    if (chunks.length >= maxChunks) {
      break;
    }
  }

  return chunks;
}

function pageAccessibility(limit = 200): AccessibilityNode[] {
  const nodes: AccessibilityNode[] = [];
  for (const element of getInteractiveElements(document, true).slice(0, limit)) {
    nodes.push({
      role: inferRole(element),
      name: inferName(element),
      tag: element.tagName.toLowerCase(),
      eid: buildEid(element)
    });
  }
  return nodes;
}

function pageMetrics(): PageMetrics {
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  return {
    navigation: {
      durationMs: navigation?.duration ?? 0,
      domContentLoadedMs: navigation ? navigation.domContentLoadedEventEnd - navigation.startTime : 0,
      loadEventMs: navigation ? navigation.loadEventEnd - navigation.startTime : 0
    },
    longTasks: {
      count: longTaskCount,
      totalDurationMs: Number(longTaskDurationMs.toFixed(2))
    },
    resources: {
      count: resources.length,
      transferSize: resources.reduce((sum, item) => sum + (item.transferSize ?? 0), 0),
      encodedBodySize: resources.reduce((sum, item) => sum + (item.encodedBodySize ?? 0), 0)
    }
  };
}

function performanceNetworkEntries(): NetworkEntry[] {
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const now = Date.now();
  const perfNow = performance.now();
  const entries: NetworkEntry[] = [];

  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index];
    if (resource.startTime < performanceBaselineMs) {
      continue;
    }

    const responseEnd = resource.responseEnd > 0 ? resource.responseEnd : resource.startTime + resource.duration;
    const ts = now - Math.max(0, Math.round(perfNow - responseEnd));
    entries.push({
      id: `perf_${index}_${Math.round(resource.startTime)}_${fnv1a(resource.name).slice(0, 8)}`,
      kind: 'resource',
      method: 'GET',
      url: resource.name,
      status: 0,
      ok: true,
      ts,
      durationMs: Math.max(0, resource.duration),
      responseBytes: resource.transferSize > 0 ? resource.transferSize : undefined
    });
  }

  return entries;
}

function networkSnapshotEntries(): NetworkEntry[] {
  const merged = [...networkEntries];
  const seen = new Set(merged.map((entry) => `${entry.kind}|${entry.url}|${Math.round(entry.ts / 10)}`));

  for (const entry of performanceNetworkEntries()) {
    const key = `${entry.kind}|${entry.url}|${Math.round(entry.ts / 10)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }

  merged.sort((a, b) => a.ts - b.ts);
  return merged;
}

function filterNetworkEntries(params: Record<string, unknown>): NetworkEntry[] {
  const urlIncludes = typeof params.urlIncludes === 'string' ? params.urlIncludes : '';
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : '';
  const status = typeof params.status === 'number' ? params.status : undefined;
  const sinceTs = typeof params.sinceTs === 'number' ? params.sinceTs : undefined;
  const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(params.limit))) : 50;

  return networkSnapshotEntries()
    .filter((entry) => {
      if (typeof sinceTs === 'number' && entry.ts < sinceTs) {
        return false;
      }
      if (urlIncludes && !entry.url.includes(urlIncludes)) {
        return false;
      }
      if (method && entry.method.toUpperCase() !== method) {
        return false;
      }
      if (typeof status === 'number' && entry.status !== status) {
        return false;
      }
      return true;
    })
    .slice(-limit)
    .reverse();
}

async function waitForNetwork(params: Record<string, unknown>): Promise<NetworkEntry> {
  const timeoutMs = typeof params.timeoutMs === 'number' ? Math.max(1, params.timeoutMs) : 5000;
  const sinceTs = typeof params.sinceTs === 'number' ? params.sinceTs : Date.now() - timeoutMs;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matched = filterNetworkEntries({ ...params, sinceTs, limit: 1 })[0];
    if (matched) {
      return matched;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw { code: 'E_TIMEOUT', message: 'network.waitFor timeout' } satisfies ActionError;
}

function performDoubleClick(target: HTMLElement, point: { x: number; y: number }): void {
  performClick(target, point);
  performClick(target, point);
  dispatchMouse(target, 'dblclick', point);
}

function performRightClick(target: HTMLElement, point: { x: number; y: number }): void {
  dispatchPointer(target, 'pointerdown', point);
  target.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      button: 2,
      buttons: 2
    })
  );
  dispatchPointer(target, 'pointerup', point);
  target.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      button: 2,
      buttons: 0
    })
  );
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      button: 2
    })
  );
}

async function handleAction(message: ActionMessage): Promise<ActionResult> {
  try {
    ensureOverlayRoot();

    if (message.action === 'scroll') {
      if (message.locator) {
        const target = resolveLocator(message.locator);
        if (!target) {
          return failAction('E_NOT_FOUND', 'scroll target not found');
        }
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return { ok: true };
      }
      window.scrollBy({ left: Number(message.dx ?? 0), top: Number(message.dy ?? 320), behavior: 'smooth' });
      return { ok: true };
    }

    const target = resolveLocator(message.locator);
    if (!target) {
      return { ok: false, error: notFoundForLocator(message.locator, 'Target not found') };
    }

    const name = inferName(target);
    const text = (target.innerText || target.textContent || '').trim();
    const riskText = `${name} ${text}`;
    const isHighRisk =
      message.requiresConfirm === true || unsafeKeywords.test(riskText) || (isInputElement(target) && target.type === 'file');

    if (isHighRisk) {
      const approved = await askConfirm(`Action: ${message.action} on "${name || text || target.tagName}"`);
      if (!approved) {
        return failAction('E_NEED_USER_CONFIRM', 'User rejected high-risk action');
      }
    }

    if (message.action === 'focus') {
      target.focus({ preventScroll: true });
      return { ok: true };
    }

    if (message.action === 'blur') {
      target.blur();
      return { ok: true };
    }

    if (message.action === 'scrollIntoView') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return { ok: true };
    }

    if (message.action === 'dragDrop') {
      const from = message.from ? resolveLocator(message.from) : target;
      const to = message.to ? resolveLocator(message.to) : target;
      if (!from || !to) {
        return failAction('E_NOT_FOUND', 'dragDrop endpoints not found');
      }

      const fromPoint = centerPoint(from.getBoundingClientRect());
      const toPoint = centerPoint(to.getBoundingClientRect());
      const transfer = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      to.dispatchEvent(
        new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: toPoint.x, clientY: toPoint.y })
      );
      to.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: toPoint.x, clientY: toPoint.y })
      );
      to.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: toPoint.x, clientY: toPoint.y })
      );
      from.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: fromPoint.x, clientY: fromPoint.y })
      );
      return { ok: true };
    }

    const assessed = assessActionTarget(target, message.action);
    if (!assessed.ok) {
      return assessed;
    }

    if (message.action === 'click') {
      performClick(target, assessed.point);
      return { ok: true };
    }

    if (message.action === 'doubleClick') {
      performDoubleClick(target, assessed.point);
      return { ok: true };
    }

    if (message.action === 'rightClick') {
      performRightClick(target, assessed.point);
      return { ok: true };
    }

    if (message.action === 'hover') {
      dispatchPointer(target, 'pointermove', assessed.point);
      dispatchMouse(target, 'mousemove', assessed.point);
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: assessed.point.x, clientY: assessed.point.y }));
      return { ok: true };
    }

    if (message.action === 'type') {
      if (!(isEditable(target) || target.isContentEditable)) {
        return failAction('E_NOT_FOUND', 'Type target is not editable');
      }

      if (isEditable(target)) {
        target.focus({ preventScroll: true });
        const appendText = message.text ?? '';
        const nextValue = message.clear ? appendText : `${target.value}${appendText}`;
        setNativeValue(target, nextValue);
        dispatchInputEvents(target);
      } else {
        insertContentEditableText(target, message.text ?? '', Boolean(message.clear));
      }
      return { ok: true };
    }

    if (message.action === 'select') {
      if (!(target instanceof HTMLSelectElement)) {
        return failAction('E_NOT_FOUND', 'select target is not a <select> element');
      }

      const values = message.values ?? [];
      if (values.length === 0) {
        return failAction('E_INVALID_PARAMS', 'values is required');
      }
      for (const option of Array.from(target.options)) {
        option.selected = values.includes(option.value) || values.includes(option.text);
      }
      dispatchInputEvents(target);
      return { ok: true };
    }

    if (message.action === 'check' || message.action === 'uncheck') {
      if (!isInputElement(target) || (target.type !== 'checkbox' && target.type !== 'radio')) {
        return failAction('E_NOT_FOUND', `${message.action} target must be checkbox/radio`);
      }
      const desired = message.action === 'check';
      if (target.checked !== desired) {
        target.checked = desired;
        dispatchInputEvents(target);
      }
      return { ok: true };
    }

    return failAction('E_NOT_FOUND', `Unsupported action ${message.action}`);
  } catch (error) {
    return failAction('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

function waitConditionMet(message: WaitMessage, root: ParentNode): boolean {
  if (message.mode === 'selector') {
    return Boolean(querySelectorAcrossOpenShadow(root, message.value));
  }

  if (message.mode === 'text') {
    if (root instanceof Document) {
      const bodyText = root.body?.innerText ?? root.documentElement?.textContent ?? '';
      return bodyText.includes(message.value);
    }
    const text = root.textContent ?? '';
    return text.includes(message.value);
  }

  return window.location.href.includes(message.value);
}

async function waitFor(message: WaitMessage): Promise<ActionResult> {
  const timeoutMs = message.timeoutMs ?? 5000;
  const rootResult = resolveRootForLocator();
  if (!rootResult.ok) {
    return { ok: false, error: rootResult.error };
  }

  const root = rootResult.root;
  if (waitConditionMet(message, root)) {
    return { ok: true };
  }

  return new Promise<ActionResult>((resolve) => {
    let done = false;
    const finish = (result: ActionResult): void => {
      if (done) {
        return;
      }
      done = true;
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(timerId);
      resolve(result);
    };

    const check = (): void => {
      const latestRoot = resolveRootForLocator();
      if (!latestRoot.ok) {
        return;
      }
      if (waitConditionMet(message, latestRoot.root)) {
        finish({ ok: true });
      }
    };

    const observer = new MutationObserver(() => {
      check();
    });
    const observationRoot = root instanceof Document ? root.documentElement : (root as Node);
    if (observationRoot) {
      observer.observe(observationRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }

    const intervalId = setInterval(() => {
      check();
    }, 120);

    const timerId = setTimeout(() => {
      finish(failAction('E_TIMEOUT', `wait timeout: ${message.mode}=${message.value}`));
    }, timeoutMs);
  });
}

async function dispatchRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  switch (method) {
    case 'page.title':
      return { title: document.title };
    case 'page.url':
      return { url: window.location.href };
    case 'page.text':
      return {
        chunks: pageTextChunks(
          typeof params.maxChunks === 'number' ? params.maxChunks : 24,
          typeof params.chunkSize === 'number' ? params.chunkSize : 320
        )
      };
    case 'page.dom':
      return { summary: domSummary() };
    case 'page.accessibilityTree':
      return {
        nodes: pageAccessibility(typeof params.limit === 'number' ? params.limit : 200)
      };
    case 'page.scrollTo': {
      const x = typeof params.x === 'number' ? params.x : window.scrollX;
      const y = typeof params.y === 'number' ? params.y : window.scrollY;
      const behavior = params.behavior === 'smooth' ? 'smooth' : 'auto';
      window.scrollTo({ left: x, top: y, behavior });
      return { ok: true, x: window.scrollX, y: window.scrollY };
    }
    case 'page.metrics':
      return pageMetrics();
    case 'page.viewport':
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      };

    case 'element.hover':
      return handleAction({ type: 'bak.performAction', action: 'hover', locator: params.locator as Locator }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.doubleClick':
      return handleAction({
        type: 'bak.performAction',
        action: 'doubleClick',
        locator: params.locator as Locator,
        requiresConfirm: params.requiresConfirm === true
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.rightClick':
      return handleAction({
        type: 'bak.performAction',
        action: 'rightClick',
        locator: params.locator as Locator,
        requiresConfirm: params.requiresConfirm === true
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.dragDrop':
      return handleAction({
        type: 'bak.performAction',
        action: 'dragDrop',
        locator: params.from as Locator,
        from: params.from as Locator,
        to: params.to as Locator,
        requiresConfirm: params.requiresConfirm === true
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.select':
      return handleAction({
        type: 'bak.performAction',
        action: 'select',
        locator: params.locator as Locator,
        values: Array.isArray(params.values) ? (params.values as string[]) : [],
        requiresConfirm: params.requiresConfirm === true
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.check':
      return handleAction({
        type: 'bak.performAction',
        action: 'check',
        locator: params.locator as Locator,
        requiresConfirm: params.requiresConfirm === true
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.uncheck':
      return handleAction({
        type: 'bak.performAction',
        action: 'uncheck',
        locator: params.locator as Locator,
        requiresConfirm: params.requiresConfirm === true
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.scrollIntoView':
      return handleAction({
        type: 'bak.performAction',
        action: 'scrollIntoView',
        locator: params.locator as Locator
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.focus':
      return handleAction({
        type: 'bak.performAction',
        action: 'focus',
        locator: params.locator as Locator
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.blur':
      return handleAction({
        type: 'bak.performAction',
        action: 'blur',
        locator: params.locator as Locator
      }).then((res) => {
        if (!res.ok) {
          throw res.error;
        }
        return { ok: true };
      });
    case 'element.get': {
      const target = resolveLocator(params.locator as Locator);
      if (!target) {
        throw notFoundForLocator(params.locator as Locator | undefined, 'element.get target not found');
      }

      const elements = collectElements({}, params.locator as Locator);
      const eid = buildEid(target);
      const element = elements.find((item) => item.eid === eid);
      if (!element) {
        throw { code: 'E_NOT_FOUND', message: 'element metadata not found' } satisfies ActionError;
      }

      const attributes: Record<string, string> = {};
      for (const attr of Array.from(target.attributes)) {
        attributes[attr.name] = attr.value;
      }

      return {
        element,
        value: isEditable(target) ? target.value : target.isContentEditable ? target.textContent ?? '' : undefined,
        checked: isInputElement(target) ? target.checked : undefined,
        attributes
      };
    }

    case 'keyboard.press': {
      const key = String(params.key ?? '').trim();
      if (!key) {
        throw { code: 'E_INVALID_PARAMS', message: 'key is required' } satisfies ActionError;
      }
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      target.dispatchEvent(keyEvent('keydown', key));
      target.dispatchEvent(keyEvent('keyup', key));
      return { ok: true };
    }
    case 'keyboard.type': {
      const text = String(params.text ?? '');
      const delayMs = typeof params.delayMs === 'number' ? Math.max(0, params.delayMs) : 0;
      const target = (document.activeElement as HTMLElement | null) ?? null;
      if (!target || !(isEditable(target) || target.isContentEditable)) {
        throw { code: 'E_NOT_FOUND', message: 'No editable active element for keyboard.type' } satisfies ActionError;
      }

      for (const char of text) {
        target.dispatchEvent(keyEvent('keydown', char));
        if (isEditable(target)) {
          setNativeValue(target, `${target.value}${char}`);
          dispatchInputEvents(target);
        } else {
          insertContentEditableText(target, char, false);
        }
        target.dispatchEvent(keyEvent('keyup', char));
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      return { ok: true };
    }
    case 'keyboard.hotkey': {
      const keys = Array.isArray(params.keys) ? (params.keys as string[]) : [];
      if (keys.length === 0) {
        throw { code: 'E_INVALID_PARAMS', message: 'keys is required' } satisfies ActionError;
      }
      const parsed = parseHotkey(keys);
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      target.dispatchEvent(
        keyEvent('keydown', parsed.key, {
          ctrlKey: parsed.ctrlKey,
          altKey: parsed.altKey,
          shiftKey: parsed.shiftKey,
          metaKey: parsed.metaKey
        })
      );
      target.dispatchEvent(
        keyEvent('keyup', parsed.key, {
          ctrlKey: parsed.ctrlKey,
          altKey: parsed.altKey,
          shiftKey: parsed.shiftKey,
          metaKey: parsed.metaKey
        })
      );
      return { ok: true };
    }

    case 'mouse.move': {
      const x = Number(params.x);
      const y = Number(params.y);
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!target) {
        throw { code: 'E_NOT_FOUND', message: 'mouse.move target not found' } satisfies ActionError;
      }
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      return { ok: true };
    }
    case 'mouse.click': {
      const x = Number(params.x);
      const y = Number(params.y);
      const button = params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0;
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!target) {
        throw { code: 'E_NOT_FOUND', message: 'mouse.click target not found' } satisfies ActionError;
      }
      target.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
      );
      target.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
      );
      target.dispatchEvent(
        new MouseEvent(button === 2 ? 'contextmenu' : 'click', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button
        })
      );
      return { ok: true };
    }
    case 'mouse.wheel': {
      const dx = typeof params.dx === 'number' ? params.dx : 0;
      const dy = typeof params.dy === 'number' ? params.dy : 120;
      window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: dx, deltaY: dy }));
      window.scrollBy({ left: dx, top: dy, behavior: 'auto' });
      return { ok: true };
    }

    case 'file.upload': {
      const target = resolveLocator(params.locator as Locator);
      if (!target || !isInputElement(target) || target.type !== 'file') {
        throw notFoundForLocator(params.locator as Locator | undefined, 'file.upload target must be <input type=file>');
      }

      if (params.requiresConfirm === true) {
        const targetName = inferName(target) || target.getAttribute('name') || target.id || '<input type=file>';
        const approved = await askConfirm(`Action: file.upload on "${targetName}"`);
        if (!approved) {
          throw { code: 'E_NEED_USER_CONFIRM', message: 'User rejected high-risk action' } satisfies ActionError;
        }
      }

      const files = Array.isArray(params.files) ? params.files : [];
      if (files.length === 0) {
        throw { code: 'E_INVALID_PARAMS', message: 'files is required' } satisfies ActionError;
      }

      const transfer = new DataTransfer();
      for (const file of files as Array<{ name?: unknown; contentBase64?: unknown; mimeType?: unknown }>) {
        const name = typeof file.name === 'string' ? file.name : 'upload.bin';
        const contentBase64 = typeof file.contentBase64 === 'string' ? file.contentBase64 : '';
        const mimeType = typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream';
        const bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
        transfer.items.add(new File([bytes], name, { type: mimeType }));
      }
      target.files = transfer.files;
      dispatchInputEvents(target);
      return { ok: true, fileCount: transfer.files.length };
    }

    case 'context.enterFrame': {
      if (params.reset === true) {
        contextState.framePath = [];
      }
      const framePath = Array.isArray(params.framePath) ? params.framePath.map(String) : [];
      if (framePath.length === 0 && params.locator && typeof (params.locator as Locator).css === 'string') {
        framePath.push((params.locator as Locator).css!);
      }
      if (framePath.length === 0) {
        throw { code: 'E_INVALID_PARAMS', message: 'framePath or locator.css is required' } satisfies ActionError;
      }

      const candidate = [...contextState.framePath, ...framePath];
      const check = resolveFrameDocument(candidate);
      if (!check.ok) {
        throw check.error;
      }
      contextState.framePath = candidate;
      return { ok: true, frameDepth: contextState.framePath.length, framePath: [...contextState.framePath] };
    }
    case 'context.exitFrame': {
      if (params.reset === true) {
        contextState.framePath = [];
      } else {
        const levels = typeof params.levels === 'number' ? Math.max(1, Math.floor(params.levels)) : 1;
        contextState.framePath = contextState.framePath.slice(0, Math.max(0, contextState.framePath.length - levels));
      }
      return { ok: true, frameDepth: contextState.framePath.length, framePath: [...contextState.framePath] };
    }
    case 'context.enterShadow': {
      if (params.reset === true) {
        contextState.shadowPath = [];
      }
      const hostSelectors = Array.isArray(params.hostSelectors) ? params.hostSelectors.map(String) : [];
      if (hostSelectors.length === 0 && params.locator && typeof (params.locator as Locator).css === 'string') {
        hostSelectors.push((params.locator as Locator).css!);
      }
      if (hostSelectors.length === 0) {
        throw { code: 'E_INVALID_PARAMS', message: 'hostSelectors or locator.css is required' } satisfies ActionError;
      }
      const rootResult = resolveRootForLocator();
      if (!rootResult.ok) {
        throw rootResult.error;
      }
      const candidate = [...contextState.shadowPath, ...hostSelectors];
      const check = resolveShadowRoot(rootResult.root, candidate);
      if (!check.ok) {
        throw check.error;
      }
      contextState.shadowPath = candidate;
      return { ok: true, shadowDepth: contextState.shadowPath.length, shadowPath: [...contextState.shadowPath] };
    }
    case 'context.exitShadow': {
      if (params.reset === true) {
        contextState.shadowPath = [];
      } else {
        const levels = typeof params.levels === 'number' ? Math.max(1, Math.floor(params.levels)) : 1;
        contextState.shadowPath = contextState.shadowPath.slice(0, Math.max(0, contextState.shadowPath.length - levels));
      }
      return { ok: true, shadowDepth: contextState.shadowPath.length, shadowPath: [...contextState.shadowPath] };
    }
    case 'context.reset':
      contextState.framePath = [];
      contextState.shadowPath = [];
      return { ok: true, frameDepth: 0, shadowDepth: 0 };

    case 'network.list':
      return { entries: filterNetworkEntries(params) };
    case 'network.get': {
      const id = String(params.id ?? '');
      const found = networkSnapshotEntries().find((entry) => entry.id === id);
      if (!found) {
        throw { code: 'E_NOT_FOUND', message: `network entry not found: ${id}` } satisfies ActionError;
      }
      return { entry: found };
    }
    case 'network.waitFor':
      return { entry: await waitForNetwork(params) };
    case 'network.clear':
      networkEntries.length = 0;
      performanceBaselineMs = performance.now();
      return { ok: true };

    case 'debug.dumpState': {
      const consoleLimit = typeof params.consoleLimit === 'number' ? Math.max(1, Math.floor(params.consoleLimit)) : 80;
      const networkLimit = typeof params.networkLimit === 'number' ? Math.max(1, Math.floor(params.networkLimit)) : 80;
      const includeAccessibility = params.includeAccessibility === true;
      return {
        url: window.location.href,
        title: document.title,
        context: {
          framePath: [...contextState.framePath],
          shadowPath: [...contextState.shadowPath]
        },
        dom: domSummary(),
        text: pageTextChunks(12, 260),
        console: consoleEntries.slice(-consoleLimit),
        network: filterNetworkEntries({ limit: networkLimit }),
        accessibility: includeAccessibility ? pageAccessibility(200) : undefined
      };
    }
    default:
      throw { code: 'E_NOT_FOUND', message: `Unsupported content RPC method: ${method}` } satisfies ActionError;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false;
  }

  const typed = message as { type: string };

  if (typed.type === 'bak.collectElements') {
    const request = message as CollectElementsMessage;
    sendResponse({ elements: collectElements({ debugRichText: Boolean(request.debugRichText) }) });
    return false;
  }

  if (typed.type === 'bak.getConsole') {
    const limit = Number((message as { limit?: number }).limit ?? 50);
    sendResponse({ entries: consoleEntries.slice(-limit) });
    return false;
  }

  if (typed.type === 'bak.performAction') {
    void handleAction(message as ActionMessage).then(sendResponse);
    return true;
  }

  if (typed.type === 'bak.waitFor') {
    void waitFor(message as WaitMessage).then(sendResponse);
    return true;
  }

  if (typed.type === 'bak.selectCandidate') {
    void pickCandidate((message as CandidateMessage).candidates).then((selectedEid) => {
      if (!selectedEid) {
        sendResponse({ ok: false, error: { code: 'E_NEED_USER_CONFIRM', message: 'No candidate selected' } });
        return;
      }
      sendResponse({ ok: true, selectedEid });
    });
    return true;
  }

  if (typed.type === 'bak.rpc') {
    const request = message as RpcMessage;
    void dispatchRpc(request.method, request.params ?? {})
      .then((result) => {
        const payload: RpcEnvelope = { ok: true, result };
        sendResponse(payload);
      })
      .catch((error) => {
        const normalized =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as ActionError)
            : { code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) };
        const payload: RpcEnvelope = { ok: false, error: normalized };
        sendResponse(payload);
      });
    return true;
  }

  return false;
});

ensureOverlayRoot();


