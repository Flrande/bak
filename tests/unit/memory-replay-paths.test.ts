import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BakErrorCode, type Locator, type SkillPlanStep } from '../../packages/protocol/src/index.js';
import { BakService } from '../../packages/cli/src/service.js';
import type { BrowserDriver, DriverConnectionStatus, SnapshotResult } from '../../packages/cli/src/drivers/browser-driver.js';
import { MemoryStore } from '../../packages/cli/src/memory/store.js';
import { PairingStore } from '../../packages/cli/src/pairing-store.js';
import { TraceStore } from '../../packages/cli/src/trace-store.js';

interface DriverRecorder {
  rawRequests: Array<{ method: string; params?: Record<string, unknown> }>;
  elementScrollCalls: Array<{ locator?: Locator; dx: number; dy: number; tabId?: number }>;
  elementClickCalls: Array<{ locator: Locator; tabId?: number; requiresConfirm?: boolean }>;
}

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

function createDriver(
  recorder: DriverRecorder,
  options: {
    failElementClickTimes?: number;
  } = {}
): BrowserDriver {
  let activeUrl = 'http://example.com/home';
  let remainingClickFailures = Math.max(0, options.failElementClickTimes ?? 0);
  return {
    isConnected: () => true,
    connectionStatus: () => createConnectionStatus(),
    sessionPing: async () => ({ ok: true, ts: Date.now() }),
    tabsList: async () => ({
      tabs: [{ id: 1, title: 'Demo', url: activeUrl, active: true }]
    }),
    tabsFocus: async () => ({ ok: true }),
    tabsNew: async () => ({ tabId: 1 }),
    tabsClose: async () => ({ ok: true }),
    pageGoto: async (url: string) => {
      activeUrl = url;
      return { ok: true };
    },
    pageBack: async () => ({ ok: true }),
    pageForward: async () => ({ ok: true }),
    pageReload: async () => ({ ok: true }),
    pageWait: async () => ({ ok: true }),
    pageSnapshot: async (): Promise<SnapshotResult> => ({
      imageBase64: '',
      elements: [],
      tabId: 1,
      url: activeUrl
    }),
    elementClick: async (locator: Locator, tabId?: number, requiresConfirm?: boolean) => {
      recorder.elementClickCalls.push({ locator, tabId, requiresConfirm });
      if (remainingClickFailures > 0) {
        remainingClickFailures -= 1;
        throw new Error('simulated click failure');
      }
      return { ok: true };
    },
    elementType: async () => ({ ok: true }),
    elementScroll: async (locator, dx, dy, tabId) => {
      recorder.elementScrollCalls.push({ locator, dx, dy, tabId });
      return { ok: true };
    },
    debugGetConsole: async () => ({ entries: [] }),
    userSelectCandidate: async () => ({ selectedEid: 'eid_demo' }),
    rawRequest: async (method, params) => {
      recorder.rawRequests.push({ method, params });
      if (method === 'page.url') {
        return { url: activeUrl };
      }
      if (method === 'page.text') {
        return { chunks: [{ text: 'demo content' }] };
      }
      return { ok: true };
    }
  };
}

function withService<T>(
  fn: (ctx: { service: BakService; memoryStore: MemoryStore; recorder: DriverRecorder }) => Promise<T> | T,
  options: { failElementClickTimes?: number } = {}
): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bak-replay-paths-'));
  const previousDataDir = process.env.BAK_DATA_DIR;
  process.env.BAK_DATA_DIR = dataDir;

  const pairingStore = new PairingStore(dataDir);
  pairingStore.createToken();
  const traceStore = new TraceStore(dataDir);
  const memoryStore = new MemoryStore(dataDir);
  const recorder: DriverRecorder = { rawRequests: [], elementScrollCalls: [], elementClickCalls: [] };
  const service = new BakService(createDriver(recorder, options), pairingStore, traceStore, memoryStore);

  const finalize = (): void => {
    if (previousDataDir === undefined) {
      delete process.env.BAK_DATA_DIR;
    } else {
      process.env.BAK_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  return Promise.resolve(fn({ service, memoryStore, recorder })).finally(finalize);
}

describe('memory replay path coverage', () => {
  it('replays scroll coordinates, element scroll, and keyboard typing steps', async () => {
    await withService(async ({ service, memoryStore, recorder }) => {
      const skill = memoryStore.createSkill({
        domain: 'example.com',
        intent: 'replay coverage',
        description: 'covers replay actions',
        plan: [
          { kind: 'scrollTo', x: 120, y: 480, behavior: 'smooth' },
          { kind: 'elementScroll', locator: { css: '#list' }, dx: 8, dy: 640 },
          { kind: 'keyboardType', text: 'hello', delayMs: 5 }
        ],
        paramsSchema: { fields: {} },
        healing: { retries: 1 }
      });

      await service.invoke('memory.skills.run', { id: skill.id });

      expect(recorder.rawRequests).toContainEqual({
        method: 'page.scrollTo',
        params: { tabId: undefined, x: 120, y: 480, behavior: 'smooth' }
      });
      expect(recorder.rawRequests).toContainEqual({
        method: 'keyboard.type',
        params: { tabId: undefined, text: 'hello', delayMs: 5 }
      });
      expect(recorder.elementScrollCalls).toContainEqual({
        locator: { css: '#list' },
        dx: 8,
        dy: 640,
        tabId: undefined
      });
    });
  });

  it('fails explicitly when skill contains unsupported step kind', async () => {
    await withService(async ({ service, memoryStore }) => {
      const unknownStep = { kind: 'custom-unsupported-step' } as unknown as SkillPlanStep;
      const skill = memoryStore.createSkill({
        domain: 'example.com',
        intent: 'invalid replay',
        description: 'should fail',
        plan: [unknownStep],
        paramsSchema: { fields: {} },
        healing: { retries: 1 }
      });

      await expect(service.invoke('memory.skills.run', { id: skill.id })).rejects.toMatchObject({
        bakCode: BakErrorCode.E_INVALID_PARAMS
      });
    });
  });

  it('records page.scrollTo, element.scroll, and keyboard.type into memory steps', async () => {
    await withService(async ({ service, memoryStore }) => {
      await service.invoke('memory.recordStart', { intent: 'record mixed actions' });
      await service.invoke('element.scroll', {
        locator: { css: '#feed' },
        dx: 12,
        dy: 256
      });
      await service.invokeDynamic('page.scrollTo', { x: 90, y: 420, behavior: 'smooth' });
      await service.invokeDynamic('keyboard.type', { text: 'draft', delayMs: 10 });
      await service.invoke('memory.recordStop', { outcome: 'success' });

      const episode = memoryStore.listEpisodes()[0];
      const elementScroll = episode?.steps.find((step) => step.kind === 'elementScroll');
      const scrollTo = episode?.steps.find((step) => step.kind === 'scrollTo');
      const keyboardType = episode?.steps.find((step) => step.kind === 'keyboardType');

      expect(elementScroll).toMatchObject({
        kind: 'elementScroll',
        locator: { css: '#feed' },
        dx: 12,
        dy: 256
      });
      expect(scrollTo).toMatchObject({
        kind: 'scrollTo',
        x: 90,
        y: 420,
        behavior: 'smooth'
      });
      expect(keyboardType).toMatchObject({
        kind: 'keyboardType',
        text: 'draft',
        delayMs: 10
      });
    });
  });

  it('updates auto-learned startUrl/domain when first step is not goto', async () => {
    await withService(async ({ service, memoryStore }) => {
      await service.invokeDynamic('keyboard.type', { text: 'seed auto flow' });
      await service.invoke('page.goto', { url: 'https://portal.local/dashboard' });
      await service.invoke('page.wait', { mode: 'url', value: '/dashboard' });

      const autoSkill = memoryStore.listSkills().find((skill) => skill.meta?.source === 'auto');
      expect(autoSkill?.domain).toBe('portal.local');
      expect(autoSkill?.urlPatterns?.[0]).toBe('https://portal.local/dashboard');
    });
  });

  it('fails memory.skills.run when required params are missing', async () => {
    await withService(async ({ service, memoryStore }) => {
      const skill = memoryStore.createSkill({
        domain: 'example.com',
        intent: 'fill email',
        description: 'needs a parameter',
        plan: [
          {
            kind: 'type',
            locator: { css: '#email' },
            targetCandidates: [{ css: '#email' }],
            text: '{{param_1}}'
          }
        ],
        paramsSchema: {
          required: ['param_1'],
          fields: {
            param_1: { type: 'string' }
          }
        },
        healing: { retries: 1 },
        preconditions: { urlPattern: 'example.com' }
      });

      await expect(service.invoke('memory.skills.run', { id: skill.id })).rejects.toMatchObject({
        bakCode: BakErrorCode.E_INVALID_PARAMS
      });
    });
  });

  it('fails memory.skills.run when preconditions do not match current page', async () => {
    await withService(async ({ service, memoryStore }) => {
      const skill = memoryStore.createSkill({
        domain: 'example.com',
        intent: 'only run on checkout',
        description: 'precondition check',
        plan: [{ kind: 'click', locator: { css: '#confirm' }, targetCandidates: [{ css: '#confirm' }] }],
        paramsSchema: { fields: {} },
        healing: { retries: 1 },
        preconditions: { urlPattern: '/checkout' }
      });

      await expect(service.invoke('memory.skills.run', { id: skill.id })).rejects.toMatchObject({
        bakCode: BakErrorCode.E_NOT_FOUND
      });
    });
  });

  it('uses healing.retries for click/type replay before failing', async () => {
    await withService(
      async ({ service, memoryStore, recorder }) => {
        const skill = memoryStore.createSkill({
          domain: 'example.com',
          intent: 'retry click',
          description: 'retries click once',
          plan: [{ kind: 'click', locator: { css: '#submit' }, targetCandidates: [{ css: '#submit' }] }],
          paramsSchema: { fields: {} },
          healing: { retries: 2 },
          preconditions: { urlPattern: 'example.com' }
        });

        const result = await service.invoke('memory.skills.run', { id: skill.id });
        expect(result.ok).toBe(true);
        expect(recorder.elementClickCalls.length).toBeGreaterThanOrEqual(2);
      },
      { failElementClickTimes: 1 }
    );
  });

  it('uses active tab url for retrieval when request omits url', async () => {
    await withService(async ({ service, memoryStore }) => {
      await service.invoke('page.goto', { url: 'https://portal.local/settings/billing?from=menu' });

      const billingSkill = memoryStore.createSkill({
        domain: 'portal.local',
        intent: 'open billing',
        description: 'billing path',
        plan: [{ kind: 'click', locator: { text: 'Billing' } }],
        paramsSchema: { fields: {} },
        healing: { retries: 1 },
        urlPatterns: ['https://portal.local/settings/billing']
      });
      const dashboardSkill = memoryStore.createSkill({
        domain: 'portal.local',
        intent: 'open billing',
        description: 'dashboard path',
        plan: [{ kind: 'click', locator: { text: 'Dashboard' } }],
        paramsSchema: { fields: {} },
        healing: { retries: 1 },
        urlPatterns: ['https://portal.local/dashboard']
      });

      const result = (await service.invoke('memory.skills.retrieve', {
        intent: 'open billing',
        domain: 'portal.local'
      })) as { skills: Array<{ id: string }> };

      expect(result.skills[0]?.id).toBe(billingSkill.id);
      expect(result.skills.map((item) => item.id)).toContain(dashboardSkill.id);
    });
  });

  it('accepts precondition urlPattern when only query string differs', async () => {
    await withService(async ({ service, memoryStore }) => {
      await service.invoke('page.goto', { url: 'https://portal.local/settings/billing?from=menu' });
      const skill = memoryStore.createSkill({
        domain: 'portal.local',
        intent: 'open billing action',
        description: 'billing precondition',
        plan: [{ kind: 'click', locator: { css: '#confirm' }, targetCandidates: [{ css: '#confirm' }] }],
        paramsSchema: { fields: {} },
        healing: { retries: 1 },
        preconditions: { urlPattern: 'https://portal.local/settings/billing?from=deep-link' }
      });

      const result = await service.invoke('memory.skills.run', { id: skill.id });
      expect(result.ok).toBe(true);
    });
  });
});
