import type { ConsoleEntry, ElementMapItem, Locator } from '@bak/protocol';

type ActionName = 'click' | 'type' | 'scroll';

interface ActionMessage {
  type: 'bak.performAction';
  action: ActionName;
  locator?: Locator;
  text?: string;
  clear?: boolean;
  dx?: number;
  dy?: number;
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

const consoleEntries: ConsoleEntry[] = [];
const elementCache = new Map<string, HTMLElement>();

function pushConsole(level: 'error' | 'warn' | 'info', message: string, source?: string): void {
  consoleEntries.push({
    level,
    message,
    source,
    ts: Date.now()
  });
  if (consoleEntries.length > 200) {
    consoleEntries.shift();
  }
}

window.addEventListener('error', (event) => {
  pushConsole('error', event.message, event.filename);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  pushConsole('error', `unhandledrejection: ${reason}`);
});

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

function inferName(element: HTMLElement): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return ariaLabel.trim();
  }

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) {
      return text;
    }
  }

  const placeholder = (element as HTMLInputElement).placeholder;
  if (placeholder) {
    return placeholder.trim();
  }

  const value = (element as HTMLInputElement).value;
  if (value && element.tagName.toLowerCase() !== 'select') {
    return value.trim().slice(0, 100);
  }

  const text = (element.innerText || element.textContent || '').trim();
  if (text) {
    return text.slice(0, 100);
  }

  const nameAttr = element.getAttribute('name');
  if (nameAttr) {
    return nameAttr.trim();
  }

  return element.tagName.toLowerCase();
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

function collectElements(): ElementMapItem[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('*'));
  const results: ElementMapItem[] = [];
  elementCache.clear();

  for (const element of nodes) {
    if (!isInteractive(element) || !isElementVisible(element)) {
      continue;
    }

    const rect = element.getBoundingClientRect();
    const name = inferName(element);
    const role = inferRole(element);
    const text = (element.innerText || element.textContent || '').trim().slice(0, 120);
    const eid = buildEid(element);
    const selectors = {
      css: toCssSelector(element),
      text: text || name ? (text || name).slice(0, 80) : null,
      aria: role && name ? `${role}:${name.slice(0, 80)}` : null
    };

    const combined = `${name} ${text}`;
    const risk = unsafeKeywords.test(combined) || (element as HTMLInputElement).type === 'file' ? 'high' : 'low';

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

function getInteractiveElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('*')).filter(
    (element) => isInteractive(element) && isElementVisible(element)
  );
}

function resolveLocator(locator?: Locator): HTMLElement | null {
  if (!locator) {
    return null;
  }

  if (locator.eid) {
    const refreshed = collectElements();
    if (refreshed.length > 0) {
      const fromCache = elementCache.get(locator.eid);
      if (fromCache) {
        return fromCache;
      }
    }
  }

  const interactive = getInteractiveElements();

  if (locator.role || locator.name) {
    const role = locator.role?.toLowerCase();
    const name = locator.name?.toLowerCase();
    const found = interactive.find((element) => {
      const roleMatch = role ? inferRole(element).toLowerCase() === role : true;
      const nameMatch = name ? inferName(element).toLowerCase().includes(name) : true;
      return roleMatch && nameMatch;
    });
    if (found) {
      return found;
    }
  }

  if (locator.text) {
    const needle = locator.text.toLowerCase();
    const found = interactive.find((element) => {
      const text = (element.innerText || element.textContent || '').toLowerCase();
      return text.includes(needle);
    });
    if (found) {
      return found;
    }
  }

  if (locator.css) {
    const found = document.querySelector<HTMLElement>(locator.css);
    if (found && isInteractive(found) && isElementVisible(found)) {
      return found;
    }
  }

  if (locator.name) {
    const fallback = interactive.find((element) => inferName(element).toLowerCase().includes(locator.name!.toLowerCase()));
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

async function handleAction(message: ActionMessage): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  try {
    ensureOverlayRoot();

    if (message.action === 'scroll') {
      if (message.locator) {
        const target = resolveLocator(message.locator);
        if (!target) {
          return { ok: false, error: { code: 'E_NOT_FOUND', message: 'scroll target not found' } };
        }
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return { ok: true };
      }
      window.scrollBy({ left: Number(message.dx ?? 0), top: Number(message.dy ?? 320), behavior: 'smooth' });
      return { ok: true };
    }

    const target = resolveLocator(message.locator);
    if (!target) {
      return { ok: false, error: { code: 'E_NOT_FOUND', message: 'Target not found' } };
    }

    const name = inferName(target);
    const text = (target.innerText || target.textContent || '').trim();
    const riskText = `${name} ${text}`;
    const isHighRisk = unsafeKeywords.test(riskText) || (target as HTMLInputElement).type === 'file';

    if (isHighRisk) {
      const approved = await askConfirm(`Action: ${message.action} on "${name || text || target.tagName}"`);
      if (!approved) {
        return { ok: false, error: { code: 'E_PERMISSION', message: 'User rejected high-risk action' } };
      }
    }

    target.scrollIntoView({ block: 'center', behavior: 'instant' });

    if (message.action === 'click') {
      target.click();
      return { ok: true };
    }

    if (message.action === 'type') {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) {
        return { ok: false, error: { code: 'E_NOT_FOUND', message: 'Type target is not editable' } };
      }

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (message.clear) {
          target.value = '';
        }
        target.focus();
        target.value = `${target.value}${message.text ?? ''}`;
        target.dispatchEvent(new InputEvent('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        if (message.clear) {
          target.textContent = '';
        }
        target.focus();
        document.execCommand('insertText', false, message.text ?? '');
      }
      return { ok: true };
    }

    return { ok: false, error: { code: 'E_NOT_FOUND', message: `Unsupported action ${message.action}` } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'E_INTERNAL',
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function waitFor(message: WaitMessage): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
  const timeoutMs = message.timeoutMs ?? 5000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (message.mode === 'selector' && document.querySelector(message.value)) {
      return { ok: true };
    }

    if (message.mode === 'text') {
      const bodyText = document.body?.innerText ?? '';
      if (bodyText.includes(message.value)) {
        return { ok: true };
      }
    }

    if (message.mode === 'url' && window.location.href.includes(message.value)) {
      return { ok: true };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: false, error: { code: 'E_TIMEOUT', message: `wait timeout: ${message.mode}=${message.value}` } };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false;
  }

  const typed = message as { type: string };

  if (typed.type === 'bak.collectElements') {
    sendResponse({ elements: collectElements() });
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
        sendResponse({ ok: false, error: { code: 'E_PERMISSION', message: 'No candidate selected' } });
        return;
      }
      sendResponse({ ok: true, selectedEid });
    });
    return true;
  }

  return false;
});

ensureOverlayRoot();
