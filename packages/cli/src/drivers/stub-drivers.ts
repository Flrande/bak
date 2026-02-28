import type { BrowserDriver } from './browser-driver.js';

export abstract class StubDriver implements BrowserDriver {
  protected unavailable(name: string): never {
    throw new Error(`${name} is not implemented in v1`);
  }

  isConnected(): boolean {
    return false;
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
