import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cliDistPath, ensureE2ERuntimeFresh } from './runtime';

export function cliBinPath(): string {
  const root = resolve(__dirname, '../..', '..');
  ensureE2ERuntimeFresh(root);
  return cliDistPath(root);
}

export function runCli<T = unknown>(args: string[], rpcPort: number, dataDir: string): T {
  const output = execFileSync('node', [cliBinPath(), ...args, '--rpc-ws-port', String(rpcPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BAK_DATA_DIR: dataDir
    },
    encoding: 'utf8'
  });
  return JSON.parse(output) as T;
}

export function runCliFailure(args: string[], rpcPort: number, dataDir: string): string {
  try {
    runCli(args, rpcPort, dataDir);
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
