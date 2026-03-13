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

async function openSessionPage(path: string, options: { active?: boolean } = {}): Promise<{ page: Page; tabId: number; url: string }> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  const marker = `__binding=${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const separator = path.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
  const deadline = Date.now() + 45_000;
  let opened: { tab: { id: number; url: string } } | null = null;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await runHarnessCliWithRetry(['session', 'ensure']);
      const args = ['session', 'open-tab', '--url', url];
      if (options.active === true) {
        args.push('--active');
      }
      opened = await runHarnessCliWithRetry<{ tab: { id: number; url: string } }>(args);
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
    throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Expected session binding tab')));
  }

  expect(opened.tab.url).toContain(marker);
  if (options.active === true) {
    await expect
      .poll(
        () => runHarnessCli<{ tab: { id: number; url: string } | null }>(['session', 'get-active-tab']).tab?.url.includes(marker) ?? false,
        { timeout: 10_000 }
      )
      .toBe(true);
    const active = runHarnessCli<{ tab: { id: number; url: string } | null }>(['session', 'get-active-tab']).tab;
    opened = {
      tab: must(active, 'Expected an active session tab after open-tab --active')
    };
  }
  await expect.poll(() => harness.context.pages().some((candidate) => candidate.url().includes(marker)), { timeout: 10_000 }).toBe(true);
  const page = must(
    harness.context.pages().find((candidate) => candidate.url().includes(marker)),
    'Expected session page'
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

async function openNamedSessionPage(
  clientName: string,
  path: string,
  options: { active?: boolean } = {}
): Promise<{
  sessionId: string;
  browser: { windowId: number | null; groupId: number | null; tabIds: number[]; activeTabId: number | null };
  tab: { id: number; url: string; windowId: number; groupId: number | null };
  page: Page;
  url: string;
}> {
  if (!harness) {
    throw new Error('Harness not initialized');
  }
  const resolved = await harness.rpcCall<{ sessionId: string }>('session.resolve', { clientName });
  const sessionId = resolved.sessionId;
  const marker = `__binding=${clientName}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const separator = path.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
  await harness.rpcCall('session.ensure', { sessionId });
  const opened = await harness.rpcCall<{
    browser: { windowId: number | null; groupId: number | null; tabIds: number[]; activeTabId: number | null };
    tab: { id: number; url: string; windowId: number; groupId: number | null };
  }>('session.openTab', {
    sessionId,
    url,
    active: options.active === true
  });
  await expect
    .poll(() => harness!.context.pages().some((candidate) => candidate.url().includes(marker)), { timeout: 10_000 })
    .toBe(true);
  const page = must(
    harness.context.pages().find((candidate) => candidate.url().includes(marker)),
    'Expected named session page'
  );
  return {
    sessionId,
    browser: opened.browser,
    tab: opened.tab,
    page,
    url
  };
}

test.describe('CLI session binding workflows', () => {
  test.beforeEach(async () => {
    harness = await createHarness();
  });

  test.afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  test('keeps the human on page A while the agent works inside the bak-controlled session window', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      const humanActiveBefore = await harness.rpcCall<{ tab: { windowId: number } | null }>('tabs.getActive');
      const humanWindowId = must(humanActiveBefore.tab?.windowId, 'Expected active human window');
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(humanPage.locator('#name-input')).toBeVisible();

      const bindingPage = await openSessionPage('/spa.html');
      const info = await sessionBrowserState();
      const bindingWindowId = must(info.browser?.windowId, 'Expected session binding window id');
      await expect(bindingPage.page).toHaveURL(/\/spa\.html\?/);

      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(humanPage.locator('#name-input')).toBeVisible();
      expect(bindingWindowId).not.toBe(humanWindowId);

      const bindingTabId = await sessionActiveTabId();
      const bindingUrl = await harness.rpcCall<{ url: string }>('page.url', { tabId: bindingTabId });

      expect(bindingUrl.url).toMatch(/\/spa\.html(\?|$)/);
    } finally {
      await humanPage.close();
    }
  });

  test('keeps session binding inspection commands read-only before the first session binding tab exists while page commands auto-repair the binding', async () => {
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
      expect(runHarnessCliFailure(['page', 'url'])).toContain('Unsupported tab URL');
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      expect(harness.context.pages().length).toBeGreaterThanOrEqual(beforePageCount);

      const afterInfo = runHarnessCli<{ browser: { tabIds: number[]; activeTabId: number | null } | null; tabs: Array<{ url: string }> }>(['session', 'list-tabs']);
      expect(afterInfo.browser).not.toBeNull();
      expect(afterInfo.browser?.tabIds.length ?? 0).toBeGreaterThan(0);
      expect(afterInfo.browser?.activeTabId).not.toBeNull();
      expect(afterInfo.tabs.some((tab) => tab.url === 'about:blank')).toBe(true);
    } finally {
      await humanPage.close();
    }
  });

  test('routes page.goto without an explicit tab id into the session binding once it exists', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      await openSessionPage('/');

      runHarnessCli(['page', 'goto', SPA_URL]);
      runHarnessCli(['page', 'wait', '--mode', 'selector', '--value', '#tab-automation', '--timeout-ms', '5000']);

      const bindingTabId = await sessionActiveTabId();
      const bindingUrl = await harness.rpcCall<{ url: string }>('page.url', { tabId: bindingTabId });

      expect(bindingUrl.url).toBe(SPA_URL);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close();
    }
  });

  test('switches the session binding current tab through the CLI and uses it for later default commands', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    const first = await openSessionPage('/network.html');
    const second = await openSessionPage('/', { active: true });
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

  test('session open-tab keeps the current session tab unchanged unless activation is requested', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const first = await openSessionPage('/network.html');
    const second = await openSessionPage('/');
    try {
      const currentAfterInactiveOpen = runHarnessCli<{ tab: { id: number } | null }>(['session', 'get-active-tab']);
      expect(currentAfterInactiveOpen.tab?.id).toBe(first.tabId);

      const third = await openSessionPage('/spa.html', { active: true });
      const currentAfterActiveOpen = runHarnessCli<{ tab: { id: number } | null }>(['session', 'get-active-tab']);
      expect(currentAfterActiveOpen.tab?.id).toBe(third.tabId);

      await third.page.close().catch(() => undefined);
    } finally {
      await first.page.close().catch(() => undefined);
      await second.page.close().catch(() => undefined);
    }
  });

  test('keeps session binding inspection commands read-only and does not create extra blank tabs or windows', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    const opened = await openSessionPage('/');
    try {
      const beforePages = harness.context.pages().length;
      const beforeInfo = await sessionBrowserState();
      const beforeBinding = must(beforeInfo.browser, 'Expected session browser metadata');

      const active = runHarnessCli<{ tab: { id: number } | null }>(['session', 'get-active-tab']);
      const listed = runHarnessCli<{ tabs: Array<{ id: number }> }>(['session', 'list-tabs']);
      const afterInfo = await sessionBrowserState();
      const afterBinding = must(afterInfo.browser, 'Expected session browser metadata');

      expect(active.tab?.id).toBe(beforeBinding.activeTabId);
      expect(listed.tabs.map((tab) => tab.id).sort((a, b) => a - b)).toEqual([...beforeBinding.tabIds].sort((a, b) => a - b));
      expect(afterBinding.windowId).toBe(beforeBinding.windowId);
      expect(afterBinding.groupId).toBe(beforeBinding.groupId);
      expect(afterBinding.tabIds).toEqual(beforeBinding.tabIds);
      expect(harness.context.pages()).toHaveLength(beforePages);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
      await expect(opened.page).toHaveURL(/\/\?/);
    } finally {
      await humanPage.close().catch(() => undefined);
      await opened.page.close().catch(() => undefined);
    }
  });

  test('repeated ensure and open-tab calls reuse the existing session binding window instead of spawning duplicate blank windows', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const first = await openSessionPage('/');
    try {
      const before = must((await sessionBrowserState()).browser, 'Expected session browser metadata');
      const openedAgain = await openSessionPage('/network.html');
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

  test('auto-closes the session when the last tracked tab is manually closed without hijacking unrelated tabs in the old binding window', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const opened = await openSessionPage('/');
    try {
      const before = await sessionBrowserState();
      const bindingState = must(before.browser, 'Expected session browser metadata');
      const marker = `__foreign=${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const foreign = await harness.createForeignTab(
        must(bindingState.windowId, 'Expected binding window id'),
        `http://127.0.0.1:4173/network.html?${marker}`
      );
      const tracked = runHarnessCli<{ tabs: Array<{ id: number }> }>(['session', 'list-tabs']);
      for (const tab of tracked.tabs) {
        await harness.closeBrowserTab(tab.id);
      }

      await expect.poll(() => runHarnessCliFailure(['session', 'ensure']), { timeout: 10_000 }).toContain('Session not found');
      await expect.poll(() => runHarnessCliFailure(['page', 'url']), { timeout: 10_000 }).toContain('Session not found');

      const allTabs = await harness.rpcCall<{ tabs: Array<{ id: number }> }>('tabs.list');
      expect(allTabs.tabs.some((tab) => tab.id === foreign.tabId)).toBe(true);
    } finally {
      await opened.page.close().catch(() => undefined);
    }
  });

  test('does not focus the session binding window by default and focuses it only on explicit command', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    try {
      await openSessionPage('/');
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

  test('groups session-created tabs automatically inside the bak-controlled session window', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const first = await openSessionPage('/');
    const second = await openSessionPage('/spa.html');
    try {
      const info = await sessionBrowserState();
      const bindingState = must(info.browser, 'Expected session browser metadata');
      const groupId = must(bindingState.groupId, 'Expected session binding group id');

      expect(bindingState.tabs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(bindingState.tabs.map((tab) => tab.windowId)).size).toBe(1);
      expect(bindingState.tabs.every((tab) => tab.groupId === groupId)).toBe(true);
    } finally {
      await first.page.close().catch(() => undefined);
      await second.page.close().catch(() => undefined);
    }
  });

  test('returns a stable session binding open-tab result when the requested URL is canonicalized by the browser', async () => {
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
      const bindingState = must(info.browser, 'Expected session browser metadata');

      expect(bindingState.windowId).not.toBeNull();
      expect(opened.tab.windowId).toBe(bindingState.windowId);
      expect(opened.tab.url).toBe('http://127.0.0.1:4173/');
      await expect(humanPage).toHaveURL(/\/form\.html\?/);
    } finally {
      await humanPage.close().catch(() => undefined);
    }
  });

  test('session.close tears down the session-owned browser state and invalidates later session-scoped commands', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    const opened = await openSessionPage('/spa.html');
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

  test('auto-closes the session when the bak-controlled window is manually closed', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const opened = await openSessionPage('/');
    const tracked = runHarnessCli<{ tabs: Array<{ id: number }> }>(['session', 'list-tabs']);
    for (const tab of tracked.tabs) {
      await harness.closeBrowserTab(tab.id);
    }

    await expect.poll(() => runHarnessCliFailure(['session', 'ensure']), { timeout: 10_000 }).toContain('Session not found');
    await expect.poll(() => runHarnessCliFailure(['page', 'url']), { timeout: 10_000 }).toContain('Session not found');
  });

  test('keeps multiple sessions in one bak-controlled window while isolating them by group', async () => {
    if (!harness) {
      throw new Error('Harness not initialized');
    }

    const { page: humanPage } = await harness.openHumanPage('/form.html');
    const first = await openNamedSessionPage('shared-window-a', '/');
    const second = await openNamedSessionPage('shared-window-b', '/spa.html');
    try {
      expect(first.browser.windowId).toBe(second.browser.windowId);
      expect(first.tab.windowId).toBe(second.tab.windowId);
      expect(first.browser.groupId).not.toBe(second.browser.groupId);
      expect(first.tab.groupId).toBe(first.browser.groupId);
      expect(second.tab.groupId).toBe(second.browser.groupId);
      await expect(humanPage).toHaveURL(/\/form\.html\?/);

      const closed = await harness.rpcCall<{ closed: boolean; closedTabId: number; sessionClosed: boolean; browser: null }>(
        'session.closeTab',
        {
          sessionId: first.sessionId,
          tabId: first.tab.id
        }
      );
      expect(closed.closed).toBe(true);
      expect(closed.closedTabId).toBe(first.tab.id);
      expect(closed.sessionClosed).toBe(true);
      expect(closed.browser).toBeNull();

      const surviving = await harness.rpcCall<{
        browser: { windowId: number | null; groupId: number | null; tabIds: number[]; activeTabId: number | null } | null;
        tabs: Array<{ id: number; url: string; windowId: number; groupId: number | null }>;
      }>('session.listTabs', { sessionId: second.sessionId });
      const survivingBrowser = must(surviving.browser, 'Expected surviving session browser metadata');
      expect(survivingBrowser.windowId).toBe(second.browser.windowId);
      expect(survivingBrowser.groupId).toBe(second.browser.groupId);
      expect(surviving.tabs).toHaveLength(1);
      expect(surviving.tabs[0]?.groupId).toBe(second.browser.groupId);
      expect(surviving.tabs[0]?.url).toContain('__binding=shared-window-b');
    } finally {
      await harness.rpcCall('session.close', { sessionId: first.sessionId }).catch(() => undefined);
      await harness.rpcCall('session.close', { sessionId: second.sessionId }).catch(() => undefined);
      await humanPage.close().catch(() => undefined);
      await first.page.close().catch(() => undefined);
      await second.page.close().catch(() => undefined);
    }
  });

  test('rehomes a stale session binding that was incorrectly bound to the human window', async () => {
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
    const orphaned = await harness.createForeignTab(humanWindowId, orphanedUrl);
    await expect
      .poll(() => harness.context.pages().some((candidate) => !beforePages.has(candidate) && candidate.url().includes(marker)), {
        timeout: 10_000
      })
      .toBe(true);

    await harness.setSessionBindingState({
      id: harness.bindingId,
      label: 'bak agent',
      color: 'blue',
      windowId: humanWindowId,
      groupId: null,
      tabIds: [orphaned.tabId],
      activeTabId: orphaned.tabId,
      primaryTabId: orphaned.tabId
    });
    const listed = runHarnessCli<{ sessions: Array<{ sessionId: string }> }>(['session', 'list']);
    expect(listed.sessions.some((session) => session.sessionId === harness.sessionId)).toBe(true);

    const opened = runHarnessCli<{ browser: { windowId: number | null }; tab: { id: number; windowId: number; url: string } }>([
      'session',
      'open-tab',
      '--url',
      HOME_URL
    ]);
    const info = await sessionBrowserState();
    const bindingState = must(info.browser, 'Expected repaired session browser metadata');
    const allTabs = await harness.rpcCall<{ tabs: Array<{ id: number; windowId: number; url: string }> }>('tabs.list');
    const humanWindowTabs = allTabs.tabs.filter((tab) => tab.windowId === humanWindowId);

    expect(bindingState.windowId).not.toBe(humanWindowId);
    expect(opened.browser.windowId).toBe(bindingState.windowId);
    expect(opened.tab.windowId).toBe(bindingState.windowId);
    expect(humanWindowTabs.some((tab) => tab.id === humanTabId)).toBe(true);
    expect(humanWindowTabs.some((tab) => tab.id === orphaned.tabId)).toBe(false);
    expect(humanWindowTabs.every((tab) => !tab.url.includes(marker))).toBe(true);
    await expect(humanPage).toHaveURL(/\/form\.html$/);
  });
});
