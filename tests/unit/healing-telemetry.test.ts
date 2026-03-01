import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ElementMapItem, Locator } from '@bak/protocol';
import { BakService } from '../../packages/cli/src/service.js';
import { BridgeError } from '../../packages/cli/src/drivers/extension-bridge.js';
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
    eid: 'eid_healed',
    tag: 'button',
    role: 'button',
    name: 'Approve',
    text: 'Approve',
    bbox: { x: 10, y: 20, width: 80, height: 24 },
    selectors: {
      css: '#approve-btn',
      text: 'Approve',
      aria: 'button:Approve'
    },
    risk: 'low'
  };
}

function createDriver(options: { failUserSelection?: boolean }): BrowserDriver {
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
      elements: [createSnapshotElement()],
      tabId: 1,
      url: 'http://example.com/form'
    }),
    elementClick: async (locator: Locator) => {
      if (locator.eid === 'eid_healed') {
        return { ok: true };
      }
      throw new BridgeError('E_NOT_FOUND', 'target not found');
    },
    elementType: async () => ({ ok: true }),
    elementScroll: async () => ({ ok: true }),
    debugGetConsole: async () => ({ entries: [] }),
    userSelectCandidate: async () => {
      if (options.failUserSelection) {
        throw new BridgeError('E_PERMISSION', 'user canceled selection');
      }
      return { selectedEid: 'eid_healed' };
    }
  };
}

function withDataDir<T>(fn: (dataDir: string) => Promise<T> | T): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bak-heal-telemetry-'));
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

describe('memory healing telemetry', () => {
  it('records healing attempt and success on healed run', async () => {
    await withDataDir(async (dataDir) => {
      const pairingStore = new PairingStore(dataDir);
      pairingStore.createToken();
      const traceStore = new TraceStore(dataDir);
      const memoryStore = new MemoryStore(dataDir);
      const service = new BakService(createDriver({}), pairingStore, traceStore, memoryStore);

      const skill = memoryStore.createSkill({
        domain: 'example.com',
        intent: 'approve request',
        description: 'demo',
        plan: [{ kind: 'click', locator: { text: 'Approve' } }],
        paramsSchema: { fields: {} },
        healing: { retries: 1 }
      });

      await service.invoke('memory.skills.run', { id: skill.id });

      const updated = memoryStore.getSkill(skill.id);
      expect(updated?.healing.attempts).toBe(1);
      expect(updated?.healing.successes).toBe(1);
      expect(updated?.stats.runs).toBe(1);
      expect(updated?.stats.success).toBe(1);
      expect(updated?.stats.failure).toBe(0);
    });
  });

  it('records healing attempt on failed heal flow', async () => {
    await withDataDir(async (dataDir) => {
      const pairingStore = new PairingStore(dataDir);
      pairingStore.createToken();
      const traceStore = new TraceStore(dataDir);
      const memoryStore = new MemoryStore(dataDir);
      const service = new BakService(createDriver({ failUserSelection: true }), pairingStore, traceStore, memoryStore);

      const skill = memoryStore.createSkill({
        domain: 'example.com',
        intent: 'approve request',
        description: 'demo',
        plan: [{ kind: 'click', locator: { text: 'Approve' } }],
        paramsSchema: { fields: {} },
        healing: { retries: 1 }
      });

      await expect(service.invoke('memory.skills.run', { id: skill.id })).rejects.toBeTruthy();

      const updated = memoryStore.getSkill(skill.id);
      expect(updated?.healing.attempts).toBe(1);
      expect(updated?.healing.successes).toBe(0);
      expect(updated?.stats.runs).toBe(1);
      expect(updated?.stats.success).toBe(0);
      expect(updated?.stats.failure).toBe(1);
    });
  });
});
