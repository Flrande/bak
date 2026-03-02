import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ElementMapItem, Locator } from '@flrande/bak-protocol';
import { BakService } from '../../packages/cli/src/service.js';
import type { BrowserDriver, DriverConnectionStatus, SnapshotResult } from '../../packages/cli/src/drivers/browser-driver.js';
import { MemoryStore } from '../../packages/cli/src/memory/store.js';
import { PairingStore } from '../../packages/cli/src/pairing-store.js';
import { TraceStore } from '../../packages/cli/src/trace-store.js';

function createConnectionStatus(): DriverConnectionStatus {
  const now = Date.now();
  return {
    state: 'connected',
    reason: null,
    extensionVersion: '0.1.0',
    lastSeenTs: now,
    lastRequestTs: now,
    lastResponseTs: now,
    lastHeartbeatTs: now,
    lastError: null,
    connectedAtTs: now,
    disconnectedAtTs: null,
    pendingRequests: 0,
    totalRequests: 0,
    totalFailures: 0,
    totalTimeouts: 0,
    totalNotReady: 0
  };
}

function createSnapshotElement(): ElementMapItem {
  return {
    eid: 'eid_trace',
    tag: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
    bbox: { x: 10, y: 20, width: 80, height: 24 },
    selectors: {
      css: '#save',
      text: 'Save',
      aria: 'button:Save'
    },
    risk: 'low'
  };
}

function createDriver(): BrowserDriver {
  return {
    isConnected: () => true,
    connectionStatus: () => createConnectionStatus(),
    sessionPing: async () => ({ ok: true, ts: Date.now() }),
    tabsList: async () => ({
      tabs: [{ id: 1, title: 'Demo', url: 'http://example.com/form', active: true }]
    }),
    tabsFocus: async () => ({ ok: true }),
    tabsNew: async () => ({ tabId: 1 }),
    tabsClose: async () => ({ ok: true }),
    pageGoto: async () => ({ ok: true }),
    pageBack: async () => ({ ok: true }),
    pageForward: async () => ({ ok: true }),
    pageReload: async () => ({ ok: true }),
    pageWait: async () => ({ ok: true }),
    pageSnapshot: async (): Promise<SnapshotResult> => ({
      imageBase64: Buffer.from('snapshot-image', 'utf8').toString('base64'),
      elements: [createSnapshotElement()],
      tabId: 1,
      url: 'http://example.com/form'
    }),
    elementClick: async (_locator: Locator) => ({ ok: true }),
    elementType: async () => ({ ok: true }),
    elementScroll: async () => ({ ok: true }),
    debugGetConsole: async () => ({ entries: [] }),
    userSelectCandidate: async () => ({ selectedEid: 'eid_trace' })
  };
}

function withDataDir<T>(fn: (dataDir: string) => Promise<T> | T): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bak-trace-redaction-'));
  const previousDataDir = process.env.BAK_DATA_DIR;
  process.env.BAK_DATA_DIR = dataDir;

  const finalize = (): void => {
    if (previousDataDir === undefined) {
      delete process.env.BAK_DATA_DIR;
    } else {
      process.env.BAK_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  return Promise.resolve(fn(dataDir)).finally(finalize);
}

describe('trace redaction', () => {
  it('redacts typed text from element.type params', async () => {
    await withDataDir(async (dataDir) => {
      const pairingStore = new PairingStore(dataDir);
      pairingStore.createToken();
      const traceStore = new TraceStore(dataDir);
      const memoryStore = new MemoryStore(dataDir);
      const service = new BakService(createDriver(), pairingStore, traceStore, memoryStore);

      await service.invoke('element.type', {
        locator: { css: '#password' },
        text: 'MySecretPassword!123',
        clear: true
      });

      const traceEntries = traceStore.readTrace(service.getCurrentTraceId());
      const params = traceEntries.find((entry) => entry.method === 'element.type')?.params as Record<string, unknown> | undefined;
      expect(params?.text).toBe('[REDACTED]');
    });
  });

  it('redacts page.snapshot base64 from trace result', async () => {
    await withDataDir(async (dataDir) => {
      const pairingStore = new PairingStore(dataDir);
      pairingStore.createToken();
      const traceStore = new TraceStore(dataDir);
      const memoryStore = new MemoryStore(dataDir);
      const service = new BakService(createDriver(), pairingStore, traceStore, memoryStore);

      await service.invoke('page.snapshot', {
        includeBase64: true
      });

      const traceEntries = traceStore.readTrace(service.getCurrentTraceId());
      const result = traceEntries.find((entry) => entry.method === 'page.snapshot:result')?.result as
        | Record<string, unknown>
        | undefined;
      expect(result?.imageBase64).toBe('[REDACTED:base64]');
    });
  });
});


