import type {
  ConsoleEntry,
  ElementMapItem,
  Locator,
  NetworkEntry,
  PageDomSummary,
  PageMetrics,
  PageTextChunk
} from '@bak/protocol';
import type { BridgeConnectionState } from './extension-bridge.js';

export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface SnapshotResult {
  imageBase64: string;
  elements: ElementMapItem[];
  tabId: number;
  url: string;
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
  tabsNew(url?: string): Promise<{ tabId: number }>;
  tabsClose(tabId: number): Promise<{ ok: true }>;
  pageGoto(url: string, tabId?: number): Promise<{ ok: true }>;
  pageBack(tabId?: number): Promise<{ ok: true }>;
  pageForward(tabId?: number): Promise<{ ok: true }>;
  pageReload(tabId?: number): Promise<{ ok: true }>;
  pageWait(mode: 'selector' | 'text' | 'url', value: string, timeoutMs?: number, tabId?: number): Promise<{ ok: true }>;
  pageSnapshot(tabId?: number): Promise<SnapshotResult>;
  elementClick(locator: Locator, tabId?: number, requiresConfirm?: boolean): Promise<{ ok: true }>;
  elementType(locator: Locator, text: string, clear?: boolean, tabId?: number, requiresConfirm?: boolean): Promise<{ ok: true }>;
  elementScroll(locator: Locator | undefined, dx: number, dy: number, tabId?: number): Promise<{ ok: true }>;
  debugGetConsole(limit?: number, tabId?: number): Promise<{ entries: ConsoleEntry[] }>;
  userSelectCandidate(candidates: ElementMapItem[], tabId?: number): Promise<{ selectedEid: string }>;
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
}

export interface DriverExtendedApis {
  pageMetrics(tabId?: number): Promise<PageMetrics>;
  debugDumpState(tabId?: number, options?: { consoleLimit?: number; networkLimit?: number; includeAccessibility?: boolean }): Promise<PageDumpState>;
}
