import type { BrowserDriver } from './browser-driver.js';

export abstract class StubDriver implements BrowserDriver {
  protected unavailable(name: string): never {
    throw new Error(`${name} is not implemented in v1`);
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
}

export class CDPDriver extends StubDriver {}

export class PlaywrightDriver extends StubDriver {}
