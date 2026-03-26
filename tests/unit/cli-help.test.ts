import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliDistPath, ensureE2ERuntimeFresh } from '../e2e/helpers/runtime';

const repoRoot = resolve(__dirname, '..', '..');
let cachedCliBinPath: string | null = null;

function cliBinPath(): string {
  if (cachedCliBinPath) {
    return cachedCliBinPath;
  }
  ensureE2ERuntimeFresh(repoRoot);
  cachedCliBinPath = cliDistPath(repoRoot);
  return cachedCliBinPath;
}

function runHelp(args: string[]): string {
  return execFileSync(process.execPath, [cliBinPath(), ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

describe('cli help output', { timeout: 30_000 }, () => {
  it('documents the top-level quick start and targeting rules', () => {
    const help = runHelp(['--help']);

    expect(help).toContain('Drive a real Chromium browser for an agent');
    expect(help).toContain('Use bak call when the protocol exposes a method');
    expect(help).toContain('bak session resolve --client-name agent-a --rpc-ws-port 17374');
  });

  it('documents session browser helpers and current-tab targeting', () => {
    const help = runHelp(['session', '--help']);

    expect(help).toContain('Manage multi-agent sessions and their browser state plus per-session tab groups');
    expect(help).toContain('Live sessions attach to the current browser window by default');
    expect(help).toContain('bak session open-tab --session-id session_123 --url "https://example.com" --rpc-ws-port 17374');
    expect(help).toContain('dashboard');
  });

  it('documents session resolve and close-tab as first-class lifecycle commands', () => {
    const help = runHelp(['session', '--help']);

    expect(help).toContain('resolve');
    expect(help).toContain('close-tab');
  });

  it('documents session ensure as the explicit repair entrypoint', () => {
    const help = runHelp(['session', 'ensure', '--help']);

    expect(help).toContain('Create or repair the session group and tracked tabs');
    expect(help).toContain('bak session ensure --session-id session_123 --url "https://example.com" --focus --rpc-ws-port 17374');
  });

  it('documents doctor --fix as the safe local repair path', () => {
    const help = runHelp(['doctor', '--help']);

    expect(help).toContain('--fix');
    expect(help).toContain('repair local runtime config/state');
    expect(help).toContain('bak doctor --fix');
  });

  it('documents policy workflow commands and preview targeting flags', () => {
    const help = runHelp(['policy', '--help']);
    const previewHelp = runHelp(['policy', 'preview', '--help']);

    expect(help).toContain('status');
    expect(help).toContain('preview');
    expect(help).toContain('audit');
    expect(help).toContain('recommend');
    expect(help).toContain('bak policy preview --action element.click --domain example.com --path /settings --css "#submit"');
    expect(previewHelp).toContain('--action <action>');
    expect(previewHelp).toContain('--domain <domain>');
    expect(previewHelp).toContain('--path <path>');
    expect(previewHelp).toContain('--client-name <name>');
  });

  it('documents page help and protocol-only navigation fallback', () => {
    const help = runHelp(['page', '--help']);
    const gotoHelp = runHelp(['page', 'goto', '--help']);

    expect(help).toContain('Use bak call for protocol-only navigation helpers');
    expect(help).toContain('bak page verify --capture --annotate --rpc-ws-port 17374');
    expect(gotoHelp).toContain('--reuse-domain');
    expect(gotoHelp).toContain('--reuse-url-contains <text>');
  });

  it('documents snapshot annotation and diff flags on page and debug commands', () => {
    const pageSnapshotHelp = runHelp(['page', 'snapshot', '--help']);
    const debugDumpHelp = runHelp(['debug', 'dump-state', '--help']);

    expect(pageSnapshotHelp).toContain('--annotate');
    expect(pageSnapshotHelp).toContain('--diff-with <path>');
    expect(debugDumpHelp).toContain('--annotate-snapshot');
    expect(debugDumpHelp).toContain('--snapshot-diff-with <path>');
  });

  it('documents page verify as the resilient preflight command', () => {
    const verifyHelp = runHelp(['page', 'verify', '--help']);

    expect(verifyHelp).toContain('--capture');
    expect(verifyHelp).toContain('--annotate');
    expect(verifyHelp).toContain('title, URL, context, freshness, refs');
  });

  it('documents page text chunk sizing controls', () => {
    const textHelp = runHelp(['page', 'text', '--help']);

    expect(textHelp).toContain('--max-chunks <count>');
    expect(textHelp).toContain('--chunk-size <chars>');
  });

  it('documents fetch and replay auth controls', () => {
    const fetchHelp = runHelp(['page', 'fetch', '--help']);
    const replayHelp = runHelp(['network', 'replay', '--help']);

    expect(fetchHelp).toContain('--auth <mode>');
    expect(fetchHelp).toContain('--out <path>');
    expect(replayHelp).toContain('--auth <mode>');
    expect(replayHelp).toContain('--out <path>');
  });

  it('documents table commands with concrete table ids instead of placeholder names', () => {
    const tableHelp = runHelp(['table', '--help']);
    const rowsHelp = runHelp(['table', 'rows', '--help']);

    expect(tableHelp).toContain('html:1');
    expect(tableHelp).not.toContain('table-1');
    expect(rowsHelp).toContain('html:1');
  });

  it('documents tabs new as a recovery-only session-aware compatibility command', () => {
    const help = runHelp(['tabs', 'new', '--help']);

    expect(help).toContain('Open a new browser tab inside the current session');
    expect(help).toContain('recovery-only compatibility');
    expect(help).toContain('--client-name <name>');
  });

  it('documents bak call as the fallback for protocol-only methods', () => {
    const help = runHelp(['call', '--help']);

    expect(help).toContain('page.reload');
    expect(help).toContain('page.scrollTo');
    expect(help).toContain('bak call --method page.reload --params "{}" --rpc-ws-port 17374');
  });
});
