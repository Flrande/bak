import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BakErrorCode,
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
  rankCandidates,
  retrieveSkills
} from './memory/extract.js';
import { resolveMemoryBackend, type MemoryBackend } from './memory/factory.js';
import type { MemoryStoreBackend } from './memory/store.js';
import { PolicyEngine, type PolicyAction, type PolicyEvaluation } from './policy.js';
import { redactElements } from './privacy.js';
import type { PairingStore } from './pairing-store.js';
import type { TraceStore } from './trace-store.js';
import { ensureDir, getDomain, getPathname, id, resolveDataDir } from './utils.js';

interface RecordingState {
  recordingId: string;
  intent: string;
  domain: string;
  startUrl: string;
  steps: SkillPlanStep[];
  anchors: string[];
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

function maybeParamValue(text: string, params?: Record<string, string>): string {
  const match = text.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
  if (!match) {
    return text;
  }
  const key = match[1];
  return params?.[key] ?? text;
}

function sanitizeInputText(locator: Locator, text: string): string {
  const lower = `${locator.name ?? ''} ${locator.text ?? ''}`.toLowerCase();
  if (lower.includes('password') || lower.includes('otp') || lower.includes('验证码')) {
    return '[REDACTED]';
  }
  return text;
}

function maybeLocatorFromStep(step: SkillPlanStep): Locator | undefined {
  if (step.locator) {
    return step.locator;
  }
  return step.targetCandidates?.[0];
}

function hasHealingAttemptFlag(error: RpcError): boolean {
  const source = error as RpcError & { data?: Record<string, unknown>; details?: Record<string, unknown> };
  const data = source.details ?? source.data;
  return data?.healingAttempted === true;
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
    this.traceStore.append(traceId, { method, params });

    try {
      const result = await action();
      this.traceStore.append(traceId, { method: `${method}:result`, params: {}, result });
      return result;
    } catch (error) {
      const normalized = this.normalizeError(error);
      this.traceStore.append(traceId, {
        method: `${method}:error`,
        params: {},
        error: {
          code: normalized.bakCode,
          message: normalized.message
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
    if (!this.recording) {
      return;
    }
    this.recording.steps.push(step);

    if (step.locator?.name) {
      this.recording.anchors.push(step.locator.name);
    }
    if (step.locator?.text) {
      this.recording.anchors.push(step.locator.text);
    }
    if (step.url) {
      this.recording.anchors.push(step.url);
    }
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
        if (step.kind === 'click') {
          await this.clickWithPolicy(candidate, options.tabId, Boolean(step.requiresConfirmation));
        } else if (step.kind === 'type') {
          const raw = maybeParamValue(step.text ?? '', options.params);
          await this.typeWithPolicy(candidate, raw, true, options.tabId, Boolean(step.requiresConfirmation));
        }
        return { ok: true, chosen: candidate, healingAttempted: false, healingSucceeded: false };
      } catch (error) {
        const normalized = this.normalizeError(error);
        if (normalized.bakCode === BakErrorCode.E_PERMISSION) {
          throw normalized;
        }
        continue;
      }
    }

    const refreshed = await this.driver.pageSnapshot(options.tabId);
    const ranked = rankCandidates(refreshed.elements, ordered, 3);

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
        await this.typeWithPolicy(retry, raw, true, options.tabId, Boolean(step.requiresConfirmation));
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
  }

  private async runSkill(skill: Skill, options: { tabId?: number; params?: Record<string, string> }): Promise<Skill | undefined> {
    let updated = false;
    let healingAttempts = 0;
    let healingSuccesses = 0;

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

      if (step.kind === 'click' || step.kind === 'type') {
        try {
          const result = await this.pickRunCandidate(step, options);
          updated = updated || Boolean(result.updated);
          if (result.healingAttempted) {
            healingAttempts += 1;
          }
          if (result.healingSucceeded) {
            healingSuccesses += 1;
          }
        } catch (error) {
          const normalized = this.normalizeError(error);
          if (hasHealingAttemptFlag(normalized)) {
            healingAttempts += 1;
          }
          this.applyHealingStats(skill, healingAttempts, healingSuccesses);
          throw normalized;
        }
        continue;
      }
    }

    skill.stats.runs += 1;
    skill.stats.success += 1;
    this.applyHealingStats(skill, healingAttempts, healingSuccesses);

    if (updated) {
      return this.memoryStore.updateSkill(skill);
    }

    this.memoryStore.updateSkill(skill);
    return undefined;
  }

  async invoke<TMethod extends MethodName>(
    method: TMethod,
    params: MethodParams<TMethod>
  ): Promise<MethodResult<TMethod>> {
    const args = asRecord(params);

    switch (method) {
      case 'session.create': {
        const sessionId = this.newSession();
        return { sessionId } as MethodResult<TMethod>;
      }
      case 'session.close': {
        this.sessionId = null;
        this.recording = null;
        return { closed: true } as MethodResult<TMethod>;
      }
      case 'session.info': {
        const connection = this.effectiveConnection();
        const activeTab = await this.activeTabSummary();
        return {
          sessionId: this.sessionId,
          paired: Boolean(this.pairingStore.getToken()),
          extensionConnected: connection.extensionConnected,
          connectionState: connection.connectionState,
          connectionReason: connection.connectionReason,
          extensionVersion: connection.raw.extensionVersion,
          memoryBackend: {
            requestedBackend: this.memoryRuntime.requestedBackend,
            backend: this.memoryRuntime.backend,
            fallbackReason: this.memoryRuntime.fallbackReason ?? null
          },
          activeTab,
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
          bridgeTotalNotReady: connection.raw.totalNotReady
        } as MethodResult<TMethod>;
      }
      case 'tabs.list': {
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, () => this.driver.tabsList()) as Promise<MethodResult<TMethod>>;
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
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
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
          const snapshot = await this.driver.pageSnapshot(tabId);
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
          return this.driver.elementScroll(locator, dx, dy, tabId);
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

          const episode = this.memoryStore.createEpisode({
            domain: recording.domain,
            startUrl: recording.startUrl,
            intent: recording.intent,
            steps: recording.steps,
            anchors: [...new Set(recording.anchors)].slice(0, 20),
            outcome
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
          const skills = this.memoryStore.listSkills({ domain, intent });
          return { skills };
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
          let domain = (args.domain as string | undefined) ?? '';

          if (!domain && this.driver.isConnected()) {
            const tabs = await this.driver.tabsList();
            domain = tabs.tabs.find((tab) => tab.active)?.url ? getDomain(tabs.tabs.find((tab) => tab.active)!.url) : '';
          }

          const skills = retrieveSkills(this.memoryStore.listSkills(), {
            domain: domain || 'unknown',
            intent,
            anchors,
            minScore: this.memoryRetrieveMinScore
          });
          return { skills };
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

          const paramsInput = (args.params as Record<string, string> | undefined) ?? {};

          try {
            const updatedSkill = await this.runSkill(skill, {
              params: paramsInput,
              tabId
            });
            return {
              ok: true,
              updatedSkill
            };
          } catch (error) {
            skill.stats.runs += 1;
            skill.stats.failure += 1;
            this.memoryStore.updateSkill(skill);
            throw error;
          }
        }) as Promise<MethodResult<TMethod>>;
      }
      default:
        throw new RpcError(`Unknown method: ${String(method)}`, -32601, BakErrorCode.E_NOT_FOUND);
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
