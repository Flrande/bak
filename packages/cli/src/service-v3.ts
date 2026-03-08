import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BakErrorCode,
  COMPATIBLE_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  type CaptureEvent,
  type CaptureMarkRole,
  type CaptureSession,
  type DraftMemory,
  type DurableMemory,
  type ElementMapItem,
  type Locator,
  type MemoryApplicabilityCheck,
  type MemoryExecutionMode,
  type MemoryKind,
  type MemoryParameterValue,
  type MemoryPlan,
  type MemoryPlanStep,
  type MemoryRevision,
  type MemoryRun,
  type MemoryRunStep,
  type MemorySearchCandidate,
  type MemoryStep,
  type MethodMap,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type PageFingerprint,
  type PatchSuggestion,
  type UploadFilePayload,
  RpcError
} from '@flrande/bak-protocol';
import type { BrowserDriver } from './drivers/browser-driver.js';
import { BridgeError } from './drivers/extension-bridge.js';
import { evaluateConnectionHealth } from './connection-health.js';
import {
  buildDraftMemories,
  buildPatchedRevision,
  buildPlanSteps,
  explainMemoryApplicability,
  rankCandidateLocators,
  rankMemories,
  splitCompositeSteps,
  summarizeStep
} from './memory/extract.js';
import { resolveMemoryBackend, type MemoryBackend } from './memory/factory.js';
import type { MemoryStoreBackend } from './memory/store.js';
import { PolicyEngine, type PolicyAction, type PolicyEvaluation } from './policy.js';
import { redactElements, redactText, redactUnknown } from './privacy.js';
import type { PairingStore } from './pairing-store.js';
import type { TraceStore } from './trace-store.js';
import { ensureDir, getDomain, getPathname, id, nowIso, resolveDataDir } from './utils.js';

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
  'memory.capture.begin',
  'memory.capture.mark',
  'memory.capture.end',
  'memory.drafts.list',
  'memory.drafts.get',
  'memory.drafts.promote',
  'memory.drafts.discard',
  'memory.memories.search',
  'memory.memories.get',
  'memory.memories.explain',
  'memory.memories.deprecate',
  'memory.memories.delete',
  'memory.plans.create',
  'memory.plans.get',
  'memory.plans.execute',
  'memory.runs.list',
  'memory.runs.get',
  'memory.patches.list',
  'memory.patches.get',
  'memory.patches.apply',
  'memory.patches.reject'
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

type ContextMethod =
  | 'context.enterFrame'
  | 'context.exitFrame'
  | 'context.enterShadow'
  | 'context.exitShadow'
  | 'context.reset';

interface ActiveCapture {
  captureSessionId: string;
  goal: string;
  tabId?: number;
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

function redactTraceParams(method: string, params: unknown): unknown {
  const redacted = redactUnknown(params);
  if (method !== 'element.type') {
    return redacted;
  }
  const payload = asRecord(redacted);
  if (!('text' in payload)) {
    return payload;
  }
  return { ...payload, text: '[REDACTED]' };
}

function redactTraceResult(method: string, result: unknown): unknown {
  const redacted = redactUnknown(result);
  if (method === 'page.snapshot') {
    const payload = asRecord(redacted);
    if (typeof payload.imageBase64 !== 'string') {
      return payload;
    }
    return { ...payload, imageBase64: '[REDACTED:base64]' };
  }
  if (method !== 'debug.dumpState') {
    return redacted;
  }
  const payload = asRecord(redacted);
  const snapshot = asRecord(payload.snapshot);
  if (typeof snapshot.imageBase64 !== 'string') {
    return payload;
  }
  return {
    ...payload,
    snapshot: {
      ...snapshot,
      imageBase64: '[REDACTED:base64]'
    }
  };
}

function templateKeys(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [...value.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => match[1]);
}

function applyTemplates(value: string | undefined, parameters: Record<string, MemoryParameterValue>): string | undefined {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
    const bound = parameters[key];
    if (typeof bound === 'string') {
      return bound;
    }
    if (typeof bound === 'boolean') {
      return bound ? 'true' : 'false';
    }
    return '';
  });
}

function rpcErrorMetadata(error: RpcError): Record<string, unknown> {
  return (error as RpcError & { details?: Record<string, unknown> }).details ?? {};
}

export class BakService {
  private readonly driver: BrowserDriver;
  private readonly pairingStore: PairingStore;
  private readonly traceStore: TraceStore;
  private readonly memoryStore: MemoryStoreBackend;
  private readonly dataDir: string;
  private readonly policyEngine: PolicyEngine;
  private readonly memoryRuntime: ServiceMemoryRuntime;
  private sessionId: string | null = null;
  private currentTraceId = '';
  private activeCapture: ActiveCapture | null = null;
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

  seedSessionIfNeeded(): string {
    if (this.sessionId) {
      return this.sessionId;
    }
    return this.newSession();
  }

  private listCapturingSessions(): CaptureSession[] {
    return this.memoryStore
      .listCaptureSessions(200)
      .filter((session) => session.status === 'capturing')
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  }

  private refreshActiveCapture(): ActiveCapture | null {
    const session = this.listCapturingSessions()[0];
    this.activeCapture = session
      ? {
          captureSessionId: session.id,
          goal: session.goal,
          tabId: session.tabId
        }
      : null;
    return this.activeCapture;
  }

  status(): MethodResult<'session.info'> {
    const connection = this.effectiveConnection();
    const activeCapture = this.refreshActiveCapture();
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
      activeTab: null,
      context: {
        frameDepth: this.contextFrameDepth,
        shadowDepth: this.contextShadowDepth
      },
      captureSessionId: activeCapture?.captureSessionId ?? null,
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
    };
  }

  async invokeDynamic(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.invoke(method as MethodName, params as never);
  }

  private async tickHeartbeat(): Promise<void> {
    if (!this.driver.isConnected()) {
      return;
    }
    try {
      await this.driver.sessionPing(Math.max(1_000, Math.floor(this.heartbeatIntervalMs / 2)));
    } catch {
      // Ignore heartbeat failures. Bridge stats capture state changes.
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
    return { ...health, raw };
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
      this.traceStore.append(traceId, { method: 'rpc.failure', params: { method, bakCode: normalized.bakCode } });
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

  private async activeTabSummary(): Promise<{ id: number; title: string; url: string } | null> {
    if (!this.driver.isConnected()) {
      return null;
    }
    try {
      const tabs = await this.driver.tabsList();
      const active = tabs.tabs.find((tab) => tab.active) ?? tabs.tabs[0];
      return active ? { id: active.id, title: active.title, url: active.url } : null;
    } catch {
      return null;
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

  private buildFingerprint(input: {
    url: string;
    title: string;
    headings?: string[];
    textSnippets?: string[];
    anchorNames?: string[];
    dom: PageFingerprint['dom'];
  }): PageFingerprint {
    const parsed = (() => {
      try {
        const url = new URL(input.url);
        return {
          origin: url.origin,
          path: url.pathname || '/'
        };
      } catch {
        return {
          origin: '',
          path: '/'
        };
      }
    })();
    return {
      id: id('page_fp'),
      url: input.url,
      origin: parsed.origin,
      path: parsed.path,
      title: input.title,
      headings: input.headings ?? [],
      textSnippets: input.textSnippets ?? [],
      anchorNames: input.anchorNames ?? [],
      dom: input.dom,
      capturedAt: nowIso()
    };
  }

  private buildFingerprintForUrl(url: string): PageFingerprint {
    return this.buildFingerprint({
      url,
      title: '',
      dom: {
        totalElements: 0,
        interactiveElements: 0,
        iframes: 0,
        shadowHosts: 0,
        tagHistogram: []
      }
    });
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

  private async withPolicyOnDynamicRequest(methodName: MethodName, params: Record<string, unknown>): Promise<Record<string, unknown>> {
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

  private async clickWithPolicy(locator: Locator, tabId?: number, requiresConfirm = false): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicy('element.click', locator);
    return this.driver.elementClick(locator, tabId, requiresConfirm || policy.requiresConfirm);
  }

  private async typeWithPolicy(locator: Locator, text: string, clear: boolean, tabId?: number, requiresConfirm = false): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicy('element.type', locator);
    return this.driver.elementType(locator, text, clear, tabId, requiresConfirm || policy.requiresConfirm);
  }

  private updateContextFromResult(methodName: ContextMethod, result: unknown): void {
    const payload = asRecord(result);
    if (methodName === 'context.enterFrame' || methodName === 'context.exitFrame' || methodName === 'context.reset') {
      this.contextFrameDepth = typeof payload.frameDepth === 'number' ? payload.frameDepth : 0;
      if (methodName === 'context.reset') {
        this.contextShadowDepth = 0;
      }
    }
    if (methodName === 'context.enterShadow' || methodName === 'context.exitShadow' || methodName === 'context.reset') {
      this.contextShadowDepth = typeof payload.shadowDepth === 'number' ? payload.shadowDepth : 0;
      if (methodName === 'context.reset') {
        this.contextFrameDepth = 0;
      }
    }
  }

  private async readCurrentFingerprint(tabId?: number): Promise<PageFingerprint | undefined> {
    if (!this.driver.isConnected()) {
      return undefined;
    }
    try {
      const [urlResult, titleResult, domResult, textResult] = await Promise.all([
        this.driver.rawRequest<{ url: string }>('page.url', { tabId }),
        this.driver.rawRequest<{ title: string }>('page.title', { tabId }),
        this.driver.rawRequest<{ summary: MethodResult<'page.dom'>['summary'] }>('page.dom', { tabId }),
        this.driver.rawRequest<{ chunks: Array<{ text: string }> }>('page.text', { tabId, maxChunks: 10, chunkSize: 160 })
      ]);
      const resolvedUrl = typeof domResult.summary.url === 'string' && domResult.summary.url.trim().length > 0 ? domResult.summary.url : (urlResult.url ?? 'about:blank');
      const resolvedTitle =
        typeof domResult.summary.title === 'string' && domResult.summary.title.trim().length > 0 ? domResult.summary.title : (titleResult.title ?? '');
      return this.buildFingerprint({
        url: resolvedUrl,
        title: resolvedTitle,
        headings: textResult.chunks.slice(0, 3).map((chunk) => chunk.text),
        textSnippets: textResult.chunks.slice(0, 10).map((chunk) => chunk.text),
        anchorNames: textResult.chunks.slice(0, 8).map((chunk) => chunk.text),
        dom: {
          totalElements: domResult.summary.totalElements,
          interactiveElements: domResult.summary.interactiveElements,
          iframes: domResult.summary.iframes,
          shadowHosts: domResult.summary.shadowHosts,
          tagHistogram: domResult.summary.tagHistogram
        }
      });
    } catch {
      return undefined;
    }
  }

  private async captureCurrentFingerprint(tabId?: number): Promise<PageFingerprint | undefined> {
    const fingerprint = await this.readCurrentFingerprint(tabId);
    if (!fingerprint) {
      return undefined;
    }
    const { id: _fingerprintId, ...persisted } = fingerprint;
    return this.memoryStore.createPageFingerprint(persisted);
  }

  private candidateLocatorsForElement(locator: Locator, element: ElementMapItem): Locator[] {
    const candidates: Locator[] = [];
    const push = (candidate: Locator | undefined): void => {
      if (!candidate) {
        return;
      }
      const normalized: Locator = {
        eid: candidate.eid,
        role: candidate.role,
        name: candidate.name,
        text: candidate.text,
        css: candidate.css,
        index: candidate.index,
        shadow: candidate.shadow,
        framePath: candidate.framePath ? [...candidate.framePath] : undefined
      };
      const key = JSON.stringify(normalized);
      if (candidates.some((existing) => JSON.stringify(existing) === key)) {
        return;
      }
      candidates.push(normalized);
    };

    push(locator);
    push({
      eid: element.eid,
      role: element.role ?? undefined,
      name: element.name || undefined,
      text: element.text || undefined,
      css: element.selectors.css ?? undefined
    });
    push({
      role: element.role ?? undefined,
      name: element.name || undefined,
      text: element.text || undefined
    });
    return candidates;
  }

  private async enrichCapturedStep(step: MemoryStep, tabId?: number): Promise<MemoryStep> {
    if (!step.locator) {
      return step;
    }

    try {
      const result = await this.driver.rawRequest<MethodResult<'element.get'>>('element.get', {
        tabId,
        locator: step.locator
      });
      if (!result.element) {
        return step;
      }
      return {
        ...step,
        targetCandidates: this.candidateLocatorsForElement(step.locator, result.element)
      };
    } catch {
      return step;
    }
  }

  private async captureStep(step: MemoryStep, tabId?: number): Promise<void> {
    const activeCapture = this.refreshActiveCapture();
    if (!activeCapture) {
      return;
    }
    const enrichedStep = await this.enrichCapturedStep(step, tabId);
    this.memoryStore.createCaptureEvent({
      captureSessionId: activeCapture.captureSessionId,
      kind: enrichedStep.kind,
      step: enrichedStep
    });
  }

  private async persistPageSnapshot(tabId: number | undefined, includeBase64: boolean): Promise<{
    traceId: string;
    imagePath: string;
    elementsPath: string;
    imageBase64?: string;
    elementCount: number;
  }> {
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
  }

  private async captureMark(label: string, note: string | undefined, role: CaptureMarkRole | undefined, tabId?: number): Promise<CaptureEvent> {
    const activeCapture = this.refreshActiveCapture();
    if (!activeCapture) {
      throw new RpcError('No capture session in progress', 4004, BakErrorCode.E_NOT_FOUND);
    }
    const fingerprint = await this.captureCurrentFingerprint(tabId ?? activeCapture.tabId);
    return this.memoryStore.createCaptureEvent({
      captureSessionId: activeCapture.captureSessionId,
      kind: 'mark',
      label,
      note,
      role,
      pageFingerprintId: fingerprint?.id
    });
  }

  private requiredParameterKeys(revisions: MemoryRevision[]): string[] {
    const required = new Set<string>();
    for (const revision of revisions) {
      for (const [key, definition] of Object.entries(revision.parameterSchema)) {
        if (definition.required) {
          required.add(key);
        }
      }
      for (const step of revision.steps) {
        for (const key of templateKeys(step.text)) {
          required.add(key);
        }
        for (const value of step.values ?? []) {
          for (const key of templateKeys(value)) {
            required.add(key);
          }
        }
      }
    }
    return [...required.values()];
  }

  private normalizePlanParameters(raw: unknown, revisions: MemoryRevision[]): Record<string, MemoryParameterValue> {
    const params = asRecord(raw);
    const normalized: Record<string, MemoryParameterValue> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' || typeof value === 'boolean' || Array.isArray(value)) {
        normalized[key] = value as MemoryParameterValue;
        continue;
      }
      if (typeof value === 'object' && value !== null) {
        normalized[key] = value as MemoryParameterValue;
        continue;
      }
      throw new RpcError(`Unsupported memory parameter: ${key}`, -32602, BakErrorCode.E_INVALID_PARAMS);
    }
    const missing = this.requiredParameterKeys(revisions).filter((key) => normalized[key] === undefined);
    if (missing.length > 0) {
      throw new RpcError(`Missing required memory parameters: ${missing.join(', ')}`, -32602, BakErrorCode.E_INVALID_PARAMS, {
        missingParameters: missing
      });
    }
    return normalized;
  }

  private collectStats(memoryId: string, revisionId: string): { runs: number; successRate: number; freshScore: number; stabilityScore: number } {
    const runs = this.memoryStore.listRuns({ memoryId, limit: 50 }).filter((run) => run.revisionIds.includes(revisionId));
    const completed = runs.filter((run) => run.status === 'completed').length;
    const successRate = runs.length > 0 ? completed / runs.length : 0.5;
    const freshScore = runs.length > 0 ? 1 : 0.35;
    const stabilityScore = runs.length > 0 ? Math.max(0.2, successRate) : 0.4;
    return {
      runs: runs.length,
      successRate,
      freshScore,
      stabilityScore
    };
  }

  private getMemoryAndRevision(memoryId: string, revisionId?: string): { memory: DurableMemory; revision: MemoryRevision } {
    const memory = this.memoryStore.getMemory(memoryId);
    if (!memory) {
      throw new RpcError('Memory not found', 4004, BakErrorCode.E_NOT_FOUND);
    }
    const revision = this.memoryStore.getRevision(revisionId ?? memory.latestRevisionId);
    if (!revision || revision.memoryId !== memory.id) {
      throw new RpcError('Memory revision not found', 4004, BakErrorCode.E_NOT_FOUND);
    }
    return { memory, revision };
  }

  private async searchCandidates(goal: string, kind: MemoryKind | undefined, currentFingerprint?: PageFingerprint, includeDeprecated = false, limit?: number): Promise<MemorySearchCandidate[]> {
    const memories = this.memoryStore.listMemories({ limit: 200 }).filter((memory) => memory.status !== 'deleted');
    const revisions = memories
      .filter((memory) => includeDeprecated || memory.status !== 'deprecated')
      .map((memory) => {
        const revision = this.memoryStore.getRevision(memory.latestRevisionId);
        if (!revision) {
          return null;
        }
        const entryFingerprint = revision.entryFingerprintId ? this.memoryStore.getPageFingerprint(revision.entryFingerprintId) ?? undefined : undefined;
        const targetFingerprint = revision.targetFingerprintId ? this.memoryStore.getPageFingerprint(revision.targetFingerprintId) ?? undefined : undefined;
        return {
          memory,
          revision,
          entryFingerprint,
          targetFingerprint,
          stats: this.collectStats(memory.id, revision.id)
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    return rankMemories({
      goal,
      kind,
      currentFingerprint,
      revisions,
      limit
    });
  }

  private async explainMemory(memoryId: string, revisionId: string | undefined, tabId?: number, url?: string): Promise<MethodResult<'memory.memories.explain'>> {
    const currentFingerprint = url && url.trim().length > 0 ? this.buildFingerprintForUrl(url) : await this.readCurrentFingerprint(tabId);
    const { memory, revision } = this.getMemoryAndRevision(memoryId, revisionId);
    const entryFingerprint = revision.entryFingerprintId ? this.memoryStore.getPageFingerprint(revision.entryFingerprintId) ?? undefined : undefined;
    const targetFingerprint = revision.targetFingerprintId ? this.memoryStore.getPageFingerprint(revision.targetFingerprintId) ?? undefined : undefined;
    return {
      memory,
      revision,
      explanation: explainMemoryApplicability({
        memory,
        revision,
        currentFingerprint,
        entryFingerprint,
        targetFingerprint
      })
    };
  }

  private buildCompositeApplicability(args: {
    route: { memory: DurableMemory; revision: MemoryRevision };
    procedure: { memory: DurableMemory; revision: MemoryRevision };
    currentFingerprint?: PageFingerprint;
  }): { status: MemoryPlan['applicabilityStatus']; summary: string; checks: MemoryApplicabilityCheck[] } {
    const routeEntryFingerprint = args.route.revision.entryFingerprintId
      ? this.memoryStore.getPageFingerprint(args.route.revision.entryFingerprintId) ?? undefined
      : undefined;
    const routeTargetFingerprint = args.route.revision.targetFingerprintId
      ? this.memoryStore.getPageFingerprint(args.route.revision.targetFingerprintId) ?? undefined
      : undefined;
    const procedureEntryFingerprint = args.procedure.revision.entryFingerprintId
      ? this.memoryStore.getPageFingerprint(args.procedure.revision.entryFingerprintId) ?? undefined
      : undefined;
    const procedureTargetFingerprint = args.procedure.revision.targetFingerprintId
      ? this.memoryStore.getPageFingerprint(args.procedure.revision.targetFingerprintId) ?? undefined
      : undefined;

    const routeExplanation = explainMemoryApplicability({
      memory: args.route.memory,
      revision: args.route.revision,
      currentFingerprint: args.currentFingerprint,
      entryFingerprint: routeEntryFingerprint,
      targetFingerprint: routeTargetFingerprint
    });
    const procedureOnRouteTarget = explainMemoryApplicability({
      memory: args.procedure.memory,
      revision: args.procedure.revision,
      currentFingerprint: routeTargetFingerprint,
      entryFingerprint: procedureEntryFingerprint,
      targetFingerprint: procedureTargetFingerprint
    });
    const procedureTargetCheck = procedureOnRouteTarget.checks.find((check) => check.key === 'target-page');
    const routeEntryCheck = routeExplanation.checks.find((check) => check.key === 'entry-page');
    const routeMutatingCheck = routeExplanation.checks.find((check) => check.key === 'mutating-steps');
    const procedureMutatingCheck = procedureOnRouteTarget.checks.find((check) => check.key === 'mutating-steps');

    const checks: MemoryApplicabilityCheck[] = [];
    if (routeEntryCheck) {
      checks.push({
        key: 'route-entry-page',
        status: routeEntryCheck.status === 'fail' ? 'warn' : routeEntryCheck.status,
        detail:
          routeEntryCheck.status === 'fail'
            ? 'current page is not a strong route entry match; the route may still work, but it needs review'
            : routeEntryCheck.detail
      });
    }
      checks.push({
      key: 'route-procedure-handoff',
      status:
        routeTargetFingerprint && procedureTargetFingerprint
          ? (procedureTargetCheck?.status ?? 'warn')
          : 'warn',
      detail:
        routeTargetFingerprint && procedureTargetFingerprint
          ? procedureTargetCheck?.status === 'fail'
            ? 'route target page does not line up with the procedure target page'
            : procedureTargetCheck?.detail ?? 'procedure target fits the route target page'
          : 'route target or procedure target fingerprint is missing; handoff cannot be fully pre-verified'
    });
    if (routeMutatingCheck) {
      checks.push({
        key: 'route-mutating-steps',
        status: routeMutatingCheck.status,
        detail: routeMutatingCheck.detail
      });
    }
    if (procedureMutatingCheck) {
      checks.push({
        key: 'procedure-mutating-steps',
        status: procedureMutatingCheck.status,
        detail: procedureMutatingCheck.detail
      });
    }

    const failed = checks.some((check) => check.status === 'fail');
    const warned = checks.some((check) => check.status === 'warn');
    return {
      status: failed ? 'inapplicable' : warned ? 'partial' : 'applicable',
      summary: failed
        ? 'route and procedure do not line up on the target page'
        : warned
          ? 'route and procedure can be composed, but the entry fit or handoff needs review'
          : 'route entry fits and the procedure matches the route target page',
      checks
    };
  }

  private deriveCompositeApplicabilityRevisions(memory: DurableMemory, revision: MemoryRevision): {
    route: { memory: DurableMemory; revision: MemoryRevision };
    procedure: { memory: DurableMemory; revision: MemoryRevision };
  } | null {
    const split = splitCompositeSteps(revision.steps);
    if (split.routeSteps.length === 0 || split.procedureSteps.length === 0) {
      return null;
    }
    return {
      route: {
        memory: { ...memory, kind: 'route' },
        revision: {
          ...revision,
          kind: 'route',
          steps: split.routeSteps
        }
      },
      procedure: {
        memory: { ...memory, kind: 'procedure' },
        revision: {
          ...revision,
          kind: 'procedure',
          steps: split.procedureSteps,
          entryFingerprintId: revision.targetFingerprintId ?? revision.entryFingerprintId,
          targetFingerprintId: revision.targetFingerprintId
        }
      }
    };
  }

  private async buildPlan(args: Record<string, unknown>): Promise<MemoryPlan> {
    const mode = (args.mode as MemoryExecutionMode | undefined) ?? 'assist';
    const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
    const currentFingerprint = await this.readCurrentFingerprint(tabId);

    const directMemoryId = typeof args.memoryId === 'string' ? args.memoryId : undefined;
    const routeMemoryId = typeof args.routeMemoryId === 'string' ? args.routeMemoryId : undefined;
    const procedureMemoryId = typeof args.procedureMemoryId === 'string' ? args.procedureMemoryId : undefined;

    if (directMemoryId) {
      const { memory, revision } = this.getMemoryAndRevision(directMemoryId, typeof args.revisionId === 'string' ? args.revisionId : undefined);
      if (memory.kind === 'composite') {
        const composite = this.deriveCompositeApplicabilityRevisions(memory, revision);
        if (composite) {
          const applicability = this.buildCompositeApplicability({
            route: composite.route,
            procedure: composite.procedure,
            currentFingerprint
          });
          const parameters = this.normalizePlanParameters(args.parameters, [revision]);
          return this.memoryStore.createPlan({
            kind: memory.kind,
            mode,
            status: 'ready',
            revisionIds: [revision.id],
            parameters,
            entryFingerprintId: revision.entryFingerprintId,
            targetFingerprintId: revision.targetFingerprintId,
            applicabilityStatus: applicability.status,
            applicabilitySummary: applicability.summary,
            checks: applicability.checks,
            steps: buildPlanSteps({
              memoryId: memory.id,
              compositeRevision: revision,
              mode
            })
          });
        }
      }
      const explanation = explainMemoryApplicability({
        memory,
        revision,
        currentFingerprint,
        entryFingerprint: revision.entryFingerprintId ? this.memoryStore.getPageFingerprint(revision.entryFingerprintId) ?? undefined : undefined,
        targetFingerprint: revision.targetFingerprintId ? this.memoryStore.getPageFingerprint(revision.targetFingerprintId) ?? undefined : undefined
      });
      if (memory.kind === 'procedure' && explanation.status === 'inapplicable') {
        throw new RpcError('Procedure memory is not applicable to the current page', 4004, BakErrorCode.E_NOT_FOUND, {
          checks: explanation.checks
        });
      }
      const parameters = this.normalizePlanParameters(args.parameters, [revision]);
      return this.memoryStore.createPlan({
        kind: memory.kind,
        mode,
        status: 'ready',
        routeRevisionId: memory.kind === 'route' ? revision.id : undefined,
        procedureRevisionId: memory.kind === 'procedure' ? revision.id : undefined,
        revisionIds: [revision.id],
        parameters,
        entryFingerprintId: revision.entryFingerprintId,
        targetFingerprintId: revision.targetFingerprintId,
        applicabilityStatus: explanation.status,
        applicabilitySummary: explanation.summary,
        checks: explanation.checks,
        steps: buildPlanSteps({
          memoryId: memory.id,
          compositeRevision: memory.kind === 'composite' ? revision : undefined,
          routeMemoryId: memory.kind === 'route' ? memory.id : undefined,
          routeRevision: memory.kind === 'route' ? revision : undefined,
          procedureMemoryId: memory.kind === 'procedure' ? memory.id : undefined,
          procedureRevision: memory.kind === 'procedure' ? revision : undefined,
          mode
        })
      });
    }

    if (!routeMemoryId && !procedureMemoryId) {
      throw new RpcError('memoryId or route/procedure memory ids are required', -32602, BakErrorCode.E_INVALID_PARAMS);
    }

    const route = routeMemoryId
      ? this.getMemoryAndRevision(routeMemoryId, typeof args.routeRevisionId === 'string' ? args.routeRevisionId : undefined)
      : undefined;
    const procedure = procedureMemoryId
      ? this.getMemoryAndRevision(procedureMemoryId, typeof args.procedureRevisionId === 'string' ? args.procedureRevisionId : undefined)
      : undefined;

    if (route && route.memory.kind !== 'route') {
      throw new RpcError('routeMemoryId must reference a route memory', -32602, BakErrorCode.E_INVALID_PARAMS);
    }
    if (procedure && procedure.memory.kind !== 'procedure') {
      throw new RpcError('procedureMemoryId must reference a procedure memory', -32602, BakErrorCode.E_INVALID_PARAMS);
    }

    if (!route || !procedure) {
      throw new RpcError('Both route and procedure memories are required for a composite plan', -32602, BakErrorCode.E_INVALID_PARAMS);
    }

    const compositeApplicability = this.buildCompositeApplicability({
      route,
      procedure,
      currentFingerprint
    });
    const parameters = this.normalizePlanParameters(args.parameters, [route.revision, procedure.revision]);

    return this.memoryStore.createPlan({
      kind: 'composite',
      mode,
      status: 'ready',
      routeRevisionId: route.revision.id,
      procedureRevisionId: procedure.revision.id,
      revisionIds: [route.revision.id, procedure.revision.id],
      parameters,
      entryFingerprintId: route.revision.entryFingerprintId,
      targetFingerprintId: procedure.revision.targetFingerprintId,
      applicabilityStatus: compositeApplicability.status,
      applicabilitySummary: compositeApplicability.summary,
      checks: compositeApplicability.checks,
      steps: buildPlanSteps({
        routeMemoryId: route.memory.id,
        routeRevision: route.revision,
        procedureMemoryId: procedure.memory.id,
        procedureRevision: procedure.revision,
        mode
      })
    });
  }

  private resolveUploadFiles(step: MemoryStep, parameters: Record<string, MemoryParameterValue>): UploadFilePayload[] {
    if (Array.isArray(step.files) && step.files.length > 0) {
      return step.files;
    }
    const key = templateKeys(step.text)[0];
    const bound = key ? parameters[key] : undefined;
    if (!bound) {
      return [];
    }
    if (Array.isArray(bound)) {
      return bound as UploadFilePayload[];
    }
    return [bound as UploadFilePayload];
  }

  private async createPatchSuggestion(memoryId: string, revision: MemoryRevision, step: MemoryPlanStep, error: RpcError, tabId?: number): Promise<PatchSuggestion | null> {
    if (!step.locator && (!step.targetCandidates || step.targetCandidates.length === 0)) {
      return null;
    }
    const snapshot = await this.driver.pageSnapshot(tabId);
    const candidateLocators = [step.locator, ...(step.targetCandidates ?? [])].filter((item): item is Locator => Boolean(item));
    const ranked = rankCandidateLocators(snapshot.elements, candidateLocators, 3);
    if (ranked.length === 0) {
      return null;
    }
    const proposedRevision = buildPatchedRevision({
      base: revision,
      replacementLocators: [{ stepIndex: step.index, locatorCandidates: ranked }],
      changeSummary: [`Patched locator candidates for step ${step.index}: ${summarizeStep(step)}`]
    });
    return this.memoryStore.createPatchSuggestion({
      memoryId,
      baseRevisionId: revision.id,
      title: `Patch ${revision.title} step ${step.index}`,
      summary: `Suggested replacement locators after drift: ${error.message}`,
      reason: error.message,
      affectedStepIndexes: [step.index],
      changeSummary: proposedRevision.changeSummary,
      proposedRevision
    });
  }

  private async executePlan(plan: MemoryPlan, mode: MemoryExecutionMode, tabId?: number): Promise<MemoryRun> {
    const revisions = plan.revisionIds
      .map((revisionId) => this.memoryStore.getRevision(revisionId))
      .filter((revision): revision is MemoryRevision => Boolean(revision));
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const run = this.memoryStore.createRun({
      planId: plan.id,
      mode,
      status: 'completed',
      revisionIds: [...plan.revisionIds],
      endedAt: undefined,
      patchSuggestionIds: [],
      resultSummary: mode === 'dry-run' ? 'Dry run completed' : 'Execution completed',
      steps: []
    });

    for (const step of plan.steps) {
      if (mode === 'dry-run') {
        run.steps.push({
          index: step.index,
          kind: step.kind,
          sourceMemoryId: step.sourceMemoryId,
          sourceRevisionId: step.sourceRevisionId,
          sourceKind: step.sourceKind,
          status: 'dry-run',
          detail: summarizeStep(step)
        });
        continue;
      }

      if (mode === 'assist' && step.assistBehavior === 'pause') {
        run.status = 'blocked';
        run.resultSummary = `Assist mode paused before step ${step.index}`;
        run.steps.push({
          index: step.index,
          kind: step.kind,
          sourceMemoryId: step.sourceMemoryId,
          sourceRevisionId: step.sourceRevisionId,
          sourceKind: step.sourceKind,
          status: 'blocked',
          detail: 'assist mode paused before a mutating step'
        });
        break;
      }

      try {
        const text = applyTemplates(step.text, plan.parameters);
        switch (step.kind) {
          case 'goto':
            await this.driver.pageGoto(String(step.url ?? ''), tabId);
            break;
          case 'wait':
            if (!step.waitFor) {
              throw new RpcError('wait step requires waitFor', -32602, BakErrorCode.E_INVALID_PARAMS);
            }
            await this.driver.pageWait(step.waitFor.mode, step.waitFor.value, step.waitFor.timeoutMs, tabId);
            break;
          case 'click':
            if (!step.locator) {
              throw new RpcError('click step requires locator', -32602, BakErrorCode.E_INVALID_PARAMS);
            }
            await this.clickWithPolicy(step.locator, tabId, false);
            break;
          case 'type':
            if (!step.locator) {
              throw new RpcError('type step requires locator', -32602, BakErrorCode.E_INVALID_PARAMS);
            }
            await this.typeWithPolicy(step.locator, text ?? '', Boolean(step.clear), tabId, false);
            break;
          case 'hover':
            await this.driver.rawRequest('element.hover', { tabId, locator: step.locator });
            break;
          case 'doubleClick':
            await this.driver.rawRequest('element.doubleClick', await this.withPolicyOnDynamicRequest('element.doubleClick', { tabId, locator: step.locator }));
            break;
          case 'rightClick':
            await this.driver.rawRequest('element.rightClick', await this.withPolicyOnDynamicRequest('element.rightClick', { tabId, locator: step.locator }));
            break;
          case 'dragDrop':
            await this.driver.rawRequest(
              'element.dragDrop',
              await this.withPolicyOnDynamicRequest('element.dragDrop', { tabId, from: step.fromLocator, to: step.toLocator })
            );
            break;
          case 'select':
            await this.driver.rawRequest(
              'element.select',
              await this.withPolicyOnDynamicRequest('element.select', {
                tabId,
                locator: step.locator,
                values: (step.values ?? []).map((value) => applyTemplates(value, plan.parameters) ?? '')
              })
            );
            break;
          case 'check':
            await this.driver.rawRequest('element.check', await this.withPolicyOnDynamicRequest('element.check', { tabId, locator: step.locator }));
            break;
          case 'uncheck':
            await this.driver.rawRequest('element.uncheck', await this.withPolicyOnDynamicRequest('element.uncheck', { tabId, locator: step.locator }));
            break;
          case 'upload':
            await this.driver.rawRequest(
              'file.upload',
              await this.withPolicyOnDynamicRequest('file.upload', {
                tabId,
                locator: step.locator,
                files: this.resolveUploadFiles(step, plan.parameters)
              })
            );
            break;
          case 'press':
            await this.driver.rawRequest('keyboard.press', { tabId, key: step.key });
            break;
          case 'hotkey':
            await this.driver.rawRequest('keyboard.hotkey', { tabId, keys: step.keys ?? [] });
            break;
          case 'keyboardType':
            await this.driver.rawRequest('keyboard.type', { tabId, text: text ?? '', delayMs: step.delayMs });
            break;
          case 'scrollTo':
            await this.driver.rawRequest('page.scrollTo', { tabId, x: step.x, y: step.y, behavior: step.behavior });
            break;
          case 'elementScroll':
            await this.driver.elementScroll(step.locator, step.dx ?? 0, step.dy ?? 320, tabId);
            break;
          case 'scrollIntoView':
            await this.driver.rawRequest('element.scrollIntoView', { tabId, locator: step.locator });
            break;
          case 'focus':
            await this.driver.rawRequest('element.focus', { tabId, locator: step.locator });
            break;
          case 'blur':
            await this.driver.rawRequest('element.blur', { tabId, locator: step.locator });
            break;
          case 'enterFrame': {
            const result = await this.driver.rawRequest('context.enterFrame', { tabId, framePath: step.framePath, locator: step.locator });
            this.updateContextFromResult('context.enterFrame', result);
            break;
          }
          case 'exitFrame': {
            const result = await this.driver.rawRequest('context.exitFrame', { tabId, levels: step.levels });
            this.updateContextFromResult('context.exitFrame', result);
            break;
          }
          case 'enterShadow': {
            const result = await this.driver.rawRequest('context.enterShadow', { tabId, hostSelectors: step.hostSelectors, locator: step.locator });
            this.updateContextFromResult('context.enterShadow', result);
            break;
          }
          case 'exitShadow': {
            const result = await this.driver.rawRequest('context.exitShadow', { tabId, levels: step.levels });
            this.updateContextFromResult('context.exitShadow', result);
            break;
          }
          case 'resetContext': {
            const result = await this.driver.rawRequest('context.reset', { tabId });
            this.updateContextFromResult('context.reset', result);
            break;
          }
          default:
            throw new RpcError(`Unsupported memory step kind: ${step.kind}`, -32602, BakErrorCode.E_INVALID_PARAMS);
        }

        run.steps.push({
          index: step.index,
          kind: step.kind,
          sourceMemoryId: step.sourceMemoryId,
          sourceRevisionId: step.sourceRevisionId,
          sourceKind: step.sourceKind,
          status: 'completed',
          detail: summarizeStep(step)
        });
      } catch (error) {
        const normalized = this.normalizeError(error);
        const baseRevision = revisionById.get(step.sourceRevisionId);
        const patch = normalized.bakCode === BakErrorCode.E_NOT_FOUND && baseRevision
          ? await this.createPatchSuggestion(step.sourceMemoryId, baseRevision, step, normalized, tabId)
          : null;
        if (patch) {
          run.patchSuggestionIds.push(patch.id);
        }
        run.status = 'failed';
        run.resultSummary = normalized.message;
        run.steps.push({
          index: step.index,
          kind: step.kind,
          sourceMemoryId: step.sourceMemoryId,
          sourceRevisionId: step.sourceRevisionId,
          sourceKind: step.sourceKind,
          status: 'failed',
          detail: normalized.message,
          patchSuggestionId: patch?.id
        } satisfies MemoryRunStep);
        break;
      }
    }

    run.endedAt = nowIso();
    this.memoryStore.updateRun(run);
    plan.lastRunId = run.id;
    plan.status = run.status === 'failed' ? 'failed' : 'executed';
    this.memoryStore.updatePlan(plan);
    return run;
  }

  async invoke<TMethod extends MethodName>(method: TMethod, params: MethodParams<TMethod>): Promise<MethodResult<TMethod>> {
    const args = asRecord(params);

    switch (method) {
      case 'session.create':
        return this.withTrace(method, params, async () => {
          const requestedProtocol = typeof args.protocolVersion === 'string' ? args.protocolVersion : undefined;
          if (requestedProtocol && !COMPATIBLE_PROTOCOL_VERSIONS.includes(requestedProtocol as never)) {
            throw new RpcError(`Unsupported protocol version: ${requestedProtocol}`, -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          return {
            sessionId: this.newSession(),
            protocolVersion: PROTOCOL_VERSION,
            compatibleProtocolVersions: [...COMPATIBLE_PROTOCOL_VERSIONS]
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'session.close':
        return this.withTrace(method, params, async () => {
          const requestedSessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          if (requestedSessionId && (!this.sessionId || requestedSessionId !== this.sessionId)) {
            throw new RpcError('Session not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          this.sessionId = null;
          this.activeCapture = null;
          this.contextFrameDepth = 0;
          this.contextShadowDepth = 0;
          return { closed: true } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'session.info':
        return this.withTrace(method, params, async () => {
          const requestedSessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          if (requestedSessionId && (!this.sessionId || requestedSessionId !== this.sessionId)) {
            throw new RpcError('Session not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          const connection = this.effectiveConnection();
          const activeTab = await this.activeTabSummary();
          const activeCapture = this.refreshActiveCapture();
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
            captureSessionId: activeCapture?.captureSessionId ?? null,
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
      case 'tabs.list':
        return this.withTrace(method, params, async () => {
          this.ensurePairing();
          this.ensureConnected();
          return this.driver.tabsList() as Promise<MethodResult<TMethod>>;
        }) as Promise<MethodResult<TMethod>>;
      case 'tabs.focus':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.tabsFocus(Number(args.tabId))) as Promise<MethodResult<TMethod>>;
      case 'tabs.new':
        return this.withTrace(method, params, async () => {
          this.ensurePairing();
          this.ensureConnected();
          return this.driver.tabsNew(args.url as string | undefined) as Promise<MethodResult<TMethod>>;
        }) as Promise<MethodResult<TMethod>>;
      case 'tabs.close':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.tabsClose(Number(args.tabId))) as Promise<MethodResult<TMethod>>;
      case 'page.goto':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const url = String(args.url ?? '');
          const result = await this.driver.pageGoto(url, tabId);
          await this.captureStep({ kind: 'goto', url }, tabId);
          return result as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'page.back':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.pageBack(args.tabId as number | undefined)) as Promise<MethodResult<TMethod>>;
      case 'page.forward':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.pageForward(args.tabId as number | undefined)) as Promise<MethodResult<TMethod>>;
      case 'page.reload':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.pageReload(args.tabId as number | undefined)) as Promise<MethodResult<TMethod>>;
      case 'page.wait':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const mode = args.mode as 'selector' | 'text' | 'url';
          const value = String(args.value);
          const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const result = await this.driver.pageWait(mode, value, timeoutMs, tabId);
          await this.captureStep({ kind: 'wait', waitFor: { mode, value, timeoutMs } }, tabId);
          return result as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'page.snapshot':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const includeBase64 = Boolean(args.includeBase64);
          return (await this.persistPageSnapshot(tabId, includeBase64)) as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'element.click':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = args.locator as Locator;
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const result = await this.clickWithPolicy(locator, tabId, args.requiresConfirm === true);
          await this.captureStep({ kind: 'click', locator }, tabId);
          return result as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'element.type':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = args.locator as Locator;
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const text = String(args.text ?? '');
          const clear = Boolean(args.clear);
          const result = await this.typeWithPolicy(locator, text, clear, tabId, args.requiresConfirm === true);
          await this.captureStep({ kind: 'type', locator, text, clear }, tabId);
          return result as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'element.scroll':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = (args.locator as Locator | undefined) ?? undefined;
          const dx = Number(args.dx ?? 0);
          const dy = Number(args.dy ?? 320);
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const result = await this.driver.elementScroll(locator, dx, dy, tabId);
          await this.captureStep({ kind: 'elementScroll', locator, dx, dy }, tabId);
          return result as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'debug.getConsole':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.debugGetConsole(typeof args.limit === 'number' ? args.limit : 50, args.tabId as number | undefined)) as Promise<MethodResult<TMethod>>;
      case 'debug.dumpState':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const dump = await this.driver.rawRequest<MethodResult<'debug.dumpState'>>('debug.dumpState', {
            tabId,
            consoleLimit: typeof args.consoleLimit === 'number' ? args.consoleLimit : undefined,
            networkLimit: typeof args.networkLimit === 'number' ? args.networkLimit : undefined,
            includeAccessibility: args.includeAccessibility === true
          });
          if (args.includeSnapshot !== true) {
            return dump as MethodResult<TMethod>;
          }
          return {
            ...dump,
            snapshot: await this.persistPageSnapshot(tabId, args.includeSnapshotBase64 === true)
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.capture.begin':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const goal = String(args.goal ?? '').trim();
          if (!goal) {
            throw new RpcError('goal is required', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const activeCapture = this.refreshActiveCapture();
          if (activeCapture) {
            throw new RpcError('A capture session is already in progress; end it before starting a new one', -32602, BakErrorCode.E_INVALID_PARAMS, {
              captureSessionId: activeCapture.captureSessionId
            });
          }
          const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
          const startFingerprint = await this.captureCurrentFingerprint(tabId);
          const captureSession = this.memoryStore.createCaptureSession({
            goal,
            tabId,
            outcome: undefined,
            endedAt: undefined,
            startFingerprintId: startFingerprint?.id,
            endFingerprintId: undefined,
            labels: Array.isArray(args.labels) ? args.labels.map(String) : []
          });
          this.activeCapture = { captureSessionId: captureSession.id, goal, tabId };
          return { captureSession } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.capture.mark':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          if (args.captureSessionId !== undefined) {
            throw new RpcError('captureSessionId is not supported; bak capture uses a single active session', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const label = String(args.label ?? '').trim();
          if (!label) {
            throw new RpcError('label is required', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const activeCapture = this.refreshActiveCapture();
          if (!activeCapture) {
            throw new RpcError('Capture session not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          const event = await this.captureMark(
            label,
            typeof args.note === 'string' ? args.note : undefined,
            args.role as CaptureMarkRole | undefined,
            typeof args.tabId === 'number' ? args.tabId : activeCapture.tabId
          );
          return { event } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.capture.end':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          if (args.captureSessionId !== undefined) {
            throw new RpcError('captureSessionId is not supported; bak capture uses a single active session', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const activeCapture = this.refreshActiveCapture();
          if (!activeCapture) {
            throw new RpcError('Capture session not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          const session = this.memoryStore.getCaptureSession(activeCapture.captureSessionId);
          if (!session) {
            throw new RpcError('Capture session not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          const endFingerprint = await this.captureCurrentFingerprint(typeof args.tabId === 'number' ? args.tabId : activeCapture.tabId);
          const updatedSession = this.memoryStore.updateCaptureSession({
            ...session,
            status: 'ended',
            outcome: (args.outcome as CaptureSession['outcome'] | undefined) ?? 'completed',
            endedAt: nowIso(),
            endFingerprintId: endFingerprint?.id ?? session.endFingerprintId
          });
          const drafts = buildDraftMemories({
            captureSession: updatedSession,
            events: this.memoryStore.listCaptureEvents(updatedSession.id),
            entryFingerprintId: updatedSession.startFingerprintId,
            targetFingerprintId: updatedSession.endFingerprintId
          }).map((draft) => this.memoryStore.createDraftMemory(draft));
          this.refreshActiveCapture();
          return { captureSession: updatedSession, drafts } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.drafts.list':
        return this.withTrace(method, params, async () => ({
          drafts: this.memoryStore.listDraftMemories({
            captureSessionId: typeof args.captureSessionId === 'string' ? args.captureSessionId : undefined,
            kind: args.kind as MemoryKind | undefined,
            status: args.status as DraftMemory['status'] | undefined,
            limit: typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined
          })
        }) as MethodResult<TMethod>) as Promise<MethodResult<TMethod>>;
      case 'memory.drafts.get':
        return this.withTrace(method, params, async () => {
          const draft = this.memoryStore.getDraftMemory(String(args.id));
          if (!draft) {
            throw new RpcError('Draft not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return { draft } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.drafts.promote':
        return this.withTrace(method, params, async () => {
          const draft = this.memoryStore.getDraftMemory(String(args.id));
          if (!draft) {
            throw new RpcError('Draft not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          const memory = this.memoryStore.createMemory({
            kind: draft.kind,
            title: typeof args.title === 'string' && args.title.trim() ? args.title : draft.title,
            goal: typeof args.goal === 'string' && args.goal.trim() ? args.goal : draft.goal,
            description: typeof args.description === 'string' && args.description.trim() ? args.description : draft.description,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : draft.tags
          });
          const revision = this.memoryStore.createRevision({
            memoryId: memory.id,
            kind: draft.kind,
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
          this.memoryStore.updateDraftMemory({ ...draft, status: 'promoted', promotedAt: nowIso() });
          return {
            memory: this.memoryStore.getMemory(memory.id) ?? { ...memory, latestRevisionId: revision.id },
            revision
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.drafts.discard':
        return this.withTrace(method, params, async () => {
          const draft = this.memoryStore.getDraftMemory(String(args.id));
          if (!draft) {
            throw new RpcError('Draft not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return {
            draft: this.memoryStore.updateDraftMemory({
              ...draft,
              status: 'discarded',
              discardedAt: nowIso(),
              riskNotes: typeof args.reason === 'string' ? [...draft.riskNotes, args.reason] : draft.riskNotes
            })
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.memories.search':
        return this.withTrace(method, params, async () => {
          const goal = String(args.goal ?? '').trim();
          if (!goal) {
            throw new RpcError('goal is required', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const explicitUrl = typeof args.url === 'string' ? args.url.trim() : '';
          return {
            candidates: await this.searchCandidates(
              goal,
              args.kind as MemoryKind | undefined,
              explicitUrl ? this.buildFingerprintForUrl(explicitUrl) : typeof args.tabId === 'number' ? await this.readCurrentFingerprint(args.tabId) : undefined,
              args.includeDeprecated === true,
              typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined
            )
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.memories.get':
        return this.withTrace(method, params, async () => {
          const memory = this.memoryStore.getMemory(String(args.id));
          if (!memory) {
            throw new RpcError('Memory not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return {
            memory,
            revisions: args.includeRevisions === true ? this.memoryStore.listRevisions(memory.id) : undefined
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.memories.explain':
        return this.withTrace(method, params, async () =>
          (await this.explainMemory(
            String(args.id),
            typeof args.revisionId === 'string' ? args.revisionId : undefined,
            typeof args.tabId === 'number' ? args.tabId : undefined,
            typeof args.url === 'string' ? args.url : undefined
          )) as MethodResult<TMethod>
        ) as Promise<MethodResult<TMethod>>;
      case 'memory.memories.deprecate':
        return this.withTrace(method, params, async () => {
          const memory = this.memoryStore.getMemory(String(args.id));
          if (!memory) {
            throw new RpcError('Memory not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return {
            memory: this.memoryStore.updateMemory({
              ...memory,
              status: 'deprecated',
              deprecatedReason: typeof args.reason === 'string' ? args.reason : memory.deprecatedReason
            })
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.memories.delete':
        return this.withTrace(method, params, async () => {
          const ok = this.memoryStore.deleteMemory(String(args.id));
          if (!ok) {
            throw new RpcError('Memory not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return { ok: true } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.plans.create':
        return this.withTrace(method, params, async () => ({ plan: await this.buildPlan(args) }) as MethodResult<TMethod>) as Promise<MethodResult<TMethod>>;
      case 'memory.plans.get':
        return this.withTrace(method, params, async () => {
          const plan = this.memoryStore.getPlan(String(args.id));
          if (!plan) {
            throw new RpcError('Plan not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return { plan } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.plans.execute':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const plan = this.memoryStore.getPlan(String(args.id));
          if (!plan) {
            throw new RpcError('Plan not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return {
            run: await this.executePlan(plan, (args.mode as MemoryExecutionMode | undefined) ?? plan.mode ?? 'assist', typeof args.tabId === 'number' ? args.tabId : undefined)
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.runs.list':
        return this.withTrace(method, params, async () => ({
          runs: this.memoryStore.listRuns({
            memoryId: typeof args.memoryId === 'string' ? args.memoryId : undefined,
            planId: typeof args.planId === 'string' ? args.planId : undefined,
            status: args.status as MemoryRun['status'] | undefined,
            limit: typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined
          })
        }) as MethodResult<TMethod>) as Promise<MethodResult<TMethod>>;
      case 'memory.runs.get':
        return this.withTrace(method, params, async () => {
          const run = this.memoryStore.getRun(String(args.id));
          if (!run) {
            throw new RpcError('Run not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return { run } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.patches.list':
        return this.withTrace(method, params, async () => ({
          patches: this.memoryStore.listPatchSuggestions({
            memoryId: typeof args.memoryId === 'string' ? args.memoryId : undefined,
            status: args.status as PatchSuggestion['status'] | undefined,
            limit: typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined
          })
        }) as MethodResult<TMethod>) as Promise<MethodResult<TMethod>>;
      case 'memory.patches.get':
        return this.withTrace(method, params, async () => {
          const patch = this.memoryStore.getPatchSuggestion(String(args.id));
          if (!patch) {
            throw new RpcError('Patch not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          return { patch } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.patches.apply':
        return this.withTrace(method, params, async () => {
          const patch = this.memoryStore.getPatchSuggestion(String(args.id));
          if (!patch) {
            throw new RpcError('Patch not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          if (patch.status !== 'open') {
            throw new RpcError('Patch is already resolved', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          const memory = this.memoryStore.getMemory(patch.memoryId);
          if (!memory) {
            throw new RpcError('Memory not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          const revision = this.memoryStore.createRevision({
            memoryId: memory.id,
            ...patch.proposedRevision,
            changeSummary: patch.changeSummary,
            createdFromDraftId: undefined,
            supersedesRevisionId: patch.baseRevisionId
          });
          const appliedPatch = this.memoryStore.updatePatchSuggestion({
            ...patch,
            status: 'applied',
            resolvedAt: nowIso(),
            resolutionNote: typeof args.note === 'string' ? args.note : patch.resolutionNote
          });
          return {
            patch: appliedPatch,
            memory: this.memoryStore.getMemory(memory.id) ?? memory,
            revision
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'memory.patches.reject':
        return this.withTrace(method, params, async () => {
          const patch = this.memoryStore.getPatchSuggestion(String(args.id));
          if (!patch) {
            throw new RpcError('Patch not found', 4004, BakErrorCode.E_NOT_FOUND);
          }
          if (patch.status !== 'open') {
            throw new RpcError('Patch is already resolved', -32602, BakErrorCode.E_INVALID_PARAMS);
          }
          return {
            patch: this.memoryStore.updatePatchSuggestion({
              ...patch,
              status: 'rejected',
              resolvedAt: nowIso(),
              resolutionNote: typeof args.reason === 'string' ? args.reason : patch.resolutionNote
            })
          } as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      default:
        break;
    }

    const methodName = String(method) as MethodName;
    if (!DYNAMIC_FORWARD_METHODS.has(methodName)) {
      throw new RpcError(`Unsupported method: ${methodName}`, 4004, BakErrorCode.E_NOT_FOUND);
    }
    this.ensurePairing();
    this.ensureConnected();
    return this.withTrace(methodName, params, async () => {
      const forwardArgs = await this.withPolicyOnDynamicRequest(methodName, args);
      const result = await this.driver.rawRequest(methodName, forwardArgs);
      if (
        methodName === 'context.enterFrame' ||
        methodName === 'context.exitFrame' ||
        methodName === 'context.enterShadow' ||
        methodName === 'context.exitShadow' ||
        methodName === 'context.reset'
      ) {
        this.updateContextFromResult(methodName as ContextMethod, result);
      }

      const tabId = typeof forwardArgs.tabId === 'number' ? (forwardArgs.tabId as number) : undefined;
      switch (methodName) {
        case 'page.scrollTo':
          await this.captureStep({ kind: 'scrollTo', x: forwardArgs.x as number | undefined, y: forwardArgs.y as number | undefined, behavior: forwardArgs.behavior as 'auto' | 'smooth' | undefined }, tabId);
          break;
        case 'keyboard.press':
          await this.captureStep({ kind: 'press', key: forwardArgs.key as string | undefined }, tabId);
          break;
        case 'keyboard.type':
          await this.captureStep({ kind: 'keyboardType', text: String(forwardArgs.text ?? ''), delayMs: forwardArgs.delayMs as number | undefined }, tabId);
          break;
        case 'keyboard.hotkey':
          await this.captureStep({ kind: 'hotkey', keys: Array.isArray(forwardArgs.keys) ? (forwardArgs.keys as string[]) : [] }, tabId);
          break;
        case 'element.hover':
          await this.captureStep({ kind: 'hover', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'element.doubleClick':
          await this.captureStep({ kind: 'doubleClick', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'element.rightClick':
          await this.captureStep({ kind: 'rightClick', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'element.dragDrop':
          await this.captureStep({ kind: 'dragDrop', fromLocator: forwardArgs.from as Locator, toLocator: forwardArgs.to as Locator }, tabId);
          break;
        case 'element.select':
          await this.captureStep({ kind: 'select', locator: forwardArgs.locator as Locator, values: Array.isArray(forwardArgs.values) ? (forwardArgs.values as string[]) : [] }, tabId);
          break;
        case 'element.check':
          await this.captureStep({ kind: 'check', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'element.uncheck':
          await this.captureStep({ kind: 'uncheck', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'element.scrollIntoView':
          await this.captureStep({ kind: 'scrollIntoView', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'element.focus':
          await this.captureStep({ kind: 'focus', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'element.blur':
          await this.captureStep({ kind: 'blur', locator: forwardArgs.locator as Locator }, tabId);
          break;
        case 'file.upload':
          await this.captureStep({ kind: 'upload', locator: forwardArgs.locator as Locator, files: Array.isArray(forwardArgs.files) ? (forwardArgs.files as UploadFilePayload[]) : [] }, tabId);
          break;
        case 'context.enterFrame':
          await this.captureStep({ kind: 'enterFrame', framePath: Array.isArray(forwardArgs.framePath) ? (forwardArgs.framePath as string[]) : undefined, locator: forwardArgs.locator as Locator | undefined }, tabId);
          break;
        case 'context.exitFrame':
          await this.captureStep({ kind: 'exitFrame', levels: forwardArgs.levels as number | undefined }, tabId);
          break;
        case 'context.enterShadow':
          await this.captureStep({ kind: 'enterShadow', hostSelectors: Array.isArray(forwardArgs.hostSelectors) ? (forwardArgs.hostSelectors as string[]) : undefined, locator: forwardArgs.locator as Locator | undefined }, tabId);
          break;
        case 'context.exitShadow':
          await this.captureStep({ kind: 'exitShadow', levels: forwardArgs.levels as number | undefined }, tabId);
          break;
        case 'context.reset':
          await this.captureStep({ kind: 'resetContext' }, tabId);
          break;
        default:
          break;
      }
      return result as MethodResult<TMethod>;
    }) as Promise<MethodResult<TMethod>>;
  }
}
