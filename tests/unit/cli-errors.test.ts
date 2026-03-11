import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const tsxCliPath = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [tsxCliPath, 'packages/cli/src/bin.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

describe('cli error output', () => {
  it('emits structured json for commander parse failures when --json-errors is enabled', () => {
    const result = runCli(['--json-errors', 'page', 'eval']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const payload = JSON.parse(result.stderr) as {
      ok: boolean;
      error: {
        code: number;
        message: string;
        data?: {
          commanderCode?: string;
        };
      };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.data?.commanderCode).toMatch(/^commander\./);
  });
});
