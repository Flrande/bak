const statusEl = document.getElementById('status') as HTMLDivElement;
const statusNoteEl = document.getElementById('statusNote') as HTMLDivElement;
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
const sessionListEl = document.getElementById('sessionList') as HTMLUListElement;

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
      windowId: number | null;
      groupId: number | null;
      detached: boolean;
    }>;
  };
}
let latestState: PopupState | null = null;

function setStatus(text: string, tone: 'neutral' | 'success' | 'warning' | 'error' = 'neutral'): void {
  statusEl.textContent = text;
  if (tone === 'success') {
    statusEl.style.color = '#166534';
    return;
  }
  if (tone === 'warning') {
    statusEl.style.color = '#b45309';
    return;
  }
  if (tone === 'error') {
    statusEl.style.color = '#dc2626';
    return;
  }
  statusEl.style.color = '#0f172a';
}

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
  return `${deltaHours}h ago`;
}

function renderSessionBindings(state: PopupState['sessionBindings']): void {
  if (state.count === 0) {
    sessionSummaryEl.textContent = 'No remembered sessions';
  } else {
    sessionSummaryEl.textContent = `${pluralize(state.count, 'session')}, ${pluralize(state.attachedCount, 'attached binding')}, ${pluralize(state.tabCount, 'tab')}, ${pluralize(state.detachedCount, 'detached binding')}`;
  }
  sessionListEl.replaceChildren();
  for (const item of state.items) {
    const li = document.createElement('li');
    const location = item.windowId === null ? 'no window' : `window ${item.windowId}`;
    const active = item.activeTabId === null ? 'no active tab' : `active ${item.activeTabId}`;
    li.textContent = `${item.label}: ${item.tabCount} tabs, ${location}, ${active}`;
    if (item.detached) {
      li.style.color = '#b45309';
    }
    sessionListEl.appendChild(li);
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

function describeStatus(state: PopupState): { text: string; note: string; tone: 'neutral' | 'success' | 'warning' | 'error' } {
  const combinedError = `${state.lastErrorContext ?? ''} ${state.lastError ?? ''}`.toLowerCase();
  const runtimeOffline = combinedError.includes('cannot connect to bak cli');

  if (state.connected) {
    return {
      text: 'Connected to local bak runtime',
      note: 'Use the bak CLI to start browser work. This popup is mainly for status and configuration.',
      tone: 'success'
    };
  }

  if (state.connectionState === 'missing-token') {
    return {
      text: 'Pair token is required',
      note: 'Paste a token once, then save it. Future reconnects happen automatically.',
      tone: 'error'
    };
  }

  if (state.connectionState === 'manual') {
    return {
      text: 'Extension bridge is paused',
      note: 'Normal browser work starts from the bak CLI. Open Advanced only if you need to reconnect manually.',
      tone: 'warning'
    };
  }

  if (runtimeOffline) {
    return {
      text: 'Waiting for local bak runtime',
      note: 'Run any bak command, such as `bak doctor`, and the extension will reconnect automatically.',
      tone: 'warning'
    };
  }

  if (state.connectionState === 'reconnecting') {
    return {
      text: 'Trying to reconnect',
      note: 'The extension is retrying in the background. You usually do not need to press anything here.',
      tone: 'warning'
    };
  }

  if (state.lastError) {
    return {
      text: 'Connection problem',
      note: 'Check the last error below. The extension keeps retrying automatically unless you disconnect it manually.',
      tone: 'error'
    };
  }

  return {
    text: 'Not connected yet',
    note: 'Once the local bak runtime is available, the extension reconnects automatically.',
    tone: 'neutral'
  };
}

async function refreshState(): Promise<void> {
  const state = (await chrome.runtime.sendMessage({ type: 'bak.getState' })) as PopupState;

  if (state.ok) {
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
    const status = describeStatus(state);
    setStatus(status.text, status.tone);
    statusNoteEl.textContent = status.note;
  }
}

saveBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const port = parsePortValue();

  if (!token && latestState?.hasToken !== true) {
    setStatus('Pair token is required', 'error');
    return;
  }

  if (port === null) {
    setStatus('Port is invalid', 'error');
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
