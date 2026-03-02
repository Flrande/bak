import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BakErrorCode,
  COMPATIBLE_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  type ElementMapItem,
  type Episode,
  type Locator,
  type MethodMap,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type Skill,
  type SkillPlanStep,
  RpcError
} from '@bak/protocol';
import type { BrowserDriver } from './drivers/browser-driver.js';
import { BridgeError } from './drivers/extension-bridge.js';
import { evaluateConnectionHealth } from './connection-health.js';
import {
  buildTargetCandidates,
  extractSkillFromEpisode,
  inferDomainFromStartUrl,
  matchesUrlPattern,
  rankCandidates,
  retrieveSkills
} from './memory/extract.js';
import { resolveMemoryBackend, type MemoryBackend } from './memory/factory.js';
import type { MemoryStoreBackend } from './memory/store.js';
import { PolicyEngine, type PolicyAction, type PolicyEvaluation } from './policy.js';
import { redactElements, redactText, redactUnknown } from './privacy.js';
import type { PairingStore } from './pairing-store.js';
import type { TraceStore } from './trace-store.js';
import { ensureDir, getDomain, getPathname, id, resolveDataDir } from './utils.js';

const DYNAMIC_FORWARD_METHODS = new Set<MethodName>([
  'tabs.getActive',
  'tabs.get',
  'page.title',
  'page.url',
  'page.text',
  'page.dom',
  'page.accessibilityTree',
  'page.scrollTo',
  'page.viewport',
  'page.metrics',
  'element.hover',
  'element.doubleClick',
  'element.rightClick',
  'element.dragDrop',
  'element.select',
  'element.check',
  'element.uncheck',
  'element.scrollIntoView',
  'element.focus',
  'element.blur',
  'element.get',
  'keyboard.press',
  'keyboard.type',
  'keyboard.hotkey',
  'mouse.move',
  'mouse.click',
  'mouse.wheel',
  'file.upload',
  'context.enterFrame',
  'context.exitFrame',
  'context.enterShadow',
  'context.exitShadow',
  'context.reset',
  'network.list',
  'network.get',
  'network.waitFor',
  'network.clear',
  'debug.dumpState'
]);

const STATIC_METHODS = new Set<MethodName>([
  'session.create',
  'session.close',
  'session.info',
  'tabs.list',
  'tabs.focus',
  'tabs.new',
  'tabs.close',
  'page.goto',
  'page.back',
  'page.forward',
  'page.reload',
  'page.wait',
  'page.snapshot',
  'element.click',
  'element.type',
  'element.scroll',
  'debug.getConsole',
  'memory.recordStart',
  'memory.recordStop',
  'memory.skills.list',
  'memory.skills.show',
  'memory.skills.retrieve',
  'memory.skills.run',
  'memory.skills.delete',
  'memory.skills.stats',
  'memory.episodes.list',
  'memory.replay.explain'
]);

const SUPPORTED_METHODS = new Set<MethodName>([...STATIC_METHODS, ...DYNAMIC_FORWARD_METHODS]);

const POLICY_ACTION_BY_METHOD: Partial<Record<MethodName, PolicyAction>> = {
  'element.click': 'element.click',
  'element.type': 'element.type',
  'element.doubleClick': 'element.doubleClick',
  'element.rightClick': 'element.rightClick',
  'element.dragDrop': 'element.dragDrop',
  'element.select': 'element.select',
  'element.check': 'element.check',
  'element.uncheck': 'element.uncheck',
  'file.upload': 'file.upload'
};

interface RecordingState {
  recordingId: string;
  intent: string;
  domain: string;
  startUrl: string;
  steps: SkillPlanStep[];
  anchors: string[];
}

interface SkillRunHealingSummary {
  attempts: number;
  successes: number;
  failed: boolean;
}

interface SkillRunOutcome {
  updatedSkill?: Skill;
  healing: SkillRunHealingSummary;
}

export interface ServiceHeartbeatConfig {
  intervalMs?: number;
}

export interface ServiceMemoryRuntime {
  requestedBackend: MemoryBackend;
  backend: MemoryBackend;
  fallbackReason?: string;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function templateParamKey(text: string): string | undefined {
  const match = text.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
  if (!match) {
    return undefined;
  }
  return match[1];
}

function maybeParamValue(text: string, params?: Record<string, string>): string {
  const key = templateParamKey(text);
  if (!key) {
    return text;
  }
  if (!params || !(key in params)) {
    throw new RpcError(`Missing required skill param: ${key}`, -32602, BakErrorCode.E_INVALID_PARAMS, {
      missingParam: key
    });
  }
  return params[key] ?? '';
}

function sanitizeInputText(locator: Locator, text: string): string {
  if (!text.trim()) {
    return '';
  }
  const lower = `${locator.name ?? ''} ${locator.text ?? ''}`.toLowerCase();
  if (lower.includes('password') || lower.includes('otp') || lower.includes('验证码')) {
    return '[REDACTED]';
  }

  if (process.env.BAK_MEMORY_RECORD_INPUT_TEXT !== '1') {
    return '[REDACTED:input]';
  }

  return redactText(text);
}

function redactTraceParams(method: string, params: unknown): unknown {
  const redacted = redactUnknown(params);
  if (method !== 'element.type') {
    return redacted;
  }

  const payload = asRecord(redacted);
  if (!('text' in payload)) {
    return payload;
  }
  return {
    ...payload,
    text: '[REDACTED]'
  };
}

function redactTraceResult(method: string, result: unknown): unknown {
  const redacted = redactUnknown(result);
  if (method !== 'page.snapshot') {
    return redacted;
  }

  const payload = asRecord(redacted);
  if (typeof payload.imageBase64 !== 'string') {
    return payload;
  }
  return {
    ...payload,
    imageBase64: '[REDACTED:base64]'
  };
}

function maybeLocatorFromStep(step: SkillPlanStep): Locator | undefined {
  if (step.locator) {
    return step.locator;
  }
  return step.targetCandidates?.[0];
}

function rpcErrorMetadata(error: RpcError): Record<string, unknown> {
  const source = error as RpcError & { data?: Record<string, unknown>; details?: Record<string, unknown> };
  return source.details ?? source.data ?? {};
}

function hasHealingAttemptFlag(error: RpcError): boolean {
  const data = rpcErrorMetadata(error);
  return data?.healingAttempted === true;
}

function healingSummaryFromError(error: RpcError): SkillRunHealingSummary {
  const data = rpcErrorMetadata(error);
  const attempts = typeof data.healingAttempts === 'number' ? Math.max(0, data.healingAttempts) : 0;
  const successes = typeof data.healingSuccesses === 'number' ? Math.max(0, data.healingSuccesses) : 0;
  return {
    attempts,
    successes,
    failed: true
  };
}

export class BakService {
  private readonly driver: BrowserDriver;
  private readonly pairingStore: PairingStore;
  private readonly traceStore: TraceStore;
  private readonly memoryStore: MemoryStoreBackend;
  private readonly dataDir: string;
  private readonly policyEngine: PolicyEngine;
  private readonly memoryRetrieveMinScore: number;
  private readonly memoryRuntime: ServiceMemoryRuntime;

  private sessionId: string | null = null;
  private currentTraceId: string = '';
  private recording: RecordingState | null = null;
  private autoRecording: RecordingState | null = null;
  private readonly autoLearningEnabled = true;
  private contextFrameDepth = 0;
  private contextShadowDepth = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatStaleAfterMs: number;

  constructor(
    driver: BrowserDriver,
    pairingStore: PairingStore,
    traceStore: TraceStore,
    memoryStore: MemoryStoreBackend,
    heartbeatConfig: ServiceHeartbeatConfig = {},
    memoryRuntime?: ServiceMemoryRuntime
  ) {
    this.driver = driver;
    this.pairingStore = pairingStore;
    this.traceStore = traceStore;
    this.memoryStore = memoryStore;
    this.dataDir = resolveDataDir();
    this.policyEngine = new PolicyEngine(this.dataDir);
    const configuredRetrieveMinScore = Number.parseFloat(process.env.BAK_MEMORY_RETRIEVE_MIN_SCORE ?? '');
    this.memoryRetrieveMinScore = Number.isFinite(configuredRetrieveMinScore)
      ? Math.min(1, Math.max(0, configuredRetrieveMinScore))
      : 0.2;
    const requestedBackend = resolveMemoryBackend();
    this.memoryRuntime = memoryRuntime ?? {
      requestedBackend,
      backend: requestedBackend
    };
    const configured = heartbeatConfig.intervalMs ?? 10_000;
    this.heartbeatIntervalMs = Math.max(500, configured);
    this.heartbeatStaleAfterMs = Math.max(this.heartbeatIntervalMs * 3, 5_000);
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async tickHeartbeat(): Promise<void> {
    if (!this.driver.isConnected()) {
      return;
    }

    try {
      await this.driver.sessionPing(Math.max(1_000, Math.floor(this.heartbeatIntervalMs / 2)));
    } catch {
      // Ignore heartbeat errors; bridge stats capture state transitions and failures.
    }
  }

  private ensurePairing(): void {
    if (!this.pairingStore.getToken()) {
      throw new RpcError('Not paired', 4001, BakErrorCode.E_NOT_PAIRED);
    }
  }

  private effectiveConnection(nowTs = Date.now()): {
    extensionConnected: boolean;
    connectionState: 'connecting' | 'connected' | 'disconnected';
    connectionReason: string | null;
    heartbeatStale: boolean;
    heartbeatAgeMs: number | null;
    raw: ReturnType<BrowserDriver['connectionStatus']>;
  } {
    const raw = this.driver.connectionStatus();
    const health = evaluateConnectionHealth(raw, nowTs, this.heartbeatStaleAfterMs);
    return {
      ...health,
      raw
    };
  }

  private ensureConnected(): void {
    const connection = this.effectiveConnection();
    if (!connection.extensionConnected) {
      throw new RpcError('Extension not connected', 4250, BakErrorCode.E_NOT_READY, {
        connectionState: connection.connectionState,
        connectionReason: connection.connectionReason,
        heartbeatStale: connection.heartbeatStale,
        heartbeatAgeMs: connection.heartbeatAgeMs
      });
    }
  }

  private newSession(): string {
    this.sessionId = id('session');
    this.currentTraceId = this.traceStore.newTraceId();
    return this.sessionId;
  }

  private async withTrace<T>(method: string, params: unknown, action: () => Promise<T>): Promise<T> {
    const traceId = this.currentTraceId || this.traceStore.newTraceId();
    this.currentTraceId = traceId;
    this.traceStore.append(traceId, { method: 'rpc.start', params: { method } });
    this.traceStore.append(traceId, { method, params: redactTraceParams(method, params) });

    try {
      const result = await action();
      this.traceStore.append(traceId, {
        method: `${method}:result`,
        params: {},
        result: redactTraceResult(method, result)
      });
      this.traceStore.append(traceId, { method: 'rpc.success', params: { method } });
      return result;
    } catch (error) {
      const normalized = this.normalizeError(error);
      this.traceStore.append(traceId, {
        method: `${method}:error`,
        params: {},
        error: {
          code: normalized.bakCode,
          message: redactText(normalized.message)
        }
      });
      this.traceStore.append(traceId, {
        method: 'rpc.failure',
        params: {
          method,
          bakCode: normalized.bakCode
        }
      });
      throw normalized;
    }
  }

  private normalizeError(error: unknown): RpcError {
    if (error instanceof RpcError) {
      return error;
    }

    if (error instanceof BridgeError) {
      const bakCode =
        error.code === 'E_TIMEOUT'
          ? BakErrorCode.E_TIMEOUT
          : error.code === 'E_NOT_FOUND'
            ? BakErrorCode.E_NOT_FOUND
            : error.code === 'E_INVALID_PARAMS'
              ? BakErrorCode.E_INVALID_PARAMS
            : error.code === 'E_PERMISSION'
              ? BakErrorCode.E_PERMISSION
              : error.code === 'E_NEED_USER_CONFIRM'
                ? BakErrorCode.E_NEED_USER_CONFIRM
                : error.code === 'E_NOT_READY'
                  ? BakErrorCode.E_NOT_READY
                  : BakErrorCode.E_INTERNAL;
      return new RpcError(error.message, -32603, bakCode, error.data);
    }

    return new RpcError(error instanceof Error ? error.message : String(error), -32603, BakErrorCode.E_INTERNAL);
  }

  private captureStep(step: SkillPlanStep): void {
    const captureInto = (state: RecordingState | null): void => {
      if (!state) {
        return;
      }
      state.steps.push(step);
      if (step.locator?.name) {
        state.anchors.push(step.locator.name);
      }
      if (step.locator?.text) {
        state.anchors.push(step.locator.text);
      }
      if (step.url) {
        state.anchors.push(step.url);
      }
    };

    captureInto(this.recording);
    if (!this.autoLearningEnabled) {
      return;
    }

    const stepUrl = typeof step.url === 'string' && step.url.trim() ? step.url : undefined;

    if (!this.autoRecording) {
      const defaultUrl = stepUrl ?? 'about:blank';
      this.autoRecording = {
        recordingId: id('auto-recording'),
        intent: this.deriveAutoIntent(step),
        domain: inferDomainFromStartUrl(defaultUrl),
        startUrl: defaultUrl,
        steps: [],
        anchors: []
      };
    } else if (stepUrl) {
      const currentDomain = inferDomainFromStartUrl(this.autoRecording.startUrl);
      if (this.autoRecording.startUrl === 'about:blank' || currentDomain === 'unknown' || this.autoRecording.domain === 'unknown') {
        this.autoRecording.startUrl = stepUrl;
        this.autoRecording.domain = inferDomainFromStartUrl(stepUrl);
      }
    }

    captureInto(this.autoRecording);
    this.maybeAutoPromoteSkill();
  }

  private deriveAutoIntent(step: SkillPlanStep): string {
    if (step.kind === 'type') {
      return `fill-${step.locator?.name?.toLowerCase().replace(/\s+/g, '-') ?? 'form'}`;
    }
    if (step.kind === 'click') {
      return `click-${step.locator?.name?.toLowerCase().replace(/\s+/g, '-') ?? 'action'}`;
    }
    if (step.kind === 'goto') {
      return `navigate-${inferDomainFromStartUrl(step.url ?? 'about:blank')}`;
    }
    return 'auto-flow';
  }

  private skillFingerprint(plan: SkillPlanStep[]): string {
    return JSON.stringify(
      plan.map((step) => ({
        kind: step.kind,
        locator: step.locator ?? step.targetCandidates?.[0] ?? null,
        waitFor: step.waitFor?.value ?? null,
        url: step.url ?? null
      }))
    );
  }

  private resolveRecordingStart(recording: RecordingState, preferFirstGoto = false): { startUrl: string; domain: string } {
    const knownStartUrl = recording.startUrl.trim();
    const knownDomain = inferDomainFromStartUrl(knownStartUrl);
    const gotoStep = recording.steps.find((step) => step.kind === 'goto' && typeof step.url === 'string' && step.url.trim().length > 0);
    const gotoUrl = gotoStep?.url?.trim();

    if (preferFirstGoto && gotoUrl) {
      return {
        startUrl: gotoUrl,
        domain: inferDomainFromStartUrl(gotoUrl)
      };
    }

    if (knownStartUrl && knownStartUrl !== 'about:blank' && knownDomain !== 'unknown') {
      return {
        startUrl: knownStartUrl,
        domain: knownDomain
      };
    }

    const startUrl = gotoUrl ?? (knownStartUrl || 'about:blank');
    return {
      startUrl,
      domain: inferDomainFromStartUrl(startUrl)
    };
  }

  private maybeAutoPromoteSkill(): void {
    if (!this.autoRecording) {
      return;
    }

    if (this.autoRecording.steps.length < 3) {
      return;
    }

    const resolvedStart = this.resolveRecordingStart(this.autoRecording, true);
    this.autoRecording.domain = resolvedStart.domain;
    this.autoRecording.startUrl = resolvedStart.startUrl;

    const candidateEpisode = {
      domain: resolvedStart.domain || 'unknown',
      startUrl: resolvedStart.startUrl || 'about:blank',
      intent: this.autoRecording.intent || 'auto-flow',
      steps: this.autoRecording.steps.slice(),
      anchors: [...new Set(this.autoRecording.anchors)].slice(0, 20),
      outcome: 'success' as const,
      mode: 'auto' as const
    };

    const skillPayload = extractSkillFromEpisode({
      ...candidateEpisode,
      id: id('episode'),
      createdAt: new Date().toISOString()
    });
    const fingerprint = this.skillFingerprint(skillPayload.plan);
    const existing = this.memoryStore
      .listSkills({ domain: candidateEpisode.domain, intent: candidateEpisode.intent })
      .find((item) => item.meta?.fingerprint === fingerprint);

    if (existing) {
      existing.meta = {
        ...existing.meta,
        source: 'auto',
        fingerprint,
        learnCount: (existing.meta?.learnCount ?? 1) + 1,
        lastLearnedAt: new Date().toISOString()
      };
      this.memoryStore.updateSkill(existing);
      this.autoRecording = null;
      return;
    }

    this.memoryStore.createEpisode(candidateEpisode);
    this.memoryStore.createSkill({
      ...skillPayload,
      meta: {
        source: 'auto',
        fingerprint,
        learnCount: 1,
        lastLearnedAt: new Date().toISOString()
      }
    });
    this.autoRecording = null;
  }

  private async activeLocation(): Promise<{ domain: string; path: string }> {
    const active = await this.activeTabSummary();
    if (!active?.url) {
      return { domain: 'unknown', path: '/' };
    }

    return {
      domain: getDomain(active.url),
      path: getPathname(active.url)
    };
  }

  private async activeTabSummary(): Promise<{ id: number; title: string; url: string } | null> {
    if (!this.driver.isConnected()) {
      return null;
    }

    try {
      const tabs = await this.driver.tabsList();
      const active = tabs.tabs.find((tab) => tab.active) ?? tabs.tabs[0];
      if (!active) {
        return null;
      }
      return {
        id: active.id,
        title: active.title,
        url: active.url
      };
    } catch {
      return null;
    }
  }

  private appendPolicyAudit(
    traceId: string,
    action: PolicyAction,
    locator: Locator,
    evaluation: PolicyEvaluation,
    location: { domain: string; path: string }
  ): void {
    const decision = evaluation.decision;
    this.traceStore.append(traceId, {
      method: 'policy.decision',
      params: {
        action,
        decision: decision.decision,
        reason: decision.reason,
        source: decision.source,
        ruleId: decision.ruleId,
        domain: location.domain,
        path: location.path,
        locatorSummary: {
          hasEid: Boolean(locator.eid),
          hasRole: Boolean(locator.role),
          hasName: Boolean(locator.name),
          hasText: Boolean(locator.text),
          hasCss: Boolean(locator.css)
        },
        tags: evaluation.audit.tags,
        matchedRuleCount: evaluation.audit.matchedRules.length,
        matchedRules: evaluation.audit.matchedRules.map((rule) => ({
          id: rule.id ?? null,
          action: rule.action,
          decision: rule.decision,
          tag: rule.tag ?? null
        })),
        defaultDecision: evaluation.audit.defaultDecision,
        defaultReason: evaluation.audit.defaultReason
      }
    });
  }

  private appendHealingAudit(traceId: string, skillId: string, healing: SkillRunHealingSummary): void {
    if (healing.attempts <= 0 && healing.successes <= 0) {
      return;
    }

    this.traceStore.append(traceId, {
      method: 'memory.healing',
      params: {
        skillId,
        attempts: healing.attempts,
        successes: healing.successes,
        failed: healing.failed,
        successRate: healing.attempts > 0 ? healing.successes / healing.attempts : 0
      }
    });
  }

  private async evaluatePolicy(action: PolicyAction, locator: Locator): Promise<{ requiresConfirm: boolean }> {
    const traceId = this.currentTraceId || this.traceStore.newTraceId();
    this.currentTraceId = traceId;

    const location = await this.activeLocation();
    const evaluation = this.policyEngine.evaluateWithAudit({
      action,
      domain: location.domain,
      path: location.path,
      locator
    });

    this.appendPolicyAudit(traceId, action, locator, evaluation, location);
    const decision = evaluation.decision;

    if (decision.decision === 'deny') {
      throw new RpcError(`Blocked by policy: ${decision.reason}`, 4030, BakErrorCode.E_PERMISSION, {
        policyDecision: decision.decision,
        policyReason: decision.reason,
        policySource: decision.source,
        policyRuleId: decision.ruleId
      });
    }

    return { requiresConfirm: decision.decision === 'requireConfirm' };
  }

  private async withPolicyOnDynamicRequest(
    methodName: MethodName,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const action = POLICY_ACTION_BY_METHOD[methodName];
    if (!action) {
      return params;
    }

    const requiresConfirm = params.requiresConfirm === true;
    if (methodName === 'element.dragDrop') {
      const from = params.from as Locator | undefined;
      const to = params.to as Locator | undefined;
      if (!from || !to) {
        throw new RpcError(`${methodName} requires both from and to locators`, -32602, BakErrorCode.E_INVALID_PARAMS);
      }
      const fromDecision = await this.evaluatePolicy(action, from);
      const toDecision = await this.evaluatePolicy(action, to);
      return {
        ...params,
        requiresConfirm: requiresConfirm || fromDecision.requiresConfirm || toDecision.requiresConfirm
      };
    }

    const locator = params.locator as Locator | undefined;
    if (!locator) {
      throw new RpcError(`${methodName} requires locator`, -32602, BakErrorCode.E_INVALID_PARAMS);
    }

    const decision = await this.evaluatePolicy(action, locator);
    return {
      ...params,
      requiresConfirm: requiresConfirm || decision.requiresConfirm
    };
  }

  private normalizeRunParams(skill: Skill, rawParams: unknown): Record<string, string> {
    const paramsInput = asRecord(rawParams);
    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(paramsInput)) {
      if (typeof value !== 'string') {
        throw new RpcError(`skill params.${key} must be a string`, -32602, BakErrorCode.E_INVALID_PARAMS, {
          param: key
        });
      }
      normalized[key] = value;
    }

    const required = (skill.paramsSchema.required ?? []).filter((key): key is string => typeof key === 'string' && key.trim().length > 0);
    const missing = required.filter((key) => !(key in normalized));
    if (missing.length > 0) {
      throw new RpcError(`Missing required skill params: ${missing.join(', ')}`, -32602, BakErrorCode.E_INVALID_PARAMS, {
        missingParams: missing
      });
    }

    return normalized;
  }

  private async verifySkillPreconditions(skill: Skill, tabId?: number): Promise<void> {
    if (!skill.preconditions) {
      return;
    }

    const hasExplicitGoto = skill.plan.some((step) => step.kind === 'goto' && typeof step.url === 'string' && step.url.trim().length > 0);

    if (skill.preconditions.urlPattern) {
      const expectedUrlPattern = skill.preconditions.urlPattern.trim();
      const current = await this.driver.rawRequest<{ url: string }>('page.url', { tabId });
      const currentUrl = String(current.url ?? '');
      if (!matchesUrlPattern(expectedUrlPattern, currentUrl)) {
        if (!hasExplicitGoto) {
          if (/^https?:\/\//i.test(expectedUrlPattern)) {
            await this.driver.pageGoto(expectedUrlPattern, tabId);
            return;
          }
          throw new RpcError('Skill precondition failed: URL does not match', 4004, BakErrorCode.E_NOT_FOUND, {
            expectedUrlPattern,
            currentUrl
          });
        }
        throw new RpcError('Skill precondition failed: URL does not match', 4004, BakErrorCode.E_NOT_FOUND, {
          expectedUrlPattern,
          currentUrl
        });
      }
    }

    const requiredText = (skill.preconditions.requiredText ?? []).filter((item) => typeof item === 'string' && item.trim().length > 0);
    if (requiredText.length === 0) {
      return;
    }

    const textResult = await this.driver.rawRequest<{ chunks: Array<{ text: string }> }>('page.text', {
      tabId,
      maxChunks: 48,
      chunkSize: 400
    });
    const haystack = textResult.chunks.map((chunk) => chunk.text).join('\n');
    const missing = requiredText.filter((needle) => !haystack.includes(needle));
    if (missing.length > 0) {
      throw new RpcError('Skill precondition failed: required text not found', 4004, BakErrorCode.E_NOT_FOUND, {
        missingRequiredText: missing
      });
    }
  }

  private async clickWithPolicy(locator: Locator, tabId?: number, requiresConfirm = false): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicy('element.click', locator);
    return this.driver.elementClick(locator, tabId, requiresConfirm || policy.requiresConfirm);
  }

  private async typeWithPolicy(
    locator: Locator,
    text: string,
    clear: boolean,
    tabId?: number,
    requiresConfirm = false
  ): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicy('element.type', locator);
    return this.driver.elementType(locator, text, clear, tabId, requiresConfirm || policy.requiresConfirm);
  }

  private async pickRunCandidate(
    step: SkillPlanStep,
    options: { tabId?: number; params?: Record<string, string> }
  ): Promise<{ ok: true; chosen?: Locator; updated?: boolean; healingAttempted: boolean; healingSucceeded: boolean }> {
    const traceId = this.currentTraceId || this.traceStore.newTraceId();
    this.currentTraceId = traceId;
    const candidates = (step.targetCandidates ?? []).slice();
    if (step.locator) {
      candidates.unshift(step.locator);
    }

    const unique = new Map<string, Locator>();
    for (const candidate of candidates) {
      unique.set(JSON.stringify(candidate), candidate);
    }

    const ordered = [...unique.values()];

    for (const candidate of ordered) {
      try {
        this.traceStore.append(traceId, {
          method: 'memory.heal.try',
          params: { strategy: 'candidate', candidate }
        });
        if (step.kind === 'click') {
          await this.clickWithPolicy(candidate, options.tabId, Boolean(step.requiresConfirmation));
        } else if (step.kind === 'type') {
          const raw = maybeParamValue(step.text ?? '', options.params);
          await this.typeWithPolicy(candidate, raw, Boolean(step.clear), options.tabId, Boolean(step.requiresConfirmation));
        }
        return { ok: true, chosen: candidate, healingAttempted: false, healingSucceeded: false };
      } catch (error) {
        const normalized = this.normalizeError(error);
        this.traceStore.append(traceId, {
          method: 'memory.heal.tryResult',
          params: {
            strategy: 'candidate',
            candidate,
            ok: false,
            bakCode: normalized.bakCode
          }
        });
        if (
          normalized.bakCode === BakErrorCode.E_PERMISSION ||
          normalized.bakCode === BakErrorCode.E_NEED_USER_CONFIRM ||
          normalized.bakCode === BakErrorCode.E_INVALID_PARAMS
        ) {
          throw normalized;
        }
        continue;
      }
    }

    const refreshed = await this.driver.pageSnapshot(options.tabId);
    const ranked = rankCandidates(refreshed.elements, ordered, 3);
    this.traceStore.append(traceId, {
      method: 'memory.heal.rank',
      params: {
        candidateCount: ranked.length
      }
    });

    if (ranked.length === 0) {
      throw new RpcError('No matching candidate after refresh', 4004, BakErrorCode.E_NOT_FOUND, {
        healingAttempted: true
      });
    }

    let selectedEid: string;
    try {
      const selected = await this.driver.userSelectCandidate(ranked as ElementMapItem[], options.tabId);
      selectedEid = selected.selectedEid;
    } catch {
      this.traceStore.append(traceId, {
        method: 'memory.heal.userSelection',
        params: { ok: false }
      });
      throw new RpcError(
        'Need user confirmation to continue',
        4090,
        BakErrorCode.E_NEED_USER_CONFIRM,
        {
          candidates: ranked,
          healingAttempted: true
        }
      );
    }
    this.traceStore.append(traceId, {
      method: 'memory.heal.userSelection',
      params: { ok: true, selectedEid }
    });

    step.targetCandidates = [{ eid: selectedEid }, ...ordered];

    const retry = step.targetCandidates[0];
    if (!retry) {
      throw new RpcError('Unable to heal step', -32603, BakErrorCode.E_INTERNAL);
    }

    try {
      if (step.kind === 'click') {
        await this.clickWithPolicy(retry, options.tabId, Boolean(step.requiresConfirmation));
      } else {
        const raw = maybeParamValue(step.text ?? '', options.params);
        await this.typeWithPolicy(retry, raw, Boolean(step.clear), options.tabId, Boolean(step.requiresConfirmation));
      }
    } catch (error) {
      const normalized = this.normalizeError(error);
      const normalizedMeta = normalized as RpcError & {
        data?: Record<string, unknown>;
        details?: Record<string, unknown>;
      };
      throw new RpcError(normalized.message, normalized.code, normalized.bakCode, {
        ...(normalizedMeta.details ?? normalizedMeta.data ?? {}),
        healingAttempted: true
      });
    }

    return { ok: true, chosen: retry, updated: true, healingAttempted: true, healingSucceeded: true };
  }

  private applyHealingStats(skill: Skill, attempts: number, successes: number): void {
    if (attempts <= 0 && successes <= 0) {
      return;
    }

    const currentAttempts = typeof skill.healing.attempts === 'number' ? skill.healing.attempts : 0;
    const currentSuccesses = typeof skill.healing.successes === 'number' ? skill.healing.successes : 0;
    skill.healing = {
      ...skill.healing,
      attempts: currentAttempts + Math.max(0, attempts),
      successes: currentSuccesses + Math.max(0, successes)
    };
    skill.stats.healAttempts = (skill.stats.healAttempts ?? 0) + Math.max(0, attempts);
    skill.stats.healSuccess = (skill.stats.healSuccess ?? 0) + Math.max(0, successes);
  }

  private updateRunStats(skill: Skill, success: boolean, retriesUsed = 0, manualIntervention = false): void {
    skill.stats.runs += 1;
    if (success) {
      skill.stats.success += 1;
    } else {
      skill.stats.failure += 1;
    }
    skill.stats.retriesTotal = (skill.stats.retriesTotal ?? 0) + Math.max(0, retriesUsed);
    if (manualIntervention) {
      skill.stats.manualInterventions = (skill.stats.manualInterventions ?? 0) + 1;
    }
    skill.stats.lastRunAt = new Date().toISOString();
  }

  private async runSkill(skill: Skill, options: { tabId?: number; params?: Record<string, string> }): Promise<SkillRunOutcome> {
    let updated = false;
    let healingAttempts = 0;
    let healingSuccesses = 0;
    const maxRetriesPerAction = Math.max(1, Math.floor(skill.healing.retries || 1));

    await this.verifySkillPreconditions(skill, options.tabId);

    for (const step of skill.plan) {
      if (step.kind === 'goto' && step.url) {
        await this.driver.pageGoto(step.url, options.tabId);
        continue;
      }

      if (step.kind === 'wait' && step.waitFor) {
        await this.driver.pageWait(
          step.waitFor.mode,
          step.waitFor.value,
          step.waitFor.timeoutMs,
          options.tabId
        );
        continue;
      }

      if (step.kind === 'hover' && step.locator) {
        await this.driver.rawRequest('element.hover', { tabId: options.tabId, locator: step.locator });
        continue;
      }

      if (step.kind === 'doubleClick' && step.locator) {
        await this.driver.rawRequest(
          'element.doubleClick',
          await this.withPolicyOnDynamicRequest('element.doubleClick', {
            tabId: options.tabId,
            locator: step.locator
          })
        );
        continue;
      }

      if (step.kind === 'rightClick' && step.locator) {
        await this.driver.rawRequest(
          'element.rightClick',
          await this.withPolicyOnDynamicRequest('element.rightClick', {
            tabId: options.tabId,
            locator: step.locator
          })
        );
        continue;
      }

      if (step.kind === 'dragDrop' && step.fromLocator && step.toLocator) {
        await this.driver.rawRequest(
          'element.dragDrop',
          await this.withPolicyOnDynamicRequest('element.dragDrop', {
            tabId: options.tabId,
            from: step.fromLocator,
            to: step.toLocator
          })
        );
        continue;
      }

      if (step.kind === 'select' && step.locator) {
        await this.driver.rawRequest(
          'element.select',
          await this.withPolicyOnDynamicRequest('element.select', {
            tabId: options.tabId,
            locator: step.locator,
            values: step.values ?? []
          })
        );
        continue;
      }

      if (step.kind === 'check' && step.locator) {
        await this.driver.rawRequest(
          'element.check',
          await this.withPolicyOnDynamicRequest('element.check', { tabId: options.tabId, locator: step.locator })
        );
        continue;
      }

      if (step.kind === 'uncheck' && step.locator) {
        await this.driver.rawRequest(
          'element.uncheck',
          await this.withPolicyOnDynamicRequest('element.uncheck', { tabId: options.tabId, locator: step.locator })
        );
        continue;
      }

      if (step.kind === 'upload' && step.locator) {
        await this.driver.rawRequest(
          'file.upload',
          await this.withPolicyOnDynamicRequest('file.upload', {
            tabId: options.tabId,
            locator: step.locator,
            files: step.files ?? []
          })
        );
        continue;
      }

      if (step.kind === 'press' && step.key) {
        await this.driver.rawRequest('keyboard.press', {
          tabId: options.tabId,
          key: step.key
        });
        continue;
      }

      if (step.kind === 'hotkey' && step.keys && step.keys.length > 0) {
        await this.driver.rawRequest('keyboard.hotkey', {
          tabId: options.tabId,
          keys: step.keys
        });
        continue;
      }

      if (step.kind === 'keyboardType') {
        if (typeof step.text !== 'string') {
          throw new RpcError('keyboardType step requires text', -32602, BakErrorCode.E_INVALID_PARAMS, {
            stepKind: step.kind
          });
        }

        await this.driver.rawRequest('keyboard.type', {
          tabId: options.tabId,
          text: maybeParamValue(step.text, options.params),
          delayMs: typeof step.delayMs === 'number' ? step.delayMs : undefined
        });
        continue;
      }

      if (step.kind === 'scrollTo') {
        await this.driver.rawRequest('page.scrollTo', {
          tabId: options.tabId,
          x: typeof step.x === 'number' ? step.x : undefined,
          y: typeof step.y === 'number' ? step.y : undefined,
          behavior: step.behavior === 'smooth' || step.behavior === 'auto' ? step.behavior : undefined
        });
        continue;
      }

      if (step.kind === 'elementScroll') {
        await this.driver.elementScroll(
          maybeLocatorFromStep(step),
          typeof step.dx === 'number' ? step.dx : 0,
          typeof step.dy === 'number' ? step.dy : 320,
          options.tabId
        );
        continue;
      }

      if (step.kind === 'scrollIntoView' && step.locator) {
        await this.driver.rawRequest('element.scrollIntoView', {
          tabId: options.tabId,
          locator: step.locator
        });
        continue;
      }

      if (step.kind === 'click' || step.kind === 'type') {
        for (let attempt = 1; attempt <= maxRetriesPerAction; attempt += 1) {
          try {
            const result = await this.pickRunCandidate(step, options);
            updated = updated || Boolean(result.updated);
            if (result.healingAttempted) {
              healingAttempts += 1;
            }
            if (result.healingSucceeded) {
              healingSuccesses += 1;
            }
            break;
          } catch (error) {
            const normalized = this.normalizeError(error);
            if (hasHealingAttemptFlag(normalized)) {
              healingAttempts += 1;
            }

            const unretriable =
              normalized.bakCode === BakErrorCode.E_PERMISSION ||
              normalized.bakCode === BakErrorCode.E_NEED_USER_CONFIRM ||
              normalized.bakCode === BakErrorCode.E_INVALID_PARAMS;
            if (unretriable || attempt >= maxRetriesPerAction) {
              this.applyHealingStats(skill, healingAttempts, healingSuccesses);
              throw new RpcError(normalized.message, normalized.code, normalized.bakCode, {
                ...rpcErrorMetadata(normalized),
                healingAttempts,
                healingSuccesses,
                healingAttempted: healingAttempts > 0,
                retriesUsed: attempt - 1
              });
            }

            const traceId = this.currentTraceId || this.traceStore.newTraceId();
            this.currentTraceId = traceId;
            this.traceStore.append(traceId, {
              method: 'memory.heal.retry',
              params: {
                stepKind: step.kind,
                retryAttempt: attempt,
                maxRetries: maxRetriesPerAction,
                bakCode: normalized.bakCode
              }
            });
          }
        }
        continue;
      }

      throw new RpcError(`Unsupported skill step kind: ${step.kind}`, -32602, BakErrorCode.E_INVALID_PARAMS, {
        stepKind: step.kind
      });
    }

    this.updateRunStats(skill, true, healingAttempts, false);
    this.applyHealingStats(skill, healingAttempts, healingSuccesses);
    const healing: SkillRunHealingSummary = {
      attempts: healingAttempts,
      successes: healingSuccesses,
      failed: false
    };

    if (updated) {
      return {
        updatedSkill: this.memoryStore.updateSkill(skill),
        healing
      };
    }

    this.memoryStore.updateSkill(skill);
    return { healing };
  }

  async invoke<TMethod extends MethodName>(
    method: TMethod,
    params: MethodParams<TMethod>
  ): Promise<MethodResult<TMethod>> {
    const args = asRecord(params);

    switch (method) {
      case 'session.create': {
        return this.withTrace(method, params, async () => {
          const requestedProtocol = typeof args.protocolVersion === 'string' ? args.protocolVersion : undefined;
          if (requestedProtocol && !COMPATIBLE_PROTOCOL_VERSIONS.includes(requestedProtocol as never)) {
            throw new RpcError(
              `Unsupported protocol version: ${requestedProtocol}`,
              -32602,
              BakErrorCode.E_INVALID_PARAMS
            );
          }
          const sessionId = this.newSession();
          return {
            sessionId,
            protocolVersion: PROTOCOL_VERSION,
            compatibleProtocolVersions: [...COMPATIBLE_PROTOCOL_VERSIONS]
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'session.close': {
        return this.withTrace(method, params, async () => {
          const requestedSessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          if (requestedSessionId && (!this.sessionId || requestedSessionId !== this.sessionId)) {
            throw new RpcError('Session not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          this.sessionId = null;
          this.recording = null;
          this.autoRecording = null;
          this.contextFrameDepth = 0;
          this.contextShadowDepth = 0;
          return { closed: true } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'session.info': {
        return this.withTrace(method, params, async () => {
          const requestedSessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          if (requestedSessionId && (!this.sessionId || requestedSessionId !== this.sessionId)) {
            throw new RpcError('Session not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          const connection = this.effectiveConnection();
          const activeTab = await this.activeTabSummary();
          return {
            sessionId: this.sessionId,
            paired: Boolean(this.pairingStore.getToken()),
            extensionConnected: connection.extensionConnected,
            connectionState: connection.connectionState,
            connectionReason: connection.connectionReason,
            protocolVersion: PROTOCOL_VERSION,
            compatibleProtocolVersions: [...COMPATIBLE_PROTOCOL_VERSIONS],
            extensionVersion: connection.raw.extensionVersion,
            memoryBackend: {
              requestedBackend: this.memoryRuntime.requestedBackend,
              backend: this.memoryRuntime.backend,
              fallbackReason: this.memoryRuntime.fallbackReason ?? null
            },
            activeTab,
            context: {
              frameDepth: this.contextFrameDepth,
              shadowDepth: this.contextShadowDepth
            },
            recording: Boolean(this.recording),
            autoLearning: this.autoLearningEnabled,
            heartbeatStale: connection.heartbeatStale,
            heartbeatAgeMs: connection.heartbeatAgeMs,
            staleAfterMs: this.heartbeatStaleAfterMs,
            lastSeenTs: connection.raw.lastSeenTs,
            lastHeartbeatTs: connection.raw.lastHeartbeatTs,
            bridgePendingRequests: connection.raw.pendingRequests,
            bridgeLastError: connection.raw.lastError,
            bridgeTotalRequests: connection.raw.totalRequests,
            bridgeTotalFailures: connection.raw.totalFailures,
            bridgeTotalTimeouts: connection.raw.totalTimeouts,
            bridgeTotalNotReady: connection.raw.totalNotReady,
            capabilityCount: SUPPORTED_METHODS.size
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'tabs.list': {
        return this.withTrace(method, params, async () => {
          this.ensurePairing();
          this.ensureConnected();
          return this.driver.tabsList();
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'tabs.focus': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const tabId = Number(args.tabId);
          const result = await this.driver.tabsFocus(tabId);
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'tabs.new': {
        return this.withTrace(method, params, async () => {
          this.ensurePairing();
          this.ensureConnected();
          const result = await this.driver.tabsNew(args.url as string | undefined);
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'tabs.close': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const result = await this.driver.tabsClose(Number(args.tabId));
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'tabs.getActive': {
        return this.withTrace(method, params, async () => {
          this.ensurePairing();
          this.ensureConnected();
          const result = await this.driver.rawRequest<{ tab: { id: number; title: string; url: string; active: boolean } | null }>(
            method,
            args
          );
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'tabs.get': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const result = await this.driver.rawRequest<{ tab: { id: number; title: string; url: string; active: boolean } }>(
            method,
            args
          );
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'page.goto': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const url = String(args.url);
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const result = await this.driver.pageGoto(url, tabId);
          this.captureStep({
            kind: 'goto',
            url
          });
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'page.back': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.pageBack(args.tabId as number | undefined)) as Promise<MethodResult<TMethod>>;
      }
      case 'page.forward': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.pageForward(args.tabId as number | undefined)) as Promise<MethodResult<TMethod>>;
      }
      case 'page.reload': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.pageReload(args.tabId as number | undefined)) as Promise<MethodResult<TMethod>>;
      }
      case 'page.wait': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const mode = args.mode as 'selector' | 'text' | 'url';
          const value = String(args.value);
          const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const result = await this.driver.pageWait(mode, value, timeoutMs, tabId);
          this.captureStep({
            kind: 'wait',
            waitFor: {
              mode,
              value,
              timeoutMs
            }
          });
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'page.snapshot': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const includeBase64 = Boolean(args.includeBase64);
          const snapshot = await this.driver.pageSnapshot(tabId, true);
          const redactedElements = redactElements(snapshot.elements);

          const traceId = this.currentTraceId || this.traceStore.newTraceId();
          this.currentTraceId = traceId;
          const snapshotDir = ensureDir(join(this.dataDir, 'snapshots', traceId));
          const imagePath = join(snapshotDir, `${Date.now()}_viewport.png`);
          const elementsPath = join(snapshotDir, `${Date.now()}_elements.json`);

          writeFileSync(imagePath, Buffer.from(snapshot.imageBase64, 'base64'));
          writeFileSync(elementsPath, `${JSON.stringify(redactedElements, null, 2)}\n`, 'utf8');

          return {
            traceId,
            imagePath,
            elementsPath,
            imageBase64: includeBase64 ? snapshot.imageBase64 : undefined,
            elementCount: redactedElements.length
          };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'element.click': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = args.locator as Locator;
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const requiresConfirm = args.requiresConfirm === true;
          const result = await this.clickWithPolicy(locator, tabId, requiresConfirm);
          this.captureStep({
            kind: 'click',
            locator,
            requiresConfirmation: requiresConfirm,
            targetCandidates: buildTargetCandidates(locator)
          });
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'element.type': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = args.locator as Locator;
          const text = String(args.text ?? '');
          const clear = Boolean(args.clear);
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const requiresConfirm = args.requiresConfirm === true;
          const result = await this.typeWithPolicy(locator, text, clear, tabId, requiresConfirm);
          this.captureStep({
            kind: 'type',
            locator,
            text: sanitizeInputText(locator, text),
            clear,
            requiresConfirmation: requiresConfirm,
            targetCandidates: buildTargetCandidates(locator)
          });
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'element.scroll': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = (args.locator as Locator | undefined) ?? undefined;
          const dx = Number(args.dx ?? 0);
          const dy = Number(args.dy ?? 320);
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const result = await this.driver.elementScroll(locator, dx, dy, tabId);
          this.captureStep({
            kind: 'elementScroll',
            locator,
            dx,
            dy,
            targetCandidates: buildTargetCandidates(locator)
          });
          return result;
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'debug.getConsole': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          return this.driver.debugGetConsole(limit, tabId);
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.recordStart': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const providedIntent = typeof args.intent === 'string' ? args.intent : undefined;
          if (providedIntent !== undefined && !providedIntent.trim()) {
            throw new RpcError('intent must not be empty', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const intent = String(args.intent ?? 'unspecified');
          const tabs = await this.driver.tabsList();
          const active = tabs.tabs.find((tab) => tab.active) ?? tabs.tabs[0];
          const startUrl = active?.url ?? 'about:blank';
          const domain = inferDomainFromStartUrl(startUrl);

          this.recording = {
            recordingId: id('recording'),
            intent,
            domain,
            startUrl,
            steps: [],
            anchors: []
          };

          return { recordingId: this.recording.recordingId };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.recordStop': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          if (!this.recording) {
            throw new RpcError('No recording in progress', 4004, BakErrorCode.E_NOT_FOUND);
          }

          const outcome = (args.outcome as Episode['outcome']) ?? 'success';

          const recording = this.recording;
          this.recording = null;
          const resolvedStart = this.resolveRecordingStart(recording, true);

          const episode = this.memoryStore.createEpisode({
            domain: resolvedStart.domain,
            startUrl: resolvedStart.startUrl,
            intent: recording.intent,
            steps: recording.steps,
            anchors: [...new Set(recording.anchors)].slice(0, 20),
            outcome,
            mode: (args.mode as 'manual' | 'auto' | undefined) ?? 'manual'
          });

          let skillId: string | undefined;
          if (outcome === 'success' && recording.steps.length > 0) {
            const skillPayload = extractSkillFromEpisode(episode);
            const skill = this.memoryStore.createSkill(skillPayload);
            skillId = skill.id;
          }

          return {
            episodeId: episode.id,
            skillId
          };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.skills.list': {
        return this.withTrace(method, params, async () => {
          const domain = (args.domain as string | undefined) ?? undefined;
          const intent = (args.intent as string | undefined) ?? undefined;
          if (typeof args.limit === 'number' && (!Number.isFinite(args.limit) || args.limit < 1)) {
            throw new RpcError('limit must be >= 1', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : undefined;
          const skills = this.memoryStore.listSkills({ domain, intent });
          return { skills: typeof limit === 'number' ? skills.slice(0, limit) : skills };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.skills.show': {
        return this.withTrace(method, params, async () => {
          const skill = this.memoryStore.getSkill(String(args.id));
          if (!skill) {
            throw new RpcError('Skill not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return { skill };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.skills.retrieve': {
        return this.withTrace(method, params, async () => {
          const intent = String(args.intent ?? '').trim();
          if (!intent) {
            throw new RpcError('intent is required', -32602, BakErrorCode.E_INVALID_PARAMS);
          }

          const anchors = Array.isArray(args.anchors) ? (args.anchors as string[]) : [];
          let url = (args.url as string | undefined) ?? '';
          let domain = (args.domain as string | undefined) ?? '';

          if (!domain && url) {
            domain = getDomain(url);
          }
          if ((!domain || !url) && this.driver.isConnected()) {
            const tabs = await this.driver.tabsList();
            const activeUrl = tabs.tabs.find((tab) => tab.active)?.url ?? tabs.tabs[0]?.url;
            if (!url && activeUrl) {
              url = activeUrl;
            }
            if (!domain && activeUrl) {
              domain = getDomain(activeUrl);
            }
          }

          const minScore =
            typeof args.minScore === 'number'
              ? Math.min(1, Math.max(0, args.minScore))
              : this.memoryRetrieveMinScore;
          const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined;
          const skills = retrieveSkills(this.memoryStore.listSkills(), {
            domain: domain || 'unknown',
            intent,
            anchors,
            url,
            minScore
          });
          return { skills: typeof limit === 'number' ? skills.slice(0, limit) : skills };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.skills.delete': {
        return this.withTrace(method, params, async () => {
          const ok = this.memoryStore.deleteSkill(String(args.id));
          if (!ok) {
            throw new RpcError('Skill not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return { ok: true };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.skills.stats': {
        return this.withTrace(method, params, async () => {
          const requestedId = typeof args.id === 'string' ? args.id : undefined;
          if (requestedId !== undefined && !requestedId.trim()) {
            throw new RpcError('id must not be empty', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const domain = typeof args.domain === 'string' ? args.domain : undefined;
          const skills = this.memoryStore.listSkills({ domain });
          const filtered = requestedId ? skills.filter((skill) => skill.id === requestedId) : skills;
          return {
            stats: filtered.map((skill) => ({
              id: skill.id,
              intent: skill.intent,
              domain: skill.domain,
              runs: skill.stats.runs,
              success: skill.stats.success,
              failure: skill.stats.failure,
              healAttempts: skill.stats.healAttempts ?? 0,
              healSuccess: skill.stats.healSuccess ?? 0
            }))
          };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.episodes.list': {
        return this.withTrace(method, params, async () => {
          const domain = typeof args.domain === 'string' ? args.domain : undefined;
          const intent = typeof args.intent === 'string' ? args.intent.toLowerCase() : undefined;
          if (typeof args.limit === 'number' && (!Number.isFinite(args.limit) || args.limit < 1)) {
            throw new RpcError('limit must be >= 1', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : undefined;
          const episodes = this.memoryStore
            .listEpisodes()
            .filter((episode) => {
              if (domain && episode.domain !== domain) {
                return false;
              }
              if (intent && !episode.intent.toLowerCase().includes(intent)) {
                return false;
              }
              return true;
            });
          return {
            episodes: typeof limit === 'number' ? episodes.slice(0, limit) : episodes
          };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.replay.explain': {
        return this.withTrace(method, params, async () => {
          const skillId = String(args.id);
          const skill = this.memoryStore.getSkill(skillId);
          if (!skill) {
            throw new RpcError('Skill not found', 4004, BakErrorCode.E_NOT_FOUND);
          }

          return {
            skillId: skill.id,
            steps: skill.plan.map((step, index) => ({
              index,
              kind: step.kind,
              locator: step.locator ?? step.targetCandidates?.[0],
              summary: [
                step.kind,
                step.locator?.name ?? step.locator?.text ?? step.locator?.css ?? '',
                step.waitFor?.value ?? '',
                step.url ?? ''
              ]
                .join(' ')
                .trim()
            }))
          };
        }) as Promise<MethodResult<TMethod>>;
      }
      case 'memory.skills.run': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const skillId = String(args.id);
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const skill = this.memoryStore.getSkill(skillId);
          if (!skill) {
            throw new RpcError('Skill not found', 4004, BakErrorCode.E_NOT_FOUND);
          }

          const paramsInput = this.normalizeRunParams(skill, args.params);

          try {
            const runOutcome = await this.runSkill(skill, {
              params: paramsInput,
              tabId
            });
            const traceId = this.currentTraceId || this.traceStore.newTraceId();
            this.currentTraceId = traceId;
            this.appendHealingAudit(traceId, skill.id, runOutcome.healing);
            return {
              ok: true,
              updatedSkill: runOutcome.updatedSkill,
              usedSkillId: skill.id,
              retries: runOutcome.healing.attempts,
              healed: runOutcome.healing.successes > 0
            };
          } catch (error) {
            this.updateRunStats(skill, false, 0, true);
            this.memoryStore.updateSkill(skill);
            const normalized = this.normalizeError(error);
            const traceId = this.currentTraceId || this.traceStore.newTraceId();
            this.currentTraceId = traceId;
            this.appendHealingAudit(traceId, skill.id, healingSummaryFromError(normalized));
            throw normalized;
          }
        }) as Promise<MethodResult<TMethod>>;
      }
      default: {
        const methodName = String(method) as MethodName;
        if (DYNAMIC_FORWARD_METHODS.has(methodName)) {
          this.ensurePairing();
          this.ensureConnected();
          return this.withTrace(methodName, params, async () => {
            const forwardArgs = await this.withPolicyOnDynamicRequest(methodName, args);
            const result = await this.driver.rawRequest(methodName, forwardArgs);
            if (methodName === 'context.enterFrame' || methodName === 'context.exitFrame' || methodName === 'context.reset') {
              const payload = asRecord(result);
              this.contextFrameDepth = typeof payload.frameDepth === 'number' ? payload.frameDepth : 0;
              if (methodName === 'context.reset') {
                this.contextShadowDepth = 0;
              }
            }
            if (methodName === 'context.enterShadow' || methodName === 'context.exitShadow' || methodName === 'context.reset') {
              const payload = asRecord(result);
              this.contextShadowDepth = typeof payload.shadowDepth === 'number' ? payload.shadowDepth : 0;
              if (methodName === 'context.reset') {
                this.contextFrameDepth = 0;
              }
            }

            if (methodName.startsWith('element.')) {
              const locator = (forwardArgs.locator as Locator | undefined) ?? undefined;
              if (methodName === 'element.hover' && locator) {
                this.captureStep({ kind: 'hover', locator, targetCandidates: buildTargetCandidates(locator) });
              }
              if (methodName === 'element.doubleClick' && locator) {
                this.captureStep({ kind: 'doubleClick', locator, targetCandidates: buildTargetCandidates(locator) });
              }
              if (methodName === 'element.rightClick' && locator) {
                this.captureStep({ kind: 'rightClick', locator, targetCandidates: buildTargetCandidates(locator) });
              }
              if (methodName === 'element.select' && locator) {
                this.captureStep({
                  kind: 'select',
                  locator,
                  values: Array.isArray(forwardArgs.values) ? (forwardArgs.values as string[]) : [],
                  targetCandidates: buildTargetCandidates(locator)
                });
              }
              if (methodName === 'element.check' && locator) {
                this.captureStep({ kind: 'check', locator, targetCandidates: buildTargetCandidates(locator) });
              }
              if (methodName === 'element.uncheck' && locator) {
                this.captureStep({ kind: 'uncheck', locator, targetCandidates: buildTargetCandidates(locator) });
              }
            }

            if (methodName === 'page.scrollTo') {
              this.captureStep({
                kind: 'scrollTo',
                x: typeof forwardArgs.x === 'number' ? forwardArgs.x : undefined,
                y: typeof forwardArgs.y === 'number' ? forwardArgs.y : undefined,
                behavior:
                  forwardArgs.behavior === 'smooth' || forwardArgs.behavior === 'auto' ? forwardArgs.behavior : undefined
              });
            }
            if (methodName === 'keyboard.press') {
              this.captureStep({
                kind: 'press',
                key: typeof forwardArgs.key === 'string' ? forwardArgs.key : undefined
              });
            }
            if (methodName === 'keyboard.type') {
              this.captureStep({
                kind: 'keyboardType',
                text: typeof forwardArgs.text === 'string' ? forwardArgs.text : '',
                delayMs: typeof forwardArgs.delayMs === 'number' ? forwardArgs.delayMs : undefined
              });
            }
            if (methodName === 'keyboard.hotkey') {
              this.captureStep({
                kind: 'hotkey',
                keys: Array.isArray(forwardArgs.keys) ? (forwardArgs.keys as string[]) : []
              });
            }
            if (methodName === 'file.upload') {
              const locator = forwardArgs.locator as Locator | undefined;
              if (locator) {
                this.captureStep({
                  kind: 'upload',
                  locator,
                  targetCandidates: buildTargetCandidates(locator)
                });
              }
            }

            return result;
          }) as Promise<MethodResult<TMethod>>;
        }
        throw new RpcError(`Unknown method: ${String(method)}`, -32601, BakErrorCode.E_NOT_FOUND);
      }
    }
  }

  async invokeDynamic(method: string, params: unknown): Promise<unknown> {
    return this.invoke(method as keyof MethodMap, params as MethodMap[keyof MethodMap]['params']);
  }

  status(): {
    sessionId: string | null;
    paired: boolean;
    extensionConnected: boolean;
    connectionState: 'connecting' | 'connected' | 'disconnected';
    connectionReason: string | null;
    protocolVersion: string;
    extensionVersion: string | null;
    memoryBackend: {
      requestedBackend: MemoryBackend;
      backend: MemoryBackend;
      fallbackReason: string | null;
    };
    recording: boolean;
    heartbeatStale: boolean;
    heartbeatAgeMs: number | null;
    staleAfterMs: number;
    lastSeenTs: number | null;
    lastHeartbeatTs: number | null;
    bridgePendingRequests: number;
    bridgeLastError: string | null;
    bridgeTotalRequests: number;
    bridgeTotalFailures: number;
    bridgeTotalTimeouts: number;
    bridgeTotalNotReady: number;
    domain?: string;
  } {
    const connection = this.effectiveConnection();
    return {
      sessionId: this.sessionId,
      paired: Boolean(this.pairingStore.getToken()),
      extensionConnected: connection.extensionConnected,
      connectionState: connection.connectionState,
      connectionReason: connection.connectionReason,
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: connection.raw.extensionVersion,
      memoryBackend: {
        requestedBackend: this.memoryRuntime.requestedBackend,
        backend: this.memoryRuntime.backend,
        fallbackReason: this.memoryRuntime.fallbackReason ?? null
      },
      recording: Boolean(this.recording),
      heartbeatStale: connection.heartbeatStale,
      heartbeatAgeMs: connection.heartbeatAgeMs,
      staleAfterMs: this.heartbeatStaleAfterMs,
      lastSeenTs: connection.raw.lastSeenTs,
      lastHeartbeatTs: connection.raw.lastHeartbeatTs,
      bridgePendingRequests: connection.raw.pendingRequests,
      bridgeLastError: connection.raw.lastError,
      bridgeTotalRequests: connection.raw.totalRequests,
      bridgeTotalFailures: connection.raw.totalFailures,
      bridgeTotalTimeouts: connection.raw.totalTimeouts,
      bridgeTotalNotReady: connection.raw.totalNotReady,
      domain: this.recording?.domain
    };
  }

  getCurrentTraceId(): string {
    return this.currentTraceId;
  }

  exportTrace(traceId: string): { tracePath: string } {
    return this.traceStore.export(traceId);
  }

  recordingState(): RecordingState | null {
    return this.recording;
  }

  seedSessionIfNeeded(): string {
    return this.sessionId ?? this.newSession();
  }

  suggestLocators(step: SkillPlanStep): Locator[] {
    const locator = maybeLocatorFromStep(step);
    return buildTargetCandidates(locator);
  }
}
