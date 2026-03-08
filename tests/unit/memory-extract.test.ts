import { describe, expect, it } from 'vitest';
import type {
  CaptureEvent,
  CaptureSession,
  DurableMemory,
  ElementMapItem,
  MemoryRevision,
  PageFingerprint
} from '@flrande/bak-protocol';
import {
  buildDraftMemories,
  buildPlanSteps,
  explainMemoryApplicability,
  rankCandidateLocators,
  rankMemories
} from '../../packages/cli/src/memory/extract.js';

function createFingerprint(input: Partial<PageFingerprint> & Pick<PageFingerprint, 'id' | 'url'>): PageFingerprint {
  const parsed = new URL(input.url);
  return {
    id: input.id,
    url: input.url,
    origin: input.origin ?? parsed.origin,
    path: input.path ?? parsed.pathname,
    title: input.title ?? 'Demo',
    headings: input.headings ?? [],
    textSnippets: input.textSnippets ?? [],
    anchorNames: input.anchorNames ?? [],
    dom: input.dom ?? {
      totalElements: 10,
      interactiveElements: 3,
      iframes: 0,
      shadowHosts: 0,
      tagHistogram: [{ tag: 'button', count: 2 }]
    },
    capturedAt: input.capturedAt ?? '2026-03-08T00:00:00.000Z'
  };
}

function createMemory(input: Partial<DurableMemory> & Pick<DurableMemory, 'id' | 'kind' | 'goal' | 'title'>): DurableMemory {
  return {
    id: input.id,
    kind: input.kind,
    status: input.status ?? 'active',
    title: input.title,
    goal: input.goal,
    description: input.description ?? input.goal,
    tags: input.tags ?? [],
    latestRevisionId: input.latestRevisionId ?? `${input.id}_rev_1`,
    createdAt: input.createdAt ?? '2026-03-08T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-08T00:00:00.000Z',
    deprecatedReason: input.deprecatedReason
  };
}

function createRevision(input: Partial<MemoryRevision> & Pick<MemoryRevision, 'id' | 'memoryId' | 'kind' | 'goal' | 'title'>): MemoryRevision {
  return {
    id: input.id,
    memoryId: input.memoryId,
    revision: input.revision ?? 1,
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    description: input.description ?? input.goal,
    steps: input.steps ?? [],
    parameterSchema: input.parameterSchema ?? {},
    entryFingerprintId: input.entryFingerprintId,
    targetFingerprintId: input.targetFingerprintId,
    tags: input.tags ?? [],
    rationale: input.rationale ?? [],
    riskNotes: input.riskNotes ?? [],
    changeSummary: input.changeSummary ?? ['Initial revision'],
    createdAt: input.createdAt ?? '2026-03-08T00:00:00.000Z',
    createdFromDraftId: input.createdFromDraftId,
    supersedesRevisionId: input.supersedesRevisionId
  };
}

describe('memory extraction helpers', () => {
  it('splits captured events into route, procedure, and composite drafts', () => {
    const captureSession: CaptureSession = {
      id: 'capture_1',
      goal: 'queue automation task',
      status: 'ended',
      outcome: 'completed',
      tabId: 1,
      startedAt: '2026-03-08T00:00:00.000Z',
      endedAt: '2026-03-08T00:05:00.000Z',
      startFingerprintId: 'fp_start',
      endFingerprintId: 'fp_end',
      labels: ['spa'],
      eventCount: 5
    };
    const events: CaptureEvent[] = [
      {
        id: 'evt_1',
        captureSessionId: captureSession.id,
        at: '2026-03-08T00:00:10.000Z',
        kind: 'goto',
        step: { kind: 'goto', url: 'https://portal.local/spa' }
      },
      {
        id: 'evt_2',
        captureSessionId: captureSession.id,
        at: '2026-03-08T00:00:20.000Z',
        kind: 'click',
        step: { kind: 'click', locator: { css: '#tab-automation', text: 'Automation' } }
      },
      {
        id: 'evt_3',
        captureSessionId: captureSession.id,
        at: '2026-03-08T00:00:30.000Z',
        kind: 'mark',
        label: 'start procedure',
        role: 'procedure'
      },
      {
        id: 'evt_4',
        captureSessionId: captureSession.id,
        at: '2026-03-08T00:00:40.000Z',
        kind: 'type',
        step: { kind: 'type', locator: { css: '#task-input', name: 'Task title' }, text: 'Daily backup', clear: true }
      },
      {
        id: 'evt_5',
        captureSessionId: captureSession.id,
        at: '2026-03-08T00:00:50.000Z',
        kind: 'click',
        step: { kind: 'click', locator: { css: '#queue-btn', text: 'Queue task' } }
      }
    ];

    const drafts = buildDraftMemories({
      captureSession,
      events,
      entryFingerprintId: 'fp_start',
      targetFingerprintId: 'fp_end'
    });

    expect(drafts.map((draft) => draft.kind)).toEqual(['route', 'procedure', 'composite']);
    expect(drafts[0]?.steps.map((step) => step.kind)).toEqual(['goto', 'click']);
    expect(drafts[1]?.steps.map((step) => step.kind)).toEqual(['type', 'click']);
    expect(drafts[1]?.steps[0]?.text).toBe('Daily backup');
    expect(Object.keys(drafts[1]?.parameterSchema ?? {})).toEqual([]);
    expect(drafts[2]?.steps).toHaveLength(4);
  });

  it('parameterizes clearly sensitive captured text while keeping ordinary text literal', () => {
    const captureSession: CaptureSession = {
      id: 'capture_sensitive',
      goal: 'sign in',
      status: 'ended',
      outcome: 'completed',
      startedAt: '2026-03-08T00:00:00.000Z',
      endedAt: '2026-03-08T00:01:00.000Z',
      labels: [],
      eventCount: 2
    };
    const drafts = buildDraftMemories({
      captureSession,
      events: [
        {
          id: 'evt_sensitive_1',
          captureSessionId: captureSession.id,
          at: '2026-03-08T00:00:05.000Z',
          kind: 'type',
          step: { kind: 'type', locator: { css: '#email', name: 'Email address' }, text: 'agent@example.test', clear: true }
        },
        {
          id: 'evt_sensitive_2',
          captureSessionId: captureSession.id,
          at: '2026-03-08T00:00:10.000Z',
          kind: 'type',
          step: { kind: 'type', locator: { css: '#password', name: 'Account password' }, text: 'super-secret', clear: true }
        }
      ]
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.steps[0]?.text).toBe('agent@example.test');
    expect(drafts[0]?.steps[1]?.text).toBe('{{account_password}}');
    expect(drafts[0]?.parameterSchema.account_password).toMatchObject({
      kind: 'secret',
      required: true
    });
  });

  it('ranks candidate locators by eid and semantic fit', () => {
    const elements: ElementMapItem[] = [
      {
        eid: 'eid_save',
        tag: 'button',
        role: 'button',
        name: 'Save',
        text: 'Save',
        bbox: { x: 10, y: 20, width: 80, height: 28 },
        selectors: { css: '#save-btn', text: 'Save', aria: 'button:Save' },
        risk: 'low'
      },
      {
        eid: 'eid_cancel',
        tag: 'button',
        role: 'button',
        name: 'Cancel',
        text: 'Cancel',
        bbox: { x: 10, y: 60, width: 80, height: 28 },
        selectors: { css: '#cancel-btn', text: 'Cancel', aria: 'button:Cancel' },
        risk: 'low'
      }
    ];

    const ranked = rankCandidateLocators(elements, [{ eid: 'eid_save' }, { text: 'Save changes' }], 2);

    expect(ranked[0]).toMatchObject({ eid: 'eid_save', css: '#save-btn' });
    expect(ranked).toHaveLength(1);
  });

  it('ranks memories using goal, kind, and page fingerprint fit', () => {
    const current = createFingerprint({
      id: 'fp_current',
      url: 'https://portal.local/settings/billing',
      title: 'Billing Settings',
      anchorNames: ['Billing', 'Invoices']
    });
    const billingTarget = createFingerprint({
      id: 'fp_billing',
      url: 'https://portal.local/settings/billing',
      title: 'Billing Settings',
      anchorNames: ['Billing', 'Invoices']
    });
    const supportTarget = createFingerprint({
      id: 'fp_support',
      url: 'https://portal.local/support',
      title: 'Support Center',
      anchorNames: ['Support']
    });

    const ranked = rankMemories({
      goal: 'open billing settings',
      kind: 'route',
      currentFingerprint: current,
      revisions: [
        {
          memory: createMemory({
            id: 'memory_billing',
            kind: 'route',
            goal: 'open billing settings',
            title: 'Billing route'
          }),
          revision: createRevision({
            id: 'rev_billing',
            memoryId: 'memory_billing',
            kind: 'route',
            goal: 'open billing settings',
            title: 'Billing route'
          }),
          targetFingerprint: billingTarget,
          stats: { runs: 4, successRate: 1, freshScore: 1, stabilityScore: 1 }
        },
        {
          memory: createMemory({
            id: 'memory_support',
            kind: 'route',
            goal: 'open support center',
            title: 'Support route'
          }),
          revision: createRevision({
            id: 'rev_support',
            memoryId: 'memory_support',
            kind: 'route',
            goal: 'open support center',
            title: 'Support route'
          }),
          targetFingerprint: supportTarget,
          stats: { runs: 1, successRate: 0.5, freshScore: 0.5, stabilityScore: 0.5 }
        }
      ]
    });

    expect(ranked[0]?.memoryId).toBe('memory_billing');
    expect(ranked[0]?.whyMatched).toContain('goal text is similar');
  });

  it('prefers route memories when the current page matches the remembered entry point better than the procedure target', () => {
    const home = createFingerprint({
      id: 'fp_home',
      url: 'https://portal.local/',
      title: 'Home',
      anchorNames: ['SPA async page', 'Upload page']
    });
    const automation = createFingerprint({
      id: 'fp_spa',
      url: 'https://portal.local/spa.html',
      title: 'Automation Console',
      anchorNames: ['Automation', 'Queue Task']
    });

    const ranked = rankMemories({
      goal: 'open automation console',
      currentFingerprint: home,
      revisions: [
        {
          memory: createMemory({
            id: 'route_memory',
            kind: 'route',
            goal: 'open automation console',
            title: 'Route to automation console'
          }),
          revision: createRevision({
            id: 'route_rev',
            memoryId: 'route_memory',
            kind: 'route',
            goal: 'open automation console',
            title: 'Route to automation console'
          }),
          entryFingerprint: home,
          targetFingerprint: automation,
          stats: { runs: 2, successRate: 1, freshScore: 1, stabilityScore: 1 }
        },
        {
          memory: createMemory({
            id: 'procedure_memory',
            kind: 'procedure',
            goal: 'open automation console',
            title: 'Queue task in automation console'
          }),
          revision: createRevision({
            id: 'procedure_rev',
            memoryId: 'procedure_memory',
            kind: 'procedure',
            goal: 'open automation console',
            title: 'Queue task in automation console'
          }),
          entryFingerprint: automation,
          targetFingerprint: automation,
          stats: { runs: 2, successRate: 1, freshScore: 1, stabilityScore: 1 }
        }
      ]
    });

    expect(ranked[0]?.memoryId).toBe('route_memory');
    expect(ranked[0]?.kind).toBe('route');
    expect(ranked[0]?.whyMatched).toContain('current page resembles the route entry');
  });

  it('explains applicability with structured reasons and warnings', () => {
    const current = createFingerprint({
      id: 'fp_current',
      url: 'https://portal.local/settings/billing',
      title: 'Billing Settings',
      anchorNames: ['Billing']
    });
    const target = createFingerprint({
      id: 'fp_target',
      url: 'https://portal.local/settings/billing',
      title: 'Billing Settings',
      anchorNames: ['Billing']
    });
    const memory = createMemory({
      id: 'memory_procedure',
      kind: 'procedure',
      goal: 'update billing profile',
      title: 'Update billing profile'
    });
    const revision = createRevision({
      id: 'rev_procedure',
      memoryId: memory.id,
      kind: 'procedure',
      goal: memory.goal,
      title: memory.title,
      targetFingerprintId: target.id,
      steps: [{ kind: 'type', locator: { css: '#name' }, text: '{{name}}' }]
    });

    const explanation = explainMemoryApplicability({
      memory,
      revision,
      currentFingerprint: current,
      targetFingerprint: target
    });

    expect(explanation.status).toBe('partial');
    expect(explanation.checks.some((check) => check.key === 'target-page')).toBe(true);
    expect(explanation.risks).toContain('contains mutating steps');
  });

  it('builds composite plan steps with assist pauses only on procedure mutations', () => {
    const routeRevision = createRevision({
      id: 'rev_route',
      memoryId: 'memory_route',
      kind: 'route',
      goal: 'reach billing page',
      title: 'Reach billing page',
      steps: [
        { kind: 'goto', url: 'https://portal.local/settings' },
        { kind: 'click', locator: { css: '#billing-link' } }
      ]
    });
    const procedureRevision = createRevision({
      id: 'rev_procedure',
      memoryId: 'memory_procedure',
      kind: 'procedure',
      goal: 'update billing name',
      title: 'Update billing name',
      steps: [{ kind: 'type', locator: { css: '#billing-name' }, text: '{{name}}' }]
    });

    const steps = buildPlanSteps({
      routeMemoryId: 'memory_route',
      routeRevision,
      procedureMemoryId: 'memory_procedure',
      procedureRevision,
      mode: 'assist'
    });

    expect(steps.map((step) => step.sourceKind)).toEqual(['route', 'route', 'procedure']);
    expect(steps[0]?.assistBehavior).toBe('execute');
    expect(steps[2]?.assistBehavior).toBe('pause');
  });
});
