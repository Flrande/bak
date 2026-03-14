import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { methodStatusPath } from './method-status';
import { cliDistPath, ensureE2ERuntimeFresh } from './runtime';

const SESSION_METADATA_PATH = 'e2e-session.json';
const DIRECT_SESSION_SCOPED_COMMANDS = new Set(['page', 'element', 'keyboard', 'mouse', 'file', 'context', 'network', 'debug', 'table', 'inspect', 'capture']);
const SESSION_SUBCOMMANDS_REQUIRING_ID = new Set(['info', 'close', 'ensure', 'open-tab', 'list-tabs', 'get-active-tab', 'set-active-tab', 'focus', 'reset']);
const POLICY_SUBCOMMANDS_WITHOUT_RPC = new Set(['status', 'audit', 'recommend']);

export function cliBinPath(): string {
  const root = resolve(__dirname, '../..', '..');
  ensureE2ERuntimeFresh(root);
  return cliDistPath(root);
}

function readHarnessSessionId(dataDir: string): string | undefined {
  const sessionPath = resolve(dataDir, SESSION_METADATA_PATH);
  if (!existsSync(sessionPath)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(sessionPath, 'utf8')) as { sessionId?: unknown };
  return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : undefined;
}

function maybeAppendSessionId(args: string[], sessionId?: string): string[] {
  if (!sessionId || args.includes('--session-id')) {
    return args;
  }
  const root = args[0] ?? '';
  if (DIRECT_SESSION_SCOPED_COMMANDS.has(root)) {
    return [...args, '--session-id', sessionId];
  }
  if (root !== 'session' || !SESSION_SUBCOMMANDS_REQUIRING_ID.has(args[1] ?? '')) {
    return args;
  }
  return [...args, '--session-id', sessionId];
}

function maybeAppendRpcPort(args: string[], rpcPort: number): string[] {
  if (args[0] === 'policy' && POLICY_SUBCOMMANDS_WITHOUT_RPC.has(args[1] ?? '')) {
    return args;
  }
  return [...args, '--rpc-ws-port', String(rpcPort)];
}

export function runCli<T = unknown>(args: string[], rpcPort: number, dataDir: string, sessionId?: string): T {
  const cliArgs = maybeAppendRpcPort(
    maybeAppendSessionId(args, sessionId ?? readHarnessSessionId(dataDir)),
    rpcPort
  );
  const output = execFileSync('node', [cliBinPath(), ...cliArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BAK_DATA_DIR: dataDir,
      BAK_E2E_METHOD_STATUS_PATH: methodStatusPath()
    },
    encoding: 'utf8'
  });
  return JSON.parse(output) as T;
}

export function runCliFailure(args: string[], rpcPort: number, dataDir: string, sessionId?: string): string {
  try {
    runCli(args, rpcPort, dataDir, sessionId);
    throw new Error('Expected CLI command to fail');
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
    return stderr || (error instanceof Error ? error.message : String(error));
  }
}

export function readJsonFile<T = unknown>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`JSON file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
