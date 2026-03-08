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

  test('exercises first-class browser and memory commands for the new route-memory flow', async () => {
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

      const started = runCli(
        ['memory', 'capture', 'begin', '--goal', 'go to next page', '--tab-id', String(tabId)],
        harness.rpcPort,
        harness.dataDir
      ) as { captureSession: { id: string } };
      expect(started.captureSession.id).toBeTruthy();

      runCli(['element', 'click', '--tab-id', String(tabId), '--css', '#next-page'], harness.rpcPort, harness.dataDir);
      runCli(
        ['page', 'wait', '--tab-id', String(tabId), '--mode', 'text', '--value', 'Alpha', '--timeout-ms', '5000'],
        harness.rpcPort,
        harness.dataDir
      );
      await expect(page).toHaveURL(/table\.html/);

      const ended = runCli(
        ['memory', 'capture', 'end', '--tab-id', String(tabId), '--outcome', 'completed'],
        harness.rpcPort,
        harness.dataDir
      ) as { drafts: Array<{ id: string; kind: string }> };
      const routeDraft = ended.drafts.find((draft) => draft.kind === 'route');
      expect(routeDraft).toBeTruthy();

      const promoted = routeDraft
        ? (runCli(['memory', 'draft', 'promote', routeDraft.id], harness.rpcPort, harness.dataDir) as { memory: { id: string } })
        : null;
      expect(promoted?.memory.id).toBeTruthy();

      const search = runCli(
        ['memory', 'search', '--goal', 'go to next page', '--url', 'http://127.0.0.1:4173/table.html', '--limit', '5'],
        harness.rpcPort,
        harness.dataDir
      ) as { candidates: Array<{ memoryId: string }> };
      expect(search.candidates.some((candidate) => candidate.memoryId === promoted?.memory.id)).toBe(true);

      const explain = promoted
        ? (runCli(['memory', 'explain', promoted.memory.id, '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir) as {
            explanation: { status: string; checks: unknown[] };
          })
        : null;
      expect(explain?.explanation.checks.length).toBeGreaterThan(0);

      const plan = promoted
        ? (runCli(
            ['memory', 'plan', 'create', '--memory-id', promoted.memory.id, '--tab-id', String(tabId), '--mode', 'dry-run'],
            harness.rpcPort,
            harness.dataDir
          ) as { plan: { id: string; kind: string } })
        : null;
      expect(plan?.plan.kind).toBe('route');

      const run = plan
        ? (runCli(['memory', 'execute', plan.plan.id, '--tab-id', String(tabId), '--mode', 'dry-run'], harness.rpcPort, harness.dataDir) as {
            run: { id: string; status: string; steps: Array<{ status: string }> };
          })
        : null;
      expect(run?.run.status).toBe('completed');
      expect(run?.run.steps.every((step) => step.status === 'dry-run')).toBe(true);

      const runs = promoted
        ? (runCli(['memory', 'run', 'list', '--memory-id', promoted.memory.id], harness.rpcPort, harness.dataDir) as {
            runs: Array<{ id: string }>;
          })
        : null;
      expect(runs?.runs.some((item) => item.id === run?.run.id)).toBe(true);
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
