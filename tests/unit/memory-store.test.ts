import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, createMemoryStoreResolved, exportMemory } from '../../packages/cli/src/memory/factory.js';

describe('sqlite memory store', () => {
  it('persists the new memory lifecycle entities and exports a full snapshot', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-memory-store-'));
    const store = createMemoryStore({ dataDir });

    const fingerprint = store.createPageFingerprint({
      url: 'https://portal.local/deployments/new',
      origin: 'https://portal.local',
      path: '/deployments/new',
      title: 'New Deployment',
      headings: ['New Deployment'],
      textSnippets: ['Queue deployment'],
      anchorNames: ['Deployment Name', 'Queue deployment'],
      dom: {
        totalElements: 20,
        interactiveElements: 5,
        iframes: 0,
        shadowHosts: 0,
        tagHistogram: [{ tag: 'button', count: 2 }]
      },
      capturedAt: '2026-03-08T00:00:00.000Z'
    });
    const capture = store.createCaptureSession({
      goal: 'queue deployment',
      tabId: 1,
      outcome: undefined,
      endedAt: undefined,
      startFingerprintId: fingerprint.id,
      endFingerprintId: undefined,
      labels: ['ops']
    });
    const event = store.createCaptureEvent({
      captureSessionId: capture.id,
      kind: 'type',
      step: {
        kind: 'type',
        locator: { css: '#deployment-name', name: 'Deployment Name' },
        text: '{{deployment_name}}',
        clear: true
      }
    });
    const draft = store.createDraftMemory({
      captureSessionId: capture.id,
      kind: 'procedure',
      title: 'procedure: queue deployment',
      goal: 'queue deployment',
      description: 'drafted from capture',
      steps: [event.step!],
      parameterSchema: {
        deployment_name: {
          kind: 'text',
          required: true
        }
      },
      tags: ['procedure'],
      rationale: ['Built from capture'],
      riskNotes: ['Review mutating actions before promotion'],
      entryFingerprintId: fingerprint.id,
      targetFingerprintId: fingerprint.id,
      sourceEventIds: [event.id]
    });
    const memory = store.createMemory({
      kind: 'procedure',
      title: 'Queue deployment',
      goal: 'queue deployment',
      description: 'fills deployment form',
      tags: ['ops', 'procedure']
    });
    const revision = store.createRevision({
      memoryId: memory.id,
      kind: 'procedure',
      title: memory.title,
      goal: memory.goal,
      description: memory.description,
      steps: draft.steps,
      parameterSchema: draft.parameterSchema,
      entryFingerprintId: draft.entryFingerprintId,
      targetFingerprintId: draft.targetFingerprintId,
      tags: memory.tags,
      rationale: draft.rationale,
      riskNotes: draft.riskNotes,
      changeSummary: ['Initial revision promoted from draft'],
      createdFromDraftId: draft.id,
      supersedesRevisionId: undefined
    });
    const plan = store.createPlan({
      kind: 'procedure',
      mode: 'assist',
      status: 'ready',
      routeRevisionId: undefined,
      procedureRevisionId: revision.id,
      revisionIds: [revision.id],
      parameters: { deployment_name: 'March rollout' },
      entryFingerprintId: fingerprint.id,
      targetFingerprintId: fingerprint.id,
      applicabilityStatus: 'applicable',
      applicabilitySummary: 'memory fits the current page',
      checks: [{ key: 'target-page', status: 'pass', detail: 'same site origin' }],
      steps: [
        {
          ...revision.steps[0]!,
          index: 0,
          sourceMemoryId: memory.id,
          sourceRevisionId: revision.id,
          sourceKind: 'procedure',
          assistBehavior: 'pause'
        }
      ]
    });
    const run = store.createRun({
      planId: plan.id,
      mode: 'assist',
      status: 'blocked',
      revisionIds: [revision.id],
      endedAt: '2026-03-08T00:02:00.000Z',
      patchSuggestionIds: [],
      resultSummary: 'Assist mode paused before step 0',
      steps: [
        {
          index: 0,
          kind: 'type',
          sourceMemoryId: memory.id,
          sourceRevisionId: revision.id,
          sourceKind: 'procedure',
          status: 'blocked',
          detail: 'assist mode paused before a mutating step'
        }
      ]
    });
    const patch = store.createPatchSuggestion({
      memoryId: memory.id,
      baseRevisionId: revision.id,
      title: 'Patch Queue deployment step 0',
      summary: 'Suggested replacement locator',
      reason: 'Target not found',
      affectedStepIndexes: [0],
      changeSummary: ['Patched locator candidates for step 0'],
      proposedRevision: {
        kind: revision.kind,
        title: revision.title,
        goal: revision.goal,
        description: revision.description,
        steps: revision.steps,
        parameterSchema: revision.parameterSchema,
        entryFingerprintId: revision.entryFingerprintId,
        targetFingerprintId: revision.targetFingerprintId,
        tags: revision.tags,
        rationale: revision.rationale,
        riskNotes: revision.riskNotes
      }
    });

    expect(store.getPageFingerprint(fingerprint.id)?.id).toBe(fingerprint.id);
    expect(store.listCaptureSessions().map((item) => item.id)).toContain(capture.id);
    expect(store.listCaptureEvents(capture.id).map((item) => item.id)).toContain(event.id);
    expect(store.getDraftMemory(draft.id)?.id).toBe(draft.id);
    expect(store.getMemory(memory.id)?.latestRevisionId).toBe(revision.id);
    expect(store.listRevisions(memory.id)).toHaveLength(1);
    expect(store.getPlan(plan.id)?.id).toBe(plan.id);
    expect(store.listRuns({ planId: plan.id })[0]?.id).toBe(run.id);
    expect(store.getPatchSuggestion(patch.id)?.id).toBe(patch.id);

    const exported = exportMemory(store);
    expect(exported.backend).toBe('sqlite');
    expect(exported.pageFingerprints).toHaveLength(1);
    expect(exported.captureSessions).toHaveLength(1);
    expect(exported.captureEvents).toHaveLength(1);
    expect(exported.drafts).toHaveLength(1);
    expect(exported.memories).toHaveLength(1);
    expect(exported.revisions).toHaveLength(1);
    expect(exported.plans).toHaveLength(1);
    expect(exported.runs).toHaveLength(1);
    expect(exported.patches).toHaveLength(1);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves sqlite as the only supported backend', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-memory-resolution-'));
    const resolved = createMemoryStoreResolved({ dataDir });

    expect(resolved.requestedBackend).toBe('sqlite');
    expect(resolved.backend).toBe('sqlite');
    resolved.store.close?.();

    rmSync(dataDir, { recursive: true, force: true });
  });
});
