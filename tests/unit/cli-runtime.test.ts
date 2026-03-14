import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PairingStore } from '../../packages/cli/src/pairing-store.js';
import { cliDistPath, ensureE2ERuntimeFresh } from '../e2e/helpers/runtime';

const repoRoot = resolve(__dirname, '..', '..');
const CLI_TEST_TIMEOUT_MS = 40_000;
let cachedCliBinPath: string | null = null;

function cliBinPath(): string {
  if (cachedCliBinPath) {
    return cachedCliBinPath;
  }
  ensureE2ERuntimeFresh(repoRoot);
  cachedCliBinPath = cliDistPath(repoRoot);
  return cachedCliBinPath;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env
  };
  for (const key of Object.keys(childEnv)) {
    if (key === 'NODE_OPTIONS' || key.startsWith('VITEST')) {
      delete childEnv[key];
    }
  }
  return spawnSync(process.execPath, [cliBinPath(), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: childEnv
  });
}

function writePolicyTraceEntries(
  dataDir: string,
  traceId: string,
  entries: Array<{ ts: string; params: Record<string, unknown> }>
): void {
  const tracesDir = join(dataDir, 'traces');
  mkdirSync(tracesDir, { recursive: true });
  writeFileSync(
    join(tracesDir, `${traceId}.jsonl`),
    entries
      .map((entry) =>
        JSON.stringify({
          traceId,
          ts: entry.ts,
          method: 'policy.decision',
          params: entry.params
        })
      )
      .join('\n')
      .concat('\n'),
    'utf8'
  );
}

async function waitForServeReady(child: ChildProcessWithoutNullStreams, timeoutMs = 15_000): Promise<void> {
  return await new Promise<void>((resolveReady, rejectReady) => {
    const deadline = setTimeout(() => {
      cleanup();
      rejectReady(new Error('Timed out waiting for bak serve to become ready'));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (!text.includes('bak daemon ready')) {
        return;
      }
      cleanup();
      resolveReady();
    };

    const onExit = (): void => {
      cleanup();
      rejectReady(new Error('bak serve exited before becoming ready'));
    };

    const cleanup = (): void => {
      clearTimeout(deadline);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };

    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore forced cleanup failures
      }
      resolveStop();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

afterEach(() => {
  delete process.env.BAK_DATA_DIR;
  delete process.env.BAK_PORT;
  delete process.env.BAK_RPC_WS_PORT;
});

describe('cli runtime management', () => {
  it('doctor --no-auto-start preserves offline diagnostics', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-runtime-offline-'));
    const env = {
      BAK_DATA_DIR: dataDir,
      BAK_PORT: '26273',
      BAK_RPC_WS_PORT: '26274'
    };

    try {
      const doctor = runCli(['doctor', '--data-dir', dataDir, '--no-auto-start'], env);
      expect(doctor.status).toBe(0);
      const report = JSON.parse(doctor.stdout) as {
        checks: {
          rpcRuntimeInfo: { ok: boolean };
        };
      };
      expect(report.checks.rpcRuntimeInfo.ok).toBe(false);

      const status = runCli(['status', '--data-dir', dataDir], env);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        running: false
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('setup --json advertises auto-start and status commands', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-runtime-setup-'));
    const env = {
      BAK_DATA_DIR: dataDir
    };

    try {
      const setup = runCli(['setup', '--json', '--port', '26473', '--rpc-ws-port', '26474'], env);
      expect(setup.status).toBe(0);
      expect(JSON.parse(setup.stdout)).toMatchObject({
        autoStart: true,
        port: 26473,
        rpcWsPort: 26474,
        statusCommand: 'bak status --port 26473 --rpc-ws-port 26474'
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('doctor auto-starts even when a custom data dir does not exist yet', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'bak-cli-runtime-custom-root-'));
    const dataDir = join(parentDir, 'custom-data-dir');
    const env = {
      BAK_PORT: '26773',
      BAK_RPC_WS_PORT: '26774'
    };

    try {
      const doctor = runCli(['doctor', '--data-dir', dataDir, '--port', '26773', '--rpc-ws-port', '26774'], env);
      expect(doctor.status).toBe(0);
      expect(existsSync(dataDir)).toBe(true);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        checks: {
          runtimeVersionCompatibility: {
            ok: true
          }
        }
      });

      const status = runCli(['status', '--data-dir', dataDir, '--port', '26773', '--rpc-ws-port', '26774'], env);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        running: true,
        managed: true,
        mode: 'background',
        port: 26773,
        rpcWsPort: 26774
      });

      const stop = runCli(['stop', '--data-dir', dataDir, '--port', '26773', '--rpc-ws-port', '26774'], env);
      expect(stop.status).toBe(0);
      expect(JSON.parse(stop.stdout)).toMatchObject({
        stopped: true,
        managed: true
      });
    } finally {
      runCli(['stop', '--data-dir', dataDir, '--port', '26773', '--rpc-ws-port', '26774'], env);
      rmSync(parentDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('doctor --fix applies safe local fixes without rotating pairing state', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-runtime-fix-'));
    const env = {
      BAK_DATA_DIR: dataDir,
      BAK_PORT: '26873',
      BAK_RPC_WS_PORT: '26874'
    };

    try {
      const doctor = runCli(['doctor', '--fix', '--data-dir', dataDir, '--port', '26873', '--rpc-ws-port', '26874'], env);
      expect(doctor.status).toBe(0);
      const report = JSON.parse(doctor.stdout) as {
        diagnosis: Array<{ code: string }>;
        fixesApplied: Array<{ code: string; ok: boolean }>;
        nextActions: Array<{ code: string; command?: string }>;
      };

      expect(report.fixesApplied).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'WRITE_RUNTIME_CONFIG', ok: true }),
          expect.objectContaining({ code: 'START_MANAGED_RUNTIME', ok: true })
        ])
      );
      expect(report.diagnosis).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PAIRING_MISSING' })])
      );
      expect(report.nextActions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'PAIRING_MISSING',
            command: expect.stringContaining('bak setup')
          })
        ])
      );
      expect(new PairingStore(dataDir).status().reason).toBe('missing');

      const status = runCli(['status', '--data-dir', dataDir, '--port', '26873', '--rpc-ws-port', '26874'], env);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        running: true,
        managed: true,
        mode: 'background',
        port: 26873,
        rpcWsPort: 26874
      });

      const stop = runCli(['stop', '--data-dir', dataDir, '--port', '26873', '--rpc-ws-port', '26874'], env);
      expect(stop.status).toBe(0);
    } finally {
      runCli(['stop', '--data-dir', dataDir, '--port', '26873', '--rpc-ws-port', '26874'], env);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('session dashboard returns a stable runtime/session view even before any tabs are attached', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-session-dashboard-'));
    const env = {
      BAK_DATA_DIR: dataDir,
      BAK_PORT: '26973',
      BAK_RPC_WS_PORT: '26974'
    };

    try {
      const dashboard = runCli(['session', 'dashboard', '--rpc-ws-port', '26974'], env);
      expect(dashboard.status).toBe(0);
      expect(JSON.parse(dashboard.stdout)).toMatchObject({
        runtime: {
          paired: false,
          extensionConnected: false,
          activeSessionCount: 0
        },
        sessions: []
      });

      const stop = runCli(['stop', '--data-dir', dataDir, '--port', '26973', '--rpc-ws-port', '26974'], env);
      expect(stop.status).toBe(0);
    } finally {
      runCli(['stop', '--data-dir', dataDir, '--port', '26973', '--rpc-ws-port', '26974'], env);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('policy status and preview work offline from only the local data dir', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-policy-offline-'));

    try {
      writeFileSync(
        join(dataDir, '.bak-policy.json'),
        `${JSON.stringify(
          {
            rules: [
              {
                id: 'allow-upload',
                action: 'file.upload',
                domain: 'example.com',
                pathPrefix: '/upload',
                tag: 'fileUpload',
                decision: 'allow',
                reason: 'trusted upload path'
              }
            ]
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      const status = runCli(['policy', 'status', '--data-dir', dataDir]);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        policyPath: join(dataDir, '.bak-policy.json'),
        exists: true,
        ruleCount: 1,
        defaults: {
          fileUpload: 'deny',
          payment: 'requireConfirm',
          destructive: 'requireConfirm',
          submit: 'requireConfirm',
          highRisk: 'requireConfirm',
          otherwise: 'allow'
        }
      });

      const preview = runCli([
        'policy',
        'preview',
        '--action',
        'file.upload',
        '--domain',
        'example.com',
        '--path',
        '/upload',
        '--css',
        'input[type="file"]',
        '--data-dir',
        dataDir
      ]);
      expect(preview.status).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        resolvedContext: {
          action: 'file.upload',
          domain: 'example.com',
          path: '/upload',
          contextSource: 'explicit'
        },
        decision: {
          decision: 'allow',
          source: 'rule',
          ruleId: 'allow-upload'
        }
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('policy audit and recommend read local trace files without rewriting the policy file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-policy-audit-'));

    try {
      const policyPath = join(dataDir, '.bak-policy.json');
      writeFileSync(
        policyPath,
        `${JSON.stringify(
          {
            rules: [
              {
                id: 'keep-existing-policy',
                action: 'element.click',
                decision: 'deny',
                domain: 'example.com',
                pathPrefix: '/danger',
                reason: 'existing local policy'
              }
            ]
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      const originalPolicy = readFileSync(policyPath, 'utf8');

      writePolicyTraceEntries(dataDir, 'trace-policy-a', [
        {
          ts: '2026-03-14T12:00:00.000Z',
          params: {
            action: 'element.click',
            decision: 'requireConfirm',
            reason: 'high-risk action requires explicit user confirmation',
            source: 'default',
            ruleId: null,
            domain: 'example.com',
            path: '/danger',
            tags: ['submit', 'highRisk'],
            matchedRuleCount: 0,
            defaultDecision: 'requireConfirm'
          }
        }
      ]);
      writePolicyTraceEntries(dataDir, 'trace-policy-b', [
        {
          ts: '2026-03-14T12:05:00.000Z',
          params: {
            action: 'element.click',
            decision: 'requireConfirm',
            reason: 'high-risk action requires explicit user confirmation',
            source: 'default',
            ruleId: null,
            domain: 'example.com',
            path: '/danger',
            tags: ['submit'],
            matchedRuleCount: 0,
            defaultDecision: 'requireConfirm'
          }
        }
      ]);

      const audit = runCli(['policy', 'audit', '--trace-id', 'trace-policy-a', '--data-dir', dataDir]);
      expect(audit.status).toBe(0);
      expect(JSON.parse(audit.stdout)).toMatchObject({
        summary: {
          total: 1,
          byDecision: {
            requireConfirm: 1
          }
        },
        entries: [
          {
            traceId: 'trace-policy-a',
            action: 'element.click',
            decision: 'requireConfirm',
            source: 'default',
            domain: 'example.com',
            path: '/danger'
          }
        ]
      });

      const recommend = runCli([
        'policy',
        'recommend',
        '--decision',
        'requireConfirm',
        '--min-occurrences',
        '2',
        '--data-dir',
        dataDir
      ]);
      expect(recommend.status).toBe(0);
      expect(JSON.parse(recommend.stdout)).toMatchObject({
        suggestions: [
          {
            rule: {
              action: 'element.click',
              decision: 'requireConfirm',
              domain: 'example.com',
              pathPrefix: '/danger',
              tag: 'submit'
            },
            basis: {
              occurrenceCount: 2,
              action: 'element.click',
              decision: 'requireConfirm',
              domain: 'example.com',
              path: '/danger',
              tag: 'submit'
            }
          }
        ]
      });
      expect(readFileSync(policyPath, 'utf8')).toBe(originalPolicy);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('capture har auto-starts the managed runtime before reporting command errors', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-runtime-capture-'));
    const env = {
      BAK_DATA_DIR: dataDir,
      BAK_PORT: '26673',
      BAK_RPC_WS_PORT: '26674'
    };

    try {
      const capture = runCli(['capture', 'har'], env);
      expect(capture.status).toBe(1);

      const status = runCli(['status', '--data-dir', dataDir], env);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        running: true,
        managed: true,
        mode: 'background',
        port: 26673,
        rpcWsPort: 26674
      });

      const stop = runCli(['stop', '--data-dir', dataDir], env);
      expect(stop.status).toBe(0);
      expect(JSON.parse(stop.stdout)).toMatchObject({
        stopped: true,
        managed: true
      });
    } finally {
      runCli(['stop', '--data-dir', dataDir], env);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('status sees a foreground serve session and stop refuses to kill it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-cli-runtime-serve-'));
    const env = {
      ...process.env,
      BAK_DATA_DIR: dataDir,
      BAK_PORT: '26573',
      BAK_RPC_WS_PORT: '26574'
    };
    for (const key of Object.keys(env)) {
      if (key === 'NODE_OPTIONS' || key.startsWith('VITEST')) {
        delete env[key];
      }
    }
    const child = spawn(process.execPath, [cliBinPath(), 'serve'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
      await waitForServeReady(child);

      const status = runCli(['status', '--data-dir', dataDir], env);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        running: true,
        managed: false,
        mode: 'foreground',
        port: 26573,
        rpcWsPort: 26574
      });

      const stop = runCli(['stop', '--data-dir', dataDir], env);
      expect(stop.status).toBe(1);
      expect(stop.stderr).toContain('Refusing to stop unmanaged bak runtime');
    } finally {
      await stopChild(child);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);
});
