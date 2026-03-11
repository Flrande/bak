import { expect, test } from '@playwright/test';
import { createHarness, type E2EHarness } from '../helpers/harness';
import { runCli, runCliFailure } from '../helpers/cli';

let harness: E2EHarness | undefined;

function runHarnessCli<T = unknown>(args: string[]): T {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return runCli(args, harness.rpcPort, harness.dataDir, harness.sessionId);
}

function runHarnessCliFailure(args: string[]): string {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return runCliFailure(args, harness.rpcPort, harness.dataDir, harness.sessionId);
}

test.describe('CLI smoke coverage', () => {
  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  test('exercises first-class browser commands for a simple navigation flow', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/form.html');
    try {
      const pageUrl = runHarnessCli(['page', 'url', '--tab-id', String(tabId)]) as {
        url: string;
      };
      expect(pageUrl.url).toContain('/form.html');

      const snapshot = runHarnessCli(['page', 'snapshot', '--tab-id', String(tabId)]) as {
        elementCount: number;
      };
      expect(snapshot.elementCount).toBeGreaterThan(0);

      const pageTitle = runHarnessCli(['page', 'title', '--tab-id', String(tabId)]) as {
        title: string;
      };
      expect(pageTitle.title).toContain('Form');

      runHarnessCli(['element', 'click', '--tab-id', String(tabId), '--css', '#next-page']);
      runHarnessCli(['page', 'wait', '--tab-id', String(tabId), '--mode', 'text', '--value', 'Alpha', '--timeout-ms', '5000']);
      await expect(page).toHaveURL(/table\.html/);

      const nextPageUrl = runHarnessCli(['page', 'url', '--tab-id', String(tabId)]) as {
        url: string;
      };
      const nextPageTitle = runHarnessCli(['page', 'title', '--tab-id', String(tabId)]) as {
        title: string;
      };
      expect(nextPageUrl.url).toContain('/table.html');
      expect(nextPageTitle.title).toContain('Table');
    } finally {
      await page.close();
    }
  });

  test('exercises drag-drop and numeric browser command parsing on the CLI surface', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/form.html');
    try {
      const move = runHarnessCli(['mouse', 'move', '--tab-id', String(tabId), '--x', '0', '--y', '0']) as {
        ok: boolean;
      };
      expect(move.ok).toBe(true);

      const click = runHarnessCli(['mouse', 'click', '--tab-id', String(tabId), '--x', '0', '--y', '0']) as {
        ok: boolean;
      };
      expect(click.ok).toBe(true);

      const wheel = runHarnessCli(['mouse', 'wheel', '--tab-id', String(tabId), '--dx', '-20', '--dy', '-40']) as {
        ok: boolean;
      };
      expect(wheel.ok).toBe(true);

      const scroll = runHarnessCli(['element', 'scroll', '--tab-id', String(tabId), '--dx', '-10', '--dy', '-120']) as {
        ok: boolean;
      };
      expect(scroll.ok).toBe(true);

      const dragDrop = runHarnessCli([
        'element',
        'drag-drop',
        '--tab-id',
        String(tabId),
        '--from-css',
        '#drag-source',
        '--to-css',
        '#drop-target'
      ]) as { ok: boolean };
      expect(dragDrop.ok).toBe(true);
      await expect(page.locator('#drag-result')).toContainText('drag:drag-source->drop-target');

      const dragDropError = runHarnessCliFailure(['element', 'drag-drop', '--tab-id', String(tabId), '--from-css', '#drag-source']);
      expect(dragDropError).toMatch(/requires both source and target locator options/i);
    } finally {
      await page.close();
    }
  });
});
