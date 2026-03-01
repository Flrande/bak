import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator } from '@bak/protocol';

export type PolicyAction = 'element.click' | 'element.type';
export type PolicyDecisionType = 'allow' | 'deny' | 'requireConfirm';
export type PolicyTag = 'fileUpload' | 'payment' | 'destructive' | 'submit' | 'highRisk';

export interface PolicyRule {
  id?: string;
  action: PolicyAction | '*';
  decision: PolicyDecisionType;
  domain?: string;
  pathPrefix?: string;
  locatorPattern?: string;
  tag?: PolicyTag;
  reason?: string;
}

interface PolicyFile {
  rules?: PolicyRule[];
}

export interface PolicyContext {
  action: PolicyAction;
  domain: string;
  path: string;
  locator: Locator;
}

export interface EvaluatedPolicyContext extends PolicyContext {
  tags: PolicyTag[];
}

export interface PolicyDecision {
  decision: PolicyDecisionType;
  reason: string;
  ruleId?: string;
  source: 'rule' | 'default';
}

export interface PolicyMatchedRuleSummary {
  id?: string;
  action: PolicyAction | '*';
  decision: PolicyDecisionType;
  tag?: PolicyTag;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  audit: {
    tags: PolicyTag[];
    matchedRules: PolicyMatchedRuleSummary[];
    defaultDecision: PolicyDecisionType;
    defaultReason: string;
  };
}

const DEFAULT_POLICY_FILE = '.bak-policy.json';
const HIGH_RISK_PATTERN = /(delete|remove|send|submit|upload|payment|pay|付款|支付|删除|提交|发送|上传)/i;
const FILE_UPLOAD_PATTERN = /(upload|file|附件|上传)/i;
const PAYMENT_PATTERN = /(payment|pay|付款|支付)/i;
const DESTRUCTIVE_PATTERN = /(delete|remove|danger|删除|清空)/i;
const SUBMIT_PATTERN = /(submit|send|confirm|提交|发送|确认)/i;

function safePatternMatch(pattern: string | undefined, value: string): boolean {
  if (!pattern) {
    return true;
  }
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
}

function domainMatches(ruleDomain: string | undefined, domain: string): boolean {
  if (!ruleDomain) {
    return true;
  }

  const expected = ruleDomain.toLowerCase();
  const actual = domain.toLowerCase();

  if (expected.startsWith('*.')) {
    const suffix = expected.slice(2);
    return actual === suffix || actual.endsWith(`.${suffix}`);
  }

  return actual === expected;
}

function tokenizeLocator(locator: Locator): string {
  return `${locator.name ?? ''} ${locator.text ?? ''} ${locator.css ?? ''} ${locator.role ?? ''}`.trim();
}

export function detectPolicyTags(locator: Locator): PolicyTag[] {
  const bucket = tokenizeLocator(locator).toLowerCase();
  const tags = new Set<PolicyTag>();

  const isFileCss = typeof locator.css === 'string' && /input\s*\[\s*type\s*=\s*["']?file["']?\s*\]/i.test(locator.css);

  if (isFileCss || FILE_UPLOAD_PATTERN.test(bucket)) {
    tags.add('fileUpload');
  }
  if (PAYMENT_PATTERN.test(bucket)) {
    tags.add('payment');
  }
  if (DESTRUCTIVE_PATTERN.test(bucket)) {
    tags.add('destructive');
  }
  if (SUBMIT_PATTERN.test(bucket)) {
    tags.add('submit');
  }
  if (HIGH_RISK_PATTERN.test(bucket)) {
    tags.add('highRisk');
  }

  return [...tags.values()];
}

function ruleMatches(rule: PolicyRule, context: EvaluatedPolicyContext): boolean {
  if (rule.action !== '*' && rule.action !== context.action) {
    return false;
  }
  if (!domainMatches(rule.domain, context.domain)) {
    return false;
  }
  if (rule.pathPrefix && !context.path.startsWith(rule.pathPrefix)) {
    return false;
  }
  if (rule.tag && !context.tags.includes(rule.tag)) {
    return false;
  }
  return safePatternMatch(rule.locatorPattern, tokenizeLocator(context.locator));
}

function defaultDecision(context: EvaluatedPolicyContext): PolicyDecision {
  if (context.tags.includes('fileUpload')) {
    return {
      decision: 'deny',
      reason: 'file upload is denied by default policy',
      source: 'default'
    };
  }

  if (context.tags.some((tag) => ['payment', 'destructive', 'submit', 'highRisk'].includes(tag))) {
    return {
      decision: 'requireConfirm',
      reason: 'high-risk action requires explicit user confirmation',
      source: 'default'
    };
  }

  return {
    decision: 'allow',
    reason: 'no blocking policy matched',
    source: 'default'
  };
}

function decisionRank(decision: PolicyDecisionType): number {
  if (decision === 'deny') {
    return 3;
  }
  if (decision === 'requireConfirm') {
    return 2;
  }
  return 1;
}

function loadRules(policyPath: string): PolicyRule[] {
  if (!existsSync(policyPath)) {
    return [];
  }

  const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as PolicyFile;
  if (!Array.isArray(parsed.rules)) {
    return [];
  }

  return parsed.rules
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      id: typeof rule.id === 'string' ? rule.id : undefined,
      action: rule.action === 'element.click' || rule.action === 'element.type' || rule.action === '*' ? rule.action : '*',
      decision:
        rule.decision === 'allow' || rule.decision === 'deny' || rule.decision === 'requireConfirm'
          ? rule.decision
          : 'deny',
      domain: typeof rule.domain === 'string' ? rule.domain : undefined,
      pathPrefix: typeof rule.pathPrefix === 'string' ? rule.pathPrefix : undefined,
      locatorPattern: typeof rule.locatorPattern === 'string' ? rule.locatorPattern : undefined,
      tag:
        rule.tag === 'fileUpload' ||
        rule.tag === 'payment' ||
        rule.tag === 'destructive' ||
        rule.tag === 'submit' ||
        rule.tag === 'highRisk'
          ? rule.tag
          : undefined,
      reason: typeof rule.reason === 'string' ? rule.reason : undefined
    }));
}

export class PolicyEngine {
  private readonly policyPath: string;
  private readonly rules: PolicyRule[];

  constructor(dataDir: string, policyPath = process.env.BAK_POLICY_PATH) {
    this.policyPath = policyPath ? resolve(policyPath) : resolve(join(dataDir, DEFAULT_POLICY_FILE));
    this.rules = loadRules(this.policyPath);
  }

  describe(): { policyPath: string; ruleCount: number } {
    return {
      policyPath: this.policyPath,
      ruleCount: this.rules.length
    };
  }

  evaluate(context: PolicyContext): PolicyDecision {
    return this.evaluateWithAudit(context).decision;
  }

  evaluateWithAudit(context: PolicyContext): PolicyEvaluation {
    const enriched: EvaluatedPolicyContext = {
      ...context,
      tags: detectPolicyTags(context.locator)
    };

    const fallback = defaultDecision(enriched);
    const matchedRules = this.rules.filter((rule) => ruleMatches(rule, enriched));
    let matchedRule: PolicyRule | null = null;
    for (const rule of matchedRules) {
      if (!matchedRule) {
        matchedRule = rule;
        continue;
      }

      if (decisionRank(rule.decision) > decisionRank(matchedRule.decision)) {
        matchedRule = rule;
      }
    }

    if (matchedRule) {
      return {
        decision: {
          decision: matchedRule.decision,
          reason: matchedRule.reason ?? `matched policy rule ${matchedRule.id ?? 'unnamed'}`,
          ruleId: matchedRule.id,
          source: 'rule'
        },
        audit: {
          tags: enriched.tags,
          matchedRules: matchedRules.map((rule) => ({
            id: rule.id,
            action: rule.action,
            decision: rule.decision,
            tag: rule.tag
          })),
          defaultDecision: fallback.decision,
          defaultReason: fallback.reason
        }
      };
    }

    return {
      decision: fallback,
      audit: {
        tags: enriched.tags,
        matchedRules: [],
        defaultDecision: fallback.decision,
        defaultReason: fallback.reason
      }
    };
  }
}
