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
  RpcError
} from '@flrande/bak-protocol';
import type { BrowserDriver } from './drivers/browser-driver.js';
import { BridgeError } from './drivers/extension-bridge.js';
import { evaluateConnectionHealth } from './connection-health.js';
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
  'workspace.ensure',
  'workspace.info',
  'workspace.openTab',
  'workspace.listTabs',
  'workspace.getActiveTab',
  'workspace.setActiveTab',
  'workspace.focus',
  'workspace.reset',
  'workspace.close',
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

interface ResolvedTarget {
  tabId?: number;
  workspaceId?: string;
}

export interface ServiceHeartbeatConfig {
  intervalMs?: number;
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

export class BakService {
  private readonly driver: BrowserDriver;
  private readonly pairingStore: PairingStore;
  private readonly traceStore: TraceStore;
  private readonly dataDir: string;
  private readonly policyEngine: PolicyEngine;
  private sessionId: string | null = null;
  private currentTraceId = '';
  private contextFrameDepth = 0;
  private contextShadowDepth = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatStaleAfterMs: number;

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

  status(): MethodResult<'session.info'> {
    const connection = this.effectiveConnection();
    return {
      sessionId: this.sessionId,
      paired: Boolean(this.pairingStore.getToken()),
      extensionConnected: connection.extensionConnected,
      connectionState: connection.connectionState,
      connectionReason: connection.connectionReason,
      protocolVersion: PROTOCOL_VERSION,
      compatibleProtocolVersions: [...COMPATIBLE_PROTOCOL_VERSIONS],
      extensionVersion: connection.raw.extensionVersion,
      activeTab: null,
      context: {
        frameDepth: this.contextFrameDepth,
        shadowDepth: this.contextShadowDepth
      },
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

  private async resolveTarget(args: Record<string, unknown>): Promise<ResolvedTarget> {
    const tabId = typeof args.tabId === 'number' ? args.tabId : undefined;
    const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.trim().length > 0 ? args.workspaceId.trim() : undefined;
    if (tabId !== undefined) {
      return { tabId, workspaceId };
    }
    if (!this.driver.isConnected()) {
      return { workspaceId };
    }
    if (workspaceId) {
      const result = await this.driver.workspaceGetActiveTab({ workspaceId });
      return {
        tabId: result.tab?.id,
        workspaceId: result.workspace.id
      };
    }

    try {
      const info = await this.driver.workspaceInfo();
      const workspaceTabId = info.workspace?.activeTabId ?? info.workspace?.tabs[0]?.id;
      if (typeof workspaceTabId === 'number' && info.workspace) {
        return {
          tabId: workspaceTabId,
          workspaceId: info.workspace.id
        };
      }
    } catch {
      // Fall back to the browser active tab when the workspace is absent or unavailable.
    }

    try {
      const active = await this.driver.tabsGetActive();
      return {
        tabId: active.tab?.id,
        workspaceId
      };
    } catch {
      return { workspaceId };
    }
  }

  private async activeLocation(target?: ResolvedTarget): Promise<{ domain: string; path: string }> {
    if (typeof target?.tabId === 'number' && this.driver.isConnected()) {
      try {
        const current = await this.driver.rawRequest<MethodResult<'page.url'>>('page.url', { tabId: target.tabId });
        return {
          domain: getDomain(current.url),
          path: getPathname(current.url)
        };
      } catch {
        // Fall back to active tab summary below.
      }
    }
    const active = await this.activeTabSummary();
    if (!active?.url) {
      return { domain: 'unknown', path: '/' };
    }
    return {
      domain: getDomain(active.url),
      path: getPathname(active.url)
    };
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
    return this.evaluatePolicyForTarget(action, locator);
  }

  private async evaluatePolicyForTarget(action: PolicyAction, locator: Locator, target?: ResolvedTarget): Promise<{ requiresConfirm: boolean }> {
    const traceId = this.currentTraceId || this.traceStore.newTraceId();
    this.currentTraceId = traceId;
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

  private async withPolicyOnDynamicRequest(methodName: MethodName, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = await this.resolveTarget(params);
    const withResolvedTarget: Record<string, unknown> = {
      ...params,
      tabId: target.tabId,
      workspaceId: target.workspaceId
    };
    const action = POLICY_ACTION_BY_METHOD[methodName];
    if (!action) {
      return withResolvedTarget;
    }
    const requiresConfirm = withResolvedTarget.requiresConfirm === true;
    if (methodName === 'element.dragDrop') {
      const from = withResolvedTarget.from as Locator | undefined;
      const to = withResolvedTarget.to as Locator | undefined;
      if (!from || !to) {
        throw new RpcError(`${methodName} requires both from and to locators`, -32602, BakErrorCode.E_INVALID_PARAMS);
      }
      const fromDecision = await this.evaluatePolicyForTarget(action, from, target);
      const toDecision = await this.evaluatePolicyForTarget(action, to, target);
      return {
        ...withResolvedTarget,
        requiresConfirm: requiresConfirm || fromDecision.requiresConfirm || toDecision.requiresConfirm
      };
    }

    const locator = withResolvedTarget.locator as Locator | undefined;
    if (!locator) {
      throw new RpcError(`${methodName} requires locator`, -32602, BakErrorCode.E_INVALID_PARAMS);
    }
    const decision = await this.evaluatePolicyForTarget(action, locator, target);
    return {
      ...withResolvedTarget,
      requiresConfirm: requiresConfirm || decision.requiresConfirm
    };
  }

  private async clickWithPolicy(locator: Locator, tabId?: number, requiresConfirm = false, target?: ResolvedTarget): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicyForTarget('element.click', locator, target);
    return this.driver.elementClick(locator, tabId, requiresConfirm || policy.requiresConfirm);
  }

  private async typeWithPolicy(
    locator: Locator,
    text: string,
    clear: boolean,
    tabId?: number,
    requiresConfirm = false,
    target?: ResolvedTarget
  ): Promise<{ ok: true }> {
    const policy = await this.evaluatePolicyForTarget('element.type', locator, target);
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
          return {
            sessionId: this.sessionId,
            paired: Boolean(this.pairingStore.getToken()),
            extensionConnected: connection.extensionConnected,
            connectionState: connection.connectionState,
            connectionReason: connection.connectionReason,
            protocolVersion: PROTOCOL_VERSION,
            compatibleProtocolVersions: [...COMPATIBLE_PROTOCOL_VERSIONS],
            extensionVersion: connection.raw.extensionVersion,
            activeTab,
            context: {
              frameDepth: this.contextFrameDepth,
              shadowDepth: this.contextShadowDepth
            },
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
          return this.driver.tabsNew({
            url: typeof args.url === 'string' ? args.url : undefined,
            active: args.active === true,
            windowId: typeof args.windowId === 'number' ? args.windowId : undefined,
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
            addToGroup: args.addToGroup === true
          }) as Promise<MethodResult<TMethod>>;
        }) as Promise<MethodResult<TMethod>>;
      case 'tabs.close':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => this.driver.tabsClose(Number(args.tabId))) as Promise<MethodResult<TMethod>>;
      case 'workspace.ensure':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceEnsure({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
            url: typeof args.url === 'string' ? args.url : undefined,
            focus: args.focus === true
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.info':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceInfo({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.openTab':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceOpenTab({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
            url: typeof args.url === 'string' ? args.url : undefined,
            active: args.active === true,
            focus: args.focus === true
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.listTabs':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceListTabs({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.getActiveTab':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceGetActiveTab({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.setActiveTab':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceSetActiveTab({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
            tabId: Number(args.tabId)
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.focus':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceFocus({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.reset':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceReset({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
            url: typeof args.url === 'string' ? args.url : undefined,
            focus: args.focus === true
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'workspace.close':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () =>
          this.driver.workspaceClose({
            workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined
          }) as Promise<MethodResult<TMethod>>
        ) as Promise<MethodResult<TMethod>>;
      case 'page.goto':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const target = await this.resolveTarget(args);
          const tabId = target.tabId;
          const url = String(args.url ?? '');
          return (await this.driver.pageGoto(url, tabId)) as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'page.back':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const target = await this.resolveTarget(args);
          return this.driver.pageBack(target.tabId) as Promise<MethodResult<TMethod>>;
        }) as Promise<MethodResult<TMethod>>;
      case 'page.forward':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const target = await this.resolveTarget(args);
          return this.driver.pageForward(target.tabId) as Promise<MethodResult<TMethod>>;
        }) as Promise<MethodResult<TMethod>>;
      case 'page.reload':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const target = await this.resolveTarget(args);
          return this.driver.pageReload(target.tabId) as Promise<MethodResult<TMethod>>;
        }) as Promise<MethodResult<TMethod>>;
      case 'page.wait':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const mode = args.mode as 'selector' | 'text' | 'url';
          const value = String(args.value);
          const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
          const target = await this.resolveTarget(args);
          const tabId = target.tabId;
          return (await this.driver.pageWait(mode, value, timeoutMs, tabId)) as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'page.snapshot':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const target = await this.resolveTarget(args);
          const tabId = target.tabId;
          const includeBase64 = Boolean(args.includeBase64);
          return (await this.persistPageSnapshot(tabId, includeBase64)) as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'element.click':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = args.locator as Locator;
          const target = await this.resolveTarget(args);
          const tabId = target.tabId;
          return (await this.clickWithPolicy(locator, tabId, args.requiresConfirm === true, target)) as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'element.type':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = args.locator as Locator;
          const target = await this.resolveTarget(args);
          const tabId = target.tabId;
          const text = String(args.text ?? '');
          const clear = Boolean(args.clear);
          return (await this.typeWithPolicy(locator, text, clear, tabId, args.requiresConfirm === true, target)) as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'element.scroll':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const locator = (args.locator as Locator | undefined) ?? undefined;
          const dx = Number(args.dx ?? 0);
          const dy = Number(args.dy ?? 320);
          const target = await this.resolveTarget(args);
          const tabId = target.tabId;
          return (await this.driver.elementScroll(locator, dx, dy, tabId)) as MethodResult<TMethod>;
        }) as Promise<MethodResult<TMethod>>;
      case 'debug.getConsole':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const target = await this.resolveTarget(args);
          return this.driver.debugGetConsole(typeof args.limit === 'number' ? args.limit : 50, target.tabId) as Promise<MethodResult<TMethod>>;
        }) as Promise<MethodResult<TMethod>>;
      case 'debug.dumpState':
        this.ensurePairing();
        this.ensureConnected();
        return this.withTrace(method, params, async () => {
          const target = await this.resolveTarget(args);
          const tabId = target.tabId;
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
      return result as MethodResult<TMethod>;
    }) as Promise<MethodResult<TMethod>>;
  }
}
