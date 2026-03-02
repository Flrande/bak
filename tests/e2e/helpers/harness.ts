import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
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

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve free port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export interface BakErrorResponse extends Error {
  bakCode?: string;
}

export interface E2EHarness {
  dataDir: string;
  rpcPort: number;
  context: BrowserContext;
  page: Page;
  rpcCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  rpcError(method: string, params?: Record<string, unknown>): Promise<{ bakCode: string; message: string }>;
  findTabIdByUrl(urlPart: string): Promise<number>;
  openPage(path: string): Promise<{ page: Page; tabId: number }>;
  assertTraceHas(method: string): void;
  disconnectBridge(): Promise<void>;
  reconnectBridge(): Promise<void>;
  dispose(): Promise<void>;
}

async function rpcCallInternal(port: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  const id = `e2e_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const response = await new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 25_000);
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
    const err = new Error(`${response.error.data?.bakCode ?? response.error.code}: ${response.error.message}`) as BakErrorResponse;
    err.bakCode = typeof response.error.data?.bakCode === 'string' ? response.error.data.bakCode : undefined;
    throw err;
  }
  return response.result;
}

async function waitForRpcReady(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await rpcCallInternal(port, 'session.info', {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error('RPC not ready');
}

async function waitForTabContentReady(port: number, tabId: number, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      await rpcCallInternal(port, 'page.url', { tabId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (!message.includes('E_NOT_READY')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(`Content script not ready for tab ${tabId}: ${lastError}`);
}

export async function createHarness(): Promise<E2EHarness> {
  const repoRoot = resolve(__dirname, '../..', '..');
  const cliBin = join(repoRoot, 'packages/cli/dist/bin.js');
  const extensionDist = join(repoRoot, 'packages/extension/dist');

  if (!existsSync(cliBin) || !existsSync(extensionDist)) {
    throw new Error('Build artifacts are missing; run pnpm build first.');
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'bak-e2e-data-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'bak-e2e-chrome-'));
  const headless = process.env.BAK_E2E_HEADLESS !== '0';
  const rpcPort = await getFreePort();
  const bridgePort = await getFreePort();
  let daemon: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let extensionId = '';
  const daemonStdout: string[] = [];
  const daemonStderr: string[] = [];

  try {
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
          },
          {
            id: 'allow-upload-on-upload-page',
            action: 'file.upload',
            domain: '127.0.0.1',
            pathPrefix: '/upload.html',
            decision: 'allow',
            reason: 'allow e2e upload coverage paths'
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

    daemon = spawn('node', [cliBin, 'serve', '--port', `${bridgePort}`, '--rpc-ws-port', `${rpcPort}`], {
      cwd: repoRoot,
      env: { ...process.env, BAK_DATA_DIR: dataDir, BAK_HEARTBEAT_MS: '1000' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    daemon.stdout?.on('data', (chunk: Buffer) => {
      daemonStdout.push(chunk.toString('utf8'));
    });
    daemon.stderr?.on('data', (chunk: Buffer) => {
      daemonStderr.push(chunk.toString('utf8'));
    });

    await waitForRpcReady(rpcPort);

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless,
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
    });

    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(sw.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.fill('#token', token);
    await popup.fill('#port', `${bridgePort}`);
    await popup.click('#save');
    await popup.evaluate(
      async ({ pairToken, port }) => {
        await chrome.storage.local.set({ pairToken, cliPort: port });
        await chrome.runtime.sendMessage({ type: 'bak.updateConfig', token: pairToken, port });
        await new Promise((resolve) => setTimeout(resolve, 900));
      },
      { pairToken: token, port: bridgePort }
    );
    await popup.close();

    await expect
      .poll(
        async () => {
          const info = (await rpcCallInternal(rpcPort, 'session.info', {})) as {
            extensionConnected: boolean;
            connectionState: string;
            protocolVersion: string;
          };
          return info.extensionConnected && info.connectionState === 'connected' && info.protocolVersion === 'v2';
        },
        { timeout: 40_000 }
      )
      .toBe(true);

    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4173/form.html');
    await page.bringToFront();
    await expect(page.locator('#name-input')).toBeVisible();
    const initialActive = (await rpcCallInternal(rpcPort, 'tabs.getActive', {})) as {
      tab: { id: number } | null;
    };
    if (initialActive.tab?.id) {
      await waitForTabContentReady(rpcPort, initialActive.tab.id);
    }

    const rpcCall = async <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const deadline = Date.now() + 8_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          return (await rpcCallInternal(rpcPort, method, params)) as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = error;
          if (!message.includes('E_NOT_READY')) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'rpc call failed'));
    };

    const rpcError = async (method: string, params: Record<string, unknown> = {}): Promise<{ bakCode: string; message: string }> => {
      try {
        await rpcCallInternal(rpcPort, method, params);
        throw new Error(`Expected error for method: ${method}`);
      } catch (error) {
        const fromError = (error as BakErrorResponse).bakCode;
        const rawMessage = error instanceof Error ? error.message : String(error);
        const inferred = rawMessage.match(/\bE_[A-Z_]+\b/)?.[0];
        const bakCode = fromError ?? inferred ?? 'UNKNOWN';
        return {
          bakCode,
          message: rawMessage
        };
      }
    };

    const findTabIdByUrl = async (urlPart: string): Promise<number> => {
      const result = await rpcCall<{ tabs: Array<{ id: number; url: string; active: boolean }> }>('tabs.list');
      const matched = result.tabs.find((tab) => tab.url.includes(urlPart));
      if (!matched) {
        throw new Error(`tab not found for ${urlPart}`);
      }
      return matched.id;
    };

    const openPage = async (path: string): Promise<{ page: Page; tabId: number }> => {
      const target = await context.newPage();
      const marker = `__e2e=${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const separator = path.includes('?') ? '&' : '?';
      const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
      await target.goto(url);
      await target.bringToFront();
      const tabId = await findTabIdByUrl(marker);
      await waitForTabContentReady(rpcPort, tabId);
      return { page: target, tabId };
    };

    const withPopup = async (action: (popup: Page) => Promise<void>): Promise<void> => {
      if (!extensionId) {
        throw new Error('extension id unavailable');
      }
      const popup = await context.newPage();
      try {
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await action(popup);
      } finally {
        await popup.close();
      }
    };

    const disconnectBridge = async (): Promise<void> => {
      await withPopup(async (popup) => {
        await popup.click('#disconnect');
      });
      await expect
        .poll(
          async () => {
            const info = (await rpcCallInternal(rpcPort, 'session.info', {})) as {
              extensionConnected: boolean;
              connectionState: string;
            };
            return info.extensionConnected === false && info.connectionState !== 'connected';
          },
          { timeout: 10_000 }
        )
        .toBe(true);
    };

    const reconnectBridge = async (): Promise<void> => {
      await withPopup(async (popup) => {
        await popup.fill('#token', token);
        await popup.fill('#port', `${bridgePort}`);
        await popup.click('#save');
      });
      await expect
        .poll(
          async () => {
            const info = (await rpcCallInternal(rpcPort, 'session.info', {})) as {
              extensionConnected: boolean;
              connectionState: string;
            };
            return info.extensionConnected && info.connectionState === 'connected';
          },
          { timeout: 15_000 }
        )
        .toBe(true);
    };

    const assertTraceHas = (method: string): void => {
      const traceDir = join(dataDir, 'traces');
      const traceFiles = existsSync(traceDir)
        ? readdirSync(traceDir)
            .filter((item) => item.endsWith('.jsonl'))
            .map((item) => ({
              path: join(traceDir, item),
              mtime: statSync(join(traceDir, item)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime)
        : [];

      if (traceFiles.length === 0) {
        throw new Error('no trace files generated');
      }

      const latest = traceFiles[0];
      const content = readFileSync(latest.path, 'utf8');
      if (!content.includes(`\"method\":\"${method}\"`) && !content.includes(`\"method\":\"${method}:`)) {
        throw new Error(`trace does not contain method ${method}`);
      }
    };

    const dispose = async (): Promise<void> => {
      try {
        await context.close();
      } catch {
        // ignore
      }
      if (daemon && !daemon.killed) {
        daemon.kill('SIGTERM');
      }
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    };

    return {
      dataDir,
      rpcPort,
      context,
      page,
      rpcCall,
      rpcError,
      findTabIdByUrl,
      openPage,
      assertTraceHas,
      disconnectBridge,
      reconnectBridge,
      dispose
    };
  } catch (error) {
    const daemonLogs = [daemonStdout.join(''), daemonStderr.join('')].filter(Boolean).join('\n');
    try {
      await context?.close();
    } catch {
      // ignore cleanup errors
    }
    if (daemon && !daemon.killed) {
      daemon.kill('SIGTERM');
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to create e2e harness: ${message}\n` +
        `rpcPort=${rpcPort} bridgePort=${bridgePort}\n` +
        `daemonLogs=${daemonLogs || '<empty>'}`
    );
  }
}
