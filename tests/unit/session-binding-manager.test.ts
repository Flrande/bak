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

const A = 'binding-agent-a';
const B = 'binding-agent-b';

const clone = (state: SessionBindingRecord | null): SessionBindingRecord | null =>
  state ? { ...state, tabIds: [...state.tabIds] } : null;

class MemoryStorage implements SessionBindingStorage {
  readonly states = new Map<string, SessionBindingRecord>();
  async load(bindingId: string): Promise<SessionBindingRecord | null> {
    return clone(this.states.get(bindingId) ?? null);
  }
  async save(state: SessionBindingRecord): Promise<void> {
    this.states.set(state.id, clone(state)!);
  }
  async delete(bindingId: string): Promise<void> {
    this.states.delete(bindingId);
  }
  async list(): Promise<SessionBindingRecord[]> {
    return [...this.states.values()].map((state) => clone(state)!).filter(Boolean);
  }
}

class FakeBrowser implements SessionBindingBrowser {
  private nextTabId = 10;
  private nextWindowId = 20;
  private nextGroupId = 30;
  readonly tabs = new Map<number, SessionBindingTab>();
  readonly windows = new Map<number, SessionBindingWindow>();
  readonly groups = new Map<number, { id: number; windowId: number; title: string; color: SessionBindingColor; collapsed: boolean }>();
  readonly transientTabMisses = new Map<number, number>();
  readonly transientWindowMisses = new Map<number, number>();
  readonly transientGroupMisses = new Map<number, number>();
  readonly focusWindowActivatesTabId = new Map<number, number>();
  activeTabId: number | null = null;

  async getTab(tabId: number): Promise<SessionBindingTab | null> {
    const misses = this.transientTabMisses.get(tabId) ?? 0;
    if (misses > 0) {
      this.transientTabMisses.set(tabId, misses - 1);
      return null;
    }
    return this.tabs.get(tabId) ?? null;
  }
  async getActiveTab(): Promise<SessionBindingTab | null> {
    return this.activeTabId === null ? null : this.tabs.get(this.activeTabId) ?? null;
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
      active: options.active === true,
      windowId,
      groupId: null
    };
    this.tabs.set(tab.id, tab);
    if (tab.active) {
      for (const item of this.tabs.values()) {
        if (item.windowId === windowId) {
          item.active = item.id === tab.id;
        }
      }
      this.activeTabId = tab.id;
    }
    return tab;
  }
  async updateTab(tabId: number, options: { active?: boolean; url?: string }): Promise<SessionBindingTab> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`missing tab ${tabId}`);
    if (typeof options.url === 'string') {
      tab.url = options.url;
      tab.title = options.url;
    }
    if (options.active === true) {
      for (const item of this.tabs.values()) {
        if (item.windowId === tab.windowId) {
          item.active = item.id === tab.id;
        }
      }
      this.activeTabId = tab.id;
    }
    return tab;
  }
  async closeTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const groupId = tab.groupId;
    const windowId = tab.windowId;
    this.tabs.delete(tabId);
    if (groupId !== null && ![...this.tabs.values()].some((item) => item.groupId === groupId)) {
      this.groups.delete(groupId);
    }
    if (![...this.tabs.values()].some((item) => item.windowId === windowId)) {
      this.windows.delete(windowId);
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
  }
  async getWindow(windowId: number): Promise<SessionBindingWindow | null> {
    const misses = this.transientWindowMisses.get(windowId) ?? 0;
    if (misses > 0) {
      this.transientWindowMisses.set(windowId, misses - 1);
      return null;
    }
    return this.windows.get(windowId) ?? null;
  }
  async createWindow(options: { url?: string; focused?: boolean }): Promise<SessionBindingWindow> {
    const window = { id: this.nextWindowId++, focused: options.focused === true };
    this.windows.set(window.id, window);
    const tab = await this.createTab({ windowId: window.id, url: options.url, active: true });
    return { ...window, initialTabId: tab.id };
  }
  async updateWindow(windowId: number, options: { focused?: boolean }): Promise<SessionBindingWindow> {
    const window = this.windows.get(windowId);
    if (!window) throw new Error(`missing window ${windowId}`);
    if (typeof options.focused === 'boolean') {
      for (const item of this.windows.values()) item.focused = false;
      window.focused = options.focused;
      if (options.focused) {
        const restoredTabId = this.focusWindowActivatesTabId.get(windowId);
        const restoredTab = typeof restoredTabId === 'number' ? this.tabs.get(restoredTabId) : null;
        if (restoredTab && restoredTab.windowId === windowId) {
          for (const item of this.tabs.values()) {
            if (item.windowId === windowId) {
              item.active = item.id === restoredTab.id;
            }
          }
          this.activeTabId = restoredTab.id;
        }
      }
    }
    return window;
  }
  async closeWindow(windowId: number): Promise<void> {
    this.windows.delete(windowId);
    for (const [tabId, tab] of this.tabs.entries()) if (tab.windowId === windowId) this.tabs.delete(tabId);
    for (const [groupId, group] of this.groups.entries()) if (group.windowId === windowId) this.groups.delete(groupId);
    if (this.activeTabId !== null && !this.tabs.has(this.activeTabId)) this.activeTabId = null;
  }
  async getGroup(groupId: number): Promise<{ id: number; windowId: number; title: string; color: SessionBindingColor; collapsed: boolean } | null> {
    const misses = this.transientGroupMisses.get(groupId) ?? 0;
    if (misses > 0) {
      this.transientGroupMisses.set(groupId, misses - 1);
      return null;
    }
    return this.groups.get(groupId) ?? null;
  }
  async groupTabs(tabIds: number[], groupId?: number): Promise<number> {
    const firstTab = this.tabs.get(tabIds[0]!);
    if (!firstTab) throw new Error('Cannot group missing tabs');
    const id = groupId ?? this.nextGroupId++;
    const group = this.groups.get(id) ?? { id, windowId: firstTab.windowId, title: '', color: 'blue' as SessionBindingColor, collapsed: false };
    this.groups.set(id, group);
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId);
      if (tab) tab.groupId = id;
    }
    return id;
  }
  async updateGroup(groupId: number, options: { title?: string; color?: SessionBindingColor; collapsed?: boolean }): Promise<{ id: number; windowId: number; title: string; color: SessionBindingColor; collapsed: boolean }> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`missing group ${groupId}`);
    if (typeof options.title === 'string') group.title = options.title;
    if (typeof options.color === 'string') group.color = options.color;
    if (typeof options.collapsed === 'boolean') group.collapsed = options.collapsed;
    return group;
  }
}

async function createManager(seed?: (browser: FakeBrowser, storage: MemoryStorage) => Promise<void> | void) {
  const browser = new FakeBrowser();
  const storage = new MemoryStorage();
  await seed?.(browser, storage);
  return { browser, storage, manager: new SessionBindingManager(storage, browser) };
}

async function seedHuman(browser: FakeBrowser, urls: string[] = ['https://human.local']) {
  const [firstUrl, ...rest] = urls;
  const window = await browser.createWindow({ url: firstUrl, focused: true });
  const activeTabId = mustActiveTabId(browser);
  const tabIds = [activeTabId];
  for (const url of rest) tabIds.push((await browser.createTab({ windowId: window.id, url, active: false })).id);
  return { windowId: window.id, activeTabId, tabIds };
}

const tabsInWindow = (browser: FakeBrowser, windowId: number) => [...browser.tabs.values()].filter((tab) => tab.windowId === windowId);
const mustActiveTabId = (browser: FakeBrowser) => {
  if (browser.activeTabId === null) throw new Error('Expected active tab');
  return browser.activeTabId;
};
const mustActiveWindowId = (browser: FakeBrowser) => {
  const activeTab = browser.tabs.get(mustActiveTabId(browser));
  if (!activeTab) throw new Error('Expected active tab to exist');
  return activeTab.windowId;
};

describe('session binding manager', () => {
  it('attaches new bindings to the current active window and creates a grouped primary tab', async () => {
    const { browser, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser)));
    const humanWindowId = mustActiveWindowId(browser);
    const humanTabId = mustActiveTabId(browser);
    const ensured = await manager.ensureBinding({ bindingId: A });
    expect(ensured.binding.windowId).toBe(humanWindowId);
    expect(ensured.binding.tabs).toHaveLength(1);
    expect(ensured.binding.tabs[0]?.groupId).toBe(ensured.binding.groupId);
    expect(browser.activeTabId).toBe(humanTabId);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['attached-active-window', 'created-primary-tab', 'recreated-group']));
  });

  it('keeps implicit targeting on the browser active tab until a binding is requested explicitly', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser)));
    const browserActive = mustActiveTabId(browser);
    const implicit = await manager.resolveTarget({});
    expect(implicit.resolution).toBe('browser-active');
    expect(implicit.tab.id).toBe(browserActive);
    await expect(storage.load(A)).resolves.toBeNull();

    const explicit = await manager.resolveTarget({ bindingId: A });
    expect(explicit.resolution).toBe('explicit-binding');
    expect(explicit.binding?.windowId).toBe(mustActiveWindowId(browser));
  });

  it('falls back to creating a new window only when there is no active browser window to attach to', async () => {
    const { browser, manager } = await createManager();
    const ensured = await manager.ensureBinding({ bindingId: A });
    expect(ensured.binding.windowId).not.toBeNull();
    expect(browser.windows.size).toBe(1);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['created-window', 'recreated-group']));
  });

  it('reattaches stale bindings to the current active window without adopting human tabs', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      await seedHuman(seedBrowser, ['https://human.local', 'https://human.local/watchlist']);
      await seedStorage.save({ id: A, label: 'bak agent', color: 'blue', windowId: 999, groupId: 777, tabIds: [555], activeTabId: 555, primaryTabId: 555 });
    });
    const humanWindowId = mustActiveWindowId(browser);
    const humanTabIds = tabsInWindow(browser, humanWindowId).filter((tab) => tab.url.includes('human.local')).map((tab) => tab.id);
    const ensured = await manager.ensureBinding({ bindingId: A });
    expect(ensured.binding.windowId).toBe(humanWindowId);
    expect(ensured.binding.tabs).toHaveLength(1);
    expect(tabsInWindow(browser, humanWindowId).filter((tab) => tab.url.includes('human.local')).map((tab) => tab.id)).toEqual(humanTabIds);
  });

  it('recreates missing groups without moving the session out of the current window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const human = await seedHuman(seedBrowser);
      const tab = await seedBrowser.createTab({ windowId: human.windowId, url: 'https://session.local', active: false });
      await seedStorage.save({ id: A, label: 'bak agent', color: 'blue', windowId: human.windowId, groupId: 1234, tabIds: [tab.id], activeTabId: tab.id, primaryTabId: tab.id });
    });
    const humanWindowId = mustActiveWindowId(browser);
    const ensured = await manager.ensureBinding({ bindingId: A });
    expect(ensured.binding.windowId).toBe(humanWindowId);
    expect(ensured.binding.groupId).not.toBe(1234);
    expect(ensured.binding.tabs[0]?.groupId).toBe(ensured.binding.groupId);
  });

  it('opens session tabs in the current window and group without changing the browser active tab by default', async () => {
    const { browser, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser)));
    const humanWindowId = mustActiveWindowId(browser);
    const humanTabId = mustActiveTabId(browser);
    const first = await manager.openTab({ bindingId: A, url: 'https://session.local/first', active: false, focus: false });
    const second = await manager.openTab({ bindingId: A, url: 'https://session.local/second', active: false, focus: false });
    expect(first.tab.windowId).toBe(humanWindowId);
    expect(second.tab.windowId).toBe(humanWindowId);
    expect(first.tab.groupId).toBe(first.binding.groupId);
    expect(second.tab.groupId).toBe(first.binding.groupId);
    expect(browser.activeTabId).toBe(humanTabId);
    expect(second.binding.activeTabId).toBe(first.binding.activeTabId);
  });

  it('updates the session current tab only when openTab is explicit about activation', async () => {
    const { manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser)));
    const first = await manager.openTab({ bindingId: A, url: 'https://session.local/first', active: false, focus: false });
    const second = await manager.openTab({ bindingId: A, url: 'https://session.local/second', active: false, focus: false });
    const third = await manager.openTab({ bindingId: A, url: 'https://session.local/third', active: true, focus: false });
    expect(first.binding.activeTabId).toBe(first.tab.id);
    expect(second.binding.activeTabId).toBe(first.tab.id);
    expect(third.binding.activeTabId).toBe(third.tab.id);
  });

  it('focuses the tracked session tab without reattaching the binding to a different active window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser, ['https://human.local', 'https://human.local/watchlist'])));
    const opened = await manager.openTab({ bindingId: A, url: 'https://session.local/focus', active: false, focus: false });
    const sessionWindowId = opened.binding.windowId!;
    const foreignWindow = await browser.createWindow({ url: 'https://foreign.local', focused: true });
    const foreignTabId = mustActiveTabId(browser);

    browser.transientWindowMisses.set(sessionWindowId, 30);

    const focused = await manager.focus(A);

    expect(browser.activeTabId).toBe(opened.tab.id);
    expect(focused.binding.windowId).toBe(sessionWindowId);
    expect(focused.binding.activeTabId).toBe(opened.tab.id);
    expect(focused.binding.tabs.some((tab) => tab.id === opened.tab.id && tab.windowId === sessionWindowId)).toBe(true);
    expect(foreignWindow.id).not.toBe(sessionWindowId);
    expect(foreignTabId).not.toBe(opened.tab.id);
  });

  it('reasserts the session tab after window focus restores another tab in the same window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser, ['https://human.local', 'https://human.local/watchlist'])));
    const humanWindowId = mustActiveWindowId(browser);
    const restoredHumanTabId =
      tabsInWindow(browser, humanWindowId).find((tab) => tab.id !== mustActiveTabId(browser) && tab.url.includes('watchlist'))?.id ??
      null;
    if (restoredHumanTabId === null) {
      throw new Error('Expected secondary human tab');
    }

    const opened = await manager.openTab({ bindingId: A, url: 'https://session.local/focus-order', active: false, focus: false });
    browser.focusWindowActivatesTabId.set(humanWindowId, restoredHumanTabId);

    const focused = await manager.focus(A);

    expect(browser.activeTabId).toBe(opened.tab.id);
    expect(focused.binding.activeTabId).toBe(opened.tab.id);
  });

  it('does not recreate the binding while reading info or during transient window and group lookup misses', async () => {
    const { browser, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser)));
    const ensured = await manager.ensureBinding({ bindingId: A });
    const windowId = ensured.binding.windowId!;
    const groupId = ensured.binding.groupId!;
    browser.transientWindowMisses.set(windowId, 3);
    browser.transientGroupMisses.set(groupId, 3);
    const info = await manager.getBindingInfo(A);
    const repaired = await manager.ensureBinding({ bindingId: A });
    expect(info?.windowId).toBe(windowId);
    expect(repaired.binding.windowId).toBe(windowId);
    expect(repaired.binding.groupId).toBe(groupId);
    expect(browser.windows.size).toBe(1);
  });

  it('rebinds to surviving tracked tabs before it considers reattaching to the active window', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      await seedHuman(seedBrowser);
      const bindingWindow = await seedBrowser.createWindow({ url: 'https://session.local', focused: false });
      const bindingTab = [...seedBrowser.tabs.values()].find((tab) => tab.windowId === bindingWindow.id)!;
      const groupId = await seedBrowser.groupTabs([bindingTab.id]);
      await seedBrowser.updateGroup(groupId, { title: 'bak agent', color: 'blue', collapsed: false });
      await seedStorage.save({ id: A, label: 'bak agent', color: 'blue', windowId: 999, groupId, tabIds: [bindingTab.id], activeTabId: bindingTab.id, primaryTabId: bindingTab.id });
    });
    const ensured = await manager.ensureBinding({ bindingId: A });
    expect(ensured.binding.windowId).toBe(ensured.binding.tabs[0]?.windowId);
    expect(browser.windows.size).toBe(2);
    expect(ensured.repairActions).toEqual(expect.arrayContaining(['rebound-window']));
  });

  it('keeps empty binding state in the current window and preserves existing human tabs', async () => {
    const { browser, manager } = await createManager(async (seedBrowser, seedStorage) => {
      const human = await seedHuman(seedBrowser, ['https://human.local', 'https://human.local/watchlist']);
      await seedStorage.save({ id: A, label: 'bak agent', color: 'blue', windowId: human.windowId, groupId: null, tabIds: [], activeTabId: null, primaryTabId: null });
    });
    const humanWindowId = mustActiveWindowId(browser);
    const humanTabIds = tabsInWindow(browser, humanWindowId).filter((tab) => tab.url.includes('human.local')).map((tab) => tab.id);
    const opened = await manager.openTab({ bindingId: A, url: 'https://session.local/recovered', active: false, focus: false });
    expect(opened.binding.windowId).toBe(humanWindowId);
    expect(tabsInWindow(browser, humanWindowId).filter((tab) => tab.url.includes('human.local')).map((tab) => tab.id)).toEqual(humanTabIds);
    expect(opened.binding.tabs[0]?.url).toBe('https://session.local/recovered');
  });

  it('keeps multiple bindings isolated by group while sharing the current window', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser, ['https://human.local', 'https://human.local/watchlist'])));
    const humanWindowId = mustActiveWindowId(browser);
    const first = await manager.openTab({ bindingId: A, url: 'https://session.local/a', active: false, focus: false });
    const second = await manager.openTab({ bindingId: B, url: 'https://session.local/b', active: false, focus: false });
    expect(first.binding.windowId).toBe(humanWindowId);
    expect(second.binding.windowId).toBe(humanWindowId);
    expect(first.binding.groupId).not.toBe(second.binding.groupId);
    expect((await storage.list()).map((item) => item.id).sort()).toEqual([A, B]);
  });

  it('closes only session-owned tabs and leaves human tabs plus sibling groups alone', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser, ['https://human.local', 'https://human.local/foreign'])));
    const first = await manager.openTab({ bindingId: A, url: 'https://session.local/a', active: true, focus: false });
    const second = await manager.openTab({ bindingId: B, url: 'https://session.local/b', active: true, focus: false });
    const humanWindowId = mustActiveWindowId(browser);
    const humanTabIds = tabsInWindow(browser, humanWindowId).filter((tab) => tab.url.includes('human.local')).map((tab) => tab.id);
    const closed = await manager.closeTab(A, first.tab.id);
    expect(closed.binding).toBeNull();
    await expect(storage.load(A)).resolves.toBeNull();
    expect(humanTabIds.every((tabId) => browser.tabs.has(tabId))).toBe(true);
    const surviving = await manager.listTabs(B);
    expect(surviving.binding.groupId).toBe(second.binding.groupId);
    expect(surviving.tabs[0]?.url).toBe('https://session.local/b');
  });

  it('keeps an empty binding anchored to the live window when sibling tracked tabs already disappeared', async () => {
    const { browser, storage, manager } = await createManager(async (seedBrowser) => void (await seedHuman(seedBrowser, ['https://human.local', 'https://human.local/watchlist'])));
    const humanWindowId = mustActiveWindowId(browser);
    const first = await manager.openTab({ bindingId: A, url: 'https://session.local/a', active: false, focus: false });
    const second = await manager.openTab({ bindingId: A, url: 'https://session.local/b', active: false, focus: false });

    await browser.closeTab(second.tab.id);

    const closed = await manager.closeTab(A, first.tab.id);

    expect(closed.binding?.windowId).toBe(humanWindowId);
    expect(closed.binding?.groupId).toBeNull();
    expect(closed.binding?.tabIds).toEqual([]);
    expect(closed.binding?.activeTabId).toBeNull();
    expect(closed.binding?.primaryTabId).toBeNull();
    await expect(storage.load(A)).resolves.toEqual({
      id: A,
      label: 'bak agent',
      color: 'blue',
      windowId: humanWindowId,
      groupId: null,
      tabIds: [],
      activeTabId: null,
      primaryTabId: null
    });
  });

  it('drops an empty binding when sibling tracked tabs already disappeared and no live window remains', async () => {
    const { browser, storage, manager } = await createManager();
    const first = await manager.openTab({ bindingId: A, url: 'https://session.local/a', active: false, focus: false });
    const second = await manager.openTab({ bindingId: A, url: 'https://session.local/b', active: false, focus: false });
    const bindingWindowId = first.binding.windowId;

    await browser.closeTab(second.tab.id);

    const closed = await manager.closeTab(A, first.tab.id);

    expect(closed.binding).toBeNull();
    await expect(storage.load(A)).resolves.toBeNull();
    expect(bindingWindowId === null ? false : browser.windows.has(bindingWindowId)).toBe(false);
  });
});
