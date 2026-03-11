import { describe, expect, it } from 'vitest';
import {
  WorkspaceManager,
  type WorkspaceBrowser,
  type WorkspaceColor,
  type WorkspaceRecord,
  type WorkspaceStorage,
  type WorkspaceTab,
  type WorkspaceWindow
} from '../../packages/extension/src/workspace.js';

const WORKSPACE_ID = 'workspace-agent-a';
const WORKSPACE_ID_B = 'workspace-agent-b';

function cloneRecord(state: WorkspaceRecord | null): WorkspaceRecord | null {
  return state ? { ...state, tabIds: [...state.tabIds] } : null;
}

class MemoryStorage implements WorkspaceStorage {
  readonly states = new Map<string, WorkspaceRecord>();

  async load(workspaceId: string): Promise<WorkspaceRecord | null> {
    return cloneRecord(this.states.get(workspaceId) ?? null);
  }

  async save(state: WorkspaceRecord): Promise<void> {
    this.states.set(state.id, cloneRecord(state)!);
  }

  async delete(workspaceId: string): Promise<void> {
    this.states.delete(workspaceId);
  }

  async list(): Promise<WorkspaceRecord[]> {
    return [...this.states.values()].map((state) => cloneRecord(state)!).filter(Boolean);
  }
}

class FakeBrowser implements WorkspaceBrowser {
  private nextTabId = 10;
  private nextWindowId = 20;
  private nextGroupId = 30;
  readonly tabs = new Map<number, WorkspaceTab>();
  readonly windows = new Map<number, WorkspaceWindow>();
  readonly groups = new Map<number, { id: number; windowId: number; title: string; color: WorkspaceColor; collapsed: boolean }>();
  activeTabId: number | null = null;
  readonly transientWindowMisses = new Map<number, number>();

  async getTab(tabId: number): Promise<WorkspaceTab | null> {
    return this.tabs.get(tabId) ?? null;
  }

  async getActiveTab(): Promise<WorkspaceTab | null> {
    return this.activeTabId !== null ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  async listTabs(filter?: { windowId?: number }): Promise<WorkspaceTab[]> {
    return [...this.tabs.values()].filter((tab) => (filter?.windowId ? tab.windowId === filter.windowId : true));
  }

  async createTab(options: { windowId?: number; url?: string; active?: boolean }): Promise<WorkspaceTab> {
    const windowId = options.windowId ?? (await this.createWindow({ focused: false })).id;
    const tab: WorkspaceTab = {
      id: this.nextTabId++,
      title: options.url ?? 'about:blank',
      url: options.url ?? 'about:blank',
      active: options.active !== false,
      windowId,
      groupId: null
    };
    this.tabs.set(tab.id, tab);
    if (tab.active) {
      this.activeTabId = tab.id;
      for (const item of this.tabs.values()) {
        if (item.windowId === windowId && item.id !== tab.id) {
          item.active = false;
        }
      }
    }
    return tab;
  }

  async updateTab(tabId: number, options: { active?: boolean; url?: string }): Promise<WorkspaceTab> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`missing tab ${tabId}`);
    }
    if (typeof options.url === 'string') {
      tab.url = options.url;
      tab.title = options.url;
    }
    if (options.active === true) {
      for (const item of this.tabs.values()) {
        if (item.windowId === tab.windowId) {
          item.active = item.id === tabId;
        }
      }
      this.activeTabId = tabId;
    }
    return tab;
  }

  async closeTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    this.tabs.delete(tabId);
    if (![...this.tabs.values()].some((item) => item.windowId === tab.windowId)) {
      this.windows.delete(tab.windowId);
      for (const [groupId, group] of this.groups.entries()) {
        if (group.windowId === tab.windowId) {
          this.groups.delete(groupId);
        }
      }
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
  }

  async getWindow(windowId: number): Promise<WorkspaceWindow | null> {
    const remainingMisses = this.transientWindowMisses.get(windowId) ?? 0;
    if (remainingMisses > 0) {
      this.transientWindowMisses.set(windowId, remainingMisses - 1);
      return null;
    }
    return this.windows.get(windowId) ?? null;
  }

  failWindowLookups(windowId: number, count: number): void {
    this.transientWindowMisses.set(windowId, count);
  }

  async createWindow(options: { url?: string; focused?: boolean }): Promise<WorkspaceWindow> {
    const window: WorkspaceWindow = {
      id: this.nextWindowId++,
      focused: options.focused === true
    };
    this.windows.set(window.id, window);
    await this.createTab({ windowId: window.id, url: options.url, active: true });
    return window;
  }

  async updateWindow(windowId: number, options: { focused?: boolean }): Promise<WorkspaceWindow> {
    const window = this.windows.get(windowId);
    if (!window) {
      throw new Error(`missing window ${windowId}`);
    }
    if (typeof options.focused === 'boolean') {
      for (const item of this.windows.values()) {
        item.focused = false;
      }
      window.focused = options.focused;
    }
    return window;
  }

  async closeWindow(windowId: number): Promise<void> {
    this.windows.delete(windowId);
    for (const [tabId, tab] of this.tabs.entries()) {
      if (tab.windowId === windowId) {
        this.tabs.delete(tabId);
      }
    }
    for (const [groupId, group] of this.groups.entries()) {
      if (group.windowId === windowId) {
        this.groups.delete(groupId);
      }
    }
    if (this.activeTabId !== null && !this.tabs.has(this.activeTabId)) {
      this.activeTabId = null;
    }
  }

  async getGroup(groupId: number): Promise<{ id: number; windowId: number; title: string; color: WorkspaceColor; collapsed: boolean } | null> {
    return this.groups.get(groupId) ?? null;
  }

  async groupTabs(tabIds: number[], groupId?: number): Promise<number> {
    const firstTab = this.tabs.get(tabIds[0]!);
    if (!firstTab) {
      throw new Error('Cannot group missing tabs');
    }
    const resolvedGroupId = groupId ?? this.nextGroupId++;
    const current = this.groups.get(resolvedGroupId) ?? {
      id: resolvedGroupId,
      windowId: firstTab.windowId,
      title: '',
      color: 'blue' as WorkspaceColor,
      collapsed: false
    };
    this.groups.set(resolvedGroupId, current);
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId);
      if (tab) {
        tab.groupId = resolvedGroupId;
      }
    }
    return resolvedGroupId;
  }

  async updateGroup(
    groupId: number,
    options: { title?: string; color?: WorkspaceColor; collapsed?: boolean }
  ): Promise<{ id: number; windowId: number; title: string; color: WorkspaceColor; collapsed: boolean }> {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`missing group ${groupId}`);
    }
    if (typeof options.title === 'string') {
      group.title = options.title;
    }
    if (typeof options.color === 'string') {
      group.color = options.color;
    }
    if (typeof options.collapsed === 'boolean') {
      group.collapsed = options.collapsed;
    }
    return group;
  }
}

async function createManager(
  seed?: (browser: FakeBrowser, storage: MemoryStorage) => Promise<void> | void
): Promise<{ browser: FakeBrowser; storage: MemoryStorage; manager: WorkspaceManager }> {
  const browser = new FakeBrowser();
  const storage = new MemoryStorage();
  await seed?.(browser, storage);
  const manager = new WorkspaceManager(storage, browser);
  return { browser, storage, manager };
}

describe('workspace manager', () => {
  it('creates a dedicated window, group, and primary tab on ensure', async () => {
    const { manager } = await createManager();

    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });

    expect(ensured.workspace.id).toBe(WORKSPACE_ID);
    expect(ensured.workspace.windowId).not.toBeNull();
    expect(ensured.workspace.groupId).not.toBeNull();
    expect(ensured.workspace.primaryTabId).not.toBeNull();
    expect(ensured.workspace.activeTabId).toBe(ensured.workspace.primaryTabId);
    expect(ensured.workspace.tabs).toHaveLength(1);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['created-window', 'recreated-group']));
  });

  it('falls back to the browser active tab without creating a workspace when none exists', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser) => {
      const humanWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === humanWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;
    });
    void browser;

    const resolved = await manager.resolveTarget({});

    expect(resolved.resolution).toBe('browser-active');
    expect(resolved.tab.url).toContain('human.local');
    expect(resolved.createdWorkspace).toBe(false);
    await expect(storage.load(WORKSPACE_ID)).resolves.toBeNull();
  });

  it('resolves explicit workspace targets and leaves implicit routing on the browser active tab', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const humanWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === humanWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;

      const workspaceWindow = await seedBrowser.createWindow({ url: 'https://workspace.local', focused: false });
      const workspaceTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === workspaceWindow.id)!;
      const groupId = await seedBrowser.groupTabs([workspaceTab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      seedBrowser.activeTabId = humanTab.id;
      await seedStorage.save({
        id: WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: workspaceWindow.id,
        groupId,
        tabIds: [workspaceTab.id],
        activeTabId: workspaceTab.id,
        primaryTabId: workspaceTab.id
      });
    });
    const humanTabId = browser.activeTabId;
    const workspaceTabId = (await storage.load(WORKSPACE_ID))?.activeTabId;

    const explicitTab = await manager.resolveTarget({ tabId: humanTabId! });
    expect(explicitTab.resolution).toBe('explicit-tab');
    expect(explicitTab.tab.id).toBe(humanTabId);

    const withWorkspace = await manager.resolveTarget({ workspaceId: WORKSPACE_ID });
    expect(withWorkspace.resolution).toBe('explicit-workspace');
    expect(withWorkspace.tab.id).toBe(workspaceTabId);

    const implicitTarget = await manager.resolveTarget({});
    expect(implicitTarget.resolution).toBe('browser-active');
    expect(implicitTarget.tab.id).toBe(humanTabId);
  });

  it('creates the workspace when an explicit workspace id is requested', async () => {
    const { storage, manager } = await createManager(async (seedBrowser) => {
      const humanWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === humanWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;
    });

    const resolved = await manager.resolveTarget({ workspaceId: WORKSPACE_ID });

    expect(resolved.resolution).toBe('explicit-workspace');
    expect(resolved.createdWorkspace).toBe(true);
    expect(resolved.workspace?.windowId).not.toBeNull();
    expect((await storage.load(WORKSPACE_ID))?.id).toBe(WORKSPACE_ID);
  });

  it('getActiveTab and setActiveTab update the workspace current tab', async () => {
    const { manager } = await createManager();
    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });
    const firstTabId = ensured.workspace.primaryTabId!;
    const second = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/second', active: false, focus: false });

    const initiallyActive = await manager.getActiveTab(WORKSPACE_ID);
    expect(initiallyActive.tab?.id).toBe(second.tab.id);

    const switched = await manager.setActiveTab(firstTabId, WORKSPACE_ID);
    expect(switched.tab.id).toBe(firstTabId);

    const resolved = await manager.resolveTarget({ workspaceId: WORKSPACE_ID });
    expect(resolved.resolution).toBe('explicit-workspace');
    expect(resolved.tab.id).toBe(firstTabId);
  });

  it('repairs a missing window without adopting unrelated tabs', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const unrelatedWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const unrelatedTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === unrelatedWindow.id)!;
      seedBrowser.activeTabId = unrelatedTab.id;
      await seedStorage.save({
        id: WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: 999,
        groupId: 777,
        tabIds: [555],
        activeTabId: 555,
        primaryTabId: 555
      });
    });
    void browser;

    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });

    expect(ensured.workspace.windowId).not.toBe(999);
    expect(ensured.workspace.tabIds).toHaveLength(1);
    expect(ensured.workspace.tabs[0]?.url).toBe('about:blank');
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recreated-window', 'recreated-group']));
  });

  it('recreates a missing group and regroups tracked tabs', async () => {
    const { manager } = await createManager(async (seedBrowser, seedStorage) => {
      const window = await seedBrowser.createWindow({ url: 'https://workspace.local', focused: false });
      const tab = [...seedBrowser.tabs.values()].find((item) => item.windowId === window.id)!;
      await seedStorage.save({
        id: WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: window.id,
        groupId: 1234,
        tabIds: [tab.id],
        activeTabId: tab.id,
        primaryTabId: tab.id
      });
    });

    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });

    expect(ensured.workspace.groupId).not.toBe(1234);
    expect(ensured.workspace.tabs[0]?.groupId).toBe(ensured.workspace.groupId);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recreated-group']));
  });

  it('recovers workspace tabs from the dedicated group when tracked tab ids are missing', async () => {
    const { manager } = await createManager(async (seedBrowser, seedStorage) => {
      const window = await seedBrowser.createWindow({ url: 'https://workspace.local', focused: false });
      const tab = [...seedBrowser.tabs.values()].find((item) => item.windowId === window.id)!;
      const groupId = await seedBrowser.groupTabs([tab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({
        id: WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: window.id,
        groupId,
        tabIds: [],
        activeTabId: null,
        primaryTabId: null
      });
    });

    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });

    expect(ensured.workspace.tabIds).toHaveLength(1);
    expect(ensured.workspace.tabs[0]?.groupId).toBe(ensured.workspace.groupId);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recovered-tracked-tabs', 'reassigned-primary-tab', 'reassigned-active-tab']));
  });

  it('opens new tabs inside the workspace window and group without changing human focus by default', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });
    const originalWindowId = ensured.workspace.windowId;
    const originalGroupId = ensured.workspace.groupId;

    const opened = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/next', active: false, focus: false });

    expect(opened.tab.windowId).toBe(originalWindowId);
    expect(opened.tab.groupId).toBe(originalGroupId);
    expect(opened.workspace.activeTabId).toBe(opened.tab.id);
    expect(browser.windows.get(originalWindowId!)?.focused).toBe(false);
  });

  it('reuses the initial workspace tab for the first open-tab request after creating the workspace', async () => {
    const { manager } = await createManager();

    const opened = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/first', active: false, focus: false });

    expect(opened.workspace.tabIds).toHaveLength(1);
    expect(opened.workspace.primaryTabId).toBe(opened.tab.id);
    expect(opened.tab.url).toBe('https://workspace.local/first');
  });

  it('reuses a lone blank primary tab after an explicit ensure instead of creating an extra blank tab', async () => {
    const { manager } = await createManager();
    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });

    const opened = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/after-ensure', active: false, focus: false });

    expect(ensured.workspace.tabIds).toHaveLength(1);
    expect(opened.workspace.tabIds).toHaveLength(1);
    expect(opened.workspace.primaryTabId).toBe(opened.tab.id);
    expect(opened.tab.url).toBe('https://workspace.local/after-ensure');
  });

  it('does not recreate the workspace while reading info or active tab', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });
    const originalWindowId = ensured.workspace.windowId;

    const info = await manager.getWorkspaceInfo(WORKSPACE_ID);
    const active = await manager.getActiveTab(WORKSPACE_ID);

    expect(info?.windowId).toBe(originalWindowId);
    expect(active.workspace.windowId).toBe(originalWindowId);
    expect(browser.windows.size).toBe(1);
    expect(info?.tabs).toHaveLength(1);
    expect(active.tab?.id).toBe(ensured.workspace.activeTabId);
  });

  it('does not recreate the workspace window when window lookup is temporarily unavailable', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });
    const originalWindowId = ensured.workspace.windowId!;
    browser.failWindowLookups(originalWindowId, 3);

    const opened = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/resilient', active: false, focus: false });

    expect(opened.workspace.windowId).toBe(originalWindowId);
    expect(browser.windows.size).toBe(1);
    expect(new Set(opened.workspace.tabs.map((tab) => tab.windowId))).toEqual(new Set([originalWindowId]));
  });

  it('rebinds the workspace to surviving tracked tabs before recreating a missing window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const workspaceWindow = await seedBrowser.createWindow({ url: 'https://workspace.local', focused: false });
      const workspaceTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === workspaceWindow.id)!;
      const groupId = await seedBrowser.groupTabs([workspaceTab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({
        id: WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: 999,
        groupId,
        tabIds: [workspaceTab.id],
        activeTabId: workspaceTab.id,
        primaryTabId: workspaceTab.id
      });
    });

    const ensured = await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });

    expect(ensured.workspace.windowId).toBe(ensured.workspace.tabs[0]?.windowId);
    expect(browser.windows.size).toBe(1);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['rebound-window']));
    expect(ensured.repairActions).not.toEqual(expect.arrayContaining(['recreated-window']));
  });

  it('openTab reuses the rebound workspace window instead of creating a duplicate blank window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const workspaceWindow = await seedBrowser.createWindow({ url: 'https://workspace.local', focused: false });
      const workspaceTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === workspaceWindow.id)!;
      const groupId = await seedBrowser.groupTabs([workspaceTab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({
        id: WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: 999,
        groupId,
        tabIds: [workspaceTab.id],
        activeTabId: workspaceTab.id,
        primaryTabId: workspaceTab.id
      });
    });

    const opened = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/next', active: false, focus: false });

    expect(browser.windows.size).toBe(1);
    expect(new Set(opened.workspace.tabs.map((tab) => tab.windowId))).toEqual(new Set([opened.workspace.windowId]));
    expect(opened.workspace.tabs.some((tab) => tab.url === 'https://workspace.local/next')).toBe(true);
  });

  it('rehomes a workspace that was accidentally bound to a user window and preserves unrelated user tabs', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const userWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === userWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;
      const agentTab = await seedBrowser.createTab({
        windowId: userWindow.id,
        url: 'https://workspace.local/orphaned',
        active: false
      });

      await seedStorage.save({
        id: WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: userWindow.id,
        groupId: null,
        tabIds: [agentTab.id],
        activeTabId: agentTab.id,
        primaryTabId: agentTab.id
      });
    });

    const humanWindowId = mustActiveWindowId(browser);
    const orphanedTabId = mustTabIdByUrl(browser, humanWindowId, '/orphaned');
    const humanTabIdsBefore = tabsInWindow(browser, humanWindowId).map((tab) => tab.id);

    const opened = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/recovered', active: false, focus: false });

    expect(opened.workspace.windowId).not.toBe(humanWindowId);
    expect(browser.windows.has(humanWindowId)).toBe(true);
    expect(tabsInWindow(browser, humanWindowId).map((tab) => tab.id)).toEqual(humanTabIdsBefore.filter((tabId) => tabId !== orphanedTabId));
    expect(tabsInWindow(browser, humanWindowId).every((tab) => !tab.url.includes('/orphaned'))).toBe(true);
    expect(new Set(opened.workspace.tabs.map((tab) => tab.windowId))).toEqual(new Set([opened.workspace.windowId]));
    expect(opened.workspace.tabs.some((tab) => tab.url === 'https://workspace.local/recovered')).toBe(true);
  });

  it('keeps multiple workspaces isolated across storage, windows, and active tabs', async () => {
    const { storage, manager } = await createManager();

    const first = await manager.openTab({ workspaceId: WORKSPACE_ID, url: 'https://workspace.local/a', active: false, focus: false });
    const second = await manager.openTab({ workspaceId: WORKSPACE_ID_B, url: 'https://workspace.local/b', active: false, focus: false });

    expect(first.workspace.windowId).not.toBe(second.workspace.windowId);
    expect(first.workspace.groupId).not.toBe(second.workspace.groupId);
    expect(first.workspace.activeTabId).toBe(first.tab.id);
    expect(second.workspace.activeTabId).toBe(second.tab.id);
    expect((await manager.getActiveTab(WORKSPACE_ID)).tab?.id).toBe(first.tab.id);
    expect((await manager.getActiveTab(WORKSPACE_ID_B)).tab?.id).toBe(second.tab.id);
    expect((await storage.list()).map((item) => item.id).sort()).toEqual([WORKSPACE_ID, WORKSPACE_ID_B]);
  });

  it('clears persisted workspace state when closed', async () => {
    const { storage, manager } = await createManager();
    await manager.ensureWorkspace({ workspaceId: WORKSPACE_ID });

    await manager.close(WORKSPACE_ID);

    await expect(storage.load(WORKSPACE_ID)).resolves.toBeNull();
    await expect(manager.getWorkspaceInfo(WORKSPACE_ID)).resolves.toBeNull();
  });
});

function tabsInWindow(browser: FakeBrowser, windowId: number): WorkspaceTab[] {
  return [...browser.tabs.values()].filter((tab) => tab.windowId === windowId);
}

function mustActiveWindowId(browser: FakeBrowser): number {
  const activeTabId = browser.activeTabId;
  if (activeTabId === null) {
    throw new Error('Expected active tab');
  }
  const activeTab = browser.tabs.get(activeTabId);
  if (!activeTab) {
    throw new Error('Expected active tab to exist');
  }
  return activeTab.windowId;
}

function mustTabIdByUrl(browser: FakeBrowser, windowId: number, urlPart: string): number {
  const tab = tabsInWindow(browser, windowId).find((candidate) => candidate.url.includes(urlPart));
  if (!tab) {
    throw new Error(`Expected tab with url containing ${urlPart}`);
  }
  return tab.id;
}
