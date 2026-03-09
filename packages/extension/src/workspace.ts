export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_WORKSPACE_LABEL = 'bak agent';
export const DEFAULT_WORKSPACE_COLOR = 'blue';
export const DEFAULT_WORKSPACE_URL = 'about:blank';

export type WorkspaceColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface WorkspaceTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  groupId: number | null;
}

export interface WorkspaceWindow {
  id: number;
  focused: boolean;
}

export interface WorkspaceGroup {
  id: number;
  windowId: number;
  title: string;
  color: WorkspaceColor;
  collapsed: boolean;
}

export interface WorkspaceRecord {
  id: string;
  label: string;
  color: WorkspaceColor;
  windowId: number | null;
  groupId: number | null;
  tabIds: number[];
  activeTabId: number | null;
  primaryTabId: number | null;
}

export interface WorkspaceInfo extends WorkspaceRecord {
  tabs: WorkspaceTab[];
}

export interface WorkspaceEnsureResult {
  workspace: WorkspaceInfo;
  created: boolean;
  repaired: boolean;
  repairActions: string[];
}

export interface WorkspaceTargetResolution {
  tab: WorkspaceTab;
  workspace: WorkspaceInfo | null;
  resolution: 'explicit-tab' | 'explicit-workspace' | 'default-workspace' | 'browser-active';
  createdWorkspace: boolean;
  repaired: boolean;
  repairActions: string[];
}

export interface WorkspaceStorage {
  load(): Promise<WorkspaceRecord | null>;
  save(state: WorkspaceRecord | null): Promise<void>;
}

export interface WorkspaceBrowser {
  getTab(tabId: number): Promise<WorkspaceTab | null>;
  getActiveTab(): Promise<WorkspaceTab | null>;
  listTabs(filter?: { windowId?: number }): Promise<WorkspaceTab[]>;
  createTab(options: { windowId?: number; url?: string; active?: boolean }): Promise<WorkspaceTab>;
  updateTab(tabId: number, options: { active?: boolean; url?: string }): Promise<WorkspaceTab>;
  closeTab(tabId: number): Promise<void>;
  getWindow(windowId: number): Promise<WorkspaceWindow | null>;
  createWindow(options: { url?: string; focused?: boolean }): Promise<WorkspaceWindow>;
  updateWindow(windowId: number, options: { focused?: boolean }): Promise<WorkspaceWindow>;
  closeWindow(windowId: number): Promise<void>;
  getGroup(groupId: number): Promise<WorkspaceGroup | null>;
  groupTabs(tabIds: number[], groupId?: number): Promise<number>;
  updateGroup(groupId: number, options: { title?: string; color?: WorkspaceColor; collapsed?: boolean }): Promise<WorkspaceGroup>;
}

export interface WorkspaceEnsureOptions {
  workspaceId?: string;
  focus?: boolean;
  initialUrl?: string;
}

export interface WorkspaceOpenTabOptions {
  workspaceId?: string;
  url?: string;
  active?: boolean;
  focus?: boolean;
}

export interface WorkspaceResolveTargetOptions {
  tabId?: number;
  workspaceId?: string;
  createIfMissing?: boolean;
}

export class WorkspaceManager {
  private readonly storage: WorkspaceStorage;
  private readonly browser: WorkspaceBrowser;

  constructor(storage: WorkspaceStorage, browser: WorkspaceBrowser) {
    this.storage = storage;
    this.browser = browser;
  }

  async getWorkspaceInfo(workspaceId = DEFAULT_WORKSPACE_ID): Promise<WorkspaceInfo | null> {
    return this.inspectWorkspace(workspaceId);
  }

  async ensureWorkspace(options: WorkspaceEnsureOptions = {}): Promise<WorkspaceEnsureResult> {
    const workspaceId = this.normalizeWorkspaceId(options.workspaceId);
    const repairActions: string[] = [];
    const initialUrl = options.initialUrl ?? DEFAULT_WORKSPACE_URL;
    const persisted = await this.storage.load();
    const created = !persisted;
    let state = this.normalizeState(persisted, workspaceId);

    const originalWindowId = state.windowId;
    let window = state.windowId !== null ? await this.waitForWindow(state.windowId) : null;
    let tabs: WorkspaceTab[] = [];
    if (!window) {
      const rebound = await this.rebindWorkspaceWindow(state);
      if (rebound) {
        window = rebound.window;
        tabs = rebound.tabs;
        if (originalWindowId !== rebound.window.id) {
          repairActions.push('rebound-window');
        }
      }
    }
    if (!window) {
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
      tabs = await this.waitForWindowTabs(createdWindow.id);
      state.tabIds = tabs.map((tab) => tab.id);
      if (state.primaryTabId === null) {
        state.primaryTabId = tabs[0]?.id ?? null;
      }
      if (state.activeTabId === null) {
        state.activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null;
      }
      repairActions.push(created ? 'created-window' : 'recreated-window');
    }

    tabs = tabs.length > 0 ? tabs : await this.readTrackedTabs(state.tabIds, state.windowId);
    const recoveredTabs = await this.recoverWorkspaceTabs(state, tabs);
    if (recoveredTabs.length > tabs.length) {
      tabs = recoveredTabs;
      repairActions.push('recovered-tracked-tabs');
    }
    if (tabs.length !== state.tabIds.length) {
      repairActions.push('pruned-missing-tabs');
    }
    state.tabIds = tabs.map((tab) => tab.id);

    if (tabs.length === 0) {
      const primary = await this.createWorkspaceTab({
        windowId: state.windowId,
        url: initialUrl,
        active: true
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

    let group = state.groupId !== null ? await this.browser.getGroup(state.groupId) : null;
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
    tabs = await this.recoverWorkspaceTabs(state, tabs);
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

    if (options.focus === true && state.activeTabId !== null) {
      await this.browser.updateTab(state.activeTabId, { active: true });
      window = await this.browser.updateWindow(state.windowId!, { focused: true });
      void window;
      repairActions.push('focused-window');
    }

    await this.storage.save(state);

    return {
      workspace: {
        ...state,
        tabs
      },
      created,
      repaired: repairActions.length > 0,
      repairActions
    };
  }

  async openTab(options: WorkspaceOpenTabOptions = {}): Promise<{ workspace: WorkspaceInfo; tab: WorkspaceTab }> {
    const workspaceId = this.normalizeWorkspaceId(options.workspaceId);
    const hadWorkspace = (await this.loadWorkspaceRecord(workspaceId)) !== null;
    const ensured = await this.ensureWorkspace({
      workspaceId,
      focus: false,
      initialUrl: hadWorkspace ? options.url ?? DEFAULT_WORKSPACE_URL : DEFAULT_WORKSPACE_URL
    });
    let state = { ...ensured.workspace, tabIds: [...ensured.workspace.tabIds], tabs: [...ensured.workspace.tabs] };
    if (state.windowId !== null && state.tabs.length === 0) {
      const rebound = await this.rebindWorkspaceWindow(state);
      if (rebound) {
        state.windowId = rebound.window.id;
        state.tabs = rebound.tabs;
        state.tabIds = [...new Set(rebound.tabs.map((tab) => tab.id))];
      }
    }
    const active = options.active === true;
    const desiredUrl = options.url ?? DEFAULT_WORKSPACE_URL;
    let reusablePrimaryTab = await this.resolveReusablePrimaryTab(
      state,
      ensured.created || ensured.repairActions.includes('recreated-window') || ensured.repairActions.includes('created-primary-tab')
    );

    let createdTab: WorkspaceTab;
    try {
      createdTab = reusablePrimaryTab
        ? await this.browser.updateTab(reusablePrimaryTab.id, {
            url: desiredUrl,
            active
          })
        : await this.createWorkspaceTab({
            windowId: state.windowId,
            url: desiredUrl,
            active
          });
    } catch (error) {
      if (!this.isMissingWindowError(error)) {
        throw error;
      }
      const repaired = await this.ensureWorkspace({
        workspaceId,
        focus: false,
        initialUrl: desiredUrl
      });
      state = { ...repaired.workspace };
      reusablePrimaryTab = await this.resolveReusablePrimaryTab(state, true);
      createdTab = reusablePrimaryTab
        ? await this.browser.updateTab(reusablePrimaryTab.id, {
            url: desiredUrl,
            active
          })
        : await this.createWorkspaceTab({
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
    const nextState: WorkspaceRecord = {
      id: state.id,
      label: state.label,
      color: state.color,
      windowId: state.windowId,
      groupId,
      tabIds: nextTabIds,
      activeTabId: createdTab.id,
      primaryTabId: state.primaryTabId ?? createdTab.id
    };

    if (options.focus === true) {
      await this.browser.updateTab(createdTab.id, { active: true });
      await this.browser.updateWindow(state.windowId!, { focused: true });
    }

    await this.storage.save(nextState);
    const tabs = await this.readTrackedTabs(nextState.tabIds, nextState.windowId);
    const tab = tabs.find((item) => item.id === createdTab.id) ?? createdTab;
    return {
      workspace: {
        ...nextState,
        tabs
      },
      tab
    };
  }

  async listTabs(workspaceId = DEFAULT_WORKSPACE_ID): Promise<{ workspace: WorkspaceInfo; tabs: WorkspaceTab[] }> {
    const ensured = await this.inspectWorkspace(workspaceId);
    if (!ensured) {
      throw new Error(`Workspace ${workspaceId} does not exist`);
    }
    return {
      workspace: ensured,
      tabs: ensured.tabs
    };
  }

  async getActiveTab(workspaceId = DEFAULT_WORKSPACE_ID): Promise<{ workspace: WorkspaceInfo; tab: WorkspaceTab | null }> {
    const ensured = await this.inspectWorkspace(workspaceId);
    if (!ensured) {
      const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
      return {
        workspace: {
          ...this.normalizeState(null, normalizedWorkspaceId),
          tabs: []
        },
        tab: null
      };
    }
    return {
      workspace: ensured,
      tab: ensured.tabs.find((tab) => tab.id === ensured.activeTabId) ?? null
    };
  }

  async setActiveTab(tabId: number, workspaceId = DEFAULT_WORKSPACE_ID): Promise<{ workspace: WorkspaceInfo; tab: WorkspaceTab }> {
    const ensured = await this.ensureWorkspace({ workspaceId });
    if (!ensured.workspace.tabIds.includes(tabId)) {
      throw new Error(`Tab ${tabId} does not belong to workspace ${workspaceId}`);
    }
    const nextState: WorkspaceRecord = {
      id: ensured.workspace.id,
      label: ensured.workspace.label,
      color: ensured.workspace.color,
      windowId: ensured.workspace.windowId,
      groupId: ensured.workspace.groupId,
      tabIds: [...ensured.workspace.tabIds],
      activeTabId: tabId,
      primaryTabId: ensured.workspace.primaryTabId ?? tabId
    };
    await this.storage.save(nextState);
    const tabs = await this.readTrackedTabs(nextState.tabIds, nextState.windowId);
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} is missing from workspace ${workspaceId}`);
    }
    return {
      workspace: {
        ...nextState,
        tabs
      },
      tab
    };
  }

  async focus(workspaceId = DEFAULT_WORKSPACE_ID): Promise<{ ok: true; workspace: WorkspaceInfo }> {
    const ensured = await this.ensureWorkspace({ workspaceId, focus: false });
    if (ensured.workspace.activeTabId !== null) {
      await this.browser.updateTab(ensured.workspace.activeTabId, { active: true });
    }
    if (ensured.workspace.windowId !== null) {
      await this.browser.updateWindow(ensured.workspace.windowId, { focused: true });
    }
    const refreshed = await this.ensureWorkspace({ workspaceId, focus: false });
    return { ok: true, workspace: refreshed.workspace };
  }

  async reset(options: WorkspaceEnsureOptions = {}): Promise<WorkspaceEnsureResult> {
    await this.close(options.workspaceId);
    return this.ensureWorkspace(options);
  }

  async close(workspaceId = DEFAULT_WORKSPACE_ID): Promise<{ ok: true }> {
    const state = await this.storage.load();
    if (!state || state.id !== workspaceId) {
      await this.storage.save(null);
      return { ok: true };
    }
    // Clear persisted state before closing the window so tab/window removal
    // listeners cannot race and resurrect an empty workspace record.
    await this.storage.save(null);
    if (state.windowId !== null) {
      const existingWindow = await this.browser.getWindow(state.windowId);
      if (existingWindow) {
        await this.browser.closeWindow(state.windowId);
      }
    }
    return { ok: true };
  }

  async resolveTarget(options: WorkspaceResolveTargetOptions = {}): Promise<WorkspaceTargetResolution> {
    if (typeof options.tabId === 'number') {
      const explicitTab = await this.browser.getTab(options.tabId);
      if (!explicitTab) {
        throw new Error(`No tab with id ${options.tabId}`);
      }
      return {
        tab: explicitTab,
        workspace: null,
        resolution: 'explicit-tab',
        createdWorkspace: false,
        repaired: false,
        repairActions: []
      };
    }

    const explicitWorkspaceId = typeof options.workspaceId === 'string' ? this.normalizeWorkspaceId(options.workspaceId) : undefined;
    if (explicitWorkspaceId) {
      const ensured = await this.ensureWorkspace({
        workspaceId: explicitWorkspaceId,
        focus: false
      });
      return this.buildWorkspaceResolution(ensured, 'explicit-workspace');
    }

    const existingWorkspace = await this.loadWorkspaceRecord(DEFAULT_WORKSPACE_ID);
    if (existingWorkspace) {
      const ensured = await this.ensureWorkspace({
        workspaceId: existingWorkspace.id,
        focus: false
      });
      return this.buildWorkspaceResolution(ensured, 'default-workspace');
    }

    if (options.createIfMissing !== true) {
      const activeTab = await this.browser.getActiveTab();
      if (!activeTab) {
        throw new Error('No active tab');
      }
      return {
        tab: activeTab,
        workspace: null,
        resolution: 'browser-active',
        createdWorkspace: false,
        repaired: false,
        repairActions: []
      };
    }

    const ensured = await this.ensureWorkspace({
      workspaceId: DEFAULT_WORKSPACE_ID,
      focus: false
    });
    return this.buildWorkspaceResolution(ensured, 'default-workspace');
  }

  private normalizeWorkspaceId(workspaceId?: string): string {
    const candidate = workspaceId?.trim();
    if (!candidate) {
      return DEFAULT_WORKSPACE_ID;
    }
    if (candidate !== DEFAULT_WORKSPACE_ID) {
      throw new Error(`Unsupported workspace id: ${candidate}`);
    }
    return candidate;
  }

  private normalizeState(state: WorkspaceRecord | null, workspaceId: string): WorkspaceRecord {
    return {
      id: workspaceId,
      label: state?.label ?? DEFAULT_WORKSPACE_LABEL,
      color: state?.color ?? DEFAULT_WORKSPACE_COLOR,
      windowId: state?.windowId ?? null,
      groupId: state?.groupId ?? null,
      tabIds: state?.tabIds ?? [],
      activeTabId: state?.activeTabId ?? null,
      primaryTabId: state?.primaryTabId ?? null
    };
  }

  private async loadWorkspaceRecord(workspaceId = DEFAULT_WORKSPACE_ID): Promise<WorkspaceRecord | null> {
    const normalizedWorkspaceId = this.normalizeWorkspaceId(workspaceId);
    const state = await this.storage.load();
    if (!state || state.id !== normalizedWorkspaceId) {
      return null;
    }
    return this.normalizeState(state, normalizedWorkspaceId);
  }

  private async buildWorkspaceResolution(
    ensured: WorkspaceEnsureResult,
    resolution: 'explicit-workspace' | 'default-workspace'
  ): Promise<WorkspaceTargetResolution> {
    const tab = ensured.workspace.tabs.find((item) => item.id === ensured.workspace.activeTabId) ?? ensured.workspace.tabs[0] ?? null;
    if (tab) {
      return {
        tab,
        workspace: ensured.workspace,
        resolution,
        createdWorkspace: ensured.created,
        repaired: ensured.repaired,
        repairActions: ensured.repairActions
      };
    }

    if (ensured.workspace.activeTabId !== null) {
      const activeWorkspaceTab = await this.waitForTrackedTab(ensured.workspace.activeTabId, ensured.workspace.windowId);
      if (activeWorkspaceTab) {
        return {
          tab: activeWorkspaceTab,
          workspace: ensured.workspace,
          resolution,
          createdWorkspace: ensured.created,
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
      workspace: null,
      resolution: 'browser-active',
      createdWorkspace: ensured.created,
      repaired: ensured.repaired,
      repairActions: ensured.repairActions
    };
  }

  private async readTrackedTabs(tabIds: number[], windowId: number | null): Promise<WorkspaceTab[]> {
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
    ).filter((tab): tab is WorkspaceTab => tab !== null);
    return tabs;
  }

  private async readLooseTrackedTabs(tabIds: number[]): Promise<WorkspaceTab[]> {
    const tabs = (
      await Promise.all(
        tabIds.map(async (tabId) => {
          return await this.browser.getTab(tabId);
        })
      )
    ).filter((tab): tab is WorkspaceTab => tab !== null);
    return tabs;
  }

  private collectCandidateTabIds(state: WorkspaceRecord): number[] {
    return [...new Set(state.tabIds.concat([state.activeTabId, state.primaryTabId].filter((value): value is number => typeof value === 'number')))];
  }

  private async rebindWorkspaceWindow(state: WorkspaceRecord): Promise<{ window: WorkspaceWindow; tabs: WorkspaceTab[] } | null> {
    const candidateWindowIds: number[] = [];
    const pushWindowId = (windowId: number | null | undefined): void => {
      if (typeof windowId !== 'number') {
        return;
      }
      if (!candidateWindowIds.includes(windowId)) {
        candidateWindowIds.push(windowId);
      }
    };

    const group = state.groupId !== null ? await this.browser.getGroup(state.groupId) : null;
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
        const windowTabs = await this.waitForWindowTabs(candidateWindowId, 750);
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

  private async recoverWorkspaceTabs(state: WorkspaceRecord, existingTabs: WorkspaceTab[]): Promise<WorkspaceTab[]> {
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

  private async createWorkspaceTab(options: { windowId: number | null; url: string; active: boolean }): Promise<WorkspaceTab> {
    if (options.windowId === null) {
      throw new Error('Workspace window is unavailable');
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

  private async inspectWorkspace(workspaceId = DEFAULT_WORKSPACE_ID): Promise<WorkspaceInfo | null> {
    const state = await this.loadWorkspaceRecord(workspaceId);
    if (!state) {
      return null;
    }

    let tabs = await this.readTrackedTabs(state.tabIds, state.windowId);
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

  private async resolveReusablePrimaryTab(workspace: WorkspaceInfo, allowReuse: boolean): Promise<WorkspaceTab | null> {
    if (workspace.windowId === null) {
      return null;
    }
    if (workspace.primaryTabId !== null) {
      const trackedPrimary = workspace.tabs.find((tab) => tab.id === workspace.primaryTabId) ?? (await this.waitForTrackedTab(workspace.primaryTabId, workspace.windowId));
      if (trackedPrimary && (allowReuse || this.isReusableBlankWorkspaceTab(trackedPrimary, workspace))) {
        return trackedPrimary;
      }
    }
    const windowTabs = await this.waitForWindowTabs(workspace.windowId, 750);
    if (windowTabs.length !== 1) {
      return null;
    }
    const candidate = windowTabs[0]!;
    if (allowReuse || this.isReusableBlankWorkspaceTab(candidate, workspace)) {
      return candidate;
    }
    return null;
  }

  private isReusableBlankWorkspaceTab(tab: WorkspaceTab, workspace: WorkspaceInfo): boolean {
    if (workspace.tabIds.length > 1) {
      return false;
    }
    const normalizedUrl = tab.url.trim().toLowerCase();
    return normalizedUrl === '' || normalizedUrl === DEFAULT_WORKSPACE_URL;
  }

  private async waitForWindow(windowId: number, timeoutMs = 750): Promise<WorkspaceWindow | null> {
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

  private async waitForTrackedTab(tabId: number, windowId: number | null, timeoutMs = 1_000): Promise<WorkspaceTab | null> {
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

  private async waitForWindowTabs(windowId: number, timeoutMs = 1_000): Promise<WorkspaceTab[]> {
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

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isMissingWindowError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('no window with id');
  }
}
