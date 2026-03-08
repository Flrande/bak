import { expect, test } from '@playwright/test';
import { createHarness, type E2EHarness } from '../helpers/harness';

let harness: E2EHarness | undefined;

test.describe('memory v3 e2e', () => {
  test.beforeAll(async () => {
    harness = await createHarness();
  });

  test.afterAll(async () => {
    await harness?.dispose();
  });

  test('supports explicit capture, draft review, promotion, search, explain, and conservative execution', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/spa.html');
    try {
      const started = (await harness.rpcCall('memory.capture.begin', {
        goal: 'queue automation task',
        tabId,
        labels: ['spa']
      })) as { captureSession: { id: string } };
      expect(started.captureSession.id).toBeTruthy();

      await harness.rpcCall('element.click', { tabId, locator: { css: '#tab-automation' } });
      await harness.rpcCall('memory.capture.mark', { tabId, label: 'start task entry', role: 'procedure' });
      await harness.rpcCall('element.type', {
        tabId,
        locator: { css: '#task-input' },
        text: 'Nightly backup',
        clear: true
      });
      await harness.rpcCall('element.click', { tabId, locator: { css: '#queue-btn' } });
      await harness.rpcCall('page.wait', { tabId, mode: 'selector', value: '#task-list li[data-task-id="1"]', timeoutMs: 5000 });
      await expect(page.locator('#task-list li').first()).toContainText('Nightly backup');

      const ended = (await harness.rpcCall('memory.capture.end', {
        tabId,
        outcome: 'completed'
      })) as { drafts: Array<{ id: string; kind: 'route' | 'procedure' | 'composite' }> };
      expect(ended.drafts.map((draft) => draft.kind)).toEqual(expect.arrayContaining(['route', 'procedure', 'composite']));

      const routeDraft = ended.drafts.find((draft) => draft.kind === 'route');
      const procedureDraft = ended.drafts.find((draft) => draft.kind === 'procedure');
      const compositeDraft = ended.drafts.find((draft) => draft.kind === 'composite');
      expect(routeDraft).toBeTruthy();
      expect(procedureDraft).toBeTruthy();
      expect(compositeDraft).toBeTruthy();

      const promotedRoute = routeDraft
        ? ((await harness.rpcCall('memory.drafts.promote', { id: routeDraft.id })) as { memory: { id: string } })
        : null;
      const promotedProcedure = procedureDraft
        ? ((await harness.rpcCall('memory.drafts.promote', { id: procedureDraft.id })) as { memory: { id: string } })
        : null;
      const promotedComposite = compositeDraft
        ? ((await harness.rpcCall('memory.drafts.promote', { id: compositeDraft.id })) as { memory: { id: string } })
        : null;
      expect(promotedRoute?.memory.id).toBeTruthy();
      expect(promotedProcedure?.memory.id).toBeTruthy();
      expect(promotedComposite?.memory.id).toBeTruthy();

      const search = (await harness.rpcCall('memory.memories.search', {
        goal: 'queue automation task',
        limit: 5
      })) as { candidates: Array<{ memoryId: string; kind: string }> };
      expect(search.candidates.length).toBeGreaterThan(0);
      expect(search.candidates.some((candidate) => candidate.memoryId === promotedProcedure?.memory.id)).toBe(true);

      const explain = promotedProcedure
        ? ((await harness.rpcCall('memory.memories.explain', {
            id: promotedProcedure.memory.id,
            tabId
          })) as { explanation: { status: string; checks: unknown[] } })
        : null;
      expect(explain?.explanation.checks.length).toBeGreaterThan(0);
      expect(['applicable', 'partial']).toContain(explain?.explanation.status);

      const plan = promotedRoute && promotedProcedure
        ? ((await harness.rpcCall('memory.plans.create', {
            routeMemoryId: promotedRoute.memory.id,
            procedureMemoryId: promotedProcedure.memory.id,
            tabId,
            mode: 'assist',
            parameters: {
              task_input: 'Nightly backup'
            }
          })) as { plan: { id: string; kind: string; steps: Array<{ sourceKind: string }> } })
        : null;
      expect(plan?.plan.kind).toBe('composite');
      expect(plan?.plan.steps.some((step) => step.sourceKind === 'route')).toBe(true);
      expect(plan?.plan.steps.some((step) => step.sourceKind === 'procedure')).toBe(true);

      const directCompositePlan = promotedComposite
        ? ((await harness.rpcCall('memory.plans.create', {
            memoryId: promotedComposite.memory.id,
            tabId,
            mode: 'assist',
            parameters: {
              task_input: 'Nightly backup'
            }
          })) as { plan: { id: string; kind: string; applicabilityStatus: string; checks: Array<{ key: string; status: string }> } })
        : null;
      expect(directCompositePlan?.plan.kind).toBe('composite');
      expect(directCompositePlan?.plan.applicabilityStatus).toBe(plan?.plan.applicabilityStatus);
      expect(directCompositePlan?.plan.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'route-procedure-handoff'
          })
        ])
      );

      const run = plan
        ? ((await harness.rpcCall('memory.plans.execute', {
            id: plan.plan.id,
            tabId,
            mode: 'assist'
          })) as { run: { id: string; status: string; steps: Array<{ status: string }> } })
        : null;
      expect(run?.run.status).toBe('blocked');
      expect(run?.run.steps.some((step) => step.status === 'blocked')).toBe(true);

      const directRun = directCompositePlan
        ? ((await harness.rpcCall('memory.plans.execute', {
            id: directCompositePlan.plan.id,
            tabId,
            mode: 'assist'
          })) as { run: { status: string; steps: Array<{ status: string }> } })
        : null;
      expect(directRun?.run.status).toBe('blocked');
      expect(directRun?.run.steps.some((step) => step.status === 'blocked')).toBe(true);

      const runs = promotedProcedure
        ? ((await harness.rpcCall('memory.runs.list', {
            memoryId: promotedProcedure.memory.id,
            limit: 10
          })) as { runs: Array<{ id: string }> })
        : null;
      expect(runs?.runs.some((item) => item.id === run?.run.id)).toBe(true);
      harness.assertTraceHas('memory.capture.end');
      harness.assertTraceHas('memory.plans.execute');
    } finally {
      await page.close();
    }
  });

  test('keeps route and procedure memories distinct and composes them into a dry-run plan', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page, tabId } = await harness.openPage('/');
    try {
      await harness.rpcCall('memory.capture.begin', { goal: 'open form and fill name', tabId });
      await harness.rpcCall('page.goto', {
        tabId,
        url: 'http://127.0.0.1:4173/form.html'
      });
      await harness.rpcCall('memory.capture.mark', { tabId, label: 'fill name field', role: 'procedure' });
      await harness.rpcCall('element.type', {
        tabId,
        locator: { css: '#name-input', name: 'Name' },
        text: 'Dry Run User',
        clear: true
      });
      const ended = (await harness.rpcCall('memory.capture.end', {
        tabId,
        outcome: 'completed'
      })) as { drafts: Array<{ id: string; kind: string }> };
      const routeDraft = ended.drafts.find((draft) => draft.kind === 'route');
      const procedureDraft = ended.drafts.find((draft) => draft.kind === 'procedure');
      expect(routeDraft).toBeTruthy();
      expect(procedureDraft).toBeTruthy();

      const route = routeDraft
        ? ((await harness.rpcCall('memory.drafts.promote', { id: routeDraft.id })) as { memory: { id: string } })
        : null;
      const procedure = procedureDraft
        ? ((await harness.rpcCall('memory.drafts.promote', { id: procedureDraft.id })) as { memory: { id: string } })
        : null;
      expect(route?.memory.id).toBeTruthy();
      expect(procedure?.memory.id).toBeTruthy();

      const routeSearch = (await harness.rpcCall('memory.memories.search', {
        goal: 'open form and fill name',
        kind: 'route',
        tabId,
        limit: 5
      })) as { candidates: Array<{ memoryId: string }> };
      const procedureSearch = (await harness.rpcCall('memory.memories.search', {
        goal: 'open form and fill name',
        kind: 'procedure',
        tabId,
        limit: 5
      })) as { candidates: Array<{ memoryId: string }> };
      expect(routeSearch.candidates.some((candidate) => candidate.memoryId === route?.memory.id)).toBe(true);
      expect(procedureSearch.candidates.some((candidate) => candidate.memoryId === procedure?.memory.id)).toBe(true);

      const plan = route && procedure
        ? ((await harness.rpcCall('memory.plans.create', {
            routeMemoryId: route.memory.id,
            procedureMemoryId: procedure.memory.id,
            tabId,
            mode: 'dry-run',
            parameters: {
              name: 'Dry Run User'
            }
          })) as { plan: { id: string; kind: string; steps: Array<{ sourceKind: string }> } })
        : null;
      expect(plan?.plan.kind).toBe('composite');
      expect(plan?.plan.steps.some((step) => step.sourceKind === 'route')).toBe(true);
      expect(plan?.plan.steps.some((step) => step.sourceKind === 'procedure')).toBe(true);

      const run = plan
        ? ((await harness.rpcCall('memory.plans.execute', {
            id: plan.plan.id,
            tabId,
            mode: 'dry-run'
          })) as { run: { status: string; steps: Array<{ status: string }> } })
        : null;
      expect(run?.run.status).toBe('completed');
      expect(run?.run.steps.every((step) => step.status === 'dry-run')).toBe(true);
      harness.assertTraceHas('memory.plans.create');
    } finally {
      await page.close();
    }
  });
});
