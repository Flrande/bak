import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Locator } from '@bak/protocol';
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
      imageBase64: '',
      elements: [],
      tabId: 1,
      url: 'http://example.com/form'
    }),
    elementClick: async (_locator: Locator) => ({ ok: true }),
    elementType: async () => ({ ok: true }),
    elementScroll: async () => ({ ok: true }),
    debugGetConsole: async () => ({ entries: [] }),
    userSelectCandidate: async () => ({ selectedEid: 'eid_demo' })
  };
}

function withDataDir<T>(
  options: { recordInputText?: boolean },
  fn: (ctx: { dataDir: string; memoryStore: MemoryStore; service: BakService }) => Promise<T> | T
): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bak-memory-redaction-'));
  const previousDataDir = process.env.BAK_DATA_DIR;
  const previousRecordInput = process.env.BAK_MEMORY_RECORD_INPUT_TEXT;
  process.env.BAK_DATA_DIR = dataDir;
  if (options.recordInputText === true) {
    process.env.BAK_MEMORY_RECORD_INPUT_TEXT = '1';
  } else {
    delete process.env.BAK_MEMORY_RECORD_INPUT_TEXT;
  }

  const pairingStore = new PairingStore(dataDir);
  pairingStore.createToken();
  const memoryStore = new MemoryStore(dataDir);
  const traceStore = new TraceStore(dataDir);
  const service = new BakService(createDriver(), pairingStore, traceStore, memoryStore);

  const finalize = (): void => {
    if (previousDataDir === undefined) {
      delete process.env.BAK_DATA_DIR;
    } else {
      process.env.BAK_DATA_DIR = previousDataDir;
    }
    if (previousRecordInput === undefined) {
      delete process.env.BAK_MEMORY_RECORD_INPUT_TEXT;
    } else {
      process.env.BAK_MEMORY_RECORD_INPUT_TEXT = previousRecordInput;
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  return Promise.resolve(fn({ dataDir, memoryStore, service })).finally(finalize);
}

describe('memory input text redaction defaults', () => {
  it('redacts typed input text in episodes by default', async () => {
    await withDataDir({ recordInputText: false }, async ({ memoryStore, service }) => {
      await service.invoke('memory.recordStart', { intent: 'fill profile form' });
      await service.invoke('element.type', {
        locator: { css: '#email-input', name: 'Email' },
        text: 'alice@example.com',
        clear: true
      });
      await service.invoke('memory.recordStop', { outcome: 'success' });

      const episode = memoryStore.listEpisodes()[0];
      const typeStep = episode?.steps.find((step) => step.kind === 'type');
      expect(typeStep?.text).toBe('[REDACTED:input]');
    });
  });

  it('keeps opt-in input recording but still applies text redaction rules', async () => {
    await withDataDir({ recordInputText: true }, async ({ memoryStore, service }) => {
      await service.invoke('memory.recordStart', { intent: 'fill profile form' });
      await service.invoke('element.type', {
        locator: { css: '#email-input', name: 'Email' },
        text: 'alice@example.com',
        clear: true
      });
      await service.invoke('memory.recordStop', { outcome: 'success' });

      const episode = memoryStore.listEpisodes()[0];
      const typeStep = episode?.steps.find((step) => step.kind === 'type');
      expect(typeStep?.text).toBe('[REDACTED:email]');
    });
  });
});
