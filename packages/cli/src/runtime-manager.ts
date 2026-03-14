import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSON_RPC_VERSION, type JsonRpcResponse } from '@flrande/bak-protocol';
import WebSocket from 'ws';
import { readCliVersion } from './cli-version.js';
import { parseOptionalPositiveInt } from './cli-args.js';
import { resolveDataDir, sleep } from './utils.js';

export const DEFAULT_PORT = 17373;
export const DEFAULT_RPC_PORT = DEFAULT_PORT + 1;

const RUNTIME_CONFIG_FILE = 'runtime.json';
const RUNTIME_STATE_FILE = 'runtime-process.json';
const RUNTIME_LOCK_DIR = 'runtime-start.lock';
const RUNTIME_LOG_DIR = 'runtime-logs';
const DEFAULT_RUNTIME_WAIT_MS = 25_000;
const LOCK_TIMEOUT_MS = 30_000;

export type RuntimePortSource = 'option' | 'env' | 'config' | 'default' | 'derived';

export interface RuntimeConfig {
  version: 1;
  port: number;
  rpcWsPort: number;
  updatedAt: string;
  updatedBy: 'setup' | 'serve' | 'auto-start';
}

export interface RuntimeState {
  version: 1;
  pid: number;
  managed: boolean;
  mode: 'background' | 'foreground';
  port: number;
  rpcWsPort: number;
  startedAt: string;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
}

export interface RuntimePortResolution {
  dataDir: string;
  port: number;
  rpcWsPort: number;
  config: RuntimeConfig | null;
  sources: {
    port: RuntimePortSource;
    rpcWsPort: RuntimePortSource;
  };
}

export interface RuntimeStatus {
  running: boolean;
  rpcReachable: boolean;
  health: 'healthy' | 'degraded' | 'stopped';
  managed: boolean;
  mode: 'background' | 'foreground' | null;
  pid: number | null;
  port: number;
  rpcWsPort: number;
  dataDir: string;
  metadataPresent: boolean;
  staleMetadata: boolean;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  info?: Record<string, unknown>;
}

export interface StopRuntimeResult {
  stopped: boolean;
  cleanedStaleMetadata: boolean;
  running: boolean;
  managed: boolean;
  pid: number | null;
  port: number;
  rpcWsPort: number;
}

function runtimeConfigPath(dataDir: string): string {
  return join(dataDir, RUNTIME_CONFIG_FILE);
}

function runtimeStatePath(dataDir: string): string {
  return join(dataDir, RUNTIME_STATE_FILE);
}

function runtimeLockPath(dataDir: string): string {
  return join(dataDir, RUNTIME_LOCK_DIR);
}

function runtimeLogsDir(dataDir: string): string {
  return join(dataDir, RUNTIME_LOG_DIR);
}

function ensureRuntimeDataDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function ensurePositiveInteger(value: unknown, label: string): number | undefined {
  const parsed = parseOptionalPositiveInt(value, label);
  if (parsed === undefined) {
    return undefined;
  }
  return parsed;
}

function ensurePort(value: unknown, label: string): number | undefined {
  const parsed = ensurePositiveInteger(value, label);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed > 65_535) {
    throw new Error(`${label} must be <= 65535`);
  }
  return parsed;
}

function parseRuntimeConfig(raw: unknown): RuntimeConfig | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const port = ensurePort(record.port, 'runtime config port');
  const rpcWsPort = ensurePort(record.rpcWsPort, 'runtime config rpc-ws-port');
  if (port === undefined || rpcWsPort === undefined) {
    return null;
  }
  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt.trim() ? record.updatedAt : new Date().toISOString();
  const updatedBy =
    record.updatedBy === 'setup' || record.updatedBy === 'serve' || record.updatedBy === 'auto-start'
      ? record.updatedBy
      : 'auto-start';
  return {
    version: 1,
    port,
    rpcWsPort,
    updatedAt,
    updatedBy
  };
}

function parseRuntimeState(raw: unknown): RuntimeState | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const pid = ensurePositiveInteger(record.pid, 'runtime pid');
  const port = ensurePort(record.port, 'runtime state port');
  const rpcWsPort = ensurePort(record.rpcWsPort, 'runtime state rpc-ws-port');
  if (pid === undefined || port === undefined || rpcWsPort === undefined) {
    return null;
  }
  const stdoutLogPath = typeof record.stdoutLogPath === 'string' ? record.stdoutLogPath : null;
  const stderrLogPath = typeof record.stderrLogPath === 'string' ? record.stderrLogPath : null;
  return {
    version: 1,
    pid,
    managed: record.managed === true,
    mode: record.mode === 'background' ? 'background' : 'foreground',
    port,
    rpcWsPort,
    startedAt: typeof record.startedAt === 'string' && record.startedAt.trim() ? record.startedAt : new Date().toISOString(),
    stdoutLogPath,
    stderrLogPath
  };
}

export function readRuntimeConfig(dataDir = resolveDataDir()): RuntimeConfig | null {
  const path = runtimeConfigPath(dataDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseRuntimeConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function writeRuntimeConfig(
  resolution: Pick<RuntimePortResolution, 'dataDir' | 'port' | 'rpcWsPort'>,
  updatedBy: RuntimeConfig['updatedBy']
): RuntimeConfig {
  ensureRuntimeDataDir(resolution.dataDir);
  const payload: RuntimeConfig = {
    version: 1,
    port: resolution.port,
    rpcWsPort: resolution.rpcWsPort,
    updatedAt: new Date().toISOString(),
    updatedBy
  };
  writeFileSync(runtimeConfigPath(resolution.dataDir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export function readRuntimeState(dataDir = resolveDataDir()): RuntimeState | null {
  const path = runtimeStatePath(dataDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseRuntimeState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function writeRuntimeState(dataDir: string, state: RuntimeState): RuntimeState {
  ensureRuntimeDataDir(dataDir);
  writeFileSync(runtimeStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function clearRuntimeState(dataDir = resolveDataDir()): void {
  const path = runtimeStatePath(dataDir);
  if (!existsSync(path)) {
    return;
  }
  unlinkSync(path);
}

export function resolveRuntimeLogPaths(dataDir = resolveDataDir()): { stdoutLogPath: string; stderrLogPath: string } {
  const logDir = runtimeLogsDir(ensureRuntimeDataDir(dataDir));
  mkdirSync(logDir, { recursive: true });
  return {
    stdoutLogPath: join(logDir, 'daemon-stdout.log'),
    stderrLogPath: join(logDir, 'daemon-stderr.log')
  };
}

function selectPortSource(
  optionValue: number | undefined,
  envValue: number | undefined,
  configValue: number | undefined
): RuntimePortSource {
  if (optionValue !== undefined) {
    return 'option';
  }
  if (envValue !== undefined) {
    return 'env';
  }
  if (configValue !== undefined) {
    return 'config';
  }
  return 'default';
}

export function resolveRuntimePorts(options: {
  dataDir?: string;
  port?: unknown;
  rpcWsPort?: unknown;
} = {}): RuntimePortResolution {
  const dataDir = options.dataDir ? resolve(String(options.dataDir)) : resolveDataDir();
  const config = readRuntimeConfig(dataDir);

  const optionPort = ensurePort(options.port, 'port');
  const optionRpc = ensurePort(options.rpcWsPort, 'rpc-ws-port');
  const envPort = ensurePort(process.env.BAK_PORT, 'BAK_PORT');
  const envRpc = ensurePort(process.env.BAK_RPC_WS_PORT, 'BAK_RPC_WS_PORT');

  const port = optionPort ?? envPort ?? config?.port ?? DEFAULT_PORT;
  const portSource = selectPortSource(optionPort, envPort, config?.port);
  let candidateRpc: number;
  let rpcSource: RuntimePortSource;
  if (optionRpc !== undefined) {
    candidateRpc = optionRpc;
    rpcSource = 'option';
  } else if (envRpc !== undefined) {
    candidateRpc = envRpc;
    rpcSource = 'env';
  } else if (portSource === 'option' || portSource === 'env') {
    candidateRpc = port + 1;
    rpcSource = 'derived';
  } else if (config?.rpcWsPort !== undefined) {
    candidateRpc = config.rpcWsPort;
    rpcSource = 'config';
  } else {
    candidateRpc = port + 1;
    rpcSource = portSource === 'default' && port === DEFAULT_PORT ? 'default' : 'derived';
  }
  if (candidateRpc > 65_535) {
    throw new Error('rpc-ws-port must be <= 65535');
  }

  return {
    dataDir,
    port,
    rpcWsPort: candidateRpc,
    config,
    sources: {
      port: portSource,
      rpcWsPort: rpcSource
    }
  };
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function probeRuntimeInfo(rpcWsPort: number, timeoutMs = 1_500): Promise<Record<string, unknown> | null> {
  return await new Promise<Record<string, unknown> | null>((resolveProbe) => {
    const id = `runtime_probe_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const socket = new WebSocket(`ws://127.0.0.1:${rpcWsPort}/rpc`);
    let settled = false;
    const finish = (result: Record<string, unknown> | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.terminate();
      } catch {
        // ignore close failures during probing
      }
      resolveProbe(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          jsonrpc: JSON_RPC_VERSION,
          id,
          method: 'runtime.info',
          params: {}
        }),
        (error) => {
          if (error) {
            finish(null);
          }
        }
      );
    });

    socket.on('message', (raw) => {
      try {
        const parsed = JSON.parse(String(raw)) as JsonRpcResponse;
        if (parsed.id !== id) {
          return;
        }
        if ('result' in parsed && typeof parsed.result === 'object' && parsed.result !== null) {
          finish(parsed.result as Record<string, unknown>);
          return;
        }
      } catch {
        // fall through to null
      }
      finish(null);
    });

    socket.once('error', () => finish(null));
    socket.once('close', () => finish(null));
  });
}

async function waitForRuntimeReady(rpcWsPort: number, timeoutMs = DEFAULT_RUNTIME_WAIT_MS): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await probeRuntimeInfo(rpcWsPort);
    if (info) {
      return info;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for bak runtime on rpc port ${rpcWsPort}`);
}

async function waitForRuntimeStopped(rpcWsPort: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await probeRuntimeInfo(rpcWsPort, 700);
    if (!info) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for bak runtime on rpc port ${rpcWsPort} to stop`);
}

function runtimeVersionFromInfo(info: Record<string, unknown>): string | null {
  return typeof info.runtimeVersion === 'string' && info.runtimeVersion.trim().length > 0 ? info.runtimeVersion : null;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildRuntimeCommand(command: 'stop', resolution: RuntimePortResolution): string {
  const parts = ['bak', command, '--port', `${resolution.port}`, '--rpc-ws-port', `${resolution.rpcWsPort}`];
  if (resolution.dataDir !== resolveDataDir()) {
    parts.push('--data-dir', quotePowerShell(resolution.dataDir));
  }
  return parts.join(' ');
}

export function shouldRefreshManagedRuntime(info: Record<string, unknown>, cliVersion: string): boolean {
  if (info.managedRuntime !== true) {
    return false;
  }

  const activeSessionCount = typeof info.activeSessionCount === 'number' ? info.activeSessionCount : null;
  if (activeSessionCount !== 0) {
    return false;
  }

  return runtimeVersionFromInfo(info) !== cliVersion;
}

function lockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_TIMEOUT_MS;
  } catch {
    return false;
  }
}

async function acquireRuntimeStartLock(dataDir: string, rpcWsPort: number): Promise<() => void> {
  const lockPath = runtimeLockPath(dataDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), rpcWsPort }, null, 2)}\n`,
        'utf8'
      );
      return () => {
        rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const info = await probeRuntimeInfo(rpcWsPort);
      if (info) {
        return () => undefined;
      }
      if (lockIsStale(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      await sleep(250);
    }
  }

  throw new Error(`Timed out waiting for bak runtime start lock in ${dataDir}`);
}

function resolveServeEntrypoint(): { command: string; args: string[]; cwd: string } {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const builtBin = fileURLToPath(new URL('./bin.js', import.meta.url));
  if (existsSync(builtBin)) {
    return {
      command: process.execPath,
      args: [builtBin],
      cwd: process.cwd()
    };
  }

  const repoRoot = resolve(currentDir, '..', '..', '..');
  const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const sourceBin = join(currentDir, 'bin.ts');
  if (existsSync(tsxCli) && existsSync(sourceBin)) {
    return {
      command: process.execPath,
      args: [tsxCli, sourceBin],
      cwd: repoRoot
    };
  }

  throw new Error('Unable to resolve bak CLI entrypoint for managed runtime startup');
}

export async function ensureRuntime(resolution: RuntimePortResolution): Promise<Record<string, unknown>> {
  ensureRuntimeDataDir(resolution.dataDir);
  const cliVersion = readCliVersion();
  const existing = await probeRuntimeInfo(resolution.rpcWsPort);
  if (existing && !shouldRefreshManagedRuntime(existing, cliVersion)) {
    return existing;
  }

  const releaseLock = await acquireRuntimeStartLock(resolution.dataDir, resolution.rpcWsPort);
  try {
    const readyAfterWait = await probeRuntimeInfo(resolution.rpcWsPort);
    if (readyAfterWait && !shouldRefreshManagedRuntime(readyAfterWait, cliVersion)) {
      return readyAfterWait;
    }
    if (readyAfterWait) {
      try {
        await stopRuntime(resolution);
      } catch (error) {
        throw new Error(
          `bak runtime on rpc port ${resolution.rpcWsPort} is not running the current CLI version ${cliVersion}. ` +
            `Stop it with \`${buildRuntimeCommand('stop', resolution)}\` and retry. ` +
            `Detail: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const currentState = readRuntimeState(resolution.dataDir);
    if (currentState) {
      if (!isProcessRunning(currentState.pid)) {
        clearRuntimeState(resolution.dataDir);
      } else if (currentState.port !== resolution.port || currentState.rpcWsPort !== resolution.rpcWsPort) {
        throw new Error(
          `bak runtime already running on port ${currentState.port} / rpc ${currentState.rpcWsPort}. ` +
            `Stop it first or use matching ports.`
        );
      }
    }

    writeRuntimeConfig(resolution, 'auto-start');
    const { stdoutLogPath, stderrLogPath } = resolveRuntimeLogPaths(resolution.dataDir);
    const stdoutFd = openSync(stdoutLogPath, 'w');
    const stderrFd = openSync(stderrLogPath, 'w');
    let childPid: number | undefined;
    try {
      const entrypoint = resolveServeEntrypoint();
      const child = spawn(
        entrypoint.command,
        [...entrypoint.args, 'serve', '--port', `${resolution.port}`, '--rpc-ws-port', `${resolution.rpcWsPort}`],
        {
          cwd: entrypoint.cwd,
          env: {
            ...process.env,
            BAK_DATA_DIR: resolution.dataDir,
            BAK_RUNTIME_MANAGED: '1'
          },
          stdio: ['ignore', stdoutFd, stderrFd],
          detached: true,
          windowsHide: true
        }
      );

      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once('spawn', () => resolveSpawn());
        child.once('error', rejectSpawn);
      });

      childPid = child.pid ?? undefined;
      if (!childPid) {
        throw new Error('Managed bak runtime started without a pid');
      }

      writeRuntimeState(resolution.dataDir, {
        version: 1,
        pid: childPid,
        managed: true,
        mode: 'background',
        port: resolution.port,
        rpcWsPort: resolution.rpcWsPort,
        startedAt: new Date().toISOString(),
        stdoutLogPath,
        stderrLogPath
      });

      child.unref();
      return await waitForRuntimeReady(resolution.rpcWsPort);
    } catch (error) {
      if (childPid && isProcessRunning(childPid)) {
        try {
          process.kill(childPid);
        } catch {
          // ignore best-effort cleanup failures
        }
      }
      clearRuntimeState(resolution.dataDir);
      throw new Error(
        `Failed to auto-start bak runtime on rpc port ${resolution.rpcWsPort}. ` +
          `Check ${stderrLogPath}. Detail: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  } finally {
    releaseLock();
  }
}

export async function runtimeStatus(resolution: RuntimePortResolution): Promise<RuntimeStatus> {
  const state = readRuntimeState(resolution.dataDir);
  const info = await probeRuntimeInfo(resolution.rpcWsPort);
  const pidRunning = state ? isProcessRunning(state.pid) : false;
  const running = Boolean(info) || pidRunning;
  const rpcReachable = Boolean(info);
  const staleMetadata = Boolean(state) && !pidRunning;

  return {
    running,
    rpcReachable,
    health: info ? 'healthy' : running ? 'degraded' : 'stopped',
    managed: state?.managed ?? false,
    mode: state?.mode ?? null,
    pid: state?.pid ?? null,
    port: resolution.port,
    rpcWsPort: resolution.rpcWsPort,
    dataDir: resolution.dataDir,
    metadataPresent: Boolean(state),
    staleMetadata,
    stdoutLogPath: state?.stdoutLogPath ?? null,
    stderrLogPath: state?.stderrLogPath ?? null,
    ...(info ? { info } : {})
  };
}

export async function stopRuntime(resolution: RuntimePortResolution): Promise<StopRuntimeResult> {
  const state = readRuntimeState(resolution.dataDir);
  const info = await probeRuntimeInfo(resolution.rpcWsPort);
  if (!state) {
    if (info) {
      throw new Error('Refusing to stop bak runtime without managed metadata. Stop the original process manually.');
    }
    return {
      stopped: false,
      cleanedStaleMetadata: false,
      running: false,
      managed: false,
      pid: null,
      port: resolution.port,
      rpcWsPort: resolution.rpcWsPort
    };
  }

  if (!state.managed) {
    throw new Error('Refusing to stop unmanaged bak runtime. Stop the foreground `bak serve` process manually.');
  }

  if (!isProcessRunning(state.pid)) {
    clearRuntimeState(resolution.dataDir);
    return {
      stopped: false,
      cleanedStaleMetadata: true,
      running: Boolean(info),
      managed: true,
      pid: state.pid,
      port: state.port,
      rpcWsPort: state.rpcWsPort
    };
  }

  process.kill(state.pid);
  await waitForRuntimeStopped(state.rpcWsPort);
  clearRuntimeState(resolution.dataDir);
  return {
    stopped: true,
    cleanedStaleMetadata: false,
    running: false,
    managed: true,
    pid: state.pid,
    port: state.port,
    rpcWsPort: state.rpcWsPort
  };
}
