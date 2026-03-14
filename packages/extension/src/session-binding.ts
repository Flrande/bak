export const DEFAULT_SESSION_BINDING_LABEL = 'bak agent';
export const DEFAULT_SESSION_BINDING_COLOR = 'blue';
export const DEFAULT_SESSION_BINDING_URL = 'about:blank';
const WINDOW_LOOKUP_TIMEOUT_MS = 1_500;
const GROUP_LOOKUP_TIMEOUT_MS = 1_000;
const WINDOW_TABS_LOOKUP_TIMEOUT_MS = 1_500;

export type SessionBindingColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface SessionBindingTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  groupId: number | null;
}

export interface SessionBindingWindow {
  id: number;
  focused: boolean;
  initialTabId?: number | null;
}

export interface SessionBindingGroup {
  id: number;
  windowId: number;
  title: string;
  color: SessionBindingColor;
  collapsed: boolean;
}

export interface SessionBindingRecord {
  id: string;
  label: string;
  color: SessionBindingColor;
  windowId: number | null;
  groupId: number | null;
  tabIds: number[];
  activeTabId: number | null;
  primaryTabId: number | null;
}

export interface SessionBindingInfo extends SessionBindingRecord {
  tabs: SessionBindingTab[];
}

export interface SessionBindingEnsureResult {
  binding: SessionBindingInfo;
  created: boolean;
  repaired: boolean;
  repairActions: string[];
}

export interface SessionBindingTargetResolution {
  tab: SessionBindingTab;
  binding: SessionBindingInfo | null;
  resolution: 'explicit-tab' | 'explicit-binding' | 'default-binding' | 'browser-active';
  createdBinding: boolean;
  repaired: boolean;
  repairActions: string[];
}

export interface SessionBindingStorage {
  load(bindingId: string): Promise<SessionBindingRecord | null>;
  save(state: SessionBindingRecord): Promise<void>;
  delete(bindingId: string): Promise<void>;
  list(): Promise<SessionBindingRecord[]>;
}

export interface SessionBindingBrowser {
  getTab(tabId: number): Promise<SessionBindingTab | null>;
  getActiveTab(): Promise<SessionBindingTab | null>;
  listTabs(filter?: { windowId?: number }): Promise<SessionBindingTab[]>;
  createTab(options: { windowId?: number; url?: string; active?: boolean }): Promise<SessionBindingTab>;
  updateTab(tabId: number, options: { active?: boolean; url?: string }): Promise<SessionBindingTab>;
  closeTab(tabId: number): Promise<void>;
  getWindow(windowId: number): Promise<SessionBindingWindow | null>;
  createWindow(options: { url?: string; focused?: boolean }): Promise<SessionBindingWindow>;
  updateWindow(windowId: number, options: { focused?: boolean }): Promise<SessionBindingWindow>;
  closeWindow(windowId: number): Promise<void>;
  getGroup(groupId: number): Promise<SessionBindingGroup | null>;
  groupTabs(tabIds: number[], groupId?: number): Promise<number>;
  updateGroup(groupId: number, options: { title?: string; color?: SessionBindingColor; collapsed?: boolean }): Promise<SessionBindingGroup>;
}

export interface SessionBindingEnsureOptions {
  bindingId?: string;
  focus?: boolean;
  initialUrl?: string;
  label?: string;
}

export interface SessionBindingOpenTabOptions {
  bindingId?: string;
  url?: string;
  active?: boolean;
  focus?: boolean;
  label?: string;
}

export interface SessionBindingResolveTargetOptions {
  tabId?: number;
  bindingId?: string;
  createIfMissing?: boolean;
}

class SessionBindingManager {
  private readonly storage: SessionBindingStorage;
  private readonly browser: SessionBindingBrowser;

  constructor(storage: SessionBindingStorage, browser: SessionBindingBrowser) {
    this.storage = storage;
    this.browser = browser;
  }

  async getBindingInfo(bindingId: string): Promise<SessionBindingInfo | null> {
    return this.inspectBinding(bindingId);
  }

  async ensureBinding(options: SessionBindingEnsureOptions = {}): Promise<SessionBindingEnsureResult> {
    const bindingId = this.normalizeBindingId(options.bindingId);
    const repairActions: string[] = [];
    const initialUrl = options.initialUrl ?? DEFAULT_SESSION_BINDING_URL;
    const persisted = await this.storage.load(bindingId);
    const created = !persisted;
    let state = this.normalizeState(persisted, bindingId, options.label);

    const originalWindowId = state.windowId;
    let window = state.windowId !== null ? await this.waitForWindow(state.windowId) : null;
    let tabs: SessionBindingTab[] = [];
    if (!window) {
      const rebound = await this.rebindBindingWindow(state);
      if (rebound) {
        window = rebound.window;
        tabs = rebound.tabs;
        if (originalWindowId !== rebound.window.id) {
          repairActions.push('rebound-window');
        }
      }
    }
    if (!window) {
      const activeWindow = await this.attachBindingToActiveWindow(state);
      if (activeWindow) {
        window = activeWindow;
        repairActions.push('attached-active-window');
      }
    }
    if (!window) {
      const sharedWindow = await this.findSharedBindingWindow(bindingId);
      if (sharedWindow) {
        state.windowId = sharedWindow.id;
        state.groupId = null;
        state.tabIds = [];
        state.activeTabId = null;
        state.primaryTabId = null;
        window = sharedWindow;
        repairActions.push('attached-shared-window');
      } else {
        const createdWindow = await this.browser.createWindow({
          url: initialUrl,
          focused: options.focus === true
        });
        state.windowId = createdWindow.id;
        state.groupId = null;
        state.tabIds = [];
        state.activeTabId = null;
        state.primaryTabId = null;
        window = createdWindow;
        const initialTab =
          typeof createdWindow.initialTabId === 'number'
            ? await this.waitForTrackedTab(createdWindow.initialTabId, createdWindow.id)
            : null;
        tabs = initialTab ? [initialTab] : await this.waitForWindowTabs(createdWindow.id);
        state.tabIds = tabs.map((tab) => tab.id);
        if (state.primaryTabId === null) {
          state.primaryTabId = initialTab?.id ?? tabs[0]?.id ?? null;
        }
        if (state.activeTabId === null) {
          state.activeTabId = tabs.find((tab) => tab.active)?.id ?? initialTab?.id ?? tabs[0]?.id ?? null;
        }
        repairActions.push(created ? 'created-window' : 'recreated-window');
      }
    }

    tabs = tabs.length > 0 ? tabs : await this.readTrackedTabs(state.tabIds, state.windowId);
    const recoveredTabs = await this.recoverBindingTabs(state, tabs);
    if (recoveredTabs.length > tabs.length) {
      tabs = recoveredTabs;
      repairActions.push('recovered-tracked-tabs');
    }
    if (tabs.length !== state.tabIds.length) {
      repairActions.push('pruned-missing-tabs');
    }
    state.tabIds = tabs.map((tab) => tab.id);

    if (tabs.length === 0) {
      const primary = await this.createBindingTab({
        windowId: state.windowId,
        url: initialUrl,
        active: options.focus === true
      });
      tabs = [primary];
      state.tabIds = [primary.id];
      state.primaryTabId = primary.id;
      state.activeTabId = primary.id;
      repairActions.push('created-primary-tab');
    }

    if (state.primaryTabId === null || !tabs.some((tab) => tab.id === state.primaryTabId)) {
      state.primaryTabId = tabs[0]?.id ?? null;
      repairActions.push('reassigned-primary-tab');
    }

    if (state.activeTabId === null || !tabs.some((tab) => tab.id === state.activeTabId)) {
      state.activeTabId = state.primaryTabId ?? tabs[0]?.id ?? null;
      repairActions.push('reassigned-active-tab');
    }

    let group = state.groupId !== null ? await this.waitForGroup(state.groupId) : null;
    if (!group || group.windowId !== state.windowId) {
      const groupId = await this.browser.groupTabs(tabs.map((tab) => tab.id));
      group = await this.browser.updateGroup(groupId, {
        title: state.label,
        color: state.color,
        collapsed: false
      });
      state.groupId = group.id;
      repairActions.push('recreated-group');
    } else {
      await this.browser.updateGroup(group.id, {
        title: state.label,
        color: state.color,
        collapsed: false
      });
    }

    const ungroupedIds = tabs.filter((tab) => tab.groupId !== state.groupId).map((tab) => tab.id);
    if (ungroupedIds.length > 0) {
      await this.browser.groupTabs(ungroupedIds, state.groupId ?? undefined);
      repairActions.push('regrouped-tabs');
    }

    tabs = await this.readTrackedTabs(state.tabIds, state.windowId);
    tabs = await this.recoverBindingTabs(state, tabs);
    const activeTab = state.activeTabId !== null ? await this.waitForTrackedTab(state.activeTabId, state.windowId) : null;
    if (activeTab && !tabs.some((tab) => tab.id === activeTab.id)) {
      tabs = [...tabs, activeTab];
    }
    if (tabs.length === 0 && state.primaryTabId !== null) {
      const primaryTab = await this.waitForTrackedTab(state.primaryTabId, state.windowId);
      if (primaryTab) {
        tabs = [primaryTab];
      }
    }
    state.tabIds = [...new Set(tabs.map((tab) => tab.id))];

    if (options.focus === true && state.windowId !== null && state.activeTabId !== null) {
      await this.focusBindingWindow(state.windowId, state.activeTabId);
      window = await this.waitForWindow(state.windowId, 300);
      void window;
      repairActions.push('focused-window');
    }

    await this.storage.save(state);

    return {
      binding: {
        ...state,
        tabs
      },
      created,
      repaired: repairActions.length > 0,
      repairActions
    };
  }

  async openTab(options: SessionBindingOpenTabOptions = {}): Promise<{ binding: SessionBindingInfo; tab: SessionBindingTab }> {
    const bindingId = this.normalizeBindingId(options.bindingId);
    const hadBinding = (await this.loadBindingRecord(bindingId)) !== null;
    const ensured = await this.ensureBinding({
      bindingId,
      focus: false,
      initialUrl: hadBinding ? options.url ?? DEFAULT_SESSION_BINDING_URL : DEFAULT_SESSION_BINDING_URL,
      label: options.label
    });
    let state = { ...ensured.binding, tabIds: [...ensured.binding.tabIds], tabs: [...ensured.binding.tabs] };
    if (state.windowId !== null && state.tabs.length === 0) {
      const rebound = await this.rebindBindingWindow(state);
      if (rebound) {
        state.windowId = rebound.window.id;
        state.tabs = rebound.tabs;
        state.tabIds = [...new Set(rebound.tabs.map((tab) => tab.id))];
      }
    }
    const active = options.active === true;
    const desiredUrl = options.url ?? DEFAULT_SESSION_BINDING_URL;
    let reusablePrimaryTab = await this.resolveReusablePrimaryTab(
      state,
      ensured.created ||
        ensured.repairActions.includes('recreated-window') ||
        ensured.repairActions.includes('created-primary-tab')
    );

    let createdTab: SessionBindingTab;
    try {
      createdTab = reusablePrimaryTab
        ? await this.browser.updateTab(reusablePrimaryTab.id, {
            url: desiredUrl,
            active
          })
        : await this.createBindingTab({
            windowId: state.windowId,
            url: desiredUrl,
            active
          });
    } catch (error) {
      if (!this.isMissingWindowError(error)) {
        throw error;
      }
      const repaired = await this.ensureBinding({
        bindingId,
        focus: false,
        initialUrl: desiredUrl,
        label: options.label
      });
      state = { ...repaired.binding };
      reusablePrimaryTab = await this.resolveReusablePrimaryTab(state, true);
      createdTab = reusablePrimaryTab
        ? await this.browser.updateTab(reusablePrimaryTab.id, {
            url: desiredUrl,
            active
          })
        : await this.createBindingTab({
            windowId: state.windowId,
            url: desiredUrl,
            active
          });
    }
    const nextTabIds = [...new Set([...state.tabIds, createdTab.id])];
    const groupId = await this.browser.groupTabs([createdTab.id], state.groupId ?? undefined);
    await this.browser.updateGroup(groupId, {
      title: state.label,
      color: state.color,
      collapsed: false
    });
    const nextState: SessionBindingRecord = {
      id: state.id,
      label: state.label,
      color: state.color,
      windowId: state.windowId,
      groupId,
      tabIds: nextTabIds,
      activeTabId: active || options.focus === true ? createdTab.id : state.activeTabId ?? state.primaryTabId ?? createdTab.id,
      primaryTabId: state.primaryTabId ?? createdTab.id
    };

    if (options.focus === true && state.windowId !== null) {
      await this.focusBindingWindow(state.windowId, createdTab.id);
    }

    await this.storage.save(nextState);
    const tabs = await this.readTrackedTabs(nextState.tabIds, nextState.windowId);
    const tab = tabs.find((item) => item.id === createdTab.id) ?? createdTab;
    return {
      binding: {
        ...nextState,
        tabs
      },
      tab
    };
  }

  async listTabs(bindingId: string): Promise<{ binding: SessionBindingInfo; tabs: SessionBindingTab[] }> {
    const ensured = await this.inspectBinding(bindingId);
    if (!ensured) {
      throw new Error(`Binding ${bindingId} does not exist`);
    }
    return {
      binding: ensured,
      tabs: ensured.tabs
    };
  }

  async getActiveTab(bindingId: string): Promise<{ binding: SessionBindingInfo; tab: SessionBindingTab | null }> {
    const ensured = await this.inspectBinding(bindingId);
    if (!ensured) {
      const normalizedBindingId = this.normalizeBindingId(bindingId);
      return {
        binding: {
          ...this.normalizeState(null, normalizedBindingId),
          tabs: []
        },
        tab: null
      };
    }
    return {
      binding: ensured,
      tab: ensured.tabs.find((tab) => tab.id === ensured.activeTabId) ?? null
    };
  }

  async setActiveTab(tabId: number, bindingId: string): Promise<{ binding: SessionBindingInfo; tab: SessionBindingTab }> {
    const ensured = await this.ensureBinding({ bindingId });
    if (!ensured.binding.tabIds.includes(tabId)) {
      throw new Error(`Tab ${tabId} does not belong to binding ${bindingId}`);
    }
    const nextState: SessionBindingRecord = {
      id: ensured.binding.id,
      label: ensured.binding.label,
      color: ensured.binding.color,
      windowId: ensured.binding.windowId,
      groupId: ensured.binding.groupId,
      tabIds: [...ensured.binding.tabIds],
      activeTabId: tabId,
      primaryTabId: ensured.binding.primaryTabId ?? tabId
    };
    await this.storage.save(nextState);
    const tabs = await this.readTrackedTabs(nextState.tabIds, nextState.windowId);
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} is missing from binding ${bindingId}`);
    }
    return {
      binding: {
        ...nextState,
        tabs
      },
      tab
    };
  }

  async focus(bindingId: string): Promise<{ ok: true; binding: SessionBindingInfo }> {
    const normalizedBindingId = this.normalizeBindingId(bindingId);
    let binding =
      (await this.inspectBinding(normalizedBindingId)) ??
      (
        await this.ensureBinding({
          bindingId: normalizedBindingId,
          focus: false
        })
      ).binding;
    let targetTabId = this.resolveFocusTabId(binding);

    if (binding.windowId === null || targetTabId === null) {
      binding = (
        await this.ensureBinding({
          bindingId: normalizedBindingId,
          focus: false
        })
      ).binding;
      targetTabId = this.resolveFocusTabId(binding);
    }

    if (binding.windowId !== null && targetTabId !== null) {
      try {
        await this.focusBindingWindow(binding.windowId, targetTabId);
      } catch (error) {
        if (!this.isMissingWindowError(error)) {
          throw error;
        }
        binding = (
          await this.ensureBinding({
            bindingId: normalizedBindingId,
            focus: false
          })
        ).binding;
        targetTabId = this.resolveFocusTabId(binding);
        if (binding.windowId !== null && targetTabId !== null) {
          await this.focusBindingWindow(binding.windowId, targetTabId);
        }
      }
    }

    const refreshed = (await this.inspectBinding(normalizedBindingId)) ?? binding;
    return {
      ok: true,
      binding:
        refreshed.windowId !== null && targetTabId !== null
          ? this.withFocusedTab(refreshed, targetTabId)
          : refreshed
    };
  }

  async closeTab(bindingId: string, tabId?: number): Promise<{ binding: SessionBindingInfo | null; closedTabId: number }> {
    const binding = await this.inspectBinding(bindingId);
    if (!binding) {
      throw new Error(`Binding ${bindingId} does not exist`);
    }
    const resolvedTabId =
      typeof tabId === 'number'
        ? tabId
        : binding.activeTabId ?? binding.primaryTabId ?? binding.tabs[0]?.id;
    if (typeof resolvedTabId !== 'number' || !binding.tabIds.includes(resolvedTabId)) {
      throw new Error(`Tab ${tabId ?? 'active'} does not belong to binding ${bindingId}`);
    }

    await this.browser.closeTab(resolvedTabId);
    const remainingTabIds = binding.tabIds.filter((candidate) => candidate !== resolvedTabId);

    if (remainingTabIds.length === 0) {
      await this.storage.delete(binding.id);
      return {
        binding: null,
        closedTabId: resolvedTabId
      };
    }

    const tabs = await this.readLooseTrackedTabs(remainingTabIds);
    if (tabs.length === 0) {
      const liveWindow = binding.windowId !== null ? await this.waitForWindow(binding.windowId, 300) : null;
      if (!liveWindow) {
        await this.storage.delete(binding.id);
        return {
          binding: null,
          closedTabId: resolvedTabId
        };
      }

      const nextState: SessionBindingRecord = {
        id: binding.id,
        label: binding.label,
        color: binding.color,
        windowId: liveWindow.id,
        groupId: null,
        tabIds: [],
        activeTabId: null,
        primaryTabId: null
      };
      await this.storage.save(nextState);
      return {
        binding: {
          ...nextState,
          tabs: []
        },
        closedTabId: resolvedTabId
      };
    }

    const nextPrimaryTabId =
      binding.primaryTabId === resolvedTabId ? tabs[0]?.id ?? null : binding.primaryTabId;
    const nextActiveTabId =
      binding.activeTabId === resolvedTabId
        ? tabs.find((candidate) => candidate.active)?.id ?? nextPrimaryTabId ?? tabs[0]?.id ?? null
        : binding.activeTabId;
    const nextState: SessionBindingRecord = {
      id: binding.id,
      label: binding.label,
      color: binding.color,
      windowId: tabs[0]?.windowId ?? binding.windowId,
      groupId: tabs[0]?.groupId ?? binding.groupId,
      tabIds: tabs.map((candidate) => candidate.id),
      activeTabId: nextActiveTabId,
      primaryTabId: nextPrimaryTabId
    };
    await this.storage.save(nextState);
    return {
      binding: {
        ...nextState,
        tabs
      },
      closedTabId: resolvedTabId
    };
  }

  async reset(options: SessionBindingEnsureOptions = {}): Promise<SessionBindingEnsureResult> {
    const bindingId = this.normalizeBindingId(options.bindingId);
    await this.close(bindingId);
    return this.ensureBinding({
      ...options,
      bindingId
    });
  }

  async close(bindingId: string): Promise<{ ok: true }> {
    const state = await this.loadBindingRecord(bindingId);
    if (!state) {
      await this.storage.delete(bindingId);
      return { ok: true };
    }
    // Clear persisted state before closing the window so tab/window removal
    // listeners cannot race and resurrect an empty binding record.
    await this.storage.delete(bindingId);
    const trackedTabs = await this.collectBindingTabsForClose(state);
    for (const trackedTab of trackedTabs) {
      try {
        await this.browser.closeTab(trackedTab.id);
      } catch {
        // Ignore tabs that were already removed before explicit close.
      }
    }
    return { ok: true };
  }

  async resolveTarget(options: SessionBindingResolveTargetOptions = {}): Promise<SessionBindingTargetResolution> {
    if (typeof options.tabId === 'number') {
      const explicitTab = await this.browser.getTab(options.tabId);
      if (!explicitTab) {
        throw new Error(`No tab with id ${options.tabId}`);
      }
      return {
        tab: explicitTab,
        binding: null,
        resolution: 'explicit-tab',
        createdBinding: false,
        repaired: false,
        repairActions: []
      };
    }

    const explicitBindingId = typeof options.bindingId === 'string' ? this.normalizeBindingId(options.bindingId) : undefined;
    if (explicitBindingId) {
      const ensured = await this.ensureBinding({
        bindingId: explicitBindingId,
        focus: false
      });
      return this.buildBindingResolution(ensured, 'explicit-binding');
    }

    if (options.createIfMissing !== true) {
      const activeTab = await this.browser.getActiveTab();
      if (!activeTab) {
        throw new Error('No active tab');
      }
      return {
        tab: activeTab,
        binding: null,
        resolution: 'browser-active',
        createdBinding: false,
        repaired: false,
        repairActions: []
      };
    }

    throw new Error('bindingId is required when createIfMissing is true');
  }

  private normalizeBindingId(bindingId?: string): string {
    const candidate = bindingId?.trim();
    if (!candidate) {
      throw new Error('bindingId is required');
    }
    return candidate;
  }

  private normalizeState(state: SessionBindingRecord | null, bindingId: string, label?: string): SessionBindingRecord {
    return {
      id: bindingId,
      label: label?.trim() ? label.trim() : state?.label ?? DEFAULT_SESSION_BINDING_LABEL,
      color: state?.color ?? DEFAULT_SESSION_BINDING_COLOR,
      windowId: state?.windowId ?? null,
      groupId: state?.groupId ?? null,
      tabIds: state?.tabIds ?? [],
      activeTabId: state?.activeTabId ?? null,
      primaryTabId: state?.primaryTabId ?? null
    };
  }

  async listBindingRecords(): Promise<SessionBindingRecord[]> {
    return await this.storage.list();
  }

  private async loadBindingRecord(bindingId: string): Promise<SessionBindingRecord | null> {
    const normalizedBindingId = this.normalizeBindingId(bindingId);
    const state = await this.storage.load(normalizedBindingId);
    if (!state || state.id !== normalizedBindingId) {
      return null;
    }
    return this.normalizeState(state, normalizedBindingId);
  }

  private async buildBindingResolution(
    ensured: SessionBindingEnsureResult,
    resolution: 'explicit-binding' | 'default-binding'
  ): Promise<SessionBindingTargetResolution> {
    const tab = ensured.binding.tabs.find((item) => item.id === ensured.binding.activeTabId) ?? ensured.binding.tabs[0] ?? null;
    if (tab) {
      return {
        tab,
        binding: ensured.binding,
        resolution,
        createdBinding: ensured.created,
        repaired: ensured.repaired,
        repairActions: ensured.repairActions
      };
    }

    if (ensured.binding.activeTabId !== null) {
      const activeBindingTab = await this.waitForTrackedTab(ensured.binding.activeTabId, ensured.binding.windowId);
      if (activeBindingTab) {
        return {
          tab: activeBindingTab,
          binding: ensured.binding,
          resolution,
          createdBinding: ensured.created,
          repaired: ensured.repaired,
          repairActions: ensured.repairActions
        };
      }
    }

    const activeTab = await this.browser.getActiveTab();
    if (!activeTab) {
      throw new Error('No active tab');
    }
    return {
      tab: activeTab,
      binding: null,
      resolution: 'browser-active',
      createdBinding: ensured.created,
      repaired: ensured.repaired,
      repairActions: ensured.repairActions
    };
  }

  private async readTrackedTabs(tabIds: number[], windowId: number | null): Promise<SessionBindingTab[]> {
    const tabs = (
      await Promise.all(
        tabIds.map(async (tabId) => {
          const tab = await this.browser.getTab(tabId);
          if (!tab) {
            return null;
          }
          if (windowId !== null && tab.windowId !== windowId) {
            return null;
          }
          return tab;
        })
      )
    ).filter((tab): tab is SessionBindingTab => tab !== null);
    return tabs;
  }

  private async readLooseTrackedTabs(tabIds: number[]): Promise<SessionBindingTab[]> {
    const tabs = (
      await Promise.all(
        tabIds.map(async (tabId) => {
          return await this.browser.getTab(tabId);
        })
      )
    ).filter((tab): tab is SessionBindingTab => tab !== null);
    return tabs;
  }

  private collectCandidateTabIds(state: SessionBindingRecord): number[] {
    return [...new Set(state.tabIds.concat([state.activeTabId, state.primaryTabId].filter((value): value is number => typeof value === 'number')))];
  }

  private async rebindBindingWindow(state: SessionBindingRecord): Promise<{ window: SessionBindingWindow; tabs: SessionBindingTab[] } | null> {
    const candidateWindowIds: number[] = [];
    const pushWindowId = (windowId: number | null | undefined): void => {
      if (typeof windowId !== 'number') {
        return;
      }
      if (!candidateWindowIds.includes(windowId)) {
        candidateWindowIds.push(windowId);
      }
    };

    const group = state.groupId !== null ? await this.waitForGroup(state.groupId) : null;
    pushWindowId(group?.windowId);

    const trackedTabs = await this.readLooseTrackedTabs(this.collectCandidateTabIds(state));
    for (const tab of trackedTabs) {
      pushWindowId(tab.windowId);
    }

    for (const candidateWindowId of candidateWindowIds) {
      const window = await this.waitForWindow(candidateWindowId);
      if (!window) {
        continue;
      }
      let tabs = await this.readTrackedTabs(this.collectCandidateTabIds(state), candidateWindowId);
      if (tabs.length === 0 && group?.id !== null && group?.windowId === candidateWindowId) {
        const windowTabs = await this.waitForWindowTabs(candidateWindowId, WINDOW_TABS_LOOKUP_TIMEOUT_MS);
        tabs = windowTabs.filter((tab) => tab.groupId === group.id);
      }
      if (tabs.length === 0) {
        tabs = trackedTabs.filter((tab) => tab.windowId === candidateWindowId);
      }
      state.windowId = candidateWindowId;
      if (tabs.length > 0) {
        state.tabIds = [...new Set(tabs.map((tab) => tab.id))];
        if (state.primaryTabId === null || !state.tabIds.includes(state.primaryTabId)) {
          state.primaryTabId = tabs[0]?.id ?? null;
        }
        if (state.activeTabId === null || !state.tabIds.includes(state.activeTabId)) {
          state.activeTabId = tabs.find((tab) => tab.active)?.id ?? state.primaryTabId;
        }
      }
      return { window, tabs };
    }

    return null;
  }

  private async attachBindingToActiveWindow(state: SessionBindingRecord): Promise<SessionBindingWindow | null> {
    const activeTab = await this.browser.getActiveTab();
    if (!activeTab) {
      return null;
    }
    const window = await this.waitForWindow(activeTab.windowId, 300);
    if (!window) {
      return null;
    }
    state.windowId = window.id;
    state.groupId = null;
    state.tabIds = [];
    state.activeTabId = null;
    state.primaryTabId = null;
    return window;
  }

  private async findSharedBindingWindow(bindingId: string, excludedWindowIds: number[] = []): Promise<SessionBindingWindow | null> {
    const peers = (await this.storage.list()).filter((candidate) => candidate.id !== bindingId);
    const candidateWindowIds: number[] = [];
    const peerTabIds = new Set<number>();
    const peerGroupIds = new Set<number>();
    const pushWindowId = (windowId: number | null | undefined): void => {
      if (typeof windowId !== 'number') {
        return;
      }
      if (excludedWindowIds.includes(windowId) || candidateWindowIds.includes(windowId)) {
        return;
      }
      candidateWindowIds.push(windowId);
    };

    for (const peer of peers) {
      const trackedTabIds = this.collectCandidateTabIds(peer);
      pushWindowId(peer.windowId);
      for (const trackedTabId of trackedTabIds) {
        peerTabIds.add(trackedTabId);
      }
      if (peer.groupId !== null) {
        const group = await this.waitForGroup(peer.groupId, 300);
        if (group) {
          peerGroupIds.add(group.id);
          pushWindowId(group.windowId);
        }
      }
      const trackedTabs = await this.readLooseTrackedTabs(trackedTabIds);
      for (const tab of trackedTabs) {
        pushWindowId(tab.windowId);
      }
    }

    for (const windowId of candidateWindowIds) {
      const window = await this.waitForWindow(windowId, 300);
      if (window) {
        const windowTabs = await this.readStableWindowTabs(window.id, WINDOW_TABS_LOOKUP_TIMEOUT_MS, 150);
        const ownedTabs = windowTabs.filter(
          (tab) => peerTabIds.has(tab.id) || (tab.groupId !== null && peerGroupIds.has(tab.groupId))
        );
        if (ownedTabs.length === 0) {
          continue;
        }
        return window;
      }
    }

    return null;
  }

  private async recoverBindingTabs(state: SessionBindingRecord, existingTabs: SessionBindingTab[]): Promise<SessionBindingTab[]> {
    if (state.windowId === null) {
      return existingTabs;
    }

    const candidates = await this.waitForWindowTabs(state.windowId, 500);
    if (candidates.length === 0) {
      return existingTabs;
    }

    const trackedIds = new Set(state.tabIds);
    const trackedTabs = candidates.filter((tab) => trackedIds.has(tab.id));
    if (trackedTabs.length > existingTabs.length) {
      return trackedTabs;
    }

    if (state.groupId !== null) {
      const groupedTabs = candidates.filter((tab) => tab.groupId === state.groupId);
      if (groupedTabs.length > 0) {
        return groupedTabs;
      }
    }

    const preferredIds = new Set([state.activeTabId, state.primaryTabId].filter((value): value is number => typeof value === 'number'));
    const preferredTabs = candidates.filter((tab) => preferredIds.has(tab.id));
    if (preferredTabs.length > existingTabs.length) {
      return preferredTabs;
    }

    return existingTabs;
  }

  private resolveFocusTabId(binding: Pick<SessionBindingInfo, 'activeTabId' | 'primaryTabId' | 'tabs'>): number | null {
    return binding.activeTabId ?? binding.primaryTabId ?? binding.tabs[0]?.id ?? null;
  }

  private withFocusedTab(binding: SessionBindingInfo, targetTabId: number): SessionBindingInfo {
    return {
      ...binding,
      activeTabId: targetTabId,
      tabs: binding.tabs.map((tab) => ({
        ...tab,
        active: tab.id === targetTabId
      }))
    };
  }

  private async focusBindingWindow(windowId: number, tabId: number): Promise<void> {
    await this.browser.updateWindow(windowId, { focused: true });
    await this.browser.updateTab(tabId, { active: true });
    const focusedTab = await this.waitForTrackedTab(tabId, windowId, 500);
    if (!focusedTab?.active) {
      await this.browser.updateTab(tabId, { active: true });
    }
  }

  private async collectBindingTabsForClose(state: SessionBindingRecord): Promise<SessionBindingTab[]> {
    const trackedTabs = await this.readLooseTrackedTabs(this.collectCandidateTabIds(state));
    if (state.windowId === null || state.groupId === null) {
      return trackedTabs;
    }
    const windowTabs = await this.waitForWindowTabs(state.windowId, 300);
    const groupedTabs = windowTabs.filter((tab) => tab.groupId === state.groupId);
    const merged = new Map<number, SessionBindingTab>();
    for (const tab of [...trackedTabs, ...groupedTabs]) {
      merged.set(tab.id, tab);
    }
    return [...merged.values()];
  }

  private async createBindingTab(options: { windowId: number | null; url: string; active: boolean }): Promise<SessionBindingTab> {
    if (options.windowId === null) {
      throw new Error('Binding window is unavailable');
    }

    const deadline = Date.now() + 1_500;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      try {
        return await this.browser.createTab({
          windowId: options.windowId,
          url: options.url,
          active: options.active
        });
      } catch (error) {
        if (!this.isMissingWindowError(error)) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.delay(50);
      }
    }

    throw lastError ?? new Error(`No window with id: ${options.windowId}.`);
  }

  private async inspectBinding(bindingId: string): Promise<SessionBindingInfo | null> {
    const state = await this.loadBindingRecord(bindingId);
    if (!state) {
      return null;
    }

    let tabs = await this.readTrackedTabs(state.tabIds, state.windowId);
    tabs = await this.recoverBindingTabs(state, tabs);
    const activeTab = state.activeTabId !== null ? await this.waitForTrackedTab(state.activeTabId, state.windowId, 300) : null;
    if (activeTab && !tabs.some((tab) => tab.id === activeTab.id)) {
      tabs = [...tabs, activeTab];
    }
    if (tabs.length === 0 && state.primaryTabId !== null) {
      const primaryTab = await this.waitForTrackedTab(state.primaryTabId, state.windowId, 300);
      if (primaryTab) {
        tabs = [primaryTab];
      }
    }

    return {
      ...state,
      tabIds: [...new Set(state.tabIds.concat(tabs.map((tab) => tab.id)))],
      tabs
    };
  }

  private async resolveReusablePrimaryTab(binding: SessionBindingInfo, allowReuse: boolean): Promise<SessionBindingTab | null> {
    if (binding.windowId === null) {
      return null;
    }
    if (binding.primaryTabId !== null) {
      const trackedPrimary = binding.tabs.find((tab) => tab.id === binding.primaryTabId) ?? (await this.waitForTrackedTab(binding.primaryTabId, binding.windowId));
      if (trackedPrimary && (allowReuse || this.isReusableBlankSessionBindingTab(trackedPrimary, binding))) {
        return trackedPrimary;
      }
    }
    const windowTabs = await this.waitForWindowTabs(binding.windowId, WINDOW_TABS_LOOKUP_TIMEOUT_MS);
    if (windowTabs.length !== 1) {
      return null;
    }
    const candidate = windowTabs[0]!;
    if (allowReuse || this.isReusableBlankSessionBindingTab(candidate, binding)) {
      return candidate;
    }
    return null;
  }

  private isReusableBlankSessionBindingTab(tab: SessionBindingTab, binding: SessionBindingInfo): boolean {
    if (binding.tabIds.length > 1) {
      return false;
    }
    const normalizedUrl = tab.url.trim().toLowerCase();
    return normalizedUrl === '' || normalizedUrl === DEFAULT_SESSION_BINDING_URL;
  }

  private async waitForWindow(windowId: number, timeoutMs = WINDOW_LOOKUP_TIMEOUT_MS): Promise<SessionBindingWindow | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const window = await this.browser.getWindow(windowId);
      if (window) {
        return window;
      }
      await this.delay(50);
    }
    return null;
  }

  private async waitForGroup(groupId: number, timeoutMs = GROUP_LOOKUP_TIMEOUT_MS): Promise<SessionBindingGroup | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const group = await this.browser.getGroup(groupId);
      if (group) {
        return group;
      }
      await this.delay(50);
    }
    return null;
  }

  private async waitForTrackedTab(tabId: number, windowId: number | null, timeoutMs = 1_000): Promise<SessionBindingTab | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await this.browser.getTab(tabId);
      if (tab && (windowId === null || tab.windowId === windowId)) {
        return tab;
      }
      await this.delay(50);
    }
    return null;
  }

  private async waitForWindowTabs(windowId: number, timeoutMs = WINDOW_TABS_LOOKUP_TIMEOUT_MS): Promise<SessionBindingTab[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tabs = await this.browser.listTabs({ windowId });
      if (tabs.length > 0) {
        return tabs;
      }
      await this.delay(50);
    }
    return [];
  }

  private async readStableWindowTabs(
    windowId: number,
    timeoutMs = WINDOW_TABS_LOOKUP_TIMEOUT_MS,
    settleMs = 150
  ): Promise<SessionBindingTab[]> {
    const deadline = Date.now() + timeoutMs;
    let bestTabs: SessionBindingTab[] = [];
    let bestSignature = '';
    let lastSignature = '';
    let stableSince = 0;

    while (Date.now() < deadline) {
      const tabs = await this.browser.listTabs({ windowId });
      if (tabs.length > 0) {
        const signature = this.windowTabSnapshotSignature(tabs);
        if (tabs.length > bestTabs.length || (tabs.length === bestTabs.length && signature !== bestSignature)) {
          bestTabs = tabs;
          bestSignature = signature;
        }
        if (signature !== lastSignature) {
          lastSignature = signature;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= settleMs) {
          return bestTabs;
        }
      }
      await this.delay(50);
    }

    return bestTabs;
  }

  private windowTabSnapshotSignature(tabs: SessionBindingTab[]): string {
    return [...tabs]
      .map((tab) => `${tab.id}:${tab.groupId ?? 'ungrouped'}`)
      .sort()
      .join('|');
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isMissingWindowError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('no window with id');
  }
}

export { SessionBindingManager };
