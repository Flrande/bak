import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const tsxCliPath = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runHelp(args: string[]): string {
  return execFileSync(process.execPath, [tsxCliPath, 'packages/cli/src/bin.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

describe('cli help output', () => {
  it('documents the top-level quick start and targeting rules', () => {
    const help = runHelp(['--help']);

    expect(help).toContain('Drive a real Chromium browser for an agent');
    expect(help).toContain('Use bak call when the protocol exposes a method');
    expect(help).toContain('bak session ensure --session-id session_123 --rpc-ws-port 17374');
  });

  it('documents session browser helpers and current-tab targeting', () => {
    const help = runHelp(['session', '--help']);

    expect(help).toContain('Manage multi-agent sessions and their dedicated browser state');
    expect(help).toContain('Each session owns one dedicated browser binding');
    expect(help).toContain('bak session open-tab --session-id session_123 --url "https://example.com" --rpc-ws-port 17374');
  });

  it('documents session ensure as the explicit repair entrypoint', () => {
    const help = runHelp(['session', 'ensure', '--help']);

    expect(help).toContain('Create or repair the dedicated browser window');
    expect(help).toContain('bak session ensure --session-id session_123 --url "https://example.com" --focus --rpc-ws-port 17374');
  });

  it('documents page help and protocol-only navigation fallback', () => {
    const help = runHelp(['page', '--help']);

    expect(help).toContain('Use bak call for protocol-only navigation helpers');
    expect(help).toContain('bak page snapshot --include-base64 --rpc-ws-port 17374');
  });

  it('documents bak call as the fallback for protocol-only methods', () => {
    const help = runHelp(['call', '--help']);

    expect(help).toContain('page.reload');
    expect(help).toContain('page.scrollTo');
    expect(help).toContain('bak call --method page.reload --params "{}" --rpc-ws-port 17374');
  });
});
