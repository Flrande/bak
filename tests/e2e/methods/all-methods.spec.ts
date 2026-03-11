import { expect, test } from '@playwright/test';
import { createHarness, type E2EHarness } from '../helpers/harness';
import { runCli, runCliFailure } from '../helpers/cli';

let harness: E2EHarness | undefined;

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
      const pageUrl = runCli(['page', 'url', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir) as {
        url: string;
      };
      expect(pageUrl.url).toContain('/form.html');

      const snapshot = runCli(['page', 'snapshot', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir) as {
        elementCount: number;
      };
      expect(snapshot.elementCount).toBeGreaterThan(0);

      const pageTitle = runCli(['page', 'title', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir) as {
        title: string;
      };
      expect(pageTitle.title).toContain('Form');

      runCli(['element', 'click', '--tab-id', String(tabId), '--css', '#next-page'], harness.rpcPort, harness.dataDir);
      runCli(
        ['page', 'wait', '--tab-id', String(tabId), '--mode', 'text', '--value', 'Alpha', '--timeout-ms', '5000'],
        harness.rpcPort,
        harness.dataDir
      );
      await expect(page).toHaveURL(/table\.html/);

      const nextPageUrl = runCli(['page', 'url', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir) as {
        url: string;
      };
      const nextPageTitle = runCli(['page', 'title', '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir) as {
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
      const move = runCli(['mouse', 'move', '--tab-id', String(tabId), '--x', '0', '--y', '0'], harness.rpcPort, harness.dataDir) as {
        ok: boolean;
      };
      expect(move.ok).toBe(true);

      const click = runCli(['mouse', 'click', '--tab-id', String(tabId), '--x', '0', '--y', '0'], harness.rpcPort, harness.dataDir) as {
        ok: boolean;
      };
      expect(click.ok).toBe(true);

      const wheel = runCli(['mouse', 'wheel', '--tab-id', String(tabId), '--dx', '-20', '--dy', '-40'], harness.rpcPort, harness.dataDir) as {
        ok: boolean;
      };
      expect(wheel.ok).toBe(true);

      const scroll = runCli(['element', 'scroll', '--tab-id', String(tabId), '--dx', '-10', '--dy', '-120'], harness.rpcPort, harness.dataDir) as {
        ok: boolean;
      };
      expect(scroll.ok).toBe(true);

      const dragDrop = runCli(
        ['element', 'drag-drop', '--tab-id', String(tabId), '--from-css', '#drag-source', '--to-css', '#drop-target'],
        harness.rpcPort,
        harness.dataDir
      ) as { ok: boolean };
      expect(dragDrop.ok).toBe(true);
      await expect(page.locator('#drag-result')).toContainText('drag:drag-source->drop-target');

      const dragDropError = runCliFailure(
        ['element', 'drag-drop', '--tab-id', String(tabId), '--from-css', '#drag-source'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(dragDropError).toMatch(/requires both source and target locator options/i);
    } finally {
      await page.close();
    }
  });
});
