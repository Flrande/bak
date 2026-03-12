import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../../packages/protocol/src/types.js';
import { markMethodInvoked } from './method-status';
import { cliDistPath, ensureE2ERuntimeFresh, extensionDistPath } from './runtime';

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

const NAVIGATION_METHODS = new Set(['page.goto', 'page.back', 'page.forward', 'page.reload']);
const SESSION_METHODS_WITHOUT_SESSION = new Set(['session.create', 'session.list']);
const DEFAULT_RPC_TIMEOUT_MS = parseTimeoutEnv('BAK_E2E_RPC_TIMEOUT_MS', 45_000);
const NAVIGATION_RPC_TIMEOUT_MS = parseTimeoutEnv('BAK_E2E_NAV_RPC_TIMEOUT_MS', 60_000);

function parseTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveRpcTimeoutMs(method: string, params: Record<string, unknown>): number {
  let timeoutMs = DEFAULT_RPC_TIMEOUT_MS;
  if (NAVIGATION_METHODS.has(method)) {
    timeoutMs = Math.max(timeoutMs, NAVIGATION_RPC_TIMEOUT_MS);
  }

  const requested = params.timeoutMs;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    timeoutMs = Math.max(timeoutMs, Math.floor(requested) + 10_000);
  }

  return timeoutMs;
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
  sessionId: string;
  bindingId: string;
  context: BrowserContext;
  page: Page;
  rpcCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  rpcError(method: string, params?: Record<string, unknown>): Promise<{ bakCode: string; message: string }>;
  findTabIdByUrl(urlPart: string): Promise<number>;
  openPage(path: string): Promise<{ page: Page; tabId: number }>;
  openHumanPage(path: string): Promise<{ page: Page }>;
  assertTraceHas(method: string): void;
  disconnectBridge(): Promise<void>;
  reconnectBridge(): Promise<void>;
  setSessionBindingState(state: unknown | null): Promise<void>;
  dispose(): Promise<void>;
}

async function rpcCallInternal(port: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  markMethodInvoked(method);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  const id = `e2e_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const timeoutMs = resolveRpcTimeoutMs(method, params);
  let response: RpcResponse;
  try {
    response = await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        socket.off('error', onError);
      };

      const onMessage = (raw: WebSocket.RawData): void => {
        try {
          const parsed = JSON.parse(String(raw)) as RpcResponse;
          if (parsed.id !== id) {
            return;
          }
          cleanup();
          resolve(parsed);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      socket.on('message', onMessage);
      socket.on('error', onError);
      socket.send(payload);
    });
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

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
      await rpcCallInternal(port, 'runtime.info', {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error('RPC not ready');
}

function isSessionScopedMethod(method: string): boolean {
  return !method.startsWith('runtime.') && !method.startsWith('tabs.') && !SESSION_METHODS_WITHOUT_SESSION.has(method);
}

function withSession(method: string, params: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  if (!isSessionScopedMethod(method) || typeof params.sessionId === 'string') {
    return params;
  }
  return {
    ...params,
    sessionId
  };
}

async function waitForTabContentReady(
  port: number,
  tabId: number,
  sessionId: string,
  timeoutMs = 12_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      await rpcCallInternal(port, 'page.url', { sessionId, tabId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (!message.includes('E_NOT_READY') && !message.includes('E_TIMEOUT')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(`Content script not ready for tab ${tabId}: ${lastError}`);
}

async function removeDirQuiet(path: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function gotoWithRetry(page: Page, url: string, readySelector: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';

  while (Date.now() < deadline) {
    try {
      await page.goto(url);
      await expect(page.locator(readySelector)).toBeVisible();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!lastError.includes('ERR_CONNECTION_REFUSED')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Failed to open ${url}: ${lastError}`);
}

async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed) {
    return;
  }

  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 2_000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function createHarness(): Promise<E2EHarness> {
  const repoRoot = resolve(__dirname, '../..', '..');
  ensureE2ERuntimeFresh(repoRoot);
  const cliBin = cliDistPath(repoRoot);
  const extensionDist = extensionDistPath(repoRoot);

  if (!existsSync(cliBin) || !existsSync(extensionDist)) {
    throw new Error('E2E runtime artifacts are still missing after automatic refresh.');
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'bak-e2e-data-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'bak-e2e-chrome-'));
  const headless = process.env.BAK_E2E_HEADLESS !== '0';
  const rpcPort = await getFreePort();
  const bridgePort = await getFreePort();
  let daemon: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let extensionId = '';
  let sessionId = '';
  let bindingId = '';
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

    const pairRaw = execFileSync('node', [cliBin, 'pair', 'create'], {
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
          const info = (await rpcCallInternal(rpcPort, 'runtime.info', {})) as {
            extensionConnected: boolean;
            connectionState: string;
            protocolVersion: string;
          };
          return info.extensionConnected && info.connectionState === 'connected' && info.protocolVersion === PROTOCOL_VERSION;
        },
        { timeout: 40_000 }
      )
      .toBe(true);

    const createdSession = (await rpcCallInternal(rpcPort, 'session.create', {
      clientName: 'e2e-harness'
    })) as {
      sessionId: string;
    };
    sessionId = createdSession.sessionId;
    bindingId = createdSession.sessionId;
    writeFileSync(
      join(dataDir, 'e2e-session.json'),
      JSON.stringify({
        sessionId
      }),
      'utf8'
    );

    const page = await context.newPage();
    await gotoWithRetry(page, 'http://127.0.0.1:4173/form.html', '#name-input');
    await page.bringToFront();

    const rpcCall = async <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const deadline = Date.now() + DEFAULT_RPC_TIMEOUT_MS;
      let lastError: unknown;
      const requestParams = withSession(method, params, sessionId);
      while (Date.now() < deadline) {
        try {
          return (await rpcCallInternal(rpcPort, method, requestParams)) as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = error;
          if (!message.includes('E_NOT_READY') && !message.includes('E_TIMEOUT')) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'rpc call failed'));
    };

    const rpcError = async (method: string, params: Record<string, unknown> = {}): Promise<{ bakCode: string; message: string }> => {
      try {
        await rpcCallInternal(rpcPort, method, withSession(method, params, sessionId));
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

    const openHumanPage = async (path: string): Promise<{ page: Page }> => {
      const target = await context.newPage();
      const marker = `__e2e=${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const separator = path.includes('?') ? '&' : '?';
      const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
      await gotoWithRetry(target, url, 'body');
      await target.bringToFront();
      return { page: target };
    };

    const openPage = async (path: string): Promise<{ page: Page; tabId: number }> => {
      const marker = `__e2e=${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const separator = path.includes('?') ? '&' : '?';
      const url = `http://127.0.0.1:4173${path}${separator}${marker}`;
      const deadline = Date.now() + 45_000;
      let opened: { tab: { id: number; url: string } } | null = null;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          await rpcCall('session.ensure');
          opened = (await rpcCall<{ tab: { id: number; url: string } }>('session.openTab', {
            url
          })) as { tab: { id: number; url: string } };
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = error;
          if (!message.includes('E_NOT_READY') && !message.includes('E_TIMEOUT')) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!opened) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'openPage failed'));
      }

      await expect
        .poll(
          () => context.pages().some((candidate) => candidate.url().includes(marker)),
          { timeout: 10_000 }
        )
        .toBe(true);

      const target = context.pages().find((candidate) => candidate.url().includes(marker));
      if (!target) {
        throw new Error(`session page not found for ${url}`);
      }
      await waitForTabContentReady(rpcPort, opened.tab.id, sessionId);
      return { page: target, tabId: opened.tab.id };
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
            const info = (await rpcCallInternal(rpcPort, 'runtime.info', {})) as {
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
            const info = (await rpcCallInternal(rpcPort, 'runtime.info', {})) as {
              extensionConnected: boolean;
              connectionState: string;
            };
            return info.extensionConnected && info.connectionState === 'connected';
          },
          { timeout: 15_000 }
        )
        .toBe(true);
    };

    const setSessionBindingState = async (state: unknown | null): Promise<void> => {
      await withPopup(async (popup) => {
        await popup.evaluate(
          async ({ targetBindingId, bindingState }) => {
            const stored = (await chrome.storage.local.get('sessionBindings')) as {
              sessionBindings?: Record<string, unknown>;
            };
            const sessionBindings = { ...(stored.sessionBindings ?? {}) };
            if (bindingState === null) {
              delete sessionBindings[targetBindingId];
              if (Object.keys(sessionBindings).length === 0) {
                await chrome.storage.local.remove('sessionBindings');
                return;
              }
              await chrome.storage.local.set({ sessionBindings });
              return;
            }
            sessionBindings[targetBindingId] = bindingState;
            await chrome.storage.local.set({ sessionBindings });
          },
          { targetBindingId: bindingId, bindingState: state }
        );
      });
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
        if (sessionId) {
          await rpcCallInternal(rpcPort, 'session.close', { sessionId });
        }
      } catch {
        // ignore session cleanup failures
      }
      try {
        await context.close();
      } catch {
        // ignore
      }
      await stopChildProcess(daemon);
      await removeDirQuiet(dataDir);
      await removeDirQuiet(userDataDir);
    };

    return {
      dataDir,
      rpcPort,
      sessionId,
      bindingId,
      context,
      page,
      rpcCall,
      rpcError,
      findTabIdByUrl,
      openPage,
      openHumanPage,
      assertTraceHas,
      disconnectBridge,
      reconnectBridge,
      setSessionBindingState,
      dispose
    };
  } catch (error) {
    const daemonLogs = [daemonStdout.join(''), daemonStderr.join('')].filter(Boolean).join('\n');
    try {
      await context?.close();
    } catch {
      // ignore cleanup errors
    }
    await stopChildProcess(daemon);
    await removeDirQuiet(dataDir);
    await removeDirQuiet(userDataDir);

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to create e2e harness: ${message}\n` +
        `rpcPort=${rpcPort} bridgePort=${bridgePort}\n` +
        `daemonLogs=${daemonLogs || '<empty>'}`
    );
  }
}
