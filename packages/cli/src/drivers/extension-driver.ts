import type { ConsoleEntry, ElementMapItem, Locator, MethodResult } from '@flrande/bak-protocol';
import type {
  BrowserDriver,
  BrowserTab,
  DriverConnectionStatus,
  SessionBindingActiveTabResult,
  SessionBindingEnsureResult,
  SessionBindingFocusResult,
  SessionBindingListTabsResult,
  SessionBindingOpenTabResult,
  SnapshotResult
} from './browser-driver.js';
import type { ExtensionBridge } from './extension-bridge.js';

const BRIDGE_TIMEOUT_GRACE_MS = 1_500;
const BRIDGE_TIMEOUT_MIN_MS = 1_000;
const NAVIGATION_BRIDGE_TIMEOUT_MS = 30_000;
const SESSION_BINDING_BRIDGE_TIMEOUT_MS = 30_000;

function normalizeTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveBridgeTimeoutMs(params?: Record<string, unknown>, timeoutMs?: number): number | undefined {
  const explicitTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const paramsTimeoutMs = normalizeTimeoutMs(params?.timeoutMs);
  const baseTimeoutMs = explicitTimeoutMs ?? paramsTimeoutMs;
  if (baseTimeoutMs === undefined) {
    return undefined;
  }
  return Math.max(BRIDGE_TIMEOUT_MIN_MS, baseTimeoutMs + BRIDGE_TIMEOUT_GRACE_MS);
}

export class ExtensionDriver implements BrowserDriver {
  private readonly bridge: ExtensionBridge;

  constructor(bridge: ExtensionBridge) {
    this.bridge = bridge;
  }

  isConnected(): boolean {
    return this.bridge.isConnected();
  }

  connectionStatus(): DriverConnectionStatus {
    const stats = this.bridge.getStats();
    return {
      state: stats.state,
      reason: stats.reason,
      extensionVersion: stats.extensionVersion,
      lastSeenTs: stats.lastSeenTs,
      lastRequestTs: stats.lastRequestTs,
      lastResponseTs: stats.lastResponseTs,
      lastHeartbeatTs: stats.lastHeartbeatTs,
      lastError: stats.lastError,
      connectedAtTs: stats.connectedAtTs,
      disconnectedAtTs: stats.disconnectedAtTs,
      pendingRequests: stats.pendingRequests,
      totalRequests: stats.totalRequests,
      totalFailures: stats.totalFailures,
      totalTimeouts: stats.totalTimeouts,
      totalNotReady: stats.totalNotReady
    };
  }

  async sessionPing(timeoutMs = 2_000): Promise<{ ok: boolean; ts: number }> {
    const result = await this.bridge.request<{ ok: boolean; ts: number }>('session.ping', {}, timeoutMs);
    this.bridge.markHeartbeat(typeof result.ts === 'number' ? result.ts : Date.now());
    return result;
  }

  tabsList(): Promise<{ tabs: BrowserTab[] }> {
    return this.bridge.request('tabs.list', {});
  }

  tabsFocus(tabId: number): Promise<{ ok: true }> {
    return this.bridge.request('tabs.focus', { tabId });
  }

  tabsGetActive(): Promise<MethodResult<'tabs.getActive'>> {
    return this.bridge.request('tabs.getActive', {});
  }

  tabsGet(tabId: number): Promise<MethodResult<'tabs.get'>> {
    return this.bridge.request('tabs.get', { tabId });
  }

  tabsNew(options: { url?: string; active?: boolean; windowId?: number; addToGroup?: boolean } = {}): Promise<MethodResult<'tabs.new'>> {
    return this.bridge.request('tabs.new', options);
  }

  tabsClose(tabId: number): Promise<{ ok: true }> {
    return this.bridge.request('tabs.close', { tabId });
  }

  pageGoto(url: string, tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.goto', { url, tabId }, NAVIGATION_BRIDGE_TIMEOUT_MS);
  }

  pageBack(tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.back', { tabId }, NAVIGATION_BRIDGE_TIMEOUT_MS);
  }

  pageForward(tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.forward', { tabId }, NAVIGATION_BRIDGE_TIMEOUT_MS);
  }

  pageReload(tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.reload', { tabId }, NAVIGATION_BRIDGE_TIMEOUT_MS);
  }

  pageWait(
    mode: 'selector' | 'text' | 'url',
    value: string,
    timeoutMs?: number,
    tabId?: number
  ): Promise<{ ok: true }> {
    const params = { mode, value, timeoutMs, tabId };
    return this.bridge.request('page.wait', params, resolveBridgeTimeoutMs(params, timeoutMs));
  }

  pageSnapshot(tabId?: number, includeBase64 = true): Promise<SnapshotResult> {
    return this.bridge.request('page.snapshot', { tabId, includeBase64 });
  }

  elementClick(locator: Locator, tabId?: number, requiresConfirm?: boolean): Promise<{ ok: true }> {
    return this.bridge.request('element.click', { locator, tabId, requiresConfirm });
  }

  elementType(locator: Locator, text: string, clear?: boolean, tabId?: number, requiresConfirm?: boolean): Promise<{ ok: true }> {
    return this.bridge.request('element.type', { locator, text, clear, tabId, requiresConfirm });
  }

  elementScroll(locator: Locator | undefined, dx: number, dy: number, tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('element.scroll', { locator, dx, dy, tabId });
  }

  debugGetConsole(limit = 50, tabId?: number): Promise<{ entries: ConsoleEntry[] }> {
    return this.bridge.request('debug.getConsole', { limit, tabId });
  }

  userSelectCandidate(candidates: ElementMapItem[], tabId?: number): Promise<{ selectedEid: string }> {
    return this.bridge.request('ui.selectCandidate', { candidates, tabId }, 60_000);
  }

  sessionBindingEnsure(params: { bindingId?: string; url?: string; focus?: boolean } = {}): Promise<SessionBindingEnsureResult> {
    return this.bridge.request('sessionBinding.ensure', params, SESSION_BINDING_BRIDGE_TIMEOUT_MS);
  }

  sessionBindingInfo(params: { bindingId?: string } = {}): Promise<{ browser: SessionBindingEnsureResult['browser'] | null }> {
    return this.bridge.request('sessionBinding.info', params);
  }

  sessionBindingOpenTab(
    params: { bindingId?: string; url?: string; active?: boolean; focus?: boolean } = {}
  ): Promise<SessionBindingOpenTabResult> {
    return this.bridge.request('sessionBinding.openTab', params, SESSION_BINDING_BRIDGE_TIMEOUT_MS);
  }

  sessionBindingListTabs(params: { bindingId?: string } = {}): Promise<SessionBindingListTabsResult> {
    return this.bridge.request('sessionBinding.listTabs', params);
  }

  sessionBindingGetActiveTab(params: { bindingId?: string } = {}): Promise<SessionBindingActiveTabResult> {
    return this.bridge.request('sessionBinding.getActiveTab', params);
  }

  sessionBindingSetActiveTab(params: { bindingId?: string; tabId: number }): Promise<SessionBindingOpenTabResult> {
    return this.bridge.request('sessionBinding.setActiveTab', params);
  }

  sessionBindingFocus(params: { bindingId?: string } = {}): Promise<SessionBindingFocusResult> {
    return this.bridge.request('sessionBinding.focus', params);
  }

  sessionBindingReset(params: { bindingId?: string; url?: string; focus?: boolean } = {}): Promise<SessionBindingEnsureResult> {
    return this.bridge.request('sessionBinding.reset', params, SESSION_BINDING_BRIDGE_TIMEOUT_MS);
  }

  sessionBindingClose(params: { bindingId?: string } = {}): Promise<{ ok: true }> {
    return this.bridge.request('sessionBinding.close', params);
  }

  rawRequest<TResult = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<TResult> {
    return this.bridge.request<TResult>(method, params, resolveBridgeTimeoutMs(params, timeoutMs));
  }
}


