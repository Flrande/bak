import { expect, test } from '@playwright/test';
import { runCli } from '../helpers/cli';
import { createHarness, type E2EHarness } from '../helpers/harness';

let harness: E2EHarness | undefined;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function openWorkspacePage(path: string): Promise<void> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }

  const marker = `__workspace=${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const separator = path.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
  const beforePages = new Set(harness.context.pages());
  runCli(['workspace', 'open-tab', '--url', url], harness.rpcPort, harness.dataDir);
  await expect
    .poll(() => harness.context.pages().some((candidate) => !beforePages.has(candidate) && candidate.url().includes(marker)), {
      timeout: 10_000
    })
    .toBe(true);
  const page = must(
    harness.context.pages().find((candidate) => !beforePages.has(candidate) && candidate.url().includes(marker)),
    'Expected workspace page'
  );
  await expect(page.locator('body')).toContainText('Browser Agent Kit Test Site');
}

const HOME_URL = 'http://127.0.0.1:4173/';
const SPA_URL = 'http://127.0.0.1:4173/spa.html';
const NETWORK_URL = 'http://127.0.0.1:4173/network.html';

function captureAndPromoteSpaRoute(goal: string, targetArgs: string[] = []): { id: string } {
  if (!harness) {
    throw new Error('Harness not initialized');
  }

  runCli(['memory', 'capture', 'begin', '--goal', goal, ...targetArgs], harness.rpcPort, harness.dataDir);
  runCli(['element', 'click', '--css', '#goto-spa', ...targetArgs], harness.rpcPort, harness.dataDir);
  runCli(
    ['page', 'wait', '--mode', 'selector', '--value', '#tab-automation', '--timeout-ms', '5000', ...targetArgs],
    harness.rpcPort,
    harness.dataDir
  );
  runCli(['element', 'click', '--css', '#tab-automation', ...targetArgs], harness.rpcPort, harness.dataDir);
  runCli(
    ['page', 'wait', '--mode', 'text', '--value', 'Route: automation', '--timeout-ms', '5000', ...targetArgs],
    harness.rpcPort,
    harness.dataDir
  );
  const ended = runCli<{ drafts: Array<{ id: string; kind: string }> }>(
    ['memory', 'capture', 'end', '--outcome', 'completed', ...targetArgs],
    harness.rpcPort,
    harness.dataDir
  );
  const routeDraft = must(
    ended.drafts.find((draft) => draft.kind === 'route'),
    'Expected a route draft for the remembered path'
  );
  const promoted = runCli<{ memory: { id: string; kind: string } }>(
    ['memory', 'draft', 'promote', routeDraft.id],
    harness.rpcPort,
    harness.dataDir
  );
  expect(promoted.memory.kind).toBe('route');
  return { id: promoted.memory.id };
}

function captureAndPromoteAutomationProcedure(goal: string, taskTitle: string, targetArgs: string[] = []): { id: string } {
  if (!harness) {
    throw new Error('Harness not initialized');
  }

  runCli(['memory', 'capture', 'begin', '--goal', goal, ...targetArgs], harness.rpcPort, harness.dataDir);
  runCli(
    ['memory', 'capture', 'mark', '--label', 'queue automation task', '--role', 'procedure', ...targetArgs],
    harness.rpcPort,
    harness.dataDir
  );
  runCli(['element', 'type', '--css', '#task-input', '--value', taskTitle, '--clear', ...targetArgs], harness.rpcPort, harness.dataDir);
  runCli(['element', 'click', '--css', '#queue-btn', ...targetArgs], harness.rpcPort, harness.dataDir);
  runCli(
    ['page', 'wait', '--mode', 'text', '--value', `queued ${taskTitle}`, '--timeout-ms', '5000', ...targetArgs],
    harness.rpcPort,
    harness.dataDir
  );
  const ended = runCli<{ drafts: Array<{ id: string; kind: string }> }>(
    ['memory', 'capture', 'end', '--outcome', 'completed', ...targetArgs],
    harness.rpcPort,
    harness.dataDir
  );
  const procedureDraft = must(
    ended.drafts.find((draft) => draft.kind === 'procedure'),
    'Expected a procedure draft for the on-page task'
  );
  const promoted = runCli<{ memory: { id: string; kind: string } }>(
    ['memory', 'draft', 'promote', procedureDraft.id],
    harness.rpcPort,
    harness.dataDir
  );
  expect(promoted.memory.kind).toBe('procedure');
  return { id: promoted.memory.id };
}

test.describe('CLI route memory workflows', () => {
  test.beforeEach(async () => {
    harness = await createHarness();
  });

  test.afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  test('captures, stores, searches, explains, plans, and replays a route memory through the CLI', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/');
    try {
      const goal = 'return to the automation console';
      const route = captureAndPromoteSpaRoute(goal, ['--tab-id', String(tabId)]);

      await expect(page).toHaveURL(/\/spa\.html$/);
      await expect(page.locator('#route-label')).toContainText('Route: automation');

      runCli(['page', 'goto', HOME_URL, '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      await expect(page).toHaveURL(HOME_URL);

      const search = runCli<{ candidates: Array<{ memoryId: string; kind: string }> }>(
        ['memory', 'search', '--goal', goal, '--kind', 'route', '--tab-id', String(tabId), '--limit', '5'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(search.candidates).toHaveLength(1);
      expect(search.candidates[0]?.memoryId).toBe(route.id);
      expect(search.candidates[0]?.kind).toBe('route');

      const explain = runCli<{ explanation: { status: string; checks: Array<{ key: string; status: string }> } }>(
        ['memory', 'explain', route.id, '--tab-id', String(tabId)],
        harness.rpcPort,
        harness.dataDir
      );
      expect(explain.explanation.status).toBe('applicable');
      expect(explain.explanation.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'entry-page',
            status: 'pass'
          })
        ])
      );

      const plan = runCli<{ plan: { id: string; kind: string; applicabilityStatus: string; steps: Array<{ sourceKind: string }> } }>(
        ['memory', 'plan', 'create', '--memory-id', route.id, '--tab-id', String(tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(plan.plan.kind).toBe('route');
      expect(plan.plan.applicabilityStatus).toBe('applicable');
      expect(plan.plan.steps.every((step) => step.sourceKind === 'route')).toBe(true);

      const run = runCli<{ run: { status: string; steps: Array<{ status: string }> } }>(
        ['memory', 'execute', plan.plan.id, '--tab-id', String(tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(run.run.status).toBe('completed');
      expect(run.run.steps.every((step) => step.status === 'completed')).toBe(true);

      await expect(page).toHaveURL(SPA_URL);
      await expect(page.locator('#route-label')).toContainText('Route: automation');
      await expect(page.locator('#task-list li')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test('captures and replays a route memory inside the workspace without interrupting the human tab', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openPage('/form.html');
    try {
      const goal = 'return to the automation console through the workspace';

      await openWorkspacePage('/');

      const route = captureAndPromoteSpaRoute(goal);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);

      runCli(['page', 'goto', HOME_URL], harness.rpcPort, harness.dataDir);

      const search = runCli<{ candidates: Array<{ memoryId: string; kind: string }> }>(
        ['memory', 'search', '--goal', goal, '--kind', 'route', '--limit', '5'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(search.candidates[0]?.memoryId).toBe(route.id);

      const explain = runCli<{ explanation: { status: string } }>(['memory', 'explain', route.id], harness.rpcPort, harness.dataDir);
      expect(explain.explanation.status).toBe('applicable');

      const plan = runCli<{ plan: { id: string; kind: string } }>(
        ['memory', 'plan', 'create', '--memory-id', route.id, '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(plan.plan.kind).toBe('route');

      const run = runCli<{ run: { status: string } }>(['memory', 'execute', plan.plan.id, '--mode', 'auto'], harness.rpcPort, harness.dataDir);
      expect(run.run.status).toBe('completed');

      const activeWorkspace = await harness.rpcCall<{ tab: { id: number } | null }>('workspace.getActiveTab');
      const workspaceTabId = must(activeWorkspace.tab?.id, 'Expected workspace tab');
      const workspaceUrl = await harness.rpcCall<{ url: string }>('page.url', { tabId: workspaceTabId });

      expect(workspaceUrl.url).toBe(SPA_URL);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close();
    }
  });

  test('keeps route and procedure memories distinct, then composes them through the CLI to return and finish the task', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/');
    try {
      const routeGoal = 'return to the automation console';
      const procedureGoal = 'queue the nightly backup task';
      const taskTitle = 'Nightly backup task';
      const route = captureAndPromoteSpaRoute(routeGoal, ['--tab-id', String(tabId)]);
      const procedure = captureAndPromoteAutomationProcedure(procedureGoal, taskTitle, ['--tab-id', String(tabId)]);

      await expect(page.locator('#task-list li')).toContainText(taskTitle);

      runCli(['page', 'goto', HOME_URL, '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      await expect(page).toHaveURL(HOME_URL);

      const routeSearch = runCli<{ candidates: Array<{ memoryId: string; kind: string }> }>(
        ['memory', 'search', '--goal', routeGoal, '--kind', 'route', '--tab-id', String(tabId), '--limit', '5'],
        harness.rpcPort,
        harness.dataDir
      );
      const procedureSearch = runCli<{ candidates: Array<{ memoryId: string; kind: string }> }>(
        ['memory', 'search', '--goal', procedureGoal, '--kind', 'procedure', '--url', SPA_URL, '--limit', '5'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(routeSearch.candidates).toHaveLength(1);
      expect(procedureSearch.candidates).toHaveLength(1);
      expect(routeSearch.candidates[0]?.memoryId).toBe(route.id);
      expect(routeSearch.candidates[0]?.kind).toBe('route');
      expect(procedureSearch.candidates[0]?.memoryId).toBe(procedure.id);
      expect(procedureSearch.candidates[0]?.kind).toBe('procedure');

      const plan = runCli<{
        plan: {
          id: string;
          kind: string;
          applicabilityStatus: string;
          steps: Array<{ sourceKind: string }>;
        };
      }>(
        [
          'memory',
          'plan',
          'create',
          '--route-memory-id',
          route.id,
          '--procedure-memory-id',
          procedure.id,
          '--tab-id',
          String(tabId),
          '--mode',
          'auto'
        ],
        harness.rpcPort,
        harness.dataDir
      );
      expect(plan.plan.kind).toBe('composite');
      expect(plan.plan.applicabilityStatus).not.toBe('inapplicable');
      expect(plan.plan.steps.some((step) => step.sourceKind === 'route')).toBe(true);
      expect(plan.plan.steps.some((step) => step.sourceKind === 'procedure')).toBe(true);

      const run = runCli<{ run: { status: string } }>(
        ['memory', 'execute', plan.plan.id, '--tab-id', String(tabId), '--mode', 'auto'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(run.run.status).toBe('completed');

      await expect(page).toHaveURL(SPA_URL);
      await expect(page.locator('#route-label')).toContainText('Route: automation');
      await expect(page.locator('#task-list li')).toContainText(taskTitle);
    } finally {
      await page.close();
    }
  });

  test('reports degraded route applicability when the current page no longer matches the remembered entry point', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/');
    try {
      const goal = 'return to the automation console';
      const route = captureAndPromoteSpaRoute(goal, ['--tab-id', String(tabId)]);

      runCli(['page', 'goto', NETWORK_URL, '--tab-id', String(tabId)], harness.rpcPort, harness.dataDir);
      await expect(page).toHaveURL(NETWORK_URL);

      const explain = runCli<{ explanation: { status: string; checks: Array<{ key: string; status: string }> } }>(
        ['memory', 'explain', route.id, '--tab-id', String(tabId)],
        harness.rpcPort,
        harness.dataDir
      );
      expect(explain.explanation.status).toBe('partial');
      expect(explain.explanation.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'entry-page',
            status: 'warn'
          })
        ])
      );

      const explicitExplain = runCli<{ explanation: { status: string; checks: Array<{ key: string; status: string }> } }>(
        ['memory', 'explain', route.id, '--url', 'https://example.com/not-home'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(explicitExplain.explanation.status).toBe('inapplicable');
      expect(explicitExplain.explanation.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'entry-page',
            status: 'fail'
          })
        ])
      );

      const plan = runCli<{ plan: { applicabilityStatus: string; checks: Array<{ key: string; status: string }> } }>(
        ['memory', 'plan', 'create', '--memory-id', route.id, '--tab-id', String(tabId), '--mode', 'dry-run'],
        harness.rpcPort,
        harness.dataDir
      );
      expect(plan.plan.applicabilityStatus).toBe('partial');
      expect(plan.plan.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'entry-page',
            status: 'warn'
          })
        ])
      );
    } finally {
      await page.close();
    }
  });
});
