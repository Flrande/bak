import type {
  AccessibilityNode,
  ConsoleEntry,
  ElementMapItem,
  Locator,
  MethodResult,
  NetworkEntry,
  PageDomSummary,
  PageMetrics,
  PageTextChunk,
  SessionBrowserState
} from '@flrande/bak-protocol';
import type { BridgeConnectionState } from './extension-bridge.js';

export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId?: number;
  groupId?: number | null;
}

export interface SnapshotResult {
  imageBase64: string;
  elements: ElementMapItem[];
  tabId: number;
  url: string;
}

export interface SessionBindingEnsureResult {
  browser: SessionBrowserState;
  created: boolean;
  repaired: boolean;
  repairActions: string[];
}

export interface SessionBindingOpenTabResult {
  browser: SessionBrowserState;
  tab: BrowserTab;
}

export interface SessionBindingListTabsResult {
  browser: SessionBrowserState;
  tabs: BrowserTab[];
}

export interface SessionBindingActiveTabResult {
  browser: SessionBrowserState;
  tab: BrowserTab | null;
}

export interface SessionBindingFocusResult {
  ok: true;
  browser: SessionBrowserState;
}

export interface SessionBindingCloseTabResult {
  browser: SessionBrowserState | null;
  closedTabId: number;
}

export interface DriverConnectionStatus {
  state: BridgeConnectionState;
  reason: string | null;
  extensionVersion: string | null;
  lastSeenTs: number | null;
  lastRequestTs: number | null;
  lastResponseTs: number | null;
  lastHeartbeatTs: number | null;
  lastError: string | null;
  connectedAtTs: number | null;
  disconnectedAtTs: number | null;
  pendingRequests: number;
  totalRequests: number;
  totalFailures: number;
  totalTimeouts: number;
  totalNotReady: number;
}

export interface BrowserDriver {
  isConnected(): boolean;
  connectionStatus(): DriverConnectionStatus;
  sessionPing(timeoutMs?: number): Promise<{ ok: boolean; ts: number }>;
  tabsList(): Promise<{ tabs: BrowserTab[] }>;
  tabsFocus(tabId: number): Promise<{ ok: true }>;
  tabsGetActive(): Promise<MethodResult<'tabs.getActive'>>;
  tabsGet(tabId: number): Promise<MethodResult<'tabs.get'>>;
  tabsNew(options?: { url?: string; active?: boolean; windowId?: number; addToGroup?: boolean }): Promise<MethodResult<'tabs.new'>>;
  tabsClose(tabId: number): Promise<{ ok: true }>;
  pageGoto(url: string, tabId?: number): Promise<{ ok: true }>;
  pageBack(tabId?: number): Promise<{ ok: true }>;
  pageForward(tabId?: number): Promise<{ ok: true }>;
  pageReload(tabId?: number): Promise<{ ok: true }>;
  pageWait(mode: 'selector' | 'text' | 'url', value: string, timeoutMs?: number, tabId?: number): Promise<{ ok: true }>;
  pageSnapshot(tabId?: number, includeBase64?: boolean): Promise<SnapshotResult>;
  elementClick(locator: Locator, tabId?: number, requiresConfirm?: boolean): Promise<{ ok: true }>;
  elementType(locator: Locator, text: string, clear?: boolean, tabId?: number, requiresConfirm?: boolean): Promise<{ ok: true }>;
  elementScroll(locator: Locator | undefined, dx: number, dy: number, tabId?: number): Promise<{ ok: true }>;
  debugGetConsole(limit?: number, tabId?: number): Promise<{ entries: ConsoleEntry[] }>;
  userSelectCandidate(candidates: ElementMapItem[], tabId?: number): Promise<{ selectedEid: string }>;
  sessionBindingEnsure(params?: { bindingId?: string; url?: string; focus?: boolean; label?: string }): Promise<SessionBindingEnsureResult>;
  sessionBindingInfo(params?: { bindingId?: string }): Promise<{ browser: SessionBrowserState | null }>;
  sessionBindingOpenTab(params?: { bindingId?: string; url?: string; active?: boolean; focus?: boolean; label?: string }): Promise<SessionBindingOpenTabResult>;
  sessionBindingListTabs(params?: { bindingId?: string }): Promise<SessionBindingListTabsResult>;
  sessionBindingGetActiveTab(params?: { bindingId?: string }): Promise<SessionBindingActiveTabResult>;
  sessionBindingSetActiveTab(params: { bindingId?: string; tabId: number }): Promise<SessionBindingOpenTabResult>;
  sessionBindingFocus(params?: { bindingId?: string }): Promise<SessionBindingFocusResult>;
  sessionBindingCloseTab(params: { bindingId?: string; tabId?: number }): Promise<SessionBindingCloseTabResult>;
  sessionBindingReset(params?: { bindingId?: string; url?: string; focus?: boolean; label?: string }): Promise<SessionBindingEnsureResult>;
  sessionBindingClose(params?: { bindingId?: string }): Promise<{ ok: true }>;
  rawRequest<TResult = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<TResult>;
}

export interface PageDumpState {
  url: string;
  title: string;
  context: {
    framePath: string[];
    shadowPath: string[];
  };
  dom: PageDomSummary;
  text: PageTextChunk[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  accessibility?: AccessibilityNode[];
}

export interface DriverExtendedApis {
  pageMetrics(tabId?: number): Promise<PageMetrics>;
  debugDumpState(tabId?: number, options?: { consoleLimit?: number; networkLimit?: number; includeAccessibility?: boolean }): Promise<PageDumpState>;
}


