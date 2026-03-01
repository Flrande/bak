import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import WebSocket from 'ws';

interface RpcResponse {
  id: string;
  jsonrpc: '2.0';
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

async function rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  const socket = new WebSocket('ws://127.0.0.1:17374/rpc');
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  const id = `e2e_${Date.now()}`;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const response = await new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 20_000);
    socket.on('message', (raw) => {
      try {
        const parsed = JSON.parse(String(raw)) as RpcResponse;
        if (parsed.id !== id) {
          return;
        }
        clearTimeout(timer);
        resolve(parsed);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.send(payload);
  });

  socket.close();

  if (response.error) {
    throw new Error(`${response.error.data?.bakCode ?? response.error.code}: ${response.error.message}`);
  }

  return response.result;
}

async function waitForRpcReady(): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    try {
      await rpcCall('session.info', {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error('RPC not ready');
}

async function findTabIdByUrl(urlPart: string): Promise<number> {
  const result = (await rpcCall('tabs.list', {})) as {
    tabs: Array<{ id: number; url: string; active: boolean }>;
  };
  const matched = result.tabs.find((tab) => tab.url.includes(urlPart));
  if (!matched) {
    throw new Error(`tab not found for ${urlPart}`);
  }
  return matched.id;
}

test.describe('bak e2e', () => {
  let daemon: ChildProcess | null = null;
  let dataDir = '';
  let userDataDir = '';
  let context: BrowserContext | null = null;

  test.afterEach(async () => {
    if (context) {
      await context.close();
      context = null;
    }

    if (daemon && !daemon.killed) {
      daemon.kill('SIGTERM');
    }

    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('loads extension and drives page through CLI RPC', async () => {
    const repoRoot = resolve(__dirname, '../..');
    const cliBin = join(repoRoot, 'packages/cli/dist/bin.js');
    const extensionDist = join(repoRoot, 'packages/extension/dist');

    expect(existsSync(cliBin)).toBe(true);
    expect(existsSync(extensionDist)).toBe(true);

    dataDir = mkdtempSync(join(tmpdir(), 'bak-e2e-data-'));
    userDataDir = mkdtempSync(join(tmpdir(), 'bak-e2e-chrome-'));

    writeFileSync(
      join(dataDir, '.bak-policy.json'),
      JSON.stringify({
        rules: [
          {
            id: 'deny-cancel-on-form',
            action: 'element.click',
            domain: '127.0.0.1',
            pathPrefix: '/form.html',
            locatorPattern: 'cancel-btn',
            decision: 'deny',
            reason: 'test policy deny path'
          }
        ]
      }),
      'utf8'
    );

    const pairRaw = execFileSync('node', [cliBin, 'pair'], {
      cwd: repoRoot,
      env: { ...process.env, BAK_DATA_DIR: dataDir },
      encoding: 'utf8'
    });

    const token = (JSON.parse(pairRaw) as { token: string }).token;

    daemon = spawn('node', [cliBin, 'serve', '--port', '17373', '--rpc-ws-port', '17374'], {
      cwd: repoRoot,
      env: { ...process.env, BAK_DATA_DIR: dataDir, BAK_HEARTBEAT_MS: '1000' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await waitForRpcReady();

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: [
        `--disable-extensions-except=${extensionDist}`,
        `--load-extension=${extensionDist}`
      ]
    });

    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(sw.url()).host;

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.fill('#token', token);
    await popup.fill('#port', '17373');
    await popup.click('#save');
    const extensionState = (await popup.evaluate(
      async ({ pairToken, port }) => {
        await chrome.storage.local.set({ pairToken, cliPort: port });
        await chrome.runtime.sendMessage({ type: 'bak.updateConfig', token: pairToken, port });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const stored = await chrome.storage.local.get(['pairToken']);
        const status = await chrome.runtime.sendMessage({ type: 'bak.getState' });
        return { stored, status };
      },
      { pairToken: token, port: 17373 }
    )) as {
      stored: { pairToken?: string };
      status: { hasToken: boolean };
    };

    expect(extensionState.stored.pairToken).toBe(token);
    expect(extensionState.status.hasToken).toBe(true);
    await popup.close();

    await expect
      .poll(
        async () => {
          const info = (await rpcCall('session.info', {})) as {
            extensionConnected: boolean;
            connectionState: string;
            extensionVersion: string | null;
            activeTab: { id: number; title: string; url: string } | null;
            lastSeenTs: number | null;
            lastHeartbeatTs: number | null;
          };
          return (
            info.extensionConnected &&
            info.connectionState === 'connected' &&
            typeof info.extensionVersion === 'string' &&
            (info.activeTab === null || typeof info.activeTab.id === 'number') &&
            typeof info.lastSeenTs === 'number' &&
            typeof info.lastHeartbeatTs === 'number'
          );
        },
        { timeout: 20_000 }
      )
      .toBe(true);

    const firstSeen = (await rpcCall('session.info', {})) as { lastSeenTs: number | null };

    await expect
      .poll(
        async () => {
          const info = (await rpcCall('session.info', {})) as { lastSeenTs: number | null };
          return typeof info.lastSeenTs === 'number' ? info.lastSeenTs : 0;
        },
        { timeout: 8_000 }
      )
      .toBeGreaterThan(typeof firstSeen.lastSeenTs === 'number' ? firstSeen.lastSeenTs : 0);

    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4173/form.html');
    await page.bringToFront();
    await expect(page.locator('#name-input')).toBeVisible();
    const tabId = await findTabIdByUrl('/form.html');
    const infoWithActiveTab = (await rpcCall('session.info', {})) as {
      activeTab: { id: number; title: string; url: string } | null;
    };
    expect(infoWithActiveTab.activeTab).not.toBeNull();
    expect(infoWithActiveTab.activeTab?.id).toBe(tabId);
    expect(infoWithActiveTab.activeTab?.url).toContain('/form.html');

    await rpcCall('session.create', { clientName: 'playwright-e2e' });
    await rpcCall('element.type', {
      tabId,
      locator: { css: '#name-input' },
      text: 'Agent QA'
    });

    await expect(page.locator('#name-input')).toHaveValue('Agent QA');

    await expect(async () => {
      await rpcCall('element.click', {
        tabId,
        locator: { css: '#cancel-btn' }
      });
    }).rejects.toThrow(/E_PERMISSION/);

    await rpcCall('element.click', {
      tabId,
      locator: { css: '#next-page' }
    });

    await expect(page).toHaveURL(/table\.html/);
    await rpcCall('page.wait', {
      tabId,
      mode: 'text',
      value: 'Alpha',
      timeoutMs: 5000
    });
    await expect(page.locator('button.delete-btn[data-id="1"]')).toBeVisible();

    await rpcCall('page.goto', { tabId, url: 'http://127.0.0.1:4173/controlled.html' });
    await expect(page).toHaveURL(/controlled\.html/);
    await expect(page.locator('#controlled-input')).toBeVisible();

    await rpcCall('element.type', {
      tabId,
      locator: { css: '#controlled-input' },
      text: 'Native Setter',
      clear: true
    });
    await expect(page.locator('#controlled-input')).toHaveValue('Native Setter');
    await expect(page.locator('#controlled-mirror')).toContainText('Native Setter');

    await expect(async () => {
      await rpcCall('element.click', { tabId, locator: { css: '#blocked-action' } });
    }).rejects.toThrow(/E_PERMISSION/);

    await rpcCall('element.click', { tabId, locator: { css: '#toggle-cover' } });
    await rpcCall('element.click', { tabId, locator: { css: '#blocked-action' } });
    await expect(page.locator('#action-result')).toContainText('clicked');

    const snapshot = (await rpcCall('page.snapshot', { tabId })) as {
      imagePath: string;
      elementsPath: string;
      elementCount: number;
    };

    expect(existsSync(snapshot.imagePath)).toBe(true);
    expect(existsSync(snapshot.elementsPath)).toBe(true);
    expect(snapshot.elementCount).toBeGreaterThan(0);

    await context.close();
    context = null;
  });
});
