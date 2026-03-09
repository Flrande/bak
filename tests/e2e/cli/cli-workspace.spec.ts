import { expect, test, type Page } from '@playwright/test';
import { runCli } from '../helpers/cli';
import { createHarness, type E2EHarness } from '../helpers/harness';

const HOME_URL = 'http://127.0.0.1:4173/';
const SPA_URL = 'http://127.0.0.1:4173/spa.html';

let harness: E2EHarness | undefined;

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function openWorkspacePage(path: string): Promise<{ page: Page; tabId: number; url: string }> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  const marker = `__workspace=${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const separator = path.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
  const beforePages = new Set(harness.context.pages());
  const opened = runCli<{ tab: { id: number } }>(['workspace', 'open-tab', '--url', url], harness.rpcPort, harness.dataDir);
  await expect.poll(() => harness.context.pages().some((candidate) => !beforePages.has(candidate) && candidate.url().includes(marker)), { timeout: 10_000 }).toBe(true);
  const page = must(
    harness.context.pages().find((candidate) => !beforePages.has(candidate) && candidate.url().includes(marker)),
    'Expected workspace page'
  );
  return {
    page,
    tabId: opened.tab.id,
    url
  };
}

async function workspaceActiveTabId(): Promise<number> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  const active = await harness.rpcCall<{ tab: { id: number } | null }>('workspace.getActiveTab');
  return must(active.tab?.id, 'Expected an active workspace tab');
}

async function workspaceInfo(): Promise<{ workspace: { windowId: number | null; groupId: number | null; tabIds: number[]; activeTabId: number | null; tabs: Array<{ id: number; url: string; groupId?: number | null; windowId?: number }> } | null }> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return harness.rpcCall('workspace.info');
}

test.describe('CLI workspace workflows', () => {
  test.beforeEach(async () => {
    harness = await createHarness();
  });

  test.afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  test('keeps the human on page A while the agent works inside the dedicated workspace window', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openPage('/form.html');
    try {
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(humanPage.locator('#name-input')).toBeVisible();

      const workspace = await openWorkspacePage('/spa.html');
      await expect(workspace.page).toHaveURL(/\/spa\.html\?/);

      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(humanPage.locator('#name-input')).toBeVisible();

      const workspaceTabId = await workspaceActiveTabId();
      const workspaceUrl = await harness.rpcCall<{ url: string }>('page.url', { tabId: workspaceTabId });

      expect(workspaceUrl.url).toMatch(/\/spa\.html(\?|$)/);
    } finally {
      await humanPage.close();
    }
  });

  test('uses the active browser tab without creating a workspace when no workspace exists', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openPage('/form.html');
    try {
      const beforeInfo = await workspaceInfo();
      const beforePageCount = harness.context.pages().length;
      expect(beforeInfo.workspace).toBeNull();

      const current = runCli<{ url: string }>(['page', 'url'], harness.rpcPort, harness.dataDir);

      expect(current.url).toMatch(/\/form\.html\?/);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      expect(harness.context.pages()).toHaveLength(beforePageCount);

      const afterInfo = await workspaceInfo();
      expect(afterInfo.workspace).toBeNull();
    } finally {
      await humanPage.close();
    }
  });

  test('routes page.goto without an explicit tab id into the workspace once it exists', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openPage('/form.html');
    try {
      await openWorkspacePage('/');

      runCli(['page', 'goto', SPA_URL], harness.rpcPort, harness.dataDir);
      runCli(['page', 'wait', '--mode', 'selector', '--value', '#tab-automation', '--timeout-ms', '5000'], harness.rpcPort, harness.dataDir);

      const workspaceTabId = await workspaceActiveTabId();
      const workspaceUrl = await harness.rpcCall<{ url: string }>('page.url', { tabId: workspaceTabId });

      expect(workspaceUrl.url).toBe(SPA_URL);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close();
    }
  });

  test('switches the workspace current tab through the CLI and uses it for later default commands', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openPage('/form.html');
    const first = await openWorkspacePage('/network.html');
    const second = await openWorkspacePage('/');
    try {
      const currentBefore = runCli<{ tab: { id: number } | null }>(['workspace', 'get-active-tab'], harness.rpcPort, harness.dataDir);
      expect(currentBefore.tab?.id).toBe(second.tabId);

      const switched = runCli<{ tab: { id: number } }>(
        ['workspace', 'set-active-tab', '--tab-id', String(first.tabId)],
        harness.rpcPort,
        harness.dataDir
      );
      expect(switched.tab.id).toBe(first.tabId);

      const currentAfter = runCli<{ tab: { id: number } | null }>(['workspace', 'get-active-tab'], harness.rpcPort, harness.dataDir);
      expect(currentAfter.tab?.id).toBe(first.tabId);

      runCli(['page', 'goto', SPA_URL], harness.rpcPort, harness.dataDir);
      runCli(['page', 'wait', '--mode', 'selector', '--value', '#tab-automation', '--timeout-ms', '5000'], harness.rpcPort, harness.dataDir);

      await expect(first.page).toHaveURL(SPA_URL);
      await expect(second.page).toHaveURL(/\/\?/);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close().catch(() => undefined);
      await first.page.close().catch(() => undefined);
      await second.page.close().catch(() => undefined);
    }
  });

  test('keeps workspace inspection commands read-only and does not create extra blank tabs or windows', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openPage('/form.html');
    const opened = await openWorkspacePage('/');
    try {
      const beforePages = harness.context.pages().length;
      const beforeInfo = await workspaceInfo();
      const beforeWorkspace = must(beforeInfo.workspace, 'Expected workspace metadata');

      const active = runCli<{ tab: { id: number } | null }>(['workspace', 'get-active-tab'], harness.rpcPort, harness.dataDir);
      const listed = runCli<{ tabs: Array<{ id: number }> }>(['workspace', 'list-tabs'], harness.rpcPort, harness.dataDir);
      const afterInfo = await workspaceInfo();
      const afterWorkspace = must(afterInfo.workspace, 'Expected workspace metadata');

      expect(active.tab?.id).toBe(beforeWorkspace.activeTabId);
      expect(listed.tabs.map((tab) => tab.id).sort((a, b) => a - b)).toEqual([...beforeWorkspace.tabIds].sort((a, b) => a - b));
      expect(afterWorkspace.windowId).toBe(beforeWorkspace.windowId);
      expect(afterWorkspace.groupId).toBe(beforeWorkspace.groupId);
      expect(afterWorkspace.tabIds).toEqual(beforeWorkspace.tabIds);
      expect(harness.context.pages()).toHaveLength(beforePages);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(opened.page).toHaveURL(/\/\?/);
    } finally {
      await humanPage.close().catch(() => undefined);
      await opened.page.close().catch(() => undefined);
    }
  });

  test('repeated ensure and open-tab calls reuse the existing workspace window instead of spawning duplicate blank windows', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const first = await openWorkspacePage('/');
    try {
      const before = must((await workspaceInfo()).workspace, 'Expected workspace metadata');
      const openedAgain = await openWorkspacePage('/network.html');
      const after = must((await workspaceInfo()).workspace, 'Expected workspace metadata');
      const ensured = runCli<{ workspace: { windowId: number | null; tabIds: number[] } }>(['workspace', 'ensure'], harness.rpcPort, harness.dataDir);

      expect(after.windowId).toBe(before.windowId);
      expect(ensured.workspace.windowId).toBe(before.windowId);
      expect(new Set(after.tabs.map((tab) => tab.windowId)).size).toBe(1);
      expect(after.tabs.some((tab) => tab.url.includes('/network.html'))).toBe(true);
      await openedAgain.page.close().catch(() => undefined);
    } finally {
      await first.page.close().catch(() => undefined);
    }
  });

  test('repairs missing group and tracked tabs without hijacking unrelated tabs in the workspace window', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const opened = await openWorkspacePage('/');
    try {
      const before = await workspaceInfo();
      const workspace = must(before.workspace, 'Expected workspace metadata');
      const originalGroupId = must(workspace.groupId, 'Expected original group id');

      const ungrouped = runCli<{ tabId: number }>(
        ['tabs', 'new', '--window-id', String(workspace.windowId), '--url', 'http://127.0.0.1:4173/network.html'],
        harness.rpcPort,
        harness.dataDir
      );
      const tracked = runCli<{ tabs: Array<{ id: number }> }>(['workspace', 'list-tabs'], harness.rpcPort, harness.dataDir);
      for (const tab of tracked.tabs) {
        runCli(['tabs', 'close', String(tab.id)], harness.rpcPort, harness.dataDir);
      }

      const repaired = runCli<{ workspace: { groupId: number | null; tabIds: number[]; tabs: Array<{ id: number }> }; repaired: boolean; repairActions: string[] }>(
        ['workspace', 'ensure'],
        harness.rpcPort,
        harness.dataDir
      );

      expect(repaired.repaired).toBe(true);
      expect(repaired.workspace.groupId).not.toBe(originalGroupId);
      expect(repaired.workspace.tabIds).toHaveLength(1);
      expect(repaired.workspace.tabIds).not.toContain(ungrouped.tabId);
      expect(repaired.repairActions).toEqual(expect.arrayContaining(['created-primary-tab', 'recreated-group']));
    } finally {
      await opened.page.close().catch(() => undefined);
    }
  });

  test('does not focus the workspace window by default and focuses it only on explicit command', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openPage('/form.html');
    try {
      await openWorkspacePage('/');
      runCli(['page', 'goto', SPA_URL], harness.rpcPort, harness.dataDir);

      await expect(humanPage).toHaveURL(/\/form\.html\?/);

      runCli(['workspace', 'focus'], harness.rpcPort, harness.dataDir);

      const afterFocus = await harness.rpcCall<{ tab: { id: number } | null }>('tabs.getActive');
      expect(afterFocus.tab?.id).toBe(await workspaceActiveTabId());
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close();
    }
  });

  test('groups workspace-created tabs automatically inside the dedicated workspace window', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const first = await openWorkspacePage('/');
    const second = await openWorkspacePage('/spa.html');
    try {
      const info = await workspaceInfo();
      const workspace = must(info.workspace, 'Expected workspace metadata');
      const groupId = must(workspace.groupId, 'Expected workspace group id');

      expect(workspace.tabs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(workspace.tabs.map((tab) => tab.windowId)).size).toBe(1);
      expect(workspace.tabs.every((tab) => tab.groupId === groupId)).toBe(true);
    } finally {
      await first.page.close().catch(() => undefined);
      await second.page.close().catch(() => undefined);
    }
  });

  test('recreates the workspace window after the dedicated window is closed', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const opened = await openWorkspacePage('/');
    const before = await workspaceInfo();
    const windowId = before.workspace?.windowId;
    const tracked = runCli<{ tabs: Array<{ id: number }> }>(['workspace', 'list-tabs'], harness.rpcPort, harness.dataDir);
    for (const tab of tracked.tabs) {
      runCli(['tabs', 'close', String(tab.id)], harness.rpcPort, harness.dataDir);
    }

    const repaired = runCli<{ workspace: { windowId: number | null; tabIds: number[] }; repaired: boolean; repairActions: string[] }>(
      ['workspace', 'ensure'],
      harness.rpcPort,
      harness.dataDir
    );

    expect(repaired.repaired).toBe(true);
    expect(repaired.workspace.windowId).not.toBeNull();
    if (windowId !== null && windowId !== undefined) {
      expect(repaired.workspace.windowId).not.toBe(windowId);
    }
    expect(repaired.workspace.tabIds.length).toBeGreaterThan(0);
  });
});
