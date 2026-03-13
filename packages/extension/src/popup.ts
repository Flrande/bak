const statusPanelEl = document.getElementById('statusPanel') as HTMLDivElement;
const statusBadgeEl = document.getElementById('statusBadge') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const statusBodyEl = document.getElementById('statusBody') as HTMLDivElement;
const recoveryListEl = document.getElementById('recoveryList') as HTMLUListElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const portInput = document.getElementById('port') as HTMLInputElement;
const debugRichTextInput = document.getElementById('debugRichText') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const saveRowEl = document.getElementById('saveRow') as HTMLDivElement;
const reconnectBtn = document.getElementById('reconnect') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;
const connectionStateEl = document.getElementById('connectionState') as HTMLDivElement;
const tokenStateEl = document.getElementById('tokenState') as HTMLDivElement;
const reconnectStateEl = document.getElementById('reconnectState') as HTMLDivElement;
const connectionUrlEl = document.getElementById('connectionUrl') as HTMLDivElement;
const lastErrorEl = document.getElementById('lastError') as HTMLDivElement;
const lastBindingUpdateEl = document.getElementById('lastBindingUpdate') as HTMLDivElement;
const extensionVersionEl = document.getElementById('extensionVersion') as HTMLDivElement;
const sessionSummaryEl = document.getElementById('sessionSummary') as HTMLDivElement;
const sessionCardsEl = document.getElementById('sessionCards') as HTMLDivElement;

type PopupTone = 'neutral' | 'success' | 'warning' | 'error';

interface PopupState {
  ok: boolean;
  connected: boolean;
  connectionState: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'manual' | 'missing-token';
  hasToken: boolean;
  port: number;
  wsUrl: string;
  debugRichText: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastErrorContext: string | null;
  reconnectAttempt: number;
  nextReconnectInMs: number | null;
  manualDisconnect: boolean;
  extensionVersion: string;
  lastBindingUpdateAt: number | null;
  lastBindingUpdateReason: string | null;
  sessionBindings: {
    count: number;
    attachedCount: number;
    detachedCount: number;
    tabCount: number;
    items: Array<{
      id: string;
      label: string;
      tabCount: number;
      activeTabId: number | null;
      activeTabTitle: string | null;
      activeTabUrl: string | null;
      windowId: number | null;
      groupId: number | null;
      detached: boolean;
      lastBindingUpdateAt: number | null;
      lastBindingUpdateReason: string | null;
    }>;
  };
}

interface StatusDescriptor {
  badge: string;
  title: string;
  body: string;
  tone: PopupTone;
  recoverySteps: string[];
}

let latestState: PopupState | null = null;

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimeAgo(at: number | null): string {
  if (typeof at !== 'number') {
    return 'never';
  }
  const deltaSeconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (deltaSeconds < 5) {
    return 'just now';
  }
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

function formatUrl(url: string | null): string {
  if (!url) {
    return 'No active tab URL';
  }
  try {
    const parsed = new URL(url);
    const trimmedPath = parsed.pathname === '/' ? '' : parsed.pathname;
    const trimmedQuery = parsed.search.length > 0 ? parsed.search : '';
    return truncate(`${parsed.host}${trimmedPath}${trimmedQuery}`, 64);
  } catch {
    return truncate(url, 64);
  }
}

function describeConnectionState(connectionState: PopupState['connectionState']): string {
  switch (connectionState) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'waiting for runtime';
    case 'reconnecting':
      return 'retrying connection';
    case 'manual':
      return 'manually disconnected';
    case 'missing-token':
      return 'token required';
    case 'disconnected':
    default:
      return 'disconnected';
  }
}

function setStatus(descriptor: StatusDescriptor): void {
  statusPanelEl.dataset.tone = descriptor.tone;
  statusBadgeEl.dataset.tone = descriptor.tone;
  statusBadgeEl.textContent = descriptor.badge;
  statusEl.textContent = descriptor.title;
  statusBodyEl.textContent = descriptor.body;
  recoveryListEl.replaceChildren();
  for (const step of descriptor.recoverySteps) {
    const li = document.createElement('li');
    li.textContent = step;
    recoveryListEl.appendChild(li);
  }
}

function describeStatus(state: PopupState): StatusDescriptor {
  const lastError = `${state.lastErrorContext ?? ''} ${state.lastError ?? ''}`.toLowerCase();
  const runtimeOffline = lastError.includes('cannot connect to bak cli');

  if (state.connected) {
    const body =
      state.sessionBindings.detachedCount > 0
        ? `${pluralize(state.sessionBindings.detachedCount, 'remembered session')} are detached. Check the cards below before you continue browser work.`
        : 'The extension bridge is healthy and ready for CLI-driven browser work.';
    return {
      badge: 'Ready',
      title: 'Connected to the local bak runtime',
      body,
      tone: 'success',
      recoverySteps: state.sessionBindings.detachedCount > 0
        ? [
            'Resume or recreate detached work from the bak CLI before sending new page commands.',
            'Use the Sessions panel below to confirm which remembered session lost its owned tabs.'
          ]
        : [
            'Start browser work from the bak CLI.',
            'Use Reconnect bridge only when you intentionally changed token or port settings.'
          ]
    };
  }

  if (state.connectionState === 'missing-token') {
    return {
      badge: 'Action needed',
      title: 'Pair token is required',
      body: 'This browser profile does not have a saved token yet, so the extension cannot pair with bak.',
      tone: 'error',
      recoverySteps: [
        'Run `bak setup` if you need a fresh token.',
        `Paste the token above, keep CLI port ${state.port}, and click Save settings.`,
        'If the bridge still stays disconnected after saving, click Reconnect bridge below.'
      ]
    };
  }

  if (state.connectionState === 'manual') {
    return {
      badge: 'Paused',
      title: 'Extension bridge is paused',
      body: 'The bridge was manually disconnected. It will stay idle until you reconnect it.',
      tone: 'warning',
      recoverySteps: [
        'Click Reconnect bridge below when you want the extension live again.',
        'If you changed the token or port, save the new settings first.'
      ]
    };
  }

  if (runtimeOffline) {
    return {
      badge: 'Runtime offline',
      title: 'The local bak runtime is not reachable',
      body: `The extension cannot reach ${state.wsUrl}, so browser work cannot start yet.`,
      tone: 'warning',
      recoverySteps: [
        `Run \`bak doctor --port ${state.port}\` in PowerShell 7.`,
        'If you just upgraded bak, reload the unpacked extension in chrome://extensions or edge://extensions.',
        'Leave this popup open for a moment after doctor so the bridge can retry.'
      ]
    };
  }

  if (state.connectionState === 'reconnecting') {
    return {
      badge: 'Retrying',
      title: 'The extension is trying to reconnect',
      body: 'The bridge is retrying in the background. You only need to intervene if the retry loop keeps failing.',
      tone: 'warning',
      recoverySteps: [
        'Wait for the current retry window to finish.',
        'If you changed the token or port, click Save settings.',
        'Use Reconnect bridge below if you want to retry immediately.'
      ]
    };
  }

  if (state.lastError) {
    return {
      badge: 'Check setup',
      title: 'The bridge needs attention',
      body: `Last error: ${state.lastError}`,
      tone: 'error',
      recoverySteps: [
        `Confirm the saved token and CLI port ${state.port}.`,
        `Run \`bak doctor --port ${state.port}\` from the bak CLI.`,
        'Reload the unpacked extension if the runtime and token both look correct.'
      ]
    };
  }

  return {
    badge: 'Waiting',
    title: 'Not connected yet',
    body: 'The extension is ready to pair, but it is still waiting for the local bak runtime to come online.',
    tone: 'neutral',
    recoverySteps: [
      `Run \`bak doctor --port ${state.port}\` or another bak CLI command to wake the runtime.`,
      'Return here and confirm the bridge reconnects automatically.'
    ]
  };
}

function renderConnectionDetails(state: PopupState): void {
  connectionStateEl.textContent = describeConnectionState(state.connectionState);
  tokenStateEl.textContent = state.hasToken ? 'configured' : 'missing';
  connectionUrlEl.textContent = state.wsUrl;
  extensionVersionEl.textContent = state.extensionVersion;

  if (state.manualDisconnect) {
    reconnectStateEl.textContent = 'manual disconnect';
  } else if (typeof state.nextReconnectInMs === 'number') {
    const seconds = Math.max(0, Math.ceil(state.nextReconnectInMs / 100) / 10);
    reconnectStateEl.textContent = `attempt ${state.reconnectAttempt}, retry in ${seconds}s`;
  } else if (state.connected) {
    reconnectStateEl.textContent = 'connected';
  } else {
    reconnectStateEl.textContent = 'idle';
  }

  if (state.lastError) {
    const context = state.lastErrorContext ? `${state.lastErrorContext}: ` : '';
    lastErrorEl.textContent = `${context}${state.lastError} (${formatTimeAgo(state.lastErrorAt)})`;
  } else {
    lastErrorEl.textContent = 'none';
  }

  if (state.lastBindingUpdateReason) {
    lastBindingUpdateEl.textContent = `${state.lastBindingUpdateReason} (${formatTimeAgo(state.lastBindingUpdateAt)})`;
  } else {
    lastBindingUpdateEl.textContent = 'none';
  }
}

function createMetaRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'session-meta-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'session-meta-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'session-meta-value';
  valueEl.textContent = value;

  row.append(labelEl, valueEl);
  return row;
}

function renderSessionBindings(state: PopupState['sessionBindings']): void {
  if (state.count === 0) {
    sessionSummaryEl.textContent = 'No remembered sessions';
  } else {
    sessionSummaryEl.textContent =
      `${pluralize(state.count, 'session')}, ` +
      `${pluralize(state.attachedCount, 'attached binding')}, ` +
      `${pluralize(state.detachedCount, 'detached binding')}, ` +
      `${pluralize(state.tabCount, 'tracked tab')}`;
  }

  sessionCardsEl.replaceChildren();

  if (state.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = 'No tracked sessions yet. Resolve a session from the bak CLI and it will appear here.';
    sessionCardsEl.appendChild(empty);
    return;
  }

  for (const item of state.items) {
    const card = document.createElement('section');
    card.className = 'session-card';
    card.dataset.detached = item.detached ? 'true' : 'false';

    const header = document.createElement('div');
    header.className = 'session-card-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'session-card-title-wrap';

    const title = document.createElement('div');
    title.className = 'session-card-title';
    title.textContent = item.label;

    const subtitle = document.createElement('div');
    subtitle.className = 'session-card-subtitle';
    subtitle.textContent = item.id;

    titleWrap.append(title, subtitle);

    const badge = document.createElement('span');
    badge.className = 'session-badge';
    badge.dataset.detached = item.detached ? 'true' : 'false';
    badge.textContent = item.detached ? 'Detached' : 'Attached';

    header.append(titleWrap, badge);

    const activeTitle = document.createElement('div');
    activeTitle.className = 'session-active-title';
    activeTitle.textContent = item.activeTabTitle ? truncate(item.activeTabTitle, 72) : 'No active tab title';
    activeTitle.title = item.activeTabTitle ?? '';

    const activeUrl = document.createElement('div');
    activeUrl.className = 'session-active-url';
    activeUrl.textContent = formatUrl(item.activeTabUrl);
    activeUrl.title = item.activeTabUrl ?? '';

    const meta = document.createElement('div');
    meta.className = 'session-meta-grid';
    meta.append(
      createMetaRow('Active tab', item.activeTabId === null ? 'none' : `${item.activeTabId}`),
      createMetaRow('Tabs', `${item.tabCount}`),
      createMetaRow('Window', item.windowId === null ? 'none' : `${item.windowId}`),
      createMetaRow('Group', item.groupId === null ? 'none' : `${item.groupId}`),
      createMetaRow(
        'Last binding',
        item.lastBindingUpdateReason
          ? `${item.lastBindingUpdateReason} (${formatTimeAgo(item.lastBindingUpdateAt)})`
          : 'none this session'
      )
    );

    const footer = document.createElement('div');
    footer.className = 'session-card-footer';
    footer.textContent = item.detached
      ? 'bak still remembers this session, but its owned tabs or window are missing.'
      : 'The saved binding still points at live browser tabs.';

    card.append(header, activeTitle, activeUrl, meta, footer);
    sessionCardsEl.appendChild(card);
  }
}

function parsePortValue(): number | null {
  const port = Number.parseInt(portInput.value.trim(), 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function isFormDirty(state: PopupState | null): boolean {
  if (!state) {
    return tokenInput.value.trim().length > 0;
  }
  return (
    tokenInput.value.trim().length > 0 ||
    portInput.value.trim() !== String(state.port) ||
    debugRichTextInput.checked !== Boolean(state.debugRichText)
  );
}

function getConfigValidationMessage(state: PopupState | null): string | null {
  if (!tokenInput.value.trim() && state?.hasToken !== true) {
    return 'Pair token is required';
  }
  if (parsePortValue() === null) {
    return 'Port is invalid';
  }
  return null;
}

function updateSaveState(state: PopupState | null): void {
  const dirty = isFormDirty(state);
  const validationError = getConfigValidationMessage(state);
  saveRowEl.hidden = !dirty;
  saveBtn.disabled = !dirty || validationError !== null;
  saveBtn.textContent = state?.hasToken ? 'Save settings' : 'Save token';
}

async function refreshState(): Promise<void> {
  const state = (await chrome.runtime.sendMessage({ type: 'bak.getState' })) as PopupState;

  if (!state.ok) {
    return;
  }

  const shouldSyncForm = !isFormDirty(latestState);
  latestState = state;
  if (shouldSyncForm) {
    portInput.value = String(state.port);
    debugRichTextInput.checked = Boolean(state.debugRichText);
    tokenInput.value = '';
  }

  renderConnectionDetails(state);
  renderSessionBindings(state.sessionBindings);
  updateSaveState(state);
  setStatus(describeStatus(state));
}

saveBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const port = parsePortValue();

  if (!token && latestState?.hasToken !== true) {
    setStatus({
      badge: 'Action needed',
      title: 'Pair token is required',
      body: 'Save a token before the extension can reconnect.',
      tone: 'error',
      recoverySteps: ['Paste a valid token above, then click Save settings.']
    });
    return;
  }

  if (port === null) {
    setStatus({
      badge: 'Invalid input',
      title: 'CLI port is invalid',
      body: 'Use a positive integer port before saving settings.',
      tone: 'error',
      recoverySteps: ['Correct the port value above and try again.']
    });
    return;
  }

  await chrome.runtime.sendMessage({
    type: 'bak.updateConfig',
    ...(token ? { token } : {}),
    port,
    debugRichText: debugRichTextInput.checked
  });

  tokenInput.value = '';
  await refreshState();
});

reconnectBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'bak.reconnectNow' });
  await refreshState();
});

disconnectBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'bak.disconnect' });
  await refreshState();
});

for (const element of [tokenInput, portInput, debugRichTextInput]) {
  element.addEventListener('input', () => {
    updateSaveState(latestState);
  });
  element.addEventListener('change', () => {
    updateSaveState(latestState);
  });
}

void refreshState();
const refreshInterval = window.setInterval(() => {
  void refreshState();
}, 1000);
window.addEventListener('unload', () => {
  window.clearInterval(refreshInterval);
});
