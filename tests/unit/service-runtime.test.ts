import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  workspaceInfoCalls = 0;
  workspaceListTabsCalls = 0;
  pageTitleCalls = 0;
  bindingExists = true;
  contextSetBehaviors: Array<'success' | 'stale-not-found' | 'timeout'> = [];
  workspace: SessionBindingEnsureResult['workspace'] = {
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

  async workspaceEnsure(): Promise<SessionBindingEnsureResult> {
    this.bindingExists = true;
    return {
      workspace: this.cloneWorkspace(),
      created: false,
      repaired: false,
      repairActions: []
    };
  }

  async workspaceInfo(): Promise<{ workspace: SessionBindingEnsureResult['workspace'] | null }> {
    this.workspaceInfoCalls += 1;
    return {
      workspace: this.bindingExists ? this.cloneWorkspace() : null
    };
  }

  async workspaceListTabs(params: { workspaceId?: string } = {}): Promise<SessionBindingListTabsResult> {
    this.workspaceListTabsCalls += 1;
    if (!this.bindingExists) {
      throw new BridgeError('E_NOT_FOUND', `Workspace ${params.workspaceId ?? 'unknown'} does not exist`);
    }
    return {
      workspace: this.cloneWorkspace(),
      tabs: this.cloneTabs()
    };
  }

  async workspaceSetActiveTab(params: { workspaceId?: string; tabId: number }): Promise<SessionBindingOpenTabResult> {
    const tab = this.workspace.tabs.find((candidate) => candidate.id === params.tabId);
    if (!tab) {
      throw new BridgeError('E_NOT_FOUND', `Tab ${params.tabId} does not belong to workspace ${params.workspaceId ?? 'unknown'}`);
    }
    this.workspace.activeTabId = tab.id;
    this.workspace.tabs = this.workspace.tabs.map((candidate) => ({
      ...candidate,
      active: candidate.id === tab.id
    }));
    return {
      workspace: this.cloneWorkspace(),
      tab: { ...tab, active: true }
    };
  }

  async rawRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
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
    if (method === 'page.title') {
      this.pageTitleCalls += 1;
      return { title: 'Example title' };
    }
    throw new Error(`Unexpected rawRequest: ${method}`);
  }

  private cloneWorkspace(): SessionBindingEnsureResult['workspace'] {
    return {
      ...this.workspace,
      tabIds: [...this.workspace.tabIds],
      tabs: this.cloneTabs()
    };
  }

  private cloneTabs(): BrowserTab[] {
    return this.workspace.tabs.map((tab) => ({ ...tab }));
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

function createService(driver: FakeDriver): BakService {
  const pairingStore = {
    getToken: () => 'pair-token'
  } as PairingStore;
  let traceCounter = 0;
  const traceStore = {
    newTraceId: () => `trace-${++traceCounter}`,
    append: () => undefined
  } as unknown as TraceStore;
  return new BakService(driver, pairingStore, traceStore);
}

describe('service runtime session bindings', () => {
  it('uses workspace.listTabs instead of workspace.info for session tab reads', async () => {
    const driver = new FakeDriver();
    const service = createService(driver);

    const created = await service.invoke('session.create', { clientName: 'test-client' });
    await service.invoke('session.ensure', { sessionId: created.sessionId });
    const tabs = await service.invoke('session.listTabs', { sessionId: created.sessionId });
    const active = await service.invoke('session.getActiveTab', { sessionId: created.sessionId });

    expect(tabs.tabs.map((tab) => tab.id)).toEqual([101, 202]);
    expect(active.tab?.id).toBe(101);
    expect(driver.workspaceListTabsCalls).toBeGreaterThanOrEqual(2);
    expect(driver.workspaceInfoCalls).toBe(0);
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

  it('clears stale session state after the binding disappears', async () => {
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

    await expect(service.invokeDynamic('page.title', { sessionId: created.sessionId })).rejects.toMatchObject({
      message: 'Session has no active tab',
      bakCode: BakErrorCode.E_NOT_FOUND
    });
    expect(driver.pageTitleCalls).toBe(0);
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
});
