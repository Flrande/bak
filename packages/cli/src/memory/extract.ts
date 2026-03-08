import type {
  CaptureEvent,
  CaptureSession,
  DraftMemory,
  DurableMemory,
  ElementMapItem,
  Locator,
  MemoryApplicabilityCheck,
  MemoryExecutionMode,
  MemoryExplanation,
  MemoryKind,
  MemoryParameterDefinition,
  MemoryPlanStep,
  MemoryRevision,
  MemorySearchCandidate,
  MemoryStep,
  PageFingerprint
} from '@flrande/bak-protocol';

const PROCEDURE_STEP_KINDS = new Set<MemoryStep['kind']>([
  'type',
  'select',
  'check',
  'uncheck',
  'upload',
  'keyboardType',
  'press',
  'hotkey',
  'dragDrop'
]);

const ROUTE_SAFE_STEP_KINDS = new Set<MemoryStep['kind']>([
  'goto',
  'wait',
  'click',
  'hover',
  'scrollTo',
  'scrollIntoView',
  'elementScroll',
  'enterFrame',
  'exitFrame',
  'enterShadow',
  'exitShadow',
  'resetContext',
  'focus',
  'blur'
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function textScore(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const leftSet = new Set(a);
  const rightSet = new Set(b);
  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function safeLocatorLabel(step: MemoryStep): string {
  const locator = step.locator ?? step.targetCandidates?.[0];
  return locator?.name ?? locator?.text ?? locator?.role ?? locator?.css ?? locator?.eid ?? step.url ?? step.waitFor?.value ?? step.kind;
}

function templateRefs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [...value.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => match[1]);
}

function classifyParameterKind(name: string): MemoryParameterDefinition['kind'] {
  const lowered = name.toLowerCase();
  if (
    lowered.includes('password') ||
    lowered.includes('passcode') ||
    lowered.includes('secret') ||
    lowered.includes('token') ||
    lowered.includes('otp') ||
    lowered.includes('pin')
  ) {
    return 'secret';
  }
  if (lowered.includes('file') || lowered.includes('upload')) {
    return 'file';
  }
  if (lowered.startsWith('is_') || lowered.startsWith('has_') || lowered.startsWith('enable_')) {
    return 'boolean';
  }
  return 'text';
}

function inferTextParameterName(step: MemoryStep, index: number): string | null {
  const locator = step.locator ?? step.targetCandidates?.[0];
  const raw = [locator?.name, locator?.text, locator?.css].find((value) => typeof value === 'string' && value.trim().length > 0);
  const seed = raw
    ?.toLowerCase()
    .replace(/[#.[\]]/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!seed) {
    return `input_${index}`;
  }
  return seed.slice(0, 32);
}

function locatorSignal(step: MemoryStep): string {
  const locator = step.locator ?? step.targetCandidates?.[0];
  return [locator?.name, locator?.text, locator?.css, locator?.role].filter((value): value is string => typeof value === 'string').join(' ');
}

function shouldParameterizeCapturedText(step: MemoryStep): boolean {
  if ((step.kind !== 'type' && step.kind !== 'keyboardType') || !step.text || step.text.includes('{{')) {
    return false;
  }

  const signal = locatorSignal(step).toLowerCase();
  return /(password|passcode|otp|token|secret|verification[\s_-]*code|mfa|2fa|pin)\b/.test(signal);
}

function inferParameterSchema(steps: MemoryStep[]): { steps: MemoryStep[]; parameterSchema: Record<string, MemoryParameterDefinition> } {
  const parameterSchema: Record<string, MemoryParameterDefinition> = {};
  let counter = 1;

  const normalizedSteps = steps.map((step) => {
    const copy: MemoryStep = {
      ...step,
      targetCandidates: step.targetCandidates ? [...step.targetCandidates] : undefined,
      values: step.values ? [...step.values] : undefined,
      files: step.files ? [...step.files] : undefined,
      framePath: step.framePath ? [...step.framePath] : undefined,
      hostSelectors: step.hostSelectors ? [...step.hostSelectors] : undefined
    };

    if (shouldParameterizeCapturedText(copy)) {
      const name = inferTextParameterName(copy, counter) ?? `input_${counter}`;
      counter += 1;
      copy.text = `{{${name}}}`;
      parameterSchema[name] = {
        kind: classifyParameterKind(name),
        required: true,
        description: `Captured sensitive value for ${safeLocatorLabel(copy)}`
      };
    }

    if (copy.kind === 'upload' && copy.files && copy.files.length > 0) {
      const name = `file_${counter}`;
      counter += 1;
      copy.files = undefined;
      copy.text = `{{${name}}}`;
      parameterSchema[name] = {
        kind: 'file',
        required: true,
        description: `Captured upload payload for ${safeLocatorLabel(copy)}`
      };
    }

    for (const ref of templateRefs(copy.text)) {
      parameterSchema[ref] ??= {
        kind: classifyParameterKind(ref),
        required: true
      };
    }

    return copy;
  });

  return {
    steps: normalizedSteps,
    parameterSchema
  };
}

function draftShape(
  captureSession: CaptureSession,
  kind: MemoryKind,
  steps: MemoryStep[],
  sourceEvents: CaptureEvent[],
  entryFingerprintId?: string,
  targetFingerprintId?: string
): Omit<DraftMemory, 'id' | 'createdAt' | 'status'> {
  const parameterized = inferParameterSchema(steps);
  const title = `${kind}: ${captureSession.goal}`;
  return {
    captureSessionId: captureSession.id,
    kind,
    title,
    goal: captureSession.goal,
    description: `${kind} memory drafted from capture session ${captureSession.id}`,
    steps: parameterized.steps,
    parameterSchema: parameterized.parameterSchema,
    tags: [...new Set([kind, ...captureSession.labels])],
    rationale: [
      `Built from ${sourceEvents.length} captured event(s)`,
      kind === 'route' ? 'Focuses on reaching the target page or feature' : 'Focuses on the on-page task steps'
    ],
    riskNotes: kind === 'procedure' ? ['Review mutating actions before promotion'] : [],
    entryFingerprintId,
    targetFingerprintId,
    sourceEventIds: sourceEvents.map((event) => event.id)
  };
}

export function summarizeStep(step: MemoryStep): string {
  return [step.kind, safeLocatorLabel(step), step.waitFor?.value ?? '', step.url ?? '']
    .filter(Boolean)
    .join(' ')
    .trim();
}

export function splitCompositeSteps(steps: MemoryStep[]): { routeSteps: MemoryStep[]; procedureSteps: MemoryStep[] } {
  const firstProcedureIndex = steps.findIndex((step) => PROCEDURE_STEP_KINDS.has(step.kind));
  const routeSteps =
    firstProcedureIndex > 0
      ? steps.slice(0, firstProcedureIndex)
      : firstProcedureIndex < 0
        ? steps.filter((step) => ROUTE_SAFE_STEP_KINDS.has(step.kind))
        : [];
  const procedureSteps = firstProcedureIndex >= 0 ? steps.slice(firstProcedureIndex) : routeSteps.length === steps.length ? [] : steps;
  return {
    routeSteps,
    procedureSteps
  };
}

export function buildDraftMemories(input: {
  captureSession: CaptureSession;
  events: CaptureEvent[];
  entryFingerprintId?: string;
  targetFingerprintId?: string;
}): Array<Omit<DraftMemory, 'id' | 'createdAt' | 'status'>> {
  const stepEvents = input.events.filter((event) => event.step);
  const markProcedureIndex = input.events.findIndex((event) => event.kind === 'mark' && event.role === 'procedure');
  const explicitProcedureEventId = markProcedureIndex >= 0 ? input.events[markProcedureIndex + 1]?.id : undefined;
  const firstProcedureIndex = stepEvents.findIndex((event) => event.id === explicitProcedureEventId || PROCEDURE_STEP_KINDS.has(event.step!.kind));

  const steps = stepEvents.map((event) => event.step!);
  if (steps.length === 0) {
    return [];
  }

  const drafts: Array<Omit<DraftMemory, 'id' | 'createdAt' | 'status'>> = [];
  const split = splitCompositeSteps(steps);
  const routeSteps = split.routeSteps;
  const procedureSteps = split.procedureSteps;
  const routeEvents = firstProcedureIndex > 0 ? stepEvents.slice(0, firstProcedureIndex) : stepEvents.filter((event) => ROUTE_SAFE_STEP_KINDS.has(event.step!.kind));
  const procedureEvents = firstProcedureIndex >= 0 ? stepEvents.slice(firstProcedureIndex) : stepEvents.slice(routeEvents.length);

  if (routeSteps.length > 0) {
    drafts.push(draftShape(input.captureSession, 'route', routeSteps, routeEvents, input.entryFingerprintId, input.targetFingerprintId));
  }
  if (procedureSteps.length > 0) {
    drafts.push(draftShape(input.captureSession, 'procedure', procedureSteps, procedureEvents, input.targetFingerprintId ?? input.entryFingerprintId, input.targetFingerprintId));
  }
  if (routeSteps.length > 0 && procedureSteps.length > 0) {
    drafts.push(draftShape(input.captureSession, 'composite', steps, stepEvents, input.entryFingerprintId, input.targetFingerprintId));
  }

  if (drafts.length === 0) {
    drafts.push(draftShape(input.captureSession, 'procedure', steps, stepEvents, input.entryFingerprintId, input.targetFingerprintId));
  }

  return drafts;
}

function fingerprintScore(expected: PageFingerprint | undefined, current: PageFingerprint | undefined): { score: number; reasons: string[] } {
  if (!expected || !current) {
    return { score: 0.2, reasons: ['current page fingerprint unavailable'] };
  }

  const reasons: string[] = [];
  const domain = expected.origin && current.origin && expected.origin === current.origin ? 1 : 0;
  if (domain > 0) {
    reasons.push('same site origin');
  }

  const path = expected.path && current.path ? textScore(expected.path, current.path) : 0;
  if (path > 0.5) {
    reasons.push('similar page path');
  }

  const title = textScore(expected.title, current.title);
  if (title > 0.5) {
    reasons.push('similar page title');
  }

  const anchor = expected.anchorNames.length > 0 ? Math.max(...expected.anchorNames.map((value) => textScore(value, current.anchorNames.join(' ')))) : 0;
  if (anchor > 0.35) {
    reasons.push('matching page anchors');
  }

  return {
    score: domain * 0.35 + path * 0.3 + title * 0.2 + anchor * 0.15,
    reasons
  };
}

function contextScoreForKind(
  kind: MemoryKind,
  entryFit: { score: number; reasons: string[] },
  targetFit: { score: number; reasons: string[] }
): number {
  switch (kind) {
    case 'route':
      return entryFit.score * 0.8 + targetFit.score * 0.2;
    case 'procedure':
      return targetFit.score * 0.8 + entryFit.score * 0.2;
    case 'composite':
      return entryFit.score * 0.45 + targetFit.score * 0.55;
    default:
      return (entryFit.score + targetFit.score) / 2;
  }
}

function whyMatchedForKind(
  kind: MemoryKind,
  entryFit: { score: number; reasons: string[] },
  targetFit: { score: number; reasons: string[] }
): string[] {
  if (kind === 'route') {
    return [
      ...(entryFit.reasons.length > 0 ? ['current page resembles the route entry'] : []),
      ...entryFit.reasons,
      ...(targetFit.reasons.length > 0 ? ['target page fingerprint is known'] : [])
    ];
  }

  if (kind === 'procedure') {
    return [
      ...(targetFit.reasons.length > 0 ? ['current page resembles the procedure target'] : []),
      ...targetFit.reasons,
      ...entryFit.reasons
    ];
  }

  return [
    ...(entryFit.reasons.length > 0 ? ['current page resembles the composite entry'] : []),
    ...entryFit.reasons,
    ...targetFit.reasons
  ];
}

export function rankMemories(input: {
  goal: string;
  kind?: MemoryKind;
  currentFingerprint?: PageFingerprint;
  revisions: Array<{
    memory: DurableMemory;
    revision: MemoryRevision;
    entryFingerprint?: PageFingerprint;
    targetFingerprint?: PageFingerprint;
    stats?: { runs: number; successRate: number; freshScore: number; stabilityScore: number };
  }>;
  limit?: number;
}): MemorySearchCandidate[] {
  const candidates = input.revisions
    .filter((item) => item.memory.status !== 'deleted')
    .filter((item) => !input.kind || item.memory.kind === input.kind)
    .map((item) => {
      const goalScore = Math.max(textScore(item.memory.goal, input.goal), textScore(item.memory.title, input.goal));
      const entryFit = fingerprintScore(item.entryFingerprint, input.currentFingerprint);
      const targetFit = fingerprintScore(item.targetFingerprint, input.currentFingerprint);
      const contextScore = contextScoreForKind(item.memory.kind, entryFit, targetFit);
      const kindScore = input.kind ? 1 : item.memory.kind === 'route' ? 0.97 : item.memory.kind === 'procedure' ? 0.94 : 0.91;
      const stats = item.stats ?? { runs: 0, successRate: 0.5, freshScore: 0.4, stabilityScore: 0.4 };
      const score =
        kindScore * 0.1 +
        goalScore * 0.35 +
        contextScore * 0.35 +
        stats.successRate * 0.1 +
        stats.freshScore * 0.05 +
        stats.stabilityScore * 0.05;

      const whyMatched = [
        ...(goalScore > 0 ? ['goal text is similar'] : []),
        ...whyMatchedForKind(item.memory.kind, entryFit, targetFit)
      ];
      const risks = item.memory.kind === 'procedure' ? ['procedure memories may mutate page state'] : [];
      const warnings = [
        ...(stats.runs === 0 ? ['no prior execution history'] : []),
        ...(contextScore < 0.25 ? ['current page fit is weak for this memory kind'] : [])
      ];
      return {
        memoryId: item.memory.id,
        revisionId: item.revision.id,
        kind: item.memory.kind,
        title: item.memory.title,
        goal: item.memory.goal,
        score: Number(score.toFixed(4)),
        whyMatched: whyMatched.length > 0 ? whyMatched : ['limited evidence match'],
        risks,
        warnings
      } satisfies MemorySearchCandidate;
    })
    .sort((left, right) => right.score - left.score || right.title.localeCompare(left.title));

  return candidates.slice(0, Math.max(1, input.limit ?? 10));
}

export function explainMemoryApplicability(input: {
  memory: DurableMemory;
  revision: MemoryRevision;
  currentFingerprint?: PageFingerprint;
  entryFingerprint?: PageFingerprint;
  targetFingerprint?: PageFingerprint;
}): MemoryExplanation {
  const checks: MemoryApplicabilityCheck[] = [];
  const current = input.currentFingerprint;
  const entry = input.entryFingerprint;
  const target = input.targetFingerprint;

  if (!current) {
    checks.push({ key: 'page', status: 'warn', detail: 'current page fingerprint unavailable' });
  }

  if (input.memory.kind === 'procedure') {
    const targetScore = fingerprintScore(target, current);
    checks.push({
      key: 'target-page',
      status: targetScore.score >= 0.5 ? 'pass' : targetScore.score >= 0.25 ? 'warn' : 'fail',
      detail: targetScore.reasons.join(', ') || 'target page fit is weak'
    });
  } else {
    const entryScore = fingerprintScore(entry, current);
    checks.push({
      key: 'entry-page',
      status: entryScore.score >= 0.45 ? 'pass' : entryScore.score >= 0.2 ? 'warn' : 'fail',
      detail: entryScore.reasons.join(', ') || 'entry page fit is weak'
    });
  }

  const mutatingSteps = input.revision.steps.filter((step) => PROCEDURE_STEP_KINDS.has(step.kind)).length;
  checks.push({
    key: 'mutating-steps',
    status: mutatingSteps === 0 ? 'pass' : 'warn',
    detail: `${mutatingSteps} step(s) may mutate page state`
  });

  const failed = checks.some((check) => check.status === 'fail');
  const warned = checks.some((check) => check.status === 'warn');
  return {
    status: failed ? 'inapplicable' : warned ? 'partial' : 'applicable',
    summary: failed ? 'memory does not fit the current page' : warned ? 'memory may apply with caution' : 'memory fits the current page',
    whyMatched: [`${input.memory.kind} memory for ${input.memory.goal}`],
    risks: mutatingSteps > 0 ? ['contains mutating steps'] : [],
    warnings: checks.filter((check) => check.status === 'warn').map((check) => check.detail),
    checks,
    currentPageFingerprint: current
  };
}

export function buildPlanSteps(args: {
  memoryId?: string;
  compositeRevision?: MemoryRevision;
  routeMemoryId?: string;
  routeRevision?: MemoryRevision;
  procedureMemoryId?: string;
  procedureRevision?: MemoryRevision;
  mode: MemoryExecutionMode;
}): MemoryPlanStep[] {
  const output: MemoryPlanStep[] = [];

  const pushRevision = (sourceMemoryId: string | undefined, sourceKind: MemoryKind, revision: MemoryRevision | undefined): void => {
    if (!sourceMemoryId || !revision) {
      return;
    }
    for (const step of revision.steps) {
      const assistBehavior =
        args.mode === 'assist' &&
        sourceKind === 'procedure' &&
        PROCEDURE_STEP_KINDS.has(step.kind)
          ? 'pause'
          : 'execute';
      output.push({
        ...step,
        index: output.length,
        sourceMemoryId,
        sourceRevisionId: revision.id,
        sourceKind,
        assistBehavior
      });
    }
  };

  if (args.memoryId && args.compositeRevision) {
    for (const step of args.compositeRevision.steps) {
      output.push({
        ...step,
        index: output.length,
        sourceMemoryId: args.memoryId,
        sourceRevisionId: args.compositeRevision.id,
        sourceKind: 'composite',
        assistBehavior: args.mode === 'assist' && PROCEDURE_STEP_KINDS.has(step.kind) ? 'pause' : 'execute'
      });
    }
    return output;
  }

  pushRevision(args.routeMemoryId, 'route', args.routeRevision);
  pushRevision(args.procedureMemoryId, 'procedure', args.procedureRevision);

  return output;
}

export function buildPatchedRevision(args: {
  base: MemoryRevision;
  replacementLocators: Array<{ stepIndex: number; locatorCandidates: MemoryStep['targetCandidates'] }>;
  changeSummary: string[];
}): Omit<MemoryRevision, 'id' | 'createdAt' | 'revision' | 'memoryId'> {
  const updatedSteps = args.base.steps.map((step, index) => {
    const replacement = args.replacementLocators.find((item) => item.stepIndex === index);
    if (!replacement) {
      return {
        ...step,
        targetCandidates: step.targetCandidates ? [...step.targetCandidates] : undefined
      };
    }
    return {
      ...step,
      locator: replacement.locatorCandidates?.[0] ?? step.locator,
      targetCandidates: replacement.locatorCandidates ? [...replacement.locatorCandidates] : step.targetCandidates
    };
  });

  return {
    kind: args.base.kind,
    title: args.base.title,
    goal: args.base.goal,
    description: args.base.description,
    steps: updatedSteps,
    parameterSchema: { ...args.base.parameterSchema },
    entryFingerprintId: args.base.entryFingerprintId,
    targetFingerprintId: args.base.targetFingerprintId,
    tags: [...args.base.tags],
    rationale: [...args.base.rationale],
    riskNotes: [...args.base.riskNotes],
    changeSummary: [...args.changeSummary],
    createdFromDraftId: undefined,
    supersedesRevisionId: args.base.id
  };
}

export function rankCandidateLocators(elements: ElementMapItem[], candidateLocators: Locator[], limit = 3): Locator[] {
  const scored = elements
    .map((element) => {
      let score = 0;
      for (const locator of candidateLocators) {
        if (locator.eid && locator.eid === element.eid) {
          score += 4;
        }
        if (locator.role && element.role && locator.role.toLowerCase() === element.role.toLowerCase()) {
          score += 1;
        }
        if (locator.name) {
          score += textScore(locator.name, element.name) * 2;
        }
        if (locator.text) {
          score += textScore(locator.text, element.text) * 1.5;
        }
        if (locator.css && element.selectors.css && locator.css === element.selectors.css) {
          score += 2;
        }
      }
      return { element, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return scored.map((item) => ({
    eid: item.element.eid,
    role: item.element.role ?? undefined,
    name: item.element.name || undefined,
    text: item.element.text || undefined,
    css: item.element.selectors.css ?? undefined
  }));
}
