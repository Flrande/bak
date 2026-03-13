const statusEl = document.getElementById('status') as HTMLDivElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const portInput = document.getElementById('port') as HTMLInputElement;
const debugRichTextInput = document.getElementById('debugRichText') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
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

function setStatus(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.style.color = bad ? '#dc2626' : '#0f172a';
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
  sessionSummaryEl.textContent = `${state.count} sessions, ${state.attachedCount} attached, ${state.tabCount} tabs, ${state.detachedCount} detached`;
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

function renderConnectionDetails(state: PopupState): void {
  connectionStateEl.textContent = state.connectionState;
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

async function refreshState(): Promise<void> {
  const state = (await chrome.runtime.sendMessage({ type: 'bak.getState' })) as PopupState;

  if (state.ok) {
    latestState = state;
    portInput.value = String(state.port);
    debugRichTextInput.checked = Boolean(state.debugRichText);
    renderConnectionDetails(state);
    renderSessionBindings(state.sessionBindings);
    if (state.connected) {
      setStatus('Connected to bak CLI');
    } else if (state.connectionState === 'missing-token') {
      setStatus('Pair token is required', true);
    } else if (state.connectionState === 'manual') {
      setStatus('Disconnected manually');
    } else if (state.connectionState === 'reconnecting') {
      setStatus('Reconnecting to bak CLI', true);
    } else if (state.lastError) {
      setStatus(`Disconnected: ${state.lastError}`, true);
    } else {
      setStatus('Disconnected');
    }
  }
}

saveBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const port = Number.parseInt(portInput.value.trim(), 10);

  if (!token && latestState?.hasToken !== true) {
    setStatus('Pair token is required', true);
    return;
  }

  if (!Number.isInteger(port) || port <= 0) {
    setStatus('Port is invalid', true);
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

void refreshState();
const refreshInterval = window.setInterval(() => {
  void refreshState();
}, 1000);
window.addEventListener('unload', () => {
  window.clearInterval(refreshInterval);
});
