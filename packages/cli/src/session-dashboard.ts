import type {
  RuntimeInfoResult,
  SessionBrowserState,
  SessionContextSnapshot,
  SessionDescriptor,
  SessionInfoResult,
  SessionSummary,
  TabInfo
} from '@flrande/bak-protocol';
import { callRpc } from './rpc/client.js';

export interface SessionDashboardRuntime {
  paired: boolean;
  extensionConnected: boolean;
  connectionState: RuntimeInfoResult['connectionState'];
  connectionReason: string | null;
  extensionVersion: string | null;
  heartbeatStale: boolean;
  heartbeatAgeMs: number | null;
  managedRuntime: boolean;
  idleStopArmed: boolean;
  activeSessionCount: number;
}

export interface SessionDashboardEntry {
  session: SessionDescriptor;
  attached: boolean;
  detached: boolean;
  activeTab: TabInfo | null;
  tabs: TabInfo[];
  currentContext: SessionContextSnapshot;
  frameDepth: number;
  shadowDepth: number;
}

export interface SessionDashboard {
  runtime: SessionDashboardRuntime;
  sessions: SessionDashboardEntry[];
}

export interface SessionDashboardEntrySource {
  summary: SessionSummary;
  info: SessionInfoResult;
  tabsListing?: {
    browser: SessionBrowserState | null;
    tabs: TabInfo[];
  } | null;
}

export function trimRuntimeInfo(info: RuntimeInfoResult): SessionDashboardRuntime {
  return {
    paired: info.paired,
    extensionConnected: info.extensionConnected,
    connectionState: info.connectionState,
    connectionReason: info.connectionReason,
    extensionVersion: info.extensionVersion,
    heartbeatStale: info.heartbeatStale,
    heartbeatAgeMs: info.heartbeatAgeMs,
    managedRuntime: info.managedRuntime,
    idleStopArmed: info.idleStopArmed,
    activeSessionCount: info.activeSessionCount
  };
}

export function buildSessionDashboardEntry(source: SessionDashboardEntrySource): SessionDashboardEntry {
  const tabsListing = source.tabsListing ?? null;
  const tabs = tabsListing?.tabs ?? [];
  const browser = tabsListing?.browser ?? null;
  const activeTab =
    source.info.activeTab ??
    source.summary.activeTab ??
    (browser && browser.activeTabId !== null ? tabs.find((tab) => tab.id === browser.activeTabId) ?? null : null);
  const attached = browser !== null && browser.windowId !== null && tabs.length > 0;

  return {
    session: source.info.session,
    attached,
    detached: !attached,
    activeTab,
    tabs,
    currentContext: source.info.currentContext,
    frameDepth: source.info.currentContext.framePath.length,
    shadowDepth: source.info.currentContext.shadowPath.length
  };
}

export function buildSessionDashboard(
  runtimeInfo: RuntimeInfoResult,
  entries: SessionDashboardEntrySource[]
): SessionDashboard {
  return {
    runtime: trimRuntimeInfo(runtimeInfo),
    sessions: entries.map((entry) => buildSessionDashboardEntry(entry))
  };
}

export async function loadSessionDashboard(rpcWsPort: number): Promise<SessionDashboard> {
  const runtimeInfo = (await callRpc('runtime.info', {}, rpcWsPort)) as RuntimeInfoResult;
  const listed = (await callRpc('session.list', {}, rpcWsPort)) as { sessions: SessionSummary[] };
  const entries = await Promise.all(
    listed.sessions.map(async (summary) => {
      const info = (await callRpc('session.info', { sessionId: summary.sessionId }, rpcWsPort)) as SessionInfoResult;
      let tabsListing: { browser: SessionBrowserState | null; tabs: TabInfo[] } | null = null;
      try {
        tabsListing = (await callRpc('session.listTabs', { sessionId: summary.sessionId }, rpcWsPort)) as {
          browser: SessionBrowserState | null;
          tabs: TabInfo[];
        };
      } catch {
        tabsListing = null;
      }
      return {
        summary,
        info,
        tabsListing
      } satisfies SessionDashboardEntrySource;
    })
  );

  return buildSessionDashboard(runtimeInfo, entries);
}
