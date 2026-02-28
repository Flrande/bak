import type { ConsoleEntry, ElementMapItem, Locator } from '@bak/protocol';

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

export interface BrowserDriver {
  isConnected(): boolean;
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
  elementClick(locator: Locator, tabId?: number): Promise<{ ok: true }>;
  elementType(locator: Locator, text: string, clear?: boolean, tabId?: number): Promise<{ ok: true }>;
  elementScroll(locator: Locator | undefined, dx: number, dy: number, tabId?: number): Promise<{ ok: true }>;
  debugGetConsole(limit?: number, tabId?: number): Promise<{ entries: ConsoleEntry[] }>;
  userSelectCandidate(candidates: ElementMapItem[], tabId?: number): Promise<{ selectedEid: string }>;
}
