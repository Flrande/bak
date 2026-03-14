import { existsSync } from 'node:fs';
import type { Locator } from '@flrande/bak-protocol';
import {
  type PolicyAction,
  POLICY_ACTION_VALUES,
  type PolicyDecisionType,
  POLICY_DEFAULT_DECISIONS,
  type PolicyEvaluation,
  type PolicyRule,
  type PolicyTag,
  POLICY_TAG_VALUES,
  PolicyEngine,
  isPolicyAction,
  isPolicyDecisionType,
  isPolicyTag
} from './policy.js';
import { TraceStore, type TraceEntry } from './trace-store.js';
import { resolveDataDir } from './utils.js';

type PolicyDecisionSource = 'rule' | 'default';

export interface PolicyStatusResult {
  policyPath: string;
  exists: boolean;
  ruleCount: number;
  actions: PolicyAction[];
  tags: PolicyTag[];
  defaults: typeof POLICY_DEFAULT_DECISIONS;
}

export interface PolicyPreviewResolvedContext {
  action: PolicyAction;
  domain: string;
  path: string;
  locator: Locator;
  contextSource: 'explicit' | 'session';
}

export interface PolicyPreviewResult {
  resolvedContext: PolicyPreviewResolvedContext;
  decision: PolicyEvaluation['decision'];
  audit: PolicyEvaluation['audit'];
}

export interface PolicyAuditEntry {
  traceId: string;
  ts: string;
  action: PolicyAction;
  decision: PolicyDecisionType;
  reason: string;
  source: PolicyDecisionSource;
  ruleId: string | null;
  domain: string;
  path: string;
  tags: PolicyTag[];
  matchedRuleCount: number;
  defaultDecision: PolicyDecisionType;
}

export interface PolicyAuditSummary {
  total: number;
  byDecision: Partial<Record<PolicyDecisionType, number>>;
  byAction: Partial<Record<PolicyAction, number>>;
  bySource: Partial<Record<PolicyDecisionSource, number>>;
}

export interface PolicyAuditResult {
  summary: PolicyAuditSummary;
  entries: PolicyAuditEntry[];
}

export interface PolicyRecommendationBasis {
  occurrenceCount: number;
  decision: PolicyDecisionType;
  action: PolicyAction;
  domain: string;
  path: string;
  tag: PolicyTag | null;
  traceIds: string[];
}

export interface PolicyRecommendationExample {
  traceId: string;
  ts: string;
  reason: string;
}

export interface PolicyRecommendation {
  rule: PolicyRule;
  basis: PolicyRecommendationBasis;
  examples: PolicyRecommendationExample[];
}

export interface PolicyRecommendResult {
  suggestions: PolicyRecommendation[];
}

export interface PolicyAuditQuery {
  traceId?: string;
  action?: PolicyAction;
  decision?: PolicyDecisionType;
  limit?: number;
}

export interface PolicyRecommendQuery extends PolicyAuditQuery {
  minOccurrences?: number;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function selectPrimaryTag(tags: PolicyTag[]): PolicyTag | null {
  for (const tag of POLICY_TAG_VALUES) {
    if (tags.includes(tag)) {
      return tag;
    }
  }
  return null;
}

function normalizePolicySource(value: unknown): PolicyDecisionSource | null {
  return value === 'rule' || value === 'default' ? value : null;
}

function normalizePolicyAuditEntry(entry: TraceEntry): PolicyAuditEntry | null {
  if (entry.method !== 'policy.decision') {
    return null;
  }
  const params = asRecord(entry.params);
  if (!isPolicyAction(params.action) || !isPolicyDecisionType(params.decision) || !isPolicyDecisionType(params.defaultDecision)) {
    return null;
  }
  const source = normalizePolicySource(params.source);
  if (!source) {
    return null;
  }
  const tags = Array.isArray(params.tags) ? params.tags.filter((tag): tag is PolicyTag => isPolicyTag(tag)) : [];

  return {
    traceId: entry.traceId,
    ts: entry.ts,
    action: params.action,
    decision: params.decision,
    reason: typeof params.reason === 'string' ? params.reason : '',
    source,
    ruleId: typeof params.ruleId === 'string' && params.ruleId.trim().length > 0 ? params.ruleId : null,
    domain: typeof params.domain === 'string' ? params.domain : 'unknown',
    path: typeof params.path === 'string' ? params.path : '/',
    tags,
    matchedRuleCount: typeof params.matchedRuleCount === 'number' && Number.isFinite(params.matchedRuleCount) ? params.matchedRuleCount : 0,
    defaultDecision: params.defaultDecision
  };
}

function listPolicyAuditEntries(dataDir: string, query: PolicyAuditQuery = {}): PolicyAuditEntry[] {
  const traceStore = new TraceStore(dataDir);
  const traceIds = query.traceId ? [query.traceId] : traceStore.listTraceIds();
  const allEntries = traceIds.flatMap((traceId) =>
    traceStore
      .readTrace(traceId)
      .map((entry) => normalizePolicyAuditEntry(entry))
      .filter((entry): entry is PolicyAuditEntry => entry !== null)
  );

  const filtered = allEntries
    .filter((entry) => (query.action ? entry.action === query.action : true))
    .filter((entry) => (query.decision ? entry.decision === query.decision : true))
    .sort((left, right) => right.ts.localeCompare(left.ts) || right.traceId.localeCompare(left.traceId));

  if (typeof query.limit === 'number') {
    return filtered.slice(0, query.limit);
  }
  return filtered;
}

function summarizePolicyAudit(entries: PolicyAuditEntry[]): PolicyAuditSummary {
  const summary: PolicyAuditSummary = {
    total: entries.length,
    byDecision: {},
    byAction: {},
    bySource: {}
  };

  for (const entry of entries) {
    summary.byDecision[entry.decision] = (summary.byDecision[entry.decision] ?? 0) + 1;
    summary.byAction[entry.action] = (summary.byAction[entry.action] ?? 0) + 1;
    summary.bySource[entry.source] = (summary.bySource[entry.source] ?? 0) + 1;
  }

  return summary;
}

function buildSuggestionId(basis: Omit<PolicyRecommendationBasis, 'occurrenceCount' | 'traceIds'>): string {
  return slugify(
    ['trace', basis.decision, basis.action, basis.domain, basis.path, basis.tag ?? 'untagged']
      .filter(Boolean)
      .join('-')
  );
}

function buildSuggestionReason(basis: Omit<PolicyRecommendationBasis, 'occurrenceCount' | 'traceIds'>, occurrenceCount: number): string {
  const tagLabel = basis.tag ? ` (${basis.tag})` : '';
  return `trace-derived suggestion from ${occurrenceCount} default ${basis.decision} decisions on ${basis.domain}${basis.path}${tagLabel}`;
}

export function loadPolicyStatus(dataDir = resolveDataDir()): PolicyStatusResult {
  const engine = new PolicyEngine(dataDir);
  const description = engine.describe();
  return {
    policyPath: description.policyPath,
    exists: existsSync(description.policyPath),
    ruleCount: description.ruleCount,
    actions: [...POLICY_ACTION_VALUES],
    tags: [...POLICY_TAG_VALUES],
    defaults: POLICY_DEFAULT_DECISIONS
  };
}

export function evaluatePolicyPreview(
  dataDir: string,
  context: Omit<PolicyPreviewResolvedContext, 'contextSource'> & { contextSource: 'explicit' | 'session' }
): PolicyPreviewResult {
  const engine = new PolicyEngine(dataDir);
  const evaluation = engine.evaluateWithAudit({
    action: context.action,
    domain: context.domain,
    path: context.path,
    locator: context.locator
  });
  return {
    resolvedContext: context,
    decision: evaluation.decision,
    audit: evaluation.audit
  };
}

export function readPolicyAudit(dataDir = resolveDataDir(), query: PolicyAuditQuery = {}): PolicyAuditResult {
  const limit = query.limit ?? 50;
  const entries = listPolicyAuditEntries(dataDir, { ...query, limit });
  return {
    summary: summarizePolicyAudit(entries),
    entries
  };
}

export function recommendPolicyRules(dataDir = resolveDataDir(), query: PolicyRecommendQuery = {}): PolicyRecommendResult {
  const minOccurrences = query.minOccurrences ?? 2;
  const entries = listPolicyAuditEntries(dataDir, {
    traceId: query.traceId,
    action: query.action,
    decision: query.decision,
    limit: query.limit
  }).filter((entry) => entry.source === 'default' && (entry.decision === 'deny' || entry.decision === 'requireConfirm'));

  const grouped = new Map<string, { basis: Omit<PolicyRecommendationBasis, 'occurrenceCount' | 'traceIds'>; entries: PolicyAuditEntry[] }>();
  for (const entry of entries) {
    const primaryTag = selectPrimaryTag(entry.tags);
    const groupBasis = {
      decision: entry.decision,
      action: entry.action,
      domain: entry.domain,
      path: entry.path,
      tag: primaryTag
    };
    const key = JSON.stringify(groupBasis);
    const current = grouped.get(key);
    if (current) {
      current.entries.push(entry);
      continue;
    }
    grouped.set(key, {
      basis: groupBasis,
      entries: [entry]
    });
  }

  const suggestions = [...grouped.values()]
    .filter((group) => group.entries.length >= minOccurrences)
    .map((group) => {
      const sortedEntries = [...group.entries].sort((left, right) => right.ts.localeCompare(left.ts) || right.traceId.localeCompare(left.traceId));
      const traceIds = [...new Set(sortedEntries.map((entry) => entry.traceId))];
      const basis: PolicyRecommendationBasis = {
        ...group.basis,
        occurrenceCount: sortedEntries.length,
        traceIds
      };
      return {
        rule: {
          id: buildSuggestionId(group.basis),
          action: group.basis.action,
          decision: group.basis.decision,
          domain: group.basis.domain,
          pathPrefix: group.basis.path,
          tag: group.basis.tag ?? undefined,
          reason: buildSuggestionReason(group.basis, sortedEntries.length)
        },
        basis,
        examples: sortedEntries.slice(0, 3).map((entry) => ({
          traceId: entry.traceId,
          ts: entry.ts,
          reason: entry.reason
        }))
      } satisfies PolicyRecommendation;
    })
    .sort((left, right) => {
      return (
        right.basis.occurrenceCount - left.basis.occurrenceCount
        || left.rule.action.localeCompare(right.rule.action)
        || left.rule.domain!.localeCompare(right.rule.domain!)
        || (left.rule.pathPrefix ?? '').localeCompare(right.rule.pathPrefix ?? '')
        || (left.rule.tag ?? '').localeCompare(right.rule.tag ?? '')
      );
    });

  return { suggestions };
}
