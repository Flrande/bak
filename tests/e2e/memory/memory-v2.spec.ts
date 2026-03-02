import { expect, test } from '@playwright/test';
import { createHarness, type E2EHarness } from '../helpers/harness';

let harness: E2EHarness | undefined;

test.describe('memory v2 e2e', () => {
  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  test('learn on first run and replay on second run', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }
    const first = await harness.openPage('/form.html');
    let skillId = '';
    try {
      await harness.rpcCall('memory.recordStart', { intent: 'fill and navigate form' });
      await harness.rpcCall('element.type', { tabId: first.tabId, locator: { css: '#name-input' }, text: 'Memory User', clear: true });
      await harness.rpcCall('element.click', { tabId: first.tabId, locator: { css: '#next-page' } });
      await harness.rpcCall('page.wait', { tabId: first.tabId, mode: 'text', value: 'Alpha', timeoutMs: 5000 });
      const stop = (await harness.rpcCall('memory.recordStop', { outcome: 'success' })) as { skillId?: string; episodeId: string };
      expect(stop.skillId).toBeTruthy();
      skillId = stop.skillId!;
      harness.assertTraceHas('memory.recordStop');
    } finally {
      await first.page.close();
    }

    const second = await harness.openPage('/form.html');
    try {
      const retrieve = (await harness.rpcCall('memory.skills.retrieve', {
        intent: 'fill and navigate form',
        domain: '127.0.0.1',
        url: 'http://127.0.0.1:4173/form.html'
      })) as { skills: Array<{ id: string }> };
      expect(retrieve.skills.some((item) => item.id === skillId)).toBe(true);

      const run = (await harness.rpcCall('memory.skills.run', {
        id: skillId,
        tabId: second.tabId,
        params: { param_1: 'Replay Memory User' }
      })) as { ok: boolean; retries: number; healed: boolean };
      expect(run.ok).toBe(true);
      expect(typeof run.retries).toBe('number');

      const stats = (await harness.rpcCall('memory.skills.stats', { id: skillId })) as {
        stats: Array<{ runs: number; success: number; failure: number }>;
      };
      expect(stats.stats[0]?.runs).toBeGreaterThan(0);
      expect(stats.stats[0]?.success).toBeGreaterThan(0);

      const explain = (await harness.rpcCall('memory.replay.explain', { id: skillId })) as {
        steps: Array<{ index: number; summary: string }>;
      };
      expect(explain.steps.length).toBeGreaterThan(0);
      harness.assertTraceHas('memory.skills.run');
    } finally {
      await second.page.close();
    }
  });

  test('failure branch exposes explainable error', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }
    const ctx = await harness.openPage('/form.html');
    try {
      await harness.rpcCall('memory.recordStart', { intent: 'failure explainability' });
      await harness.rpcCall('element.type', { tabId: ctx.tabId, locator: { css: '#name-input' }, text: 'Fail Case', clear: true });
      const stop = (await harness.rpcCall('memory.recordStop', { outcome: 'success' })) as { skillId?: string };
      const skillId = stop.skillId!;

      const failed = await harness.rpcError('memory.skills.run', { id: `${skillId}_missing`, tabId: ctx.tabId });
      expect(failed.bakCode).toBe('E_NOT_FOUND');
      harness.assertTraceHas('memory.skills.run:error');
    } finally {
      await ctx.page.close();
    }
  });
});
