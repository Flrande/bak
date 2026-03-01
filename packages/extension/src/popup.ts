const statusEl = document.getElementById('status') as HTMLDivElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const portInput = document.getElementById('port') as HTMLInputElement;
const debugRichTextInput = document.getElementById('debugRichText') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;

function setStatus(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.style.color = bad ? '#dc2626' : '#0f172a';
}

async function refreshState(): Promise<void> {
  const state = (await chrome.runtime.sendMessage({ type: 'bak.getState' })) as {
    ok: boolean;
    connected: boolean;
    hasToken: boolean;
    port: number;
    debugRichText: boolean;
    lastError: string | null;
  };

  if (state.ok) {
    portInput.value = String(state.port);
    debugRichTextInput.checked = Boolean(state.debugRichText);
    if (state.connected) {
      setStatus('Connected to bak CLI');
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

  if (!token) {
    setStatus('Pair token is required', true);
    return;
  }

  if (!Number.isInteger(port) || port <= 0) {
    setStatus('Port is invalid', true);
    return;
  }

  await chrome.runtime.sendMessage({
    type: 'bak.updateConfig',
    token,
    port,
    debugRichText: debugRichTextInput.checked
  });

  await refreshState();
});

disconnectBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'bak.disconnect' });
  await refreshState();
});

void refreshState();
