import { describe, expect, it } from 'vitest';
import {
  SessionBindingManager,
  type SessionBindingBrowser,
  type SessionBindingColor,
  type SessionBindingRecord,
  type SessionBindingStorage,
  type SessionBindingTab,
  type SessionBindingWindow
} from '../../packages/extension/src/session-binding.js';

const BINDING_ID = 'binding-agent-a';
const BINDING_ID_B = 'binding-agent-b';

function cloneRecord(state: SessionBindingRecord | null): SessionBindingRecord | null {
  return state ? { ...state, tabIds: [...state.tabIds] } : null;
}

class MemoryStorage implements SessionBindingStorage {
  readonly states = new Map<string, SessionBindingRecord>();

  async load(bindingId: string): Promise<SessionBindingRecord | null> {
    return cloneRecord(this.states.get(bindingId) ?? null);
  }

  async save(state: SessionBindingRecord): Promise<void> {
    this.states.set(state.id, cloneRecord(state)!);
  }

  async delete(bindingId: string): Promise<void> {
    this.states.delete(bindingId);
  }

  async list(): Promise<SessionBindingRecord[]> {
    return [...this.states.values()].map((state) => cloneRecord(state)!).filter(Boolean);
  }
}

class FakeBrowser implements SessionBindingBrowser {
  private nextTabId = 10;
  private nextWindowId = 20;
  private nextGroupId = 30;
  readonly tabs = new Map<number, SessionBindingTab>();
  readonly windows = new Map<number, SessionBindingWindow>();
  readonly groups = new Map<number, { id: number; windowId: number; title: string; color: SessionBindingColor; collapsed: boolean }>();
  activeTabId: number | null = null;
  readonly transientWindowMisses = new Map<number, number>();
  readonly transientGroupMisses = new Map<number, number>();

  async getTab(tabId: number): Promise<SessionBindingTab | null> {
    return this.tabs.get(tabId) ?? null;
  }

  async getActiveTab(): Promise<SessionBindingTab | null> {
    return this.activeTabId !== null ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  async listTabs(filter?: { windowId?: number }): Promise<SessionBindingTab[]> {
    return [...this.tabs.values()].filter((tab) => (filter?.windowId ? tab.windowId === filter.windowId : true));
  }

  async createTab(options: { windowId?: number; url?: string; active?: boolean }): Promise<SessionBindingTab> {
    const windowId = options.windowId ?? (await this.createWindow({ focused: false })).id;
    const tab: SessionBindingTab = {
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

  async updateTab(tabId: number, options: { active?: boolean; url?: string }): Promise<SessionBindingTab> {
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

  async getWindow(windowId: number): Promise<SessionBindingWindow | null> {
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

  failGroupLookups(groupId: number, count: number): void {
    this.transientGroupMisses.set(groupId, count);
  }

  async createWindow(options: { url?: string; focused?: boolean }): Promise<SessionBindingWindow> {
    const window: SessionBindingWindow = {
      id: this.nextWindowId++,
      focused: options.focused === true
    };
    this.windows.set(window.id, window);
    await this.createTab({ windowId: window.id, url: options.url, active: true });
    return window;
  }

  async updateWindow(windowId: number, options: { focused?: boolean }): Promise<SessionBindingWindow> {
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

  async getGroup(groupId: number): Promise<{ id: number; windowId: number; title: string; color: SessionBindingColor; collapsed: boolean } | null> {
    const remainingMisses = this.transientGroupMisses.get(groupId) ?? 0;
    if (remainingMisses > 0) {
      this.transientGroupMisses.set(groupId, remainingMisses - 1);
      return null;
    }
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
      color: 'blue' as SessionBindingColor,
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
    options: { title?: string; color?: SessionBindingColor; collapsed?: boolean }
  ): Promise<{ id: number; windowId: number; title: string; color: SessionBindingColor; collapsed: boolean }> {
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
): Promise<{ browser: FakeBrowser; storage: MemoryStorage; manager: SessionBindingManager }> {
  const browser = new FakeBrowser();
  const storage = new MemoryStorage();
  await seed?.(browser, storage);
  const manager = new SessionBindingManager(storage, browser);
  return { browser, storage, manager };
}

describe('session binding manager', () => {
  it('creates a dedicated window, group, and primary tab on ensure', async () => {
    const { manager } = await createManager();

    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });

    expect(ensured.binding.id).toBe(BINDING_ID);
    expect(ensured.binding.windowId).not.toBeNull();
    expect(ensured.binding.groupId).not.toBeNull();
    expect(ensured.binding.primaryTabId).not.toBeNull();
    expect(ensured.binding.activeTabId).toBe(ensured.binding.primaryTabId);
    expect(ensured.binding.tabs).toHaveLength(1);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['created-window', 'recreated-group']));
  });

  it('falls back to the browser active tab without creating a binding when none exists', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser) => {
      const humanWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === humanWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;
    });
    void browser;

    const resolved = await manager.resolveTarget({});

    expect(resolved.resolution).toBe('browser-active');
    expect(resolved.tab.url).toContain('human.local');
    expect(resolved.createdBinding).toBe(false);
    await expect(storage.load(BINDING_ID)).resolves.toBeNull();
  });

  it('resolves explicit binding targets and leaves implicit routing on the browser active tab', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const humanWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === humanWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;

      const bindingWindow = await seedBrowser.createWindow({ url: 'https://session.local', focused: false });
      const bindingTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === bindingWindow.id)!;
      const groupId = await seedBrowser.groupTabs([bindingTab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      seedBrowser.activeTabId = humanTab.id;
      await seedStorage.save({
        id: BINDING_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: bindingWindow.id,
        groupId,
        tabIds: [bindingTab.id],
        activeTabId: bindingTab.id,
        primaryTabId: bindingTab.id
      });
    });
    const humanTabId = browser.activeTabId;
    const bindingTabId = (await storage.load(BINDING_ID))?.activeTabId;

    const explicitTab = await manager.resolveTarget({ tabId: humanTabId! });
    expect(explicitTab.resolution).toBe('explicit-tab');
    expect(explicitTab.tab.id).toBe(humanTabId);

    const withBinding = await manager.resolveTarget({ bindingId: BINDING_ID });
    expect(withBinding.resolution).toBe('explicit-binding');
    expect(withBinding.tab.id).toBe(bindingTabId);

    const implicitTarget = await manager.resolveTarget({});
    expect(implicitTarget.resolution).toBe('browser-active');
    expect(implicitTarget.tab.id).toBe(humanTabId);
  });

  it('creates the binding when an explicit binding id is requested', async () => {
    const { storage, manager } = await createManager(async (seedBrowser) => {
      const humanWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === humanWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;
    });

    const resolved = await manager.resolveTarget({ bindingId: BINDING_ID });

    expect(resolved.resolution).toBe('explicit-binding');
    expect(resolved.createdBinding).toBe(true);
    expect(resolved.binding?.windowId).not.toBeNull();
    expect((await storage.load(BINDING_ID))?.id).toBe(BINDING_ID);
  });

  it('getActiveTab and setActiveTab update the binding current tab', async () => {
    const { manager } = await createManager();
    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });
    const firstTabId = ensured.binding.primaryTabId!;
    const second = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/second', active: false, focus: false });

    const initiallyActive = await manager.getActiveTab(BINDING_ID);
    expect(initiallyActive.tab?.id).toBe(second.tab.id);

    const switched = await manager.setActiveTab(firstTabId, BINDING_ID);
    expect(switched.tab.id).toBe(firstTabId);

    const resolved = await manager.resolveTarget({ bindingId: BINDING_ID });
    expect(resolved.resolution).toBe('explicit-binding');
    expect(resolved.tab.id).toBe(firstTabId);
  });

  it('repairs a missing window without adopting unrelated tabs', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const unrelatedWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const unrelatedTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === unrelatedWindow.id)!;
      seedBrowser.activeTabId = unrelatedTab.id;
      await seedStorage.save({
        id: BINDING_ID,
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

    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });

    expect(ensured.binding.windowId).not.toBe(999);
    expect(ensured.binding.tabIds).toHaveLength(1);
    expect(ensured.binding.tabs[0]?.url).toBe('about:blank');
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recreated-window', 'recreated-group']));
  });

  it('recreates a missing group and regroups tracked tabs', async () => {
    const { manager } = await createManager(async (seedBrowser, seedStorage) => {
      const window = await seedBrowser.createWindow({ url: 'https://session.local', focused: false });
      const tab = [...seedBrowser.tabs.values()].find((item) => item.windowId === window.id)!;
      await seedStorage.save({
        id: BINDING_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: window.id,
        groupId: 1234,
        tabIds: [tab.id],
        activeTabId: tab.id,
        primaryTabId: tab.id
      });
    });

    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });

    expect(ensured.binding.groupId).not.toBe(1234);
    expect(ensured.binding.tabs[0]?.groupId).toBe(ensured.binding.groupId);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recreated-group']));
  });

  it('recovers binding tabs from the dedicated group when tracked tab ids are missing', async () => {
    const { manager } = await createManager(async (seedBrowser, seedStorage) => {
      const window = await seedBrowser.createWindow({ url: 'https://session.local', focused: false });
      const tab = [...seedBrowser.tabs.values()].find((item) => item.windowId === window.id)!;
      const groupId = await seedBrowser.groupTabs([tab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({
        id: BINDING_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: window.id,
        groupId,
        tabIds: [],
        activeTabId: null,
        primaryTabId: null
      });
    });

    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });

    expect(ensured.binding.tabIds).toHaveLength(1);
    expect(ensured.binding.tabs[0]?.groupId).toBe(ensured.binding.groupId);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['recovered-tracked-tabs', 'reassigned-primary-tab', 'reassigned-active-tab']));
  });

  it('opens new tabs inside the binding window and group without changing human focus by default', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });
    const originalWindowId = ensured.binding.windowId;
    const originalGroupId = ensured.binding.groupId;
    const originalActiveTabId = ensured.binding.activeTabId;

    const opened = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/next', active: false, focus: false });

    expect(opened.tab.windowId).toBe(originalWindowId);
    expect(opened.tab.groupId).toBe(originalGroupId);
    expect(opened.binding.activeTabId).toBe(originalActiveTabId);
    expect(opened.tab.id).toBe(originalActiveTabId);
    expect(browser.windows.get(originalWindowId!)?.focused).toBe(false);
  });

  it('switches the binding current tab only when openTab is explicit about activation', async () => {
    const { manager } = await createManager();
    const first = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/first', active: false, focus: false });
    const second = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/second', active: false, focus: false });
    const third = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/third', active: true, focus: false });

    expect(first.binding.activeTabId).toBe(first.tab.id);
    expect(second.binding.activeTabId).toBe(first.tab.id);
    expect(second.tab.active).toBe(false);
    expect(third.binding.activeTabId).toBe(third.tab.id);
    expect(third.tab.active).toBe(true);
  });

  it('reuses the initial binding tab for the first open-tab request after creating the binding', async () => {
    const { manager } = await createManager();

    const opened = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/first', active: false, focus: false });

    expect(opened.binding.tabIds).toHaveLength(1);
    expect(opened.binding.primaryTabId).toBe(opened.tab.id);
    expect(opened.tab.url).toBe('https://session.local/first');
  });

  it('reuses a lone blank primary tab after an explicit ensure instead of creating an extra blank tab', async () => {
    const { manager } = await createManager();
    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });

    const opened = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/after-ensure', active: false, focus: false });

    expect(ensured.binding.tabIds).toHaveLength(1);
    expect(opened.binding.tabIds).toHaveLength(1);
    expect(opened.binding.primaryTabId).toBe(opened.tab.id);
    expect(opened.tab.url).toBe('https://session.local/after-ensure');
  });

  it('does not recreate the binding while reading info or active tab', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });
    const originalWindowId = ensured.binding.windowId;

    const info = await manager.getBindingInfo(BINDING_ID);
    const active = await manager.getActiveTab(BINDING_ID);

    expect(info?.windowId).toBe(originalWindowId);
    expect(active.binding.windowId).toBe(originalWindowId);
    expect(browser.windows.size).toBe(1);
    expect(info?.tabs).toHaveLength(1);
    expect(active.tab?.id).toBe(ensured.binding.activeTabId);
  });

  it('does not recreate the binding window when window lookup is temporarily unavailable', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });
    const originalWindowId = ensured.binding.windowId!;
    browser.failWindowLookups(originalWindowId, 3);

    const opened = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/resilient', active: false, focus: false });

    expect(opened.binding.windowId).toBe(originalWindowId);
    expect(browser.windows.size).toBe(1);
    expect(new Set(opened.binding.tabs.map((tab) => tab.windowId))).toEqual(new Set([originalWindowId]));
  });

  it('does not recreate the binding group when group lookup is temporarily unavailable', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });
    const originalGroupId = ensured.binding.groupId!;
    browser.failGroupLookups(originalGroupId, 3);

    const repaired = await manager.ensureBinding({ bindingId: BINDING_ID });

    expect(repaired.binding.groupId).toBe(originalGroupId);
    expect(repaired.repairActions).not.toEqual(expect.arrayContaining(['recreated-group']));
  });

  it('rebinds the binding to surviving tracked tabs before recreating a missing window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const bindingWindow = await seedBrowser.createWindow({ url: 'https://session.local', focused: false });
      const bindingTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === bindingWindow.id)!;
      const groupId = await seedBrowser.groupTabs([bindingTab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({
        id: BINDING_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: 999,
        groupId,
        tabIds: [bindingTab.id],
        activeTabId: bindingTab.id,
        primaryTabId: bindingTab.id
      });
    });

    const ensured = await manager.ensureBinding({ bindingId: BINDING_ID });

    expect(ensured.binding.windowId).toBe(ensured.binding.tabs[0]?.windowId);
    expect(browser.windows.size).toBe(1);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['rebound-window']));
    expect(ensured.repairActions).not.toEqual(expect.arrayContaining(['recreated-window']));
  });

  it('openTab reuses the rebound binding window instead of creating a duplicate blank window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const bindingWindow = await seedBrowser.createWindow({ url: 'https://session.local', focused: false });
      const bindingTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === bindingWindow.id)!;
      const groupId = await seedBrowser.groupTabs([bindingTab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({
        id: BINDING_ID,
        label: 'bak agent',
        color: 'blue',
        windowId: 999,
        groupId,
        tabIds: [bindingTab.id],
        activeTabId: bindingTab.id,
        primaryTabId: bindingTab.id
      });
    });

    const opened = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/next', active: false, focus: false });

    expect(browser.windows.size).toBe(1);
    expect(new Set(opened.binding.tabs.map((tab) => tab.windowId))).toEqual(new Set([opened.binding.windowId]));
    expect(opened.binding.tabs.some((tab) => tab.url === 'https://session.local/next')).toBe(true);
  });

  it('rehomes a binding that was accidentally bound to a user window and preserves unrelated user tabs', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const userWindow = await seedBrowser.createWindow({ url: 'https://human.local', focused: true });
      const humanTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === userWindow.id)!;
      seedBrowser.activeTabId = humanTab.id;
      const agentTab = await seedBrowser.createTab({
        windowId: userWindow.id,
        url: 'https://session.local/orphaned',
        active: false
      });

      await seedStorage.save({
        id: BINDING_ID,
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

    const opened = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/recovered', active: false, focus: false });

    expect(opened.binding.windowId).not.toBe(humanWindowId);
    expect(browser.windows.has(humanWindowId)).toBe(true);
    expect(tabsInWindow(browser, humanWindowId).map((tab) => tab.id)).toEqual(humanTabIdsBefore.filter((tabId) => tabId !== orphanedTabId));
    expect(tabsInWindow(browser, humanWindowId).every((tab) => !tab.url.includes('/orphaned'))).toBe(true);
    expect(new Set(opened.binding.tabs.map((tab) => tab.windowId))).toEqual(new Set([opened.binding.windowId]));
    expect(opened.binding.tabs.some((tab) => tab.url === 'https://session.local/recovered')).toBe(true);
  });

  it('keeps multiple bindings isolated across storage, windows, and active tabs', async () => {
    const { storage, manager } = await createManager();

    const first = await manager.openTab({ bindingId: BINDING_ID, url: 'https://session.local/a', active: false, focus: false });
    const second = await manager.openTab({ bindingId: BINDING_ID_B, url: 'https://session.local/b', active: false, focus: false });

    expect(first.binding.windowId).not.toBe(second.binding.windowId);
    expect(first.binding.groupId).not.toBe(second.binding.groupId);
    expect(first.binding.activeTabId).toBe(first.tab.id);
    expect(second.binding.activeTabId).toBe(second.tab.id);
    expect((await manager.getActiveTab(BINDING_ID)).tab?.id).toBe(first.tab.id);
    expect((await manager.getActiveTab(BINDING_ID_B)).tab?.id).toBe(second.tab.id);
    expect((await storage.list()).map((item) => item.id).sort()).toEqual([BINDING_ID, BINDING_ID_B]);
  });

  it('clears persisted binding state when closed', async () => {
    const { storage, manager } = await createManager();
    await manager.ensureBinding({ bindingId: BINDING_ID });

    await manager.close(BINDING_ID);

    await expect(storage.load(BINDING_ID)).resolves.toBeNull();
    await expect(manager.getBindingInfo(BINDING_ID)).resolves.toBeNull();
  });
});

function tabsInWindow(browser: FakeBrowser, windowId: number): SessionBindingTab[] {
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
