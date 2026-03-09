import type { BrowserDriver } from './browser-driver.js';

export abstract class StubDriver implements BrowserDriver {
  protected unavailable(name: string): never {
    throw new Error(`${name} is not implemented in v2`);
  }

  isConnected(): boolean {
    return false;
  }

  connectionStatus() {
    return {
      state: 'disconnected' as const,
      reason: 'stub-driver',
      extensionVersion: null,
      lastSeenTs: null,
      lastRequestTs: null,
      lastResponseTs: null,
      lastHeartbeatTs: null,
      lastError: 'stub-driver',
      connectedAtTs: null,
      disconnectedAtTs: Date.now(),
      pendingRequests: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      totalNotReady: 0
    };
  }

  sessionPing() {
    return this.unavailable('sessionPing');
  }

  tabsList() {
    return this.unavailable('tabsList');
  }

  tabsFocus() {
    return this.unavailable('tabsFocus');
  }

  tabsGetActive() {
    return this.unavailable('tabsGetActive');
  }

  tabsGet() {
    return this.unavailable('tabsGet');
  }

  tabsNew() {
    return this.unavailable('tabsNew');
  }

  tabsClose() {
    return this.unavailable('tabsClose');
  }

  pageGoto() {
    return this.unavailable('pageGoto');
  }

  pageBack() {
    return this.unavailable('pageBack');
  }

  pageForward() {
    return this.unavailable('pageForward');
  }

  pageReload() {
    return this.unavailable('pageReload');
  }

  pageWait() {
    return this.unavailable('pageWait');
  }

  pageSnapshot() {
    return this.unavailable('pageSnapshot');
  }

  elementClick() {
    return this.unavailable('elementClick');
  }

  elementType() {
    return this.unavailable('elementType');
  }

  elementScroll() {
    return this.unavailable('elementScroll');
  }

  debugGetConsole() {
    return this.unavailable('debugGetConsole');
  }

  userSelectCandidate() {
    return this.unavailable('userSelectCandidate');
  }

  workspaceEnsure() {
    return this.unavailable('workspaceEnsure');
  }

  workspaceInfo() {
    return this.unavailable('workspaceInfo');
  }

  workspaceOpenTab() {
    return this.unavailable('workspaceOpenTab');
  }

  workspaceListTabs() {
    return this.unavailable('workspaceListTabs');
  }

  workspaceGetActiveTab() {
    return this.unavailable('workspaceGetActiveTab');
  }

  workspaceSetActiveTab() {
    return this.unavailable('workspaceSetActiveTab');
  }

  workspaceFocus() {
    return this.unavailable('workspaceFocus');
  }

  workspaceReset() {
    return this.unavailable('workspaceReset');
  }

  workspaceClose() {
    return this.unavailable('workspaceClose');
  }

  rawRequest() {
    return this.unavailable('rawRequest');
  }
}

export class CDPDriver extends StubDriver {}

export class PlaywrightDriver extends StubDriver {}
