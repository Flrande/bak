import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BakErrorCode,
  COMPATIBLE_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  type Locator,
  type MethodName,
  type MethodParams,
  type MethodResult,
  RpcError,
  type SessionBrowserState,
  type SessionContextSnapshot,
  type SessionDescriptor,
  type SessionInfoResult,
  type SessionSummary
} from '@flrande/bak-protocol';
import type { BrowserDriver } from './drivers/browser-driver.js';
import type { BridgeEventEnvelope, SessionBindingUpdatedBridgeEvent } from './drivers/extension-bridge.js';
import { BridgeError } from './drivers/extension-bridge.js';
import { evaluateConnectionHealth } from './connection-health.js';
import { PolicyEngine, type PolicyAction, type PolicyEvaluation } from './policy.js';
import { redactElements, redactText, redactUnknown } from './privacy.js';
import type { PairingStore } from './pairing-store.js';
import { SessionManager, type SessionState } from './session-manager.js';
import type { TraceStore } from './trace-store.js';
import { ensureDir, getDomain, getPathname, id, nowIso, resolveDataDir } from './utils.js';

const GLOBAL_DYNAMIC_FORWARD_METHODS = new Set<MethodName>(['tabs.getActive', 'tabs.get']);

const SESSION_DYNAMIC_FORWARD_METHODS = new Set<MethodName>([
  'page.title',
  'page.url',
  'page.text',
  'page.eval',
  'page.extract',
  'page.fetch',
  'page.dom',
  'page.accessibilityTree',
  'page.scrollTo',
  'page.viewport',
  'page.metrics',
  'page.freshness',
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
  'context.get',
  'context.set',
  'context.enterFrame',
  'context.exitFrame',
  'context.enterShadow',
  'context.exitShadow',
  'context.reset',
  'network.list',
  'network.get',
  'network.search',
  'network.replay',
  'network.waitFor',
  'network.clear',
  'debug.dumpState',
  'table.list',
  'table.schema',
  'table.rows',
  'table.export',
  'inspect.pageData',
  'inspect.liveUpdates',
  'inspect.freshness',
  'capture.snapshot',
  'capture.har'
]);

const STATIC_METHODS = new Set<MethodName>([
  'runtime.info',
  'session.create',
  'session.resolve',
  'session.list',
  'session.close',
  'session.info',
  'session.ensure',
  'session.openTab',
  'session.listTabs',
  'session.getActiveTab',
  'session.setActiveTab',
  'session.focus',
  'session.closeTab',
  'session.reset',
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
  'debug.getConsole'
]);

const SUPPORTED_METHODS = new Set<MethodName>([
  ...STATIC_METHODS,
  ...GLOBAL_DYNAMIC_FORWARD_METHODS,
  ...SESSION_DYNAMIC_FORWARD_METHODS
]);

const POLICY_ACTION_BY_METHOD: Partial<Record<MethodName, PolicyAction>> = {
  'element.click': 'element.click',
  'element.type': 'element.type',
  'element.doubleClick': 'element.doubleClick',
  'element.rightClick': 'element.rightClick',
  'element.dragDrop': 'element.dragDrop',
  'element.select': 'element.select',
  'element.check': 'element.check',
  'element.uncheck': 'element.uncheck',
  'file.upload': 'file.upload',
  'page.fetch': 'page.fetch',
  'network.replay': 'network.replay'
};

type SessionContextMethod =
  | 'context.get'
  | 'context.set'
  | 'context.enterFrame'
  | 'context.exitFrame'
  | 'context.enterShadow'
  | 'context.exitShadow'
  | 'context.reset';

interface ResolvedSessionTarget {
  session: SessionState;
  bindingId: string;
  tabId?: number;
}

export interface ServiceHeartbeatConfig {
  intervalMs?: number;
  managedRuntime?: boolean;
  onManagedIdle?: () => void | Promise<void>;
}

interface ResolveSessionTargetOptions {
  allowMissing?: boolean;
  autoEnsure?: boolean;
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

function cloneDescriptor(session: SessionState): SessionDescriptor {
  const descriptor: SessionDescriptor = {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt
  };
  if (session.clientName) {
    descriptor.clientName = session.clientName;
  }
  return descriptor;
}

export class BakService {
  private readonly driver: BrowserDriver;
  private readonly pairingStore: PairingStore;
  private readonly traceStore: TraceStore;
  private readonly dataDir: string;
  private readonly policyEngine: PolicyEngine;
  private readonly sessions = new SessionManager();
  private readonly runtimeTraceId: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatStaleAfterMs: number;
  private readonly managedRuntime: boolean;
  private readonly onManagedIdle?: () => void | Promise<void>;
  private idleStopArmed = false;
  private idleStopScheduled = false;

  constructor(
    driver: BrowserDriver,
    pairingStore: PairingStore,
    traceStore: TraceStore,
    heartbeatConfig: ServiceHeartbeatConfig = {}
  ) {
    this.driver = driver;
    this.pairingStore = pairingStore;
    this.traceStore = traceStore;
    this.dataDir = resolveDataDir();
    this.policyEngine = new PolicyEngine(this.dataDir);
    this.runtimeTraceId = this.traceStore.newTraceId();
    const configured = heartbeatConfig.intervalMs ?? 10_000;
    this.heartbeatIntervalMs = Math.max(500, configured);
    this.heartbeatStaleAfterMs = Math.max(this.heartbeatIntervalMs * 3, 5_000);
    this.managedRuntime = heartbeatConfig.managedRuntime === true;
    this.onManagedIdle = heartbeatConfig.onManagedIdle;
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

  handleBridgeEvent(event: BridgeEventEnvelope): void {
    if (event.event !== 'sessionBinding.updated') {
      return;
    }
    void this.handleSessionBindingUpdated(event.data as SessionBindingUpdatedBridgeEvent | undefined);
  }

  status(): MethodResult<'runtime.info'> {
    return this.runtimeInfo();
  }

  async shutdown(): Promise<void> {
    if (this.driver.isConnected()) {
      for (const session of this.sessions.list()) {
        try {
          await this.driver.sessionBindingClose({ bindingId: session.bindingId });
        } catch {
          // Ignore close failures during shutdown.
        }
      }
    }
    for (const session of this.sessions.list()) {
      this.sessions.close(session.sessionId);
    }
  }

  async invokeDynamic(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.invoke(method as MethodName, params as never);
  }

  private createSessionState(clientName?: string, traceId = this.traceStore.newTraceId()): SessionState {
    const sessionId = id('session');
    const createdAt = nowIso();
    return this.sessions.create({
      sessionId,
      bindingId: sessionId,
      bindingInitialized: false,
      clientName,
      createdAt,
      lastSeenAt: createdAt,
      activeTabId: null,
      traceId,
      contextsByTab: new Map()
    });
  }

  private resolveSessionLabel(session: SessionState): string {
    if (session.clientName && session.clientName.trim().length > 0) {
      const normalized = session.clientName.trim();
      if (/^[a-f0-9-]{20,}$/i.test(normalized)) {
        return `bak ${normalized.slice(0, 8)}`;
      }
      return normalized;
    }
    const suffix = session.sessionId.replace(/^session_/, '').slice(0, 8);
    return `bak ${suffix}`;
  }

  private noteSessionCountChanged(): void {
    const count = this.sessions.list().length;
    if (count > 0) {
      this.idleStopArmed = true;
      return;
    }
    if (!this.managedRuntime || !this.idleStopArmed || this.idleStopScheduled) {
      return;
    }
    this.idleStopScheduled = true;
    setTimeout(() => {
      this.idleStopScheduled = false;
      if (!this.managedRuntime || !this.idleStopArmed || this.sessions.list().length > 0) {
        return;
      }
      void this.onManagedIdle?.();
    }, 0);
  }

  private async closeSessionInternal(
    sessionId: string,
    options: { closeBinding: boolean }
  ): Promise<SessionState | null> {
    const session = this.sessions.close(sessionId);
    if (!session) {
      return null;
    }
    if (options.closeBinding && this.driver.isConnected()) {
      try {
        await this.driver.sessionBindingClose({ bindingId: session.bindingId });
      } catch {
        // Continue closing the session even if the binding is already gone.
      }
    }
    this.noteSessionCountChanged();
    return session;
  }

  private resolveSession(clientName: string): { session: SessionState; created: boolean } {
    const normalizedClientName = clientName.trim();
    if (!normalizedClientName) {
      throw new RpcError('clientName is required', -32602, BakErrorCode.E_INVALID_PARAMS);
    }
    const matches = this.sessions.findByClientName(normalizedClientName);
    if (matches.length > 1) {
      throw new RpcError('Multiple live sessions match clientName', -32602, BakErrorCode.E_INVALID_PARAMS, {
        clientName: normalizedClientName,
        sessionIds: matches.map((session) => session.sessionId)
      });
    }
    if (matches.length === 1) {
      return {
        session: this.touchSession(matches[0]!.sessionId),
        created: false
      };
    }
    const session = this.createSessionState(normalizedClientName);
    this.noteSessionCountChanged();
    return { session, created: true };
  }

  private runtimeInfo(): MethodResult<'runtime.info'> {
    const connection = this.effectiveConnection();
    return {
      paired: Boolean(this.pairingStore.getToken()),
      extensionConnected: connection.extensionConnected,
      connectionState: connection.connectionState,
      connectionReason: connection.connectionReason,
      protocolVersion: PROTOCOL_VERSION,
      compatibleProtocolVersions: [...COMPATIBLE_PROTOCOL_VERSIONS],
      extensionVersion: connection.raw.extensionVersion,
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
      capabilityCount: SUPPORTED_METHODS.size,
      activeSessionCount: this.sessions.list().length
    };
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

  private async withTrace<T>(traceId: string, method: string, params: unknown, action: () => Promise<T>): Promise<T> {
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
        error.code === BakErrorCode.E_TIMEOUT ||
        error.code === BakErrorCode.E_NOT_FOUND ||
        error.code === BakErrorCode.E_INVALID_PARAMS ||
        error.code === BakErrorCode.E_PERMISSION ||
        error.code === BakErrorCode.E_NEED_USER_CONFIRM ||
        error.code === BakErrorCode.E_NOT_READY ||
        error.code === BakErrorCode.E_EXECUTION ||
        error.code === BakErrorCode.E_NOT_SERIALIZABLE ||
        error.code === BakErrorCode.E_BODY_TOO_LARGE ||
        error.code === BakErrorCode.E_RESPONSE_NOT_CAPTURED ||
        error.code === BakErrorCode.E_CROSS_ORIGIN_BLOCKED ||
        error.code === BakErrorCode.E_SELECTOR_AMBIGUOUS ||
        error.code === BakErrorCode.E_DEBUGGER_NOT_ATTACHED
          ? error.code
          : BakErrorCode.E_INTERNAL;
      return new RpcError(error.message, -32603, bakCode, error.data);
    }
    return new RpcError(error instanceof Error ? error.message : String(error), -32603, BakErrorCode.E_INTERNAL);
  }

  private requireSessionId(args: Record<string, unknown>): string {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    if (!sessionId) {
      throw new RpcError('sessionId is required', -32602, BakErrorCode.E_INVALID_PARAMS);
    }
    return sessionId;
  }

  private getSession(sessionId: string): SessionState {
    try {
      return this.sessions.require(sessionId);
    } catch {
      throw new RpcError('Session not found', 4004, BakErrorCode.E_NOT_FOUND, { sessionId });
    }
  }

  private touchSession(sessionId: string): SessionState {
    return this.sessions.touch(sessionId, nowIso());
  }

  private async getGlobalActiveTabSummary(): Promise<{ id: number; title: string; url: string } | null> {
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

  private async activeLocation(target?: { tabId?: number }): Promise<{ domain: string; path: string }> {
    if (typeof target?.tabId === 'number' && this.driver.isConnected()) {
      try {
        const current = await this.driver.rawRequest<MethodResult<'page.url'>>('page.url', { tabId: target.tabId });
        return {
          domain: getDomain(current.url),
          path: getPathname(current.url)
        };
      } catch {
        // Fall back to the global active tab summary below.
      }
    }
    const active = await this.getGlobalActiveTabSummary();
    if (!active?.url) {
      return { domain: 'unknown', path: '/' };
    }
    return {
      domain: getDomain(active.url),
      path: getPathname(active.url)
    };
  }

  private resolveLocationFromUrl(url: string | undefined, fallback: { domain: string; path: string }): {
    domain: string;
    path: string;
  } {
    if (typeof url !== 'string' || url.trim().length === 0) {
      return fallback;
    }
    return {
      domain: getDomain(url),
      path: getPathname(url)
    };
  }

  private buildRequestPolicyLocator(action: PolicyAction, requestMethod: string, requestUrl: string | undefined): Locator {
    const summary = requestUrl && requestUrl.trim().length > 0 ? requestUrl.trim() : '(unknown-url)';
    return {
      role: 'request',
      name: `${requestMethod} ${summary}`,
      text: `${action} ${requestMethod} ${summary}`
    };
  }

  private isSafeRequestMethod(method: string): boolean {
    const normalized = method.trim().toUpperCase();
    return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS';
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

  private async evaluatePolicyForTarget(
    action: PolicyAction,
    locator: Locator,
    traceId: string,
    target?: { tabId?: number }
  ): Promise<{ requiresConfirm: boolean }> {
    const location = await this.activeLocation(target);
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

  private async evaluatePolicyForRequest(
    action: Extract<PolicyAction, 'page.fetch' | 'network.replay'>,
    request: {
      method?: string;
      url?: string;
      requiresConfirm?: boolean;
    },
    traceId: string,
    target?: { tabId?: number }
  ): Promise<void> {
    const fallbackLocation = await this.activeLocation(target);
    const requestMethod =
      typeof request.method === 'string' && request.method.trim().length > 0
        ? request.method.trim().toUpperCase()
        : action === 'network.replay'
          ? 'REPLAY'
          : 'GET';
    const location = this.resolveLocationFromUrl(request.url, fallbackLocation);
    const locator = this.buildRequestPolicyLocator(action, requestMethod, request.url);
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
        policyRuleId: decision.ruleId,
        requestMethod,
        requestUrl: request.url ?? null
      });
    }

    const requiresConfirm = decision.decision === 'requireConfirm' || !this.isSafeRequestMethod(requestMethod);
    if (requiresConfirm && request.requiresConfirm !== true) {
      throw new RpcError(
        'Request requires explicit confirmation. Re-run with --requires-confirm.',
        4090,
        BakErrorCode.E_NEED_USER_CONFIRM,
        {
          action,
          policyDecision: decision.decision,
          policyReason: decision.reason,
          policySource: decision.source,
          policyRuleId: decision.ruleId,
          requestMethod,
          requestUrl: request.url ?? null
        }
      );
    }
  }

  private async clickWithPolicy(
    locator: Locator,
    tabId: number | undefined,
    traceId: string,
    requiresConfirm = false
  ): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicyForTarget('element.click', locator, traceId, { tabId });
    return this.driver.elementClick(locator, tabId, requiresConfirm || policy.requiresConfirm);
  }

  private async typeWithPolicy(
    locator: Locator,
    text: string,
    clear: boolean,
    tabId: number | undefined,
    traceId: string,
    requiresConfirm = false
  ): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicyForTarget('element.type', locator, traceId, { tabId });
    return this.driver.elementType(locator, text, clear, tabId, requiresConfirm || policy.requiresConfirm);
  }

  private async persistPageSnapshot(
    tabId: number | undefined,
    includeBase64: boolean,
    traceId: string
  ): Promise<{
    traceId: string;
    imagePath: string;
    elementsPath: string;
    imageBase64?: string;
    elementCount: number;
  }> {
    const snapshot = await this.driver.pageSnapshot(tabId, true);
    const redactedElements = redactElements(snapshot.elements);
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

  private buildSessionContext(sessionId: string, tabId?: number): SessionContextSnapshot {
    return this.sessions.getContext(sessionId, tabId);
  }

  private syncSessionContext(sessionId: string, snapshot: SessionContextSnapshot): void {
    this.sessions.setContext(sessionId, snapshot);
  }

  private updateContextFromResult(sessionId: string, tabId: number, methodName: SessionContextMethod, result: unknown): SessionContextSnapshot {
    const current = this.buildSessionContext(sessionId, tabId);
    const payload = asRecord(result);
    const framePath =
      methodName === 'context.reset'
        ? []
        : Array.isArray(payload.framePath)
          ? payload.framePath.map(String)
          : current.framePath;
    const shadowPath =
      methodName === 'context.reset'
        ? []
        : Array.isArray(payload.shadowPath)
          ? payload.shadowPath.map(String)
          : current.shadowPath;
    const next: SessionContextSnapshot = {
      tabId,
      framePath,
      shadowPath
    };
    this.syncSessionContext(sessionId, next);
    return next;
  }

  private clearTabContext(sessionId: string, tabId: number): SessionContextSnapshot {
    const next: SessionContextSnapshot = {
      tabId,
      framePath: [],
      shadowPath: []
    };
    this.syncSessionContext(sessionId, next);
    return next;
  }

  private async applyStoredContext(sessionId: string, tabId: number): Promise<SessionContextSnapshot> {
    const snapshot = this.buildSessionContext(sessionId, tabId);
    const result = await this.driver.rawRequest('context.set', {
      tabId,
      framePath: snapshot.framePath,
      shadowPath: snapshot.shadowPath
    });
    return this.updateContextFromResult(sessionId, tabId, 'context.set', result);
  }

  private async listSessionTabs(session: SessionState): Promise<Awaited<ReturnType<BrowserDriver['sessionBindingListTabs']>>> {
    const listing = await this.driver.sessionBindingListTabs({ bindingId: session.bindingId });
    this.sessions.syncBinding(session.sessionId, listing.browser);
    return {
      ...listing,
      browser: this.hydrateSessionBrowserState(session.sessionId, listing.browser)
    };
  }

  private syncSessionBrowserState(sessionId: string, browser: SessionBrowserState): SessionState {
    return this.sessions.syncBinding(sessionId, {
      tabIds: browser.tabIds,
      activeTabId: browser.activeTabId
    });
  }

  private hydrateSessionBrowserState(sessionId: string, browser: SessionBrowserState): SessionBrowserState {
    return {
      ...browser,
      activeTabId: this.getSession(sessionId).activeTabId
    };
  }

  private clearSessionBindingState(sessionId: string): SessionState {
    return this.sessions.clearBinding(sessionId);
  }

  private isMissingBindingError(error: unknown, bindingId: string): boolean {
    if (error instanceof BridgeError && error.code === 'E_NOT_FOUND') {
      return true;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes(`binding ${bindingId}`.toLowerCase()) && message.includes('does not exist');
  }

  private isRecoverableContextRestoreError(error: unknown): boolean {
    if (!(error instanceof BridgeError)) {
      return false;
    }
    const message = error.message.toLowerCase();
    const referencesContextPath =
      message.includes('frame') ||
      message.includes('shadow') ||
      message.includes('context');
    if (!referencesContextPath) {
      return false;
    }
    return error.code === 'E_NOT_FOUND' || error.code === 'E_NOT_READY' || error.code === 'E_PERMISSION';
  }

  private async safeListSessionTabs(session: SessionState): Promise<Awaited<ReturnType<BrowserDriver['sessionBindingListTabs']>> | null> {
    if (!session.bindingInitialized) {
      return null;
    }
    try {
      return await this.listSessionTabs(session);
    } catch (error) {
      if (this.isMissingBindingError(error, session.bindingId)) {
        this.clearSessionBindingState(session.sessionId);
        return null;
      }
      throw error;
    }
  }

  private async handleSessionBindingUpdated(event: SessionBindingUpdatedBridgeEvent | undefined): Promise<void> {
    if (!event || typeof event.bindingId !== 'string' || !this.sessions.has(event.bindingId)) {
      return;
    }
    const browser = event.browser;
    if (!browser || !Array.isArray(browser.tabIds) || browser.tabIds.length === 0) {
      await this.closeSessionInternal(event.bindingId, { closeBinding: true });
      return;
    }
    this.sessions.syncBinding(event.bindingId, {
      id: event.bindingId,
      tabIds: browser.tabIds.map((tabId) => Number(tabId)).filter((tabId) => Number.isInteger(tabId) && tabId >= 0),
      activeTabId: typeof browser.activeTabId === 'number' ? browser.activeTabId : null
    });
  }

  private async ensureSessionBindingAvailable(sessionId: string, args: Record<string, unknown>): Promise<SessionState> {
    let session = this.touchSession(sessionId);
    let needsEnsure = !session.bindingInitialized || session.activeTabId === null;
    if (!needsEnsure) {
      const listing = await this.safeListSessionTabs(session);
      session = this.getSession(sessionId);
      needsEnsure = !listing || listing.tabs.length === 0 || session.activeTabId === null;
    }
    if (!needsEnsure) {
      return session;
    }
    const result = await this.driver.sessionBindingEnsure({
      bindingId: session.bindingId,
      url: typeof args.url === 'string' ? args.url : undefined,
      label: this.resolveSessionLabel(session)
    });
    this.syncSessionBrowserState(sessionId, result.browser);
    return this.getSession(sessionId);
  }

  private async resolveSessionTarget(
    sessionId: string,
    args: Record<string, unknown>,
    options: ResolveSessionTargetOptions = {}
  ): Promise<ResolvedSessionTarget> {
    const allowMissing = options.allowMissing === true;
    let session = this.touchSession(sessionId);
    if (options.autoEnsure !== false) {
      session = await this.ensureSessionBindingAvailable(sessionId, args);
    }
    const explicitTabId = typeof args.tabId === 'number' ? args.tabId : undefined;

    if (explicitTabId !== undefined) {
      const listing = await this.safeListSessionTabs(session);
      const tab = listing?.tabs.find((candidate) => candidate.id === explicitTabId);
      if (!tab) {
        throw new RpcError('Tab does not belong to session', 4004, BakErrorCode.E_NOT_FOUND, {
          sessionId,
          bindingId: this.getSession(sessionId).bindingId,
          tabId: explicitTabId
        });
      }
      return {
        session: this.getSession(sessionId),
        bindingId: this.getSession(sessionId).bindingId,
        tabId: explicitTabId
      };
    }

    if (session.activeTabId !== null) {
      const listing = await this.safeListSessionTabs(session);
      session = this.getSession(sessionId);
      const tab = listing?.tabs.find((candidate) => candidate.id === session.activeTabId);
      if (tab) {
        return {
          session,
          bindingId: session.bindingId,
          tabId: tab.id
        };
      }
    }

    if (!session.bindingInitialized) {
      if (allowMissing) {
        return {
          session: this.getSession(sessionId),
          bindingId: session.bindingId
        };
      }
      throw new RpcError('Session has no active tab', 4004, BakErrorCode.E_NOT_FOUND, {
        sessionId,
        bindingId: session.bindingId
      });
    }

    const active = await this.driver.sessionBindingGetActiveTab({ bindingId: session.bindingId });
    this.sessions.syncBinding(sessionId, active.browser);
    if (active.tab) {
      return {
        session: this.getSession(sessionId),
        bindingId: session.bindingId,
        tabId: active.tab.id
      };
    }

    if (allowMissing) {
      return {
        session: this.getSession(sessionId),
        bindingId: session.bindingId
      };
    }

    throw new RpcError('Session has no active tab', 4004, BakErrorCode.E_NOT_FOUND, {
      sessionId,
      bindingId: session.bindingId
    });
  }

  private async buildSessionSummary(session: SessionState): Promise<SessionSummary> {
    let activeTab: SessionSummary['activeTab'] = null;
    if (this.driver.isConnected() && session.activeTabId !== null) {
      try {
        const listing = await this.safeListSessionTabs(session);
        const current = this.getSession(session.sessionId);
        activeTab = listing?.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
      } catch {
        activeTab = null;
      }
    }
    return {
      ...cloneDescriptor(this.getSession(session.sessionId)),
      activeTab,
      currentContext: this.buildSessionContext(session.sessionId, this.getSession(session.sessionId).activeTabId ?? undefined)
    };
  }

  private async buildSessionInfo(sessionId: string): Promise<SessionInfoResult> {
    const session = this.touchSession(sessionId);
    const summary = await this.buildSessionSummary(session);
    return {
      session: cloneDescriptor(this.getSession(sessionId)),
      activeTab: summary.activeTab,
      currentContext: summary.currentContext
    };
  }

  async invoke<TMethod extends MethodName>(method: TMethod, params: MethodParams<TMethod>): Promise<MethodResult<TMethod>> {
    const args = asRecord(params);

    switch (method) {
      case 'runtime.info':
        return this.withTrace(this.runtimeTraceId, method, params, async () => this.runtimeInfo() as MethodResult<TMethod>);
      case 'session.create': {
        const requestedProtocol = typeof args.protocolVersion === 'string' ? args.protocolVersion : undefined;
        if (requestedProtocol && !COMPATIBLE_PROTOCOL_VERSIONS.includes(requestedProtocol as never)) {
          throw new RpcError(`Unsupported protocol version: ${requestedProtocol}`, -32602, BakErrorCode.E_INVALID_PARAMS);
        }
        this.ensurePairing();
        this.ensureConnected();
        const clientName = typeof args.clientName === 'string' && args.clientName.trim().length > 0 ? args.clientName.trim() : undefined;
        const seedTraceId = this.traceStore.newTraceId();
        return this.withTrace(seedTraceId, method, params, async () => {
          const created = this.createSessionState(clientName, seedTraceId);
          this.noteSessionCountChanged();
          return {
            sessionId: created.sessionId,
            clientName,
            createdAt: created.createdAt,
            protocolVersion: PROTOCOL_VERSION,
            compatibleProtocolVersions: [...COMPATIBLE_PROTOCOL_VERSIONS]
          } as MethodResult<TMethod>;
        });
      }
      case 'session.resolve': {
        this.ensurePairing();
        this.ensureConnected();
        const clientName = typeof args.clientName === 'string' ? args.clientName : '';
        return this.withTrace(this.runtimeTraceId, method, params, async () => {
          const resolved = this.resolveSession(clientName);
          return {
            sessionId: resolved.session.sessionId,
            clientName: resolved.session.clientName,
            createdAt: resolved.session.createdAt,
            created: resolved.created
          } as MethodResult<TMethod>;
        });
      }
      case 'session.list':
        return this.withTrace(this.runtimeTraceId, method, params, async () => {
          const sessions = await Promise.all(this.sessions.list().map(async (session) => await this.buildSessionSummary(session)));
          return { sessions } as MethodResult<TMethod>;
        });
      case 'session.close': {
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          await this.closeSessionInternal(sessionId, { closeBinding: true });
          return { closed: true } as MethodResult<TMethod>;
        });
      }
      case 'session.info': {
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => await this.buildSessionInfo(sessionId) as MethodResult<TMethod>);
      }
      case 'tabs.list':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(this.runtimeTraceId, method, params, async () => this.driver.tabsList() as Promise<MethodResult<TMethod>>);
      case 'tabs.focus':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(this.runtimeTraceId, method, params, async () => {
          const sessionId = this.requireSessionId(args);
          const result = await this.driver.sessionBindingSetActiveTab({
            bindingId: this.getSession(sessionId).bindingId,
            tabId: Number(args.tabId)
          });
          this.syncSessionBrowserState(sessionId, result.browser);
          this.sessions.setActiveTab(sessionId, result.tab.id);
          return { ok: true } as MethodResult<TMethod>;
        });
      case 'tabs.new':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(this.runtimeTraceId, method, params, async () => {
          const sessionId = this.requireSessionId(args);
          const session = this.getSession(sessionId);
          const result = await this.driver.sessionBindingOpenTab({
            bindingId: session.bindingId,
            url: typeof args.url === 'string' ? args.url : undefined,
            active: args.active === true,
            focus: args.focus === true,
            label: this.resolveSessionLabel(session)
          });
          this.syncSessionBrowserState(sessionId, result.browser);
          if (args.active === true || args.focus === true) {
            this.sessions.setActiveTab(sessionId, result.tab.id);
          }
          this.clearTabContext(sessionId, result.tab.id);
          return {
            tabId: result.tab.id,
            windowId: result.tab.windowId,
            groupId: result.tab.groupId ?? null
          } as MethodResult<TMethod>;
        });
      case 'tabs.close':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(this.runtimeTraceId, method, params, async () => {
          const sessionId = this.requireSessionId(args);
          const session = this.getSession(sessionId);
          const result = await this.driver.sessionBindingCloseTab({
            bindingId: session.bindingId,
            tabId: Number(args.tabId)
          });
          if (result.browser && result.browser.tabIds.length > 0) {
            this.syncSessionBrowserState(sessionId, result.browser);
          } else {
            await this.closeSessionInternal(sessionId, { closeBinding: true });
          }
          return { ok: true } as MethodResult<TMethod>;
        });
      case 'session.ensure': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.touchSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const result = await this.driver.sessionBindingEnsure({
            bindingId: session.bindingId,
            url: typeof args.url === 'string' ? args.url : undefined,
            focus: args.focus === true,
            label: this.resolveSessionLabel(session)
          });
          this.syncSessionBrowserState(sessionId, result.browser);
          const browser = this.hydrateSessionBrowserState(sessionId, result.browser);
          return {
            browser,
            created: result.created,
            repaired: result.repaired,
            repairActions: result.repairActions
          } as MethodResult<TMethod>;
        });
      }
      case 'session.openTab': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.touchSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const result = await this.driver.sessionBindingOpenTab({
            bindingId: session.bindingId,
            url: typeof args.url === 'string' ? args.url : undefined,
            active: args.active === true,
            focus: args.focus === true,
            label: this.resolveSessionLabel(session)
          });
          this.syncSessionBrowserState(sessionId, result.browser);
          if (args.active === true || args.focus === true) {
            this.sessions.setActiveTab(sessionId, result.tab.id);
          }
          this.clearTabContext(sessionId, result.tab.id);
          const browser = this.hydrateSessionBrowserState(sessionId, result.browser);
          return {
            browser,
            tab: result.tab
          } as MethodResult<TMethod>;
        });
      }
      case 'session.listTabs': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.touchSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const listing = await this.safeListSessionTabs(session);
          if (!listing) {
            return {
              browser: null,
              tabs: []
            } as MethodResult<TMethod>;
          }
          return {
            browser: listing.browser,
            tabs: listing.tabs
          } as MethodResult<TMethod>;
        });
      }
      case 'session.getActiveTab': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.touchSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const listing = await this.safeListSessionTabs(session);
          if (!listing) {
            return {
              browser: null,
              tab: null
            } as MethodResult<TMethod>;
          }
          const current = this.getSession(sessionId);
          return {
            browser: this.hydrateSessionBrowserState(sessionId, listing.browser),
            tab: listing.tabs.find((tab) => tab.id === current.activeTabId) ?? null
          } as MethodResult<TMethod>;
        });
      }
      case 'session.setActiveTab': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.touchSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const result = await this.driver.sessionBindingSetActiveTab({
            bindingId: session.bindingId,
            tabId: Number(args.tabId)
          });
          this.syncSessionBrowserState(sessionId, result.browser);
          this.sessions.setActiveTab(sessionId, result.tab.id);
          try {
            await this.applyStoredContext(sessionId, result.tab.id);
          } catch (error) {
            if (!this.isRecoverableContextRestoreError(error)) {
              throw error;
            }
            // The binding changed successfully; clear the stale snapshot so later calls can rebuild it.
            this.clearTabContext(sessionId, result.tab.id);
          }
          const browser = this.hydrateSessionBrowserState(sessionId, result.browser);
          return {
            browser,
            tab: result.tab
          } as MethodResult<TMethod>;
        });
      }
      case 'session.focus': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.touchSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const result = await this.driver.sessionBindingFocus({ bindingId: session.bindingId });
          this.syncSessionBrowserState(sessionId, result.browser);
          const browser = this.hydrateSessionBrowserState(sessionId, result.browser);
          return {
            ok: true,
            browser
          } as MethodResult<TMethod>;
        });
      }
      case 'session.closeTab': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args, { autoEnsure: false });
          const result = await this.driver.sessionBindingCloseTab({
            bindingId: session.bindingId,
            tabId: target.tabId
          });
          if (result.browser && result.browser.tabIds.length > 0) {
            this.syncSessionBrowserState(sessionId, result.browser);
            return {
              closed: true,
              closedTabId: result.closedTabId,
              sessionClosed: false,
              browser: this.hydrateSessionBrowserState(sessionId, result.browser)
            } as MethodResult<TMethod>;
          }
          await this.closeSessionInternal(sessionId, { closeBinding: true });
          return {
            closed: true,
            closedTabId: result.closedTabId,
            sessionClosed: true,
            browser: null
          } as MethodResult<TMethod>;
        });
      }
      case 'session.reset': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.touchSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const result = await this.driver.sessionBindingReset({
            bindingId: session.bindingId,
            url: typeof args.url === 'string' ? args.url : undefined,
            focus: args.focus === true,
            label: this.resolveSessionLabel(session)
          });
          this.syncSessionBrowserState(sessionId, result.browser);
          for (const tabId of result.browser.tabIds) {
            this.clearTabContext(sessionId, tabId);
          }
          const browser = this.hydrateSessionBrowserState(sessionId, result.browser);
          return {
            browser,
            created: result.created,
            repaired: result.repaired,
            repairActions: result.repairActions
          } as MethodResult<TMethod>;
        });
      }
      case 'page.goto': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          const result = await this.driver.pageGoto(String(args.url ?? ''), target.tabId);
          if (typeof target.tabId === 'number') {
            this.clearTabContext(sessionId, target.tabId);
          }
          return result as MethodResult<TMethod>;
        });
      }
      case 'page.back':
      case 'page.forward':
      case 'page.reload': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          const tabId = target.tabId;
          const result =
            method === 'page.back'
              ? await this.driver.pageBack(tabId)
              : method === 'page.forward'
                ? await this.driver.pageForward(tabId)
                : await this.driver.pageReload(tabId);
          if (typeof tabId === 'number') {
            this.clearTabContext(sessionId, tabId);
          }
          return result as MethodResult<TMethod>;
        });
      }
      case 'page.wait': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          if (typeof target.tabId === 'number') {
            await this.applyStoredContext(sessionId, target.tabId);
          }
          return (await this.driver.pageWait(
            args.mode as 'selector' | 'text' | 'url',
            String(args.value ?? ''),
            typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
            target.tabId
          )) as MethodResult<TMethod>;
        });
      }
      case 'page.snapshot': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          if (typeof target.tabId === 'number') {
            await this.applyStoredContext(sessionId, target.tabId);
          }
          return (await this.persistPageSnapshot(target.tabId, args.includeBase64 === true, session.traceId)) as MethodResult<TMethod>;
        });
      }
      case 'element.click': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          if (typeof target.tabId === 'number') {
            await this.applyStoredContext(sessionId, target.tabId);
          }
          return (await this.clickWithPolicy(args.locator as Locator, target.tabId, session.traceId, args.requiresConfirm === true)) as MethodResult<TMethod>;
        });
      }
      case 'element.type': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          if (typeof target.tabId === 'number') {
            await this.applyStoredContext(sessionId, target.tabId);
          }
          return (await this.typeWithPolicy(
            args.locator as Locator,
            String(args.text ?? ''),
            args.clear === true,
            target.tabId,
            session.traceId,
            args.requiresConfirm === true
          )) as MethodResult<TMethod>;
        });
      }
      case 'element.scroll': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          if (typeof target.tabId === 'number') {
            await this.applyStoredContext(sessionId, target.tabId);
          }
          return (await this.driver.elementScroll(
            (args.locator as Locator | undefined) ?? undefined,
            Number(args.dx ?? 0),
            Number(args.dy ?? 320),
            target.tabId
          )) as MethodResult<TMethod>;
        });
      }
      case 'debug.getConsole': {
        this.ensurePairing();
        this.ensureConnected();
        const sessionId = this.requireSessionId(args);
        const session = this.getSession(sessionId);
        return this.withTrace(session.traceId, method, params, async () => {
          const target = await this.resolveSessionTarget(sessionId, args);
          return this.driver.debugGetConsole(typeof args.limit === 'number' ? args.limit : 50, target.tabId) as Promise<MethodResult<TMethod>>;
        });
      }
      default:
        break;
    }

    const methodName = String(method) as MethodName;

    if (GLOBAL_DYNAMIC_FORWARD_METHODS.has(methodName)) {
      this.ensurePairing();
      this.ensureConnected();
      return this.withTrace(this.runtimeTraceId, methodName, params, async () =>
        (await this.driver.rawRequest(methodName, args)) as MethodResult<TMethod>
      );
    }

    if (!SESSION_DYNAMIC_FORWARD_METHODS.has(methodName)) {
      throw new RpcError(`Unsupported method: ${methodName}`, 4004, BakErrorCode.E_NOT_FOUND);
    }

    this.ensurePairing();
    this.ensureConnected();
    const sessionId = this.requireSessionId(args);
    const session = this.getSession(sessionId);
    return this.withTrace(session.traceId, methodName, params, async () => {
      const target = await this.resolveSessionTarget(sessionId, args, {
        allowMissing: methodName === 'context.get'
      });
      if (
        typeof target.tabId === 'number' &&
        methodName !== 'context.set' &&
        methodName !== 'context.get' &&
        methodName !== 'context.reset'
      ) {
        await this.applyStoredContext(sessionId, target.tabId);
      }
      if (methodName === 'context.get') {
        if (typeof target.tabId === 'number') {
          await this.applyStoredContext(sessionId, target.tabId);
        }
        return this.buildSessionContext(sessionId, target.tabId) as MethodResult<TMethod>;
      }

      const forwardArgs: Record<string, unknown> = { ...args };
      delete forwardArgs.sessionId;
      if (typeof target.tabId === 'number') {
        forwardArgs.tabId = target.tabId;
      } else {
        delete forwardArgs.tabId;
      }

      const action = POLICY_ACTION_BY_METHOD[methodName];
      if (action && methodName === 'page.fetch') {
        await this.evaluatePolicyForRequest(
          'page.fetch',
          {
            method: typeof forwardArgs.method === 'string' ? String(forwardArgs.method) : 'GET',
            url: typeof forwardArgs.url === 'string' ? String(forwardArgs.url) : undefined,
            requiresConfirm: forwardArgs.requiresConfirm === true
          },
          session.traceId,
          { tabId: target.tabId }
        );
      } else if (action && methodName === 'network.replay') {
        let replayMethod = 'REPLAY';
        let replayUrl: string | undefined;
        try {
          const preview = asRecord(
            await this.driver.rawRequest('network.get', {
              tabId: target.tabId,
              id: forwardArgs.id,
              include: ['request']
            })
          );
          const entry = asRecord(preview.entry);
          if (typeof entry.method === 'string' && entry.method.trim().length > 0) {
            replayMethod = entry.method;
          }
          if (typeof entry.url === 'string' && entry.url.trim().length > 0) {
            replayUrl = entry.url;
          }
        } catch {
          // Fall back to conservative confirmation when the captured request metadata is unavailable.
        }
        await this.evaluatePolicyForRequest(
          'network.replay',
          {
            method: replayMethod,
            url: replayUrl,
            requiresConfirm: forwardArgs.requiresConfirm === true
          },
          session.traceId,
          { tabId: target.tabId }
        );
      } else if (action && methodName === 'element.dragDrop') {
        const from = forwardArgs.from as Locator | undefined;
        const to = forwardArgs.to as Locator | undefined;
        if (!from || !to) {
          throw new RpcError(`${methodName} requires both from and to locators`, -32602, BakErrorCode.E_INVALID_PARAMS);
        }
        const fromDecision = await this.evaluatePolicyForTarget(action, from, session.traceId, { tabId: target.tabId });
        const toDecision = await this.evaluatePolicyForTarget(action, to, session.traceId, { tabId: target.tabId });
        forwardArgs.requiresConfirm =
          forwardArgs.requiresConfirm === true || fromDecision.requiresConfirm || toDecision.requiresConfirm;
      } else if (action) {
        const locator = forwardArgs.locator as Locator | undefined;
        if (!locator) {
          throw new RpcError(`${methodName} requires locator`, -32602, BakErrorCode.E_INVALID_PARAMS);
        }
        const decision = await this.evaluatePolicyForTarget(action, locator, session.traceId, { tabId: target.tabId });
        forwardArgs.requiresConfirm = forwardArgs.requiresConfirm === true || decision.requiresConfirm;
      }

      const result = await this.driver.rawRequest(methodName, forwardArgs);
      if (
        methodName === 'debug.dumpState' &&
        typeof target.tabId === 'number' &&
        args.includeSnapshot === true
      ) {
        return {
          ...asRecord(result),
          snapshot: await this.persistPageSnapshot(
            target.tabId,
            args.includeSnapshotBase64 === true,
            session.traceId
          )
        } as MethodResult<TMethod>;
      }
      if (
        (methodName === 'context.set' ||
          methodName === 'context.enterFrame' ||
          methodName === 'context.exitFrame' ||
          methodName === 'context.enterShadow' ||
          methodName === 'context.exitShadow' ||
          methodName === 'context.reset') &&
        typeof target.tabId === 'number'
      ) {
        const snapshot = this.updateContextFromResult(sessionId, target.tabId, methodName as SessionContextMethod, result);
        if (methodName === 'context.set' || methodName === 'context.reset') {
          return {
            ...asRecord(result),
            ...snapshot
          } as MethodResult<TMethod>;
        }
      }
      return result as MethodResult<TMethod>;
    });
  }
}
