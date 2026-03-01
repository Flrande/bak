import type { ConsoleEntry, ElementMapItem, Locator } from '@bak/protocol';
import type { BrowserDriver, BrowserTab, DriverConnectionStatus, SnapshotResult } from './browser-driver.js';
import type { ExtensionBridge } from './extension-bridge.js';

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
      lastSeenTs: stats.lastSeenTs,
      lastRequestTs: stats.lastRequestTs,
      lastResponseTs: stats.lastResponseTs,
      lastHeartbeatTs: stats.lastHeartbeatTs,
      lastError: stats.lastError,
      connectedAtTs: stats.connectedAtTs,
      disconnectedAtTs: stats.disconnectedAtTs,
      pendingRequests: stats.pendingRequests
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

  tabsNew(url?: string): Promise<{ tabId: number }> {
    return this.bridge.request('tabs.new', { url });
  }

  tabsClose(tabId: number): Promise<{ ok: true }> {
    return this.bridge.request('tabs.close', { tabId });
  }

  pageGoto(url: string, tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.goto', { url, tabId });
  }

  pageBack(tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.back', { tabId });
  }

  pageForward(tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.forward', { tabId });
  }

  pageReload(tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('page.reload', { tabId });
  }

  pageWait(
    mode: 'selector' | 'text' | 'url',
    value: string,
    timeoutMs?: number,
    tabId?: number
  ): Promise<{ ok: true }> {
    return this.bridge.request('page.wait', { mode, value, timeoutMs, tabId });
  }

  pageSnapshot(tabId?: number): Promise<SnapshotResult> {
    return this.bridge.request('page.snapshot', { tabId });
  }

  elementClick(locator: Locator, tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('element.click', { locator, tabId });
  }

  elementType(locator: Locator, text: string, clear?: boolean, tabId?: number): Promise<{ ok: true }> {
    return this.bridge.request('element.type', { locator, text, clear, tabId });
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
}
