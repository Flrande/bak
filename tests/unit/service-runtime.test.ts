import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BakErrorCode } from '@flrande/bak-protocol';
import type { PairingStore } from '../../packages/cli/src/pairing-store.js';
import { BakService } from '../../packages/cli/src/service-runtime.js';
import type { TraceStore } from '../../packages/cli/src/trace-store.js';
import type {
  BrowserTab,
  DriverConnectionStatus,
  SessionBindingEnsureResult,
  SessionBindingListTabsResult,
  SessionBindingOpenTabResult
} from '../../packages/cli/src/drivers/browser-driver.js';
import { BridgeError } from '../../packages/cli/src/drivers/extension-bridge.js';
import { StubDriver } from '../../packages/cli/src/drivers/stub-drivers.js';

class FakeDriver extends StubDriver {
  nextTabId = 303;
  sessionBindingEnsureCalls = 0;
  sessionBindingInfoCalls = 0;
  sessionBindingListTabsCalls = 0;
  sessionBindingCloseCalls = 0;
  sessionBindingCloseTabCalls = 0;
  pageTitleCalls = 0;
  pageSnapshotCalls = 0;
  closeTabHook: ((closedTabId: number) => void | Promise<void>) | null = null;
  rawRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  bindingLabels: string[] = [];
  replayEntry: { method: string; url: string } = {
    method: 'POST',
    url: 'https://api.example.test/orders'
  };
  bindingExists = true;
  contextSetBehaviors: Array<'success' | 'stale-not-found' | 'timeout'> = [];
  browser: SessionBindingEnsureResult['browser'] = {
    windowId: 1,
    groupId: 2,
    tabIds: [101, 202],
    activeTabId: 101,
    primaryTabId: 101,
    tabs: [
      {
        id: 101,
        title: 'First',
        url: 'https://example.test/first',
        active: true,
        windowId: 1,
        groupId: 2
      },
      {
        id: 202,
        title: 'Second',
        url: 'https://example.test/second',
        active: false,
        windowId: 1,
        groupId: 2
      }
    ]
  };

  isConnected(): boolean {
    return true;
  }

  connectionStatus(): DriverConnectionStatus {
    return {
      state: 'connected',
      reason: null,
      extensionVersion: 'test',
      lastSeenTs: Date.now(),
      lastRequestTs: Date.now(),
      lastResponseTs: Date.now(),
      lastHeartbeatTs: Date.now(),
      lastError: null,
      connectedAtTs: Date.now(),
      disconnectedAtTs: null,
      pendingRequests: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      totalNotReady: 0
    };
  }

  async sessionBindingEnsure(params: { label?: string } = {}): Promise<SessionBindingEnsureResult> {
    this.sessionBindingEnsureCalls += 1;
    this.bindingExists = true;
    if (typeof params.label === 'string') {
      this.bindingLabels.push(params.label);
    }
    return {
      browser: this.cloneBrowser(),
      created: false,
      repaired: false,
      repairActions: []
    };
  }

  async sessionBindingInfo(): Promise<{ browser: SessionBindingEnsureResult['browser'] | null }> {
    this.sessionBindingInfoCalls += 1;
    return {
      browser: this.bindingExists ? this.cloneBrowser() : null
    };
  }

  async sessionBindingListTabs(params: { bindingId?: string } = {}): Promise<SessionBindingListTabsResult> {
    this.sessionBindingListTabsCalls += 1;
    if (!this.bindingExists) {
      throw new BridgeError('E_NOT_FOUND', `Binding ${params.bindingId ?? 'unknown'} does not exist`);
    }
    return {
      browser: this.cloneBrowser(),
      tabs: this.cloneTabs()
    };
  }

  async sessionBindingOpenTab(params: { bindingId?: string; url?: string; active?: boolean }): Promise<SessionBindingOpenTabResult> {
    const tab: BrowserTab = {
      id: this.nextTabId++,
      title: params.url ?? 'about:blank',
      url: params.url ?? 'about:blank',
      active: params.active === true,
      windowId: this.browser.windowId ?? 1,
      groupId: this.browser.groupId
    };
    if (params.active === true) {
      this.browser.activeTabId = tab.id;
      this.browser.tabs = this.browser.tabs.map((candidate) => ({
        ...candidate,
        active: false
      }));
    }
    this.browser.tabIds = [...this.browser.tabIds, tab.id];
    this.browser.tabs = [...this.browser.tabs, tab];
    return {
      browser: this.cloneBrowser(),
      tab: { ...tab }
    };
  }

  async sessionBindingCloseTab(params: { bindingId?: string; tabId?: number }): Promise<{ browser: SessionBindingEnsureResult['browser'] | null; closedTabId: number }> {
    this.sessionBindingCloseTabCalls += 1;
    const resolvedTabId = typeof params.tabId === 'number' ? params.tabId : this.browser.activeTabId ?? this.browser.tabIds[0];
    if (typeof resolvedTabId !== 'number') {
      throw new BridgeError('E_NOT_FOUND', `Binding ${params.bindingId ?? 'unknown'} has no tabs`);
    }
    const remainingTabs = this.browser.tabs.filter((candidate) => candidate.id !== resolvedTabId);
    this.browser.tabs = remainingTabs.map((candidate, index) => ({
      ...candidate,
      active: index === 0
    }));
    this.browser.tabIds = this.browser.tabs.map((candidate) => candidate.id);
    this.browser.activeTabId = this.browser.tabs[0]?.id ?? null;
    this.browser.primaryTabId = this.browser.tabs[0]?.id ?? null;
    if (this.browser.tabs.length === 0) {
      this.bindingExists = false;
      this.browser.windowId = null;
      this.browser.groupId = null;
      await this.closeTabHook?.(resolvedTabId);
      return {
        browser: {
          windowId: null,
          groupId: null,
          tabIds: [],
          activeTabId: null,
          primaryTabId: null,
          tabs: []
        },
        closedTabId: resolvedTabId
      };
    }
    await this.closeTabHook?.(resolvedTabId);
    return {
      browser: this.cloneBrowser(),
      closedTabId: resolvedTabId
    };
  }

  async sessionBindingClose(): Promise<{ ok: true }> {
    this.sessionBindingCloseCalls += 1;
    this.bindingExists = false;
    this.browser = {
      windowId: null,
      groupId: null,
      tabIds: [],
      activeTabId: null,
      primaryTabId: null,
      tabs: []
    };
    return { ok: true };
  }

  async sessionBindingSetActiveTab(params: { bindingId?: string; tabId: number }): Promise<SessionBindingOpenTabResult> {
    const tab = this.browser.tabs.find((candidate) => candidate.id === params.tabId);
    if (!tab) {
      throw new BridgeError('E_NOT_FOUND', `Tab ${params.tabId} does not belong to binding ${params.bindingId ?? 'unknown'}`);
    }
    this.browser.activeTabId = tab.id;
    this.browser.tabs = this.browser.tabs.map((candidate) => ({
      ...candidate,
      active: candidate.id === tab.id
    }));
    return {
      browser: this.cloneBrowser(),
      tab: { ...tab, active: true }
    };
  }

  async rawRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.rawRequests.push({ method, params });
    if (method === 'context.set') {
      const behavior = this.contextSetBehaviors.shift() ?? 'success';
      if (behavior === 'stale-not-found') {
        throw new BridgeError('E_NOT_FOUND', 'frame not found: #frame-b');
      }
      if (behavior === 'timeout') {
        throw new BridgeError('E_TIMEOUT', 'timeout waiting response for context.set');
      }
      return {
        framePath: Array.isArray(params?.framePath) ? params.framePath : [],
        shadowPath: Array.isArray(params?.shadowPath) ? params.shadowPath : []
      };
    }
    if (method === 'page.url') {
      return { url: 'https://example.test/frame' };
    }
    if (method === 'page.title') {
      this.pageTitleCalls += 1;
      return { title: 'Example title' };
    }
    if (method === 'page.fetch') {
      return {
        scope: 'current',
        result: {
          url: 'https://example.test/frame',
          framePath: [],
          value: {
            url: typeof params?.url === 'string' ? params.url : 'https://api.example.test/orders',
            status: 200,
            ok: true,
            headers: {},
            bodyText: '{}',
            bytes: 2,
            truncated: false
          }
        }
      };
    }
    if (method === 'network.get') {
      return {
        entry: {
          id: typeof params?.id === 'string' ? params.id : 'req_1',
          url: this.replayEntry.url,
          method: this.replayEntry.method
        }
      };
    }
    if (method === 'network.replay') {
      return {
        url: this.replayEntry.url,
        status: 200,
        ok: true,
        headers: {},
        bodyText: '{}',
        bytes: 2,
        truncated: false
      };
    }
    if (method === 'debug.dumpState') {
      return {
        url: 'https://example.test/frame',
        title: 'Frame Title',
        context: {
          framePath: ['#frame-a'],
          shadowPath: ['#shadow-a']
        },
        dom: {
          title: 'Frame Title',
          url: 'https://example.test/frame',
          forms: [],
          tables: [],
          landmarks: [],
          dialogs: [],
          iframes: []
        },
        text: [],
        elements: [],
        metrics: {
          readyState: 'complete',
          scrollX: 0,
          scrollY: 0,
          innerWidth: 1280,
          innerHeight: 720,
          documentWidth: 1280,
          documentHeight: 720
        },
        viewport: {
          width: 1280,
          height: 720,
          devicePixelRatio: 1
        },
        console: [],
        network: []
      };
    }
    throw new Error(`Unexpected rawRequest: ${method}`);
  }

  async pageSnapshot(tabId?: number): Promise<{ imageBase64: string; elements: Array<{ eid: string; tag: string; name: string; text: string; bbox: { x: number; y: number; width: number; height: number }; selectors: { css: string | null; text: string | null; aria: string | null }; risk: 'low' | 'high'; role: string | null }>; tabId: number; url: string }> {
    this.pageSnapshotCalls += 1;
    return {
      imageBase64: Buffer.from('fake-image', 'utf8').toString('base64'),
      elements: [
        {
          eid: 'el-1',
          tag: 'button',
          role: 'button',
          name: 'Save',
          text: 'Save',
          bbox: { x: 1, y: 2, width: 3, height: 4 },
          selectors: {
            css: '#save',
            text: 'Save',
            aria: 'button "Save"'
          },
          risk: 'low'
        }
      ],
      tabId: tabId ?? 101,
      url: 'https://example.test/frame'
    };
  }

  private cloneBrowser(): SessionBindingEnsureResult['browser'] {
    return {
      ...this.browser,
      tabIds: [...this.browser.tabIds],
      tabs: this.cloneTabs()
    };
  }

  private cloneTabs(): BrowserTab[] {
    return this.browser.tabs.map((tab) => ({ ...tab }));
  }
}

const tempRoots: string[] = [];
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.BAK_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'bak-service-runtime-'));
  tempRoots.push(root);
  process.env.BAK_DATA_DIR = root;
});

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (previousDataDir === undefined) {
    delete process.env.BAK_DATA_DIR;
  } else {
    process.env.BAK_DATA_DIR = previousDataDir;
  }
});

function createService(
  driver: FakeDriver,
  options: { managedRuntime?: boolean; onManagedIdle?: () => void | Promise<void> } = {}
): BakService {
  const pairingStore = {
    getToken: () => 'pair-token'
  } as PairingStore;
  let traceCounter = 0;
  const traceStore = {
    newTraceId: () => `trace-${++traceCounter}`,
    append: () => undefined
  } as unknown as TraceStore;
  return new BakService(driver, pairingStore, traceStore, options);
}

async function waitForAsyncTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('service runtime session bindings', () => {
  it('resolves a client name to a unique live session and reuses it on later calls', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const first = await service.invoke('session.resolve', { clientName: 'agent-a' });
    const second = await service.invoke('session.resolve', { clientName: 'agent-a' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('rejects session.resolve when multiple live sessions share the same client name', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    await service.invoke('session.create', { clientName: 'agent-a' });
    await service.invoke('session.create', { clientName: 'agent-a' });

    await expect(service.invoke('session.resolve', { clientName: 'agent-a' })).rejects.toMatchObject({
      bakCode: BakErrorCode.E_INVALID_PARAMS
    });
  });

  it('auto-ensures the binding before session-scoped page reads', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: '019ce19b-abd1-7692-8a9a-478b4f078aa4' });
    const title = await service.invokeDynamic('page.title', { sessionId: created.sessionId });

    expect(title).toEqual({ title: 'Example title' });
    expect(driver.sessionBindingEnsureCalls).toBe(1);
    expect(driver.bindingLabels).toContain('bak 019ce19b');
  });

  it('uses session binding tab listing instead of binding info for session tab reads', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    const tabs = await service.invoke('session.listTabs', { sessionId: created.sessionId });
    const active = await service.invoke('session.getActiveTab', { sessionId: created.sessionId });

    expect(tabs.tabs.map((tab) => tab.id)).toEqual([101, 202]);
    expect(active.tab?.id).toBe(101);
    expect(driver.sessionBindingListTabsCalls).toBeGreaterThanOrEqual(2);
    expect(driver.sessionBindingInfoCalls).toBe(0);
  });

  it('refreshes lastSeenAt for static session commands', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    const listed = await service.invoke('session.list', {});

    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.lastSeenAt).not.toBe(created.createdAt);
    expect(Date.parse(listed.sessions[0]!.lastSeenAt)).toBeGreaterThan(Date.parse(created.createdAt));
  });

  it('repairs the session on demand after the binding disappears', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    driver.contextSetBehaviors = ['success'];
    await service.invokeDynamic('context.set', {
      sessionId: created.sessionId,
      framePath: ['#frame-a'],
      shadowPath: ['#shadow-a']
    });

    driver.bindingExists = false;

    const tabs = await service.invoke('session.listTabs', { sessionId: created.sessionId });
    const info = await service.invoke('session.info', { sessionId: created.sessionId });

    expect(tabs).toEqual({
      browser: null,
      tabs: []
    });
    expect(info.activeTab).toBeNull();
    expect(info.currentContext).toEqual({
      tabId: null,
      framePath: [],
      shadowPath: []
    });

    await expect(service.invokeDynamic('page.title', { sessionId: created.sessionId })).resolves.toEqual({
      title: 'Example title'
    });
    expect(driver.pageTitleCalls).toBe(1);
    expect(driver.sessionBindingEnsureCalls).toBeGreaterThanOrEqual(2);
  });

  it('keeps session.setActiveTab successful even when restoring a stale context fails', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    driver.contextSetBehaviors = ['success', 'stale-not-found'];
    await service.invokeDynamic('context.set', {
      sessionId: created.sessionId,
      tabId: 202,
      framePath: ['#frame-b'],
      shadowPath: ['#shadow-b']
    });

    const switched = await service.invoke('session.setActiveTab', {
      sessionId: created.sessionId,
      tabId: 202
    });
    const info = await service.invoke('session.info', { sessionId: created.sessionId });

    expect(switched.tab.id).toBe(202);
    expect(info.activeTab?.id).toBe(202);
    expect(info.currentContext).toEqual({
      tabId: 202,
      framePath: [],
      shadowPath: []
    });
  });

  it('uses the opened tab as the session current tab when session.openTab is explicit about activation', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });

    const opened = await service.invoke('session.openTab', {
      sessionId: created.sessionId,
      url: 'https://example.test/third',
      active: true
    });
    const active = await service.invoke('session.getActiveTab', { sessionId: created.sessionId });
    await service.invokeDynamic('page.title', { sessionId: created.sessionId });

    expect(opened.browser.activeTabId).toBe(opened.tab.id);
    expect(active.tab?.id).toBe(opened.tab.id);
    expect(driver.rawRequests.at(-1)).toMatchObject({
      method: 'page.title',
      params: { tabId: opened.tab.id }
    });
  });

  it('keeps the previous session current tab when session.openTab creates a background tab', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });

    const opened = await service.invoke('session.openTab', {
      sessionId: created.sessionId,
      url: 'https://example.test/background',
      active: false
    });
    const active = await service.invoke('session.getActiveTab', { sessionId: created.sessionId });

    expect(opened.browser.activeTabId).toBe(101);
    expect(active.tab?.id).toBe(101);
    expect(opened.tab.id).not.toBe(101);
  });

  it('surfaces transport failures while restoring context during session.setActiveTab', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    driver.contextSetBehaviors = ['success', 'timeout'];
    await service.invokeDynamic('context.set', {
      sessionId: created.sessionId,
      tabId: 202,
      framePath: ['#frame-b'],
      shadowPath: ['#shadow-b']
    });

    await expect(
      service.invoke('session.setActiveTab', {
        sessionId: created.sessionId,
        tabId: 202
      })
    ).rejects.toMatchObject({
      bakCode: BakErrorCode.E_TIMEOUT
    });
  });

  it('attaches a persisted snapshot when debug.dumpState requests one', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    const dump = await service.invokeDynamic('debug.dumpState', {
      sessionId: created.sessionId,
      includeSnapshot: true
    });

    expect(driver.pageSnapshotCalls).toBe(1);
    expect(dump.snapshot).toBeDefined();
    expect(existsSync(dump.snapshot!.imagePath)).toBe(true);
    expect(existsSync(dump.snapshot!.elementsPath)).toBe(true);
    expect(Array.isArray(dump.snapshot!.refs)).toBe(true);
    expect(dump.snapshot!.refs?.[0]).toMatchObject({
      ref: '@e1',
      eid: 'el-1',
      actionability: 'click'
    });
    expect(dump.snapshot!.actionSummary?.clickable[0]).toMatchObject({
      ref: '@e1',
      eid: 'el-1'
    });
    expect(dump.snapshot!.imageBase64).toBeUndefined();
    expect(JSON.parse(readFileSync(dump.snapshot!.elementsPath, 'utf8'))).toHaveLength(1);
  });

  it('adds annotated snapshot output and structured diffs for page.snapshot', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });

    const previousElementsPath = join(process.env.BAK_DATA_DIR!, 'previous-elements.json');
    writeFileSync(
      previousElementsPath,
      `${JSON.stringify(
        [
          {
            eid: 'el-previous',
            tag: 'button',
            role: 'button',
            name: 'Save draft',
            text: 'Save draft',
            bbox: { x: 25, y: 48, width: 24, height: 24 },
            selectors: {
              css: '#save',
              xpath: null,
              text: 'Save draft',
              aria: 'button "Save draft"'
            },
            risk: 'low'
          }
        ],
        null,
        2
      )}\n`,
      'utf8'
    );
    const previousSnapshotPath = join(process.env.BAK_DATA_DIR!, 'previous-snapshot.json');
    writeFileSync(
      previousSnapshotPath,
      `${JSON.stringify(
        {
          elementsPath: previousElementsPath
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const snapshot = await service.invoke('page.snapshot', {
      sessionId: created.sessionId,
      includeBase64: true,
      annotate: true,
      diffWith: previousSnapshotPath
    });

    expect(existsSync(snapshot.imagePath)).toBe(true);
    expect(existsSync(snapshot.annotatedImagePath!)).toBe(true);
    expect(snapshot.imageBase64).toBeTruthy();
    expect(snapshot.annotatedImageBase64).toBeTruthy();
    expect(snapshot.refs?.[0]).toMatchObject({
      ref: '@e1',
      eid: 'el-1',
      actionability: 'click'
    });
    expect(snapshot.actionSummary?.recommendedNextActions[0]?.summary).toContain('@e1');
    expect(snapshot.diff?.comparedTo).toContain('previous-elements.json');
    expect(snapshot.diff?.summary.changed).toBe(1);
    expect(snapshot.diff?.changedRefs[0]?.changes).toEqual(expect.arrayContaining(['name', 'text', 'bbox']));
  });

  it('requires explicit confirmation for mutating page.fetch requests', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });

    await expect(
      service.invokeDynamic('page.fetch', {
        sessionId: created.sessionId,
        url: 'https://api.example.test/orders',
        method: 'POST'
      })
    ).rejects.toMatchObject({
      bakCode: BakErrorCode.E_NEED_USER_CONFIRM
    });
    expect(driver.rawRequests.filter((entry) => entry.method === 'page.fetch')).toHaveLength(0);

    await expect(
      service.invokeDynamic('page.fetch', {
        sessionId: created.sessionId,
        url: 'https://api.example.test/orders',
        method: 'POST',
        requiresConfirm: true
      })
    ).resolves.toMatchObject({
      scope: 'current'
    });
    expect(driver.rawRequests.filter((entry) => entry.method === 'page.fetch')).toHaveLength(1);
  });

  it('requires explicit confirmation for mutating network replays', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });

    await expect(
      service.invokeDynamic('network.replay', {
        sessionId: created.sessionId,
        id: 'req_1'
      })
    ).rejects.toMatchObject({
      bakCode: BakErrorCode.E_NEED_USER_CONFIRM
    });
    expect(driver.rawRequests.filter((entry) => entry.method === 'network.replay')).toHaveLength(0);

    await expect(
      service.invokeDynamic('network.replay', {
        sessionId: created.sessionId,
        id: 'req_1',
        requiresConfirm: true
      })
    ).resolves.toMatchObject({
      ok: true
    });
    expect(driver.rawRequests.filter((entry) => entry.method === 'network.replay')).toHaveLength(1);
  });

  it('closes the session after the last tab closes and only then triggers managed idle stop', async () => {
    const driver = new FakeDriver();
    driver.browser = {
      windowId: 1,
      groupId: 2,
      tabIds: [101],
      activeTabId: 101,
      primaryTabId: 101,
      tabs: [
        {
          id: 101,
          title: 'Only',
          url: 'https://example.test/only',
          active: true,
          windowId: 1,
          groupId: 2
        }
      ]
    };
    const onManagedIdle = vi.fn();
    const service = createService(driver, {
      managedRuntime: true,
      onManagedIdle
    });

    const created = await service.invoke('session.create', { clientName: 'agent-a' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });

    const closed = await service.invoke('session.closeTab', { sessionId: created.sessionId, tabId: 101 });
    await waitForAsyncTurn();

    expect(closed).toEqual({
      closed: true,
      closedTabId: 101,
      sessionClosed: true,
      browser: null
    });
    await expect(service.invoke('session.info', { sessionId: created.sessionId })).rejects.toMatchObject({
      bakCode: BakErrorCode.E_NOT_FOUND
    });
    expect(onManagedIdle).toHaveBeenCalledTimes(1);
    expect(driver.sessionBindingCloseCalls).toBe(0);
  });

  it('does not trigger managed idle stop until an in-flight close-tab request has returned', async () => {
    const driver = new FakeDriver();
    driver.browser = {
      windowId: 1,
      groupId: 2,
      tabIds: [101],
      activeTabId: 101,
      primaryTabId: 101,
      tabs: [
        {
          id: 101,
          title: 'Only',
          url: 'https://example.test/only',
          active: true,
          windowId: 1,
          groupId: 2
        }
      ]
    };
    const onManagedIdle = vi.fn();
    const service = createService(driver, {
      managedRuntime: true,
      onManagedIdle
    });

    const created = await service.invoke('session.create', { clientName: 'agent-a' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    driver.closeTabHook = async (closedTabId) => {
      service.handleBridgeEvent({
        event: 'sessionBinding.updated',
        data: {
          bindingId: created.sessionId,
          reason: 'tab-removed',
          browser: null,
          closedTabId
        }
      });
      await waitForAsyncTurn();
      expect(onManagedIdle).not.toHaveBeenCalled();
    };

    const closed = await service.invoke('session.closeTab', { sessionId: created.sessionId, tabId: 101 });
    expect(closed).toEqual({
      closed: true,
      closedTabId: 101,
      sessionClosed: true,
      browser: null
    });

    await waitForAsyncTurn();
    expect(onManagedIdle).toHaveBeenCalledTimes(1);
  });

  it('does not trigger managed idle stop before any session has existed', async () => {
    const driver = new FakeDriver();
    const onManagedIdle = vi.fn();
    const service = createService(driver, {
      managedRuntime: true,
      onManagedIdle
    });

    service.handleBridgeEvent({
      event: 'sessionBinding.updated',
      data: {
        bindingId: 'missing-session',
        reason: 'window-removed',
        browser: {
          windowId: null,
          groupId: null,
          tabIds: [],
          activeTabId: null,
          primaryTabId: null
        }
      }
    });
    await waitForAsyncTurn();

    expect(onManagedIdle).not.toHaveBeenCalled();
  });

  it('closes the session from a binding update without issuing a second binding close', async () => {
    const driver = new FakeDriver();
    const onManagedIdle = vi.fn();
    const service = createService(driver, {
      managedRuntime: true,
      onManagedIdle
    });

    const created = await service.invoke('session.create', { clientName: 'agent-a' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });

    service.handleBridgeEvent({
      event: 'sessionBinding.updated',
      data: {
        bindingId: created.sessionId,
        reason: 'tab-removed',
        browser: null,
        closedTabId: 101
      }
    });
    await waitForAsyncTurn();

    await expect(service.invoke('session.info', { sessionId: created.sessionId })).rejects.toMatchObject({
      bakCode: BakErrorCode.E_NOT_FOUND
    });
    expect(driver.sessionBindingCloseCalls).toBe(0);
    expect(onManagedIdle).toHaveBeenCalledTimes(1);
  });
});
