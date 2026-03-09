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
    expect(help).toContain('bak workspace ensure --rpc-ws-port 17374');
  });

  it('documents workspace behavior and current-tab targeting', () => {
    const help = runHelp(['workspace', '--help']);

    expect(help).toContain('Manage the dedicated agent workspace window');
    expect(help).toContain('workspace ensure creates or repairs the agent-owned browser window');
    expect(help).toContain('bak workspace open-tab --url "https://example.com" --rpc-ws-port 17374');
  });

  it('documents workspace ensure as the explicit repair entrypoint', () => {
    const help = runHelp(['workspace', 'ensure', '--help']);

    expect(help).toContain('Create or repair the workspace window, group, and tracked tabs');
    expect(help).toContain('bak workspace ensure --url "https://example.com" --focus --rpc-ws-port 17374');
  });

  it('documents page help and protocol-only navigation fallback', () => {
    const help = runHelp(['page', '--help']);

    expect(help).toContain('Use bak call for protocol-only navigation helpers');
    expect(help).toContain('bak page snapshot --include-base64 --rpc-ws-port 17374');
  });

  it('documents memory help with explicit sqlite-backed workflow', () => {
    const help = runHelp(['memory', '--help']);

    expect(help).toContain('Memory is explicit');
    expect(help).toContain('The current backend is sqlite');
    expect(help).toContain('bak memory search --goal "return to billing settings" --kind route --rpc-ws-port 17374');
  });

  it('documents memory plan creation examples', () => {
    const help = runHelp(['memory', 'plan', 'create', '--help']);

    expect(help).toContain('Create an execution plan from one memory or a route plus procedure pair');
    expect(help).toContain('assist is the safest default');
    expect(help).toContain('bak memory plan create --route-memory-id mem_route --procedure-memory-id mem_proc --param accountName=Acme --rpc-ws-port 17374');
  });

  it('documents bak call as the fallback for protocol-only methods', () => {
    const help = runHelp(['call', '--help']);

    expect(help).toContain('page.reload');
    expect(help).toContain('page.scrollTo');
    expect(help).toContain('bak call --method page.reload --params "{}" --rpc-ws-port 17374');
  });
});
