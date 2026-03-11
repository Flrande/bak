import { expect, test, type Page } from '@playwright/test';
import { runCli, runCliFailure } from '../helpers/cli';
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

function runHarnessCli<T = unknown>(args: string[]): T {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return runCli(args, harness.rpcPort, harness.dataDir, harness.sessionId);
}

function runHarnessCliFailure(args: string[]): string {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return runCliFailure(args, harness.rpcPort, harness.dataDir, harness.sessionId);
}

function cliErrorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${String((error as { stderr?: string }).stderr ?? '')}` : String(error);
}

async function runHarnessCliWithRetry<T = unknown>(args: string[], timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return runHarnessCli<T>(args);
    } catch (error) {
      const message = cliErrorText(error);
      lastError = error;
      if (!message.includes('E_TIMEOUT') && !message.includes('E_NOT_READY')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'CLI command failed')));
}

async function openWorkspacePage(path: string): Promise<{ page: Page; tabId: number; url: string }> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  const marker = `__workspace=${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const separator = path.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
  const deadline = Date.now() + 45_000;
  let opened: { tab: { id: number; url: string } } | null = null;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await runHarnessCliWithRetry(['session', 'ensure']);
      opened = await runHarnessCliWithRetry<{ tab: { id: number; url: string } }>(['session', 'open-tab', '--url', url]);
      break;
    } catch (error) {
      const cliError = cliErrorText(error);
      lastError = error;
      if (!cliError.includes('E_TIMEOUT') && !cliError.includes('E_NOT_READY')) {
        throw error;
      }

      const existingPage = harness.context.pages().find((candidate) => candidate.url().includes(marker));
      if (existingPage) {
        const listed = runHarnessCli<{ tabs: Array<{ id: number; url: string }> }>(['session', 'list-tabs']);
        const matchingTab = listed.tabs.find((candidate) => candidate.url.includes(marker));
        if (matchingTab) {
          opened = { tab: matchingTab };
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!opened) {
    throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Expected workspace tab')));
  }

  expect(opened.tab.url).toContain(marker);
  await expect.poll(() => harness.context.pages().some((candidate) => candidate.url().includes(marker)), { timeout: 10_000 }).toBe(true);
  const page = must(
    harness.context.pages().find((candidate) => candidate.url().includes(marker)),
    'Expected workspace page'
  );
  return {
    page,
    tabId: opened.tab.id,
    url
  };
}

async function sessionActiveTabId(): Promise<number> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  const active = await harness.rpcCall<{ tab: { id: number } | null }>('session.getActiveTab');
  return must(active.tab?.id, 'Expected an active session tab');
}

async function sessionBrowserState(): Promise<{ browser: { windowId: number | null; groupId: number | null; tabIds: number[]; activeTabId: number | null; tabs: Array<{ id: number; url: string; groupId?: number | null; windowId?: number }> } | null }> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  return harness.rpcCall('session.listTabs');
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

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      const humanActiveBefore = await harness.rpcCall<{ tab: { windowId: number } | null }>('tabs.getActive');
      const humanWindowId = must(humanActiveBefore.tab?.windowId, 'Expected active human window');
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(humanPage.locator('#name-input')).toBeVisible();

      const workspace = await openWorkspacePage('/spa.html');
      const info = await sessionBrowserState();
      const workspaceWindowId = must(info.browser?.windowId, 'Expected workspace window id');
      await expect(workspace.page).toHaveURL(/\/spa\.html\?/);

      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(humanPage.locator('#name-input')).toBeVisible();
      expect(workspaceWindowId).not.toBe(humanWindowId);

      const workspaceTabId = await sessionActiveTabId();
      const workspaceUrl = await harness.rpcCall<{ url: string }>('page.url', { tabId: workspaceTabId });

      expect(workspaceUrl.url).toMatch(/\/spa\.html(\?|$)/);
    } finally {
      await humanPage.close();
    }
  });

  test('keeps workspace inspection commands read-only before the first workspace tab exists', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      const beforeInfo = runHarnessCli<{ browser: null }>(['session', 'list-tabs']);
      const beforeActive = runHarnessCli<{ tab: null }>(['session', 'get-active-tab']);
      const beforePageCount = harness.context.pages().length;
      expect(beforeInfo.browser).toBeNull();
      expect(beforeActive.tab).toBeNull();
      expect(runHarnessCliFailure(['page', 'url'])).toContain('Session has no active tab');
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      expect(harness.context.pages()).toHaveLength(beforePageCount);

      const afterInfo = runHarnessCli<{ browser: null }>(['session', 'list-tabs']);
      expect(afterInfo.browser).toBeNull();
    } finally {
      await humanPage.close();
    }
  });

  test('routes page.goto without an explicit tab id into the workspace once it exists', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      await openWorkspacePage('/');

      runHarnessCli(['page', 'goto', SPA_URL]);
      runHarnessCli(['page', 'wait', '--mode', 'selector', '--value', '#tab-automation', '--timeout-ms', '5000']);

      const workspaceTabId = await sessionActiveTabId();
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

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    const first = await openWorkspacePage('/network.html');
    const second = await openWorkspacePage('/');
    try {
      const currentBefore = runHarnessCli<{ tab: { id: number } | null }>(['session', 'get-active-tab']);
      expect(currentBefore.tab?.id).toBe(second.tabId);

      const switched = runHarnessCli<{ tab: { id: number } }>(['session', 'set-active-tab', '--tab-id', String(first.tabId)]);
      expect(switched.tab.id).toBe(first.tabId);

      const currentAfter = runHarnessCli<{ tab: { id: number } | null }>(['session', 'get-active-tab']);
      expect(currentAfter.tab?.id).toBe(first.tabId);

      runHarnessCli(['page', 'goto', SPA_URL]);
      runHarnessCli(['page', 'wait', '--mode', 'selector', '--value', '#tab-automation', '--timeout-ms', '5000']);

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

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    const opened = await openWorkspacePage('/');
    try {
      const beforePages = harness.context.pages().length;
      const beforeInfo = await sessionBrowserState();
      const beforeWorkspace = must(beforeInfo.browser, 'Expected session browser metadata');

      const active = runHarnessCli<{ tab: { id: number } | null }>(['session', 'get-active-tab']);
      const listed = runHarnessCli<{ tabs: Array<{ id: number }> }>(['session', 'list-tabs']);
      const afterInfo = await sessionBrowserState();
      const afterWorkspace = must(afterInfo.browser, 'Expected session browser metadata');

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
      const before = must((await sessionBrowserState()).browser, 'Expected session browser metadata');
      const openedAgain = await openWorkspacePage('/network.html');
      const after = must((await sessionBrowserState()).browser, 'Expected session browser metadata');
      const ensured = runHarnessCli<{ browser: { windowId: number | null; tabIds: number[] } }>(['session', 'ensure']);

      expect(after.windowId).toBe(before.windowId);
      expect(ensured.browser.windowId).toBe(before.windowId);
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
      const before = await sessionBrowserState();
      const workspace = must(before.browser, 'Expected session browser metadata');
      const originalGroupId = must(workspace.groupId, 'Expected original group id');

      const ungrouped = runHarnessCli<{ tabId: number }>([
        'tabs',
        'new',
        '--window-id',
        String(workspace.windowId),
        '--url',
        'http://127.0.0.1:4173/network.html'
      ]);
      const tracked = runHarnessCli<{ tabs: Array<{ id: number }> }>(['session', 'list-tabs']);
      for (const tab of tracked.tabs) {
        runHarnessCli(['tabs', 'close', String(tab.id)]);
      }

      const repaired = runHarnessCli<{ browser: { groupId: number | null; tabIds: number[]; tabs: Array<{ id: number }> }; repaired: boolean; repairActions: string[] }>([
        'session',
        'ensure'
      ]);

      expect(repaired.repaired).toBe(true);
      expect(repaired.browser.groupId).not.toBe(originalGroupId);
      expect(repaired.browser.tabIds).toHaveLength(1);
      expect(repaired.browser.tabIds).not.toContain(ungrouped.tabId);
      expect(repaired.repairActions).toEqual(expect.arrayContaining(['recreated-group']));
      expect(
        repaired.repairActions.some((action) => action === 'created-primary-tab' || action === 'migrated-dirty-window')
      ).toBe(true);
    } finally {
      await opened.page.close().catch(() => undefined);
    }
  });

  test('does not focus the workspace window by default and focuses it only on explicit command', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      await openWorkspacePage('/');
      runHarnessCli(['page', 'goto', SPA_URL]);

      await expect(humanPage).toHaveURL(/\/form\.html\?/);

      runHarnessCli(['session', 'focus']);

      const afterFocus = await harness.rpcCall<{ tab: { id: number } | null }>('tabs.getActive');
      expect(afterFocus.tab?.id).toBe(await sessionActiveTabId());
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
      const info = await sessionBrowserState();
      const workspace = must(info.browser, 'Expected session browser metadata');
      const groupId = must(workspace.groupId, 'Expected workspace group id');

      expect(workspace.tabs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(workspace.tabs.map((tab) => tab.windowId)).size).toBe(1);
      expect(workspace.tabs.every((tab) => tab.groupId === groupId)).toBe(true);
    } finally {
      await first.page.close().catch(() => undefined);
      await second.page.close().catch(() => undefined);
    }
  });

  test('returns a stable workspace open-tab result when the requested URL is canonicalized by the browser', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      const opened = await runHarnessCliWithRetry<{ browser: { windowId: number | null }; tab: { id: number; url: string; windowId: number } }>([
        'session',
        'open-tab',
        '--url',
        'http://127.0.0.1:4173'
      ]);
      const info = await sessionBrowserState();
      const workspace = must(info.browser, 'Expected session browser metadata');

      expect(workspace.windowId).not.toBeNull();
      expect(opened.tab.windowId).toBe(workspace.windowId);
      expect(opened.tab.url).toBe('http://127.0.0.1:4173/');
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close().catch(() => undefined);
    }
  });

  test('session.close tears down the dedicated browser state and invalidates later session-scoped commands', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    const opened = await openWorkspacePage('/spa.html');
    try {
      const before = must((await sessionBrowserState()).browser, 'Expected session browser metadata before close');
      expect(before.windowId).not.toBeNull();

      const closed = runHarnessCli<{ closed: boolean }>(['session', 'close']);
      expect(closed.closed).toBe(true);

      expect(runHarnessCliFailure(['page', 'url'])).toContain('Session not found');
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close().catch(() => undefined);
      await opened.page.close().catch(() => undefined);
    }
  });

  test('recreates the workspace window after the dedicated window is closed', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const opened = await openWorkspacePage('/');
    const before = await sessionBrowserState();
    const windowId = before.browser?.windowId;
    const tracked = runHarnessCli<{ tabs: Array<{ id: number }> }>(['session', 'list-tabs']);
    for (const tab of tracked.tabs) {
      runHarnessCli(['tabs', 'close', String(tab.id)]);
    }

    const repaired = runHarnessCli<{ browser: { windowId: number | null; tabIds: number[] }; repaired: boolean; repairActions: string[] }>([
      'session',
      'ensure'
    ]);

    expect(repaired.repaired).toBe(true);
    expect(repaired.browser.windowId).not.toBeNull();
    if (windowId !== null && windowId !== undefined) {
      expect(repaired.browser.windowId).not.toBe(windowId);
    }
    expect(repaired.browser.tabIds.length).toBeGreaterThan(0);
  });

  test('rehomes a stale workspace that was incorrectly bound to the human window', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const humanPage = harness.page;
    await expect(humanPage).toHaveURL(/\/form\.html$/);
    const activeBefore = await harness.rpcCall<{ tab: { id: number; windowId: number } | null }>('tabs.getActive');
    const humanTabId = must(activeBefore.tab?.id, 'Expected active human tab');
    const humanWindowId = must(activeBefore.tab?.windowId, 'Expected active human window');
    const marker = `__orphaned=${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const orphanedUrl = `http://127.0.0.1:4173/spa.html?${marker}`;
    const beforePages = new Set(harness.context.pages());
    const orphaned = runHarnessCli<{ tabId: number }>(['tabs', 'new', '--window-id', String(humanWindowId), '--url', orphanedUrl]);
    await expect
      .poll(() => harness.context.pages().some((candidate) => !beforePages.has(candidate) && candidate.url().includes(marker)), {
        timeout: 10_000
      })
      .toBe(true);

    await harness.setWorkspaceState({
      id: harness.bindingId,
      label: 'bak agent',
      color: 'blue',
      windowId: humanWindowId,
      groupId: null,
      tabIds: [orphaned.tabId],
      activeTabId: orphaned.tabId,
      primaryTabId: orphaned.tabId
    });

    const opened = runHarnessCli<{ browser: { windowId: number | null }; tab: { id: number; windowId: number; url: string } }>([
      'session',
      'open-tab',
      '--url',
      HOME_URL
    ]);
    const info = await sessionBrowserState();
    const workspace = must(info.browser, 'Expected repaired session browser metadata');
    const allTabs = await harness.rpcCall<{ tabs: Array<{ id: number; windowId: number; url: string }> }>('tabs.list');
    const humanWindowTabs = allTabs.tabs.filter((tab) => tab.windowId === humanWindowId);

    expect(workspace.windowId).not.toBe(humanWindowId);
    expect(opened.browser.windowId).toBe(workspace.windowId);
    expect(opened.tab.windowId).toBe(workspace.windowId);
    expect(humanWindowTabs.some((tab) => tab.id === humanTabId)).toBe(true);
    expect(humanWindowTabs.some((tab) => tab.id === orphaned.tabId)).toBe(false);
    expect(humanWindowTabs.every((tab) => !tab.url.includes(marker))).toBe(true);
    await expect(humanPage).toHaveURL(/\/form\.html$/);
  });
});
