import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ID, WorkspaceManager, type WorkspaceBrowser, type WorkspaceColor, type WorkspaceRecord, type WorkspaceStorage, type WorkspaceTab, type WorkspaceWindow } from '../../packages/extension/src/workspace.js';

class MemoryStorage implements WorkspaceStorage {
  state: WorkspaceRecord | null = null;

  async load(): Promise<WorkspaceRecord | null> {
    return this.state ? { ...this.state, tabIds: [...this.state.tabIds] } : null;
  }

  async save(state: WorkspaceRecord | null): Promise<void> {
    this.state = state ? { ...state, tabIds: [...state.tabIds] } : null;
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
    return this.windows.get(windowId) ?? null;
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

  async updateGroup(groupId: number, options: { title?: string; color?: WorkspaceColor; collapsed?: boolean }): Promise<{ id: number; windowId: number; title: string; color: WorkspaceColor; collapsed: boolean }> {
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

    const ensured = await manager.ensureWorkspace();

    expect(ensured.workspace.id).toBe(DEFAULT_WORKSPACE_ID);
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
    expect(await storage.load()).toBeNull();
  });

  it('resolves targets in the required priority order once a workspace exists', async () => {
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
        id: DEFAULT_WORKSPACE_ID,
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
    const workspaceTabId = storage.state?.activeTabId;

    const explicitTab = await manager.resolveTarget({ tabId: humanTabId! });
    expect(explicitTab.resolution).toBe('explicit-tab');
    expect(explicitTab.tab.id).toBe(humanTabId);

    const withWorkspace = await manager.resolveTarget({ workspaceId: DEFAULT_WORKSPACE_ID });
    expect(withWorkspace.resolution).toBe('explicit-workspace');
    expect(withWorkspace.tab.id).toBe(workspaceTabId);

    const defaultWorkspace = await manager.resolveTarget({});
    expect(defaultWorkspace.resolution).toBe('default-workspace');
    expect(defaultWorkspace.tab.id).toBe(workspaceTabId);
  });

  it('creates the workspace when an explicit workspace id is requested', async () => {
    const { storage, manager } = await createManager(async (seedBrowser) => {
      const humanWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === humanWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;
    });

    const resolved = await manager.resolveTarget({ workspaceId: DEFAULT_WORKSPACE_ID });

    expect(resolved.resolution).toBe('explicit-workspace');
    expect(resolved.createdWorkspace).toBe(true);
    expect(resolved.workspace?.windowId).not.toBeNull();
    expect((await storage.load())?.id).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('getActiveTab and setActiveTab update the workspace default target', async () => {
    const { manager } = await createManager();
    const ensured = await manager.ensureWorkspace();
    const firstTabId = ensured.workspace.primaryTabId!;
    const second = await manager.openTab({ url: 'https://workspace.local/second', active: false, focus: false });

    const initiallyActive = await manager.getActiveTab();
    expect(initiallyActive.tab?.id).toBe(second.tab.id);

    const switched = await manager.setActiveTab(firstTabId);
    expect(switched.tab.id).toBe(firstTabId);

    const defaultTarget = await manager.resolveTarget({});
    expect(defaultTarget.resolution).toBe('default-workspace');
    expect(defaultTarget.tab.id).toBe(firstTabId);
  });

  it('repairs a missing window without adopting unrelated tabs', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const unrelatedWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const unrelatedTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === unrelatedWindow.id)!;
      seedBrowser.activeTabId = unrelatedTab.id;
      await seedStorage.save({
        id: DEFAULT_WORKSPACE_ID,
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
    void storage;

    const ensured = await manager.ensureWorkspace();

    expect(ensured.workspace.windowId).not.toBe(999);
    expect(ensured.workspace.tabIds).toHaveLength(1);
    expect(ensured.workspace.tabs[0]?.url).toBe('about:blank');
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recreated-window', 'recreated-group']));
  });

  it('recreates a missing group and regroups tracked tabs', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const window = await seedBrowser.createWindow({ url: 'https://workspace.local', focused: false });
      const tab = [...seedBrowser.tabs.values()].find((item) => item.windowId === window.id)!;
      await seedStorage.save({
        id: DEFAULT_WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: window.id,
        groupId: 1234,
        tabIds: [tab.id],
        activeTabId: tab.id,
        primaryTabId: tab.id
      });
    });
    void browser;
    void storage;

    const ensured = await manager.ensureWorkspace();

    expect(ensured.workspace.groupId).not.toBe(1234);
    expect(ensured.workspace.tabs[0]?.groupId).toBe(ensured.workspace.groupId);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recreated-group']));
  });

  it('recovers workspace tabs from the dedicated group when tracked tab ids are missing', async () => {
    const { storage, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const window = await seedBrowser.createWindow({ url: 'https://workspace.local', focused: false });
      const tab = [...seedBrowser.tabs.values()].find((item) => item.windowId === window.id)!;
      const groupId = await seedBrowser.groupTabs([tab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({
        id: DEFAULT_WORKSPACE_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: window.id,
        groupId,
        tabIds: [],
        activeTabId: null,
        primaryTabId: null
      });
    });
    void storage;

    const ensured = await manager.ensureWorkspace();

    expect(ensured.workspace.tabIds).toHaveLength(1);
    expect(ensured.workspace.tabs[0]?.groupId).toBe(ensured.workspace.groupId);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recovered-tracked-tabs', 'reassigned-primary-tab', 'reassigned-active-tab']));
  });

  it('opens new tabs inside the workspace window and group without changing human focus by default', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureWorkspace();
    const originalWindowId = ensured.workspace.windowId;
    const originalGroupId = ensured.workspace.groupId;

    const opened = await manager.openTab({ url: 'https://workspace.local/next', active: false, focus: false });

    expect(opened.tab.windowId).toBe(originalWindowId);
    expect(opened.tab.groupId).toBe(originalGroupId);
    expect(opened.workspace.activeTabId).toBe(opened.tab.id);
    expect(browser.windows.get(originalWindowId!)?.focused).toBe(false);
  });

  it('reuses the initial workspace tab for the first open-tab request after creating the workspace', async () => {
    const { manager } = await createManager();

    const opened = await manager.openTab({ url: 'https://workspace.local/first', active: false, focus: false });

    expect(opened.workspace.tabIds).toHaveLength(1);
    expect(opened.workspace.primaryTabId).toBe(opened.tab.id);
    expect(opened.tab.url).toBe('https://workspace.local/first');
  });
});
