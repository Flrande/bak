import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeState,
  readRuntimeConfig,
  readRuntimeState,
  resolveRuntimePorts,
  runtimeStatus,
  shouldRefreshManagedRuntime,
  stopRuntime,
  writeRuntimeConfig,
  writeRuntimeState
} from '../../packages/cli/src/runtime-manager.js';

const ORIGINAL_ENV = {
  BAK_PORT: process.env.BAK_PORT,
  BAK_RPC_WS_PORT: process.env.BAK_RPC_WS_PORT
};

afterEach(() => {
  if (ORIGINAL_ENV.BAK_PORT === undefined) {
    delete process.env.BAK_PORT;
  } else {
    process.env.BAK_PORT = ORIGINAL_ENV.BAK_PORT;
  }
  if (ORIGINAL_ENV.BAK_RPC_WS_PORT === undefined) {
    delete process.env.BAK_RPC_WS_PORT;
  } else {
    process.env.BAK_RPC_WS_PORT = ORIGINAL_ENV.BAK_RPC_WS_PORT;
  }
});

describe('runtime manager', () => {
  it('resolves ports with option, env, config, and default precedence', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-runtime-config-'));
    try {
      writeRuntimeConfig({ dataDir, port: 21173, rpcWsPort: 21174 }, 'setup');
      expect(readRuntimeConfig(dataDir)).toMatchObject({
        port: 21173,
        rpcWsPort: 21174,
        updatedBy: 'setup'
      });

      process.env.BAK_PORT = '22173';
      process.env.BAK_RPC_WS_PORT = '22174';
      expect(resolveRuntimePorts({ dataDir })).toMatchObject({
        port: 22173,
        rpcWsPort: 22174,
        sources: {
          port: 'env',
          rpcWsPort: 'env'
        }
      });

      delete process.env.BAK_RPC_WS_PORT;
      expect(resolveRuntimePorts({ dataDir })).toMatchObject({
        port: 22173,
        rpcWsPort: 22174,
        sources: {
          port: 'env',
          rpcWsPort: 'derived'
        }
      });

      expect(resolveRuntimePorts({ dataDir, port: '23173', rpcWsPort: '23174' })).toMatchObject({
        port: 23173,
        rpcWsPort: 23174,
        sources: {
          port: 'option',
          rpcWsPort: 'option'
        }
      });

      expect(resolveRuntimePorts({ dataDir, port: '24173' })).toMatchObject({
        port: 24173,
        rpcWsPort: 24174,
        sources: {
          port: 'option',
          rpcWsPort: 'derived'
        }
      });

      delete process.env.BAK_PORT;
      expect(resolveRuntimePorts({ dataDir })).toMatchObject({
        port: 21173,
        rpcWsPort: 21174,
        sources: {
          port: 'config',
          rpcWsPort: 'config'
        }
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('supports null log paths in runtime state for foreground serve', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-runtime-state-'));
    try {
      writeRuntimeState(dataDir, {
        version: 1,
        pid: 12345,
        managed: false,
        mode: 'foreground',
        port: 17373,
        rpcWsPort: 17374,
        startedAt: '2026-03-12T00:00:00.000Z',
        stdoutLogPath: null,
        stderrLogPath: null
      });

      expect(readRuntimeState(dataDir)).toMatchObject({
        pid: 12345,
        managed: false,
        mode: 'foreground',
        stdoutLogPath: null,
        stderrLogPath: null
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('cleans stale managed runtime metadata when stop sees a dead process', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-runtime-stop-'));
    try {
      writeRuntimeState(dataDir, {
        version: 1,
        pid: 999_999,
        managed: true,
        mode: 'background',
        port: 29173,
        rpcWsPort: 29174,
        startedAt: new Date().toISOString(),
        stdoutLogPath: join(dataDir, 'runtime-logs', 'daemon-stdout.log'),
        stderrLogPath: join(dataDir, 'runtime-logs', 'daemon-stderr.log')
      });

      const result = await stopRuntime(resolveRuntimePorts({ dataDir, port: '29173', rpcWsPort: '29174' }));

      expect(result.stopped).toBe(false);
      expect(result.cleanedStaleMetadata).toBe(true);
      expect(readRuntimeState(dataDir)).toBeNull();
      clearRuntimeState(dataDir);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reports degraded health when the pid is alive but rpc is unreachable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-runtime-status-degraded-'));
    try {
      writeRuntimeState(dataDir, {
        version: 1,
        pid: process.pid,
        managed: true,
        mode: 'background',
        port: 30173,
        rpcWsPort: 30174,
        startedAt: new Date().toISOString(),
        stdoutLogPath: join(dataDir, 'runtime-logs', 'daemon-stdout.log'),
        stderrLogPath: join(dataDir, 'runtime-logs', 'daemon-stderr.log')
      });

      const status = await runtimeStatus(resolveRuntimePorts({ dataDir, port: '30173', rpcWsPort: '30174' }));

      expect(status).toMatchObject({
        running: true,
        rpcReachable: false,
        health: 'degraded',
        managed: true,
        pid: process.pid
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('refreshes a managed runtime with no active sessions when the runtime version mismatches', () => {
    expect(
      shouldRefreshManagedRuntime(
        {
          managedRuntime: true,
          activeSessionCount: 0,
          runtimeVersion: '0.6.10'
        },
        '0.6.11'
      )
    ).toBe(true);
  });

  it('keeps a managed runtime running when active sessions are present', () => {
    expect(
      shouldRefreshManagedRuntime(
        {
          managedRuntime: true,
          activeSessionCount: 2,
          runtimeVersion: '0.6.10'
        },
        '0.6.11'
      )
    ).toBe(false);
  });

  it('keeps an aligned managed runtime running', () => {
    expect(
      shouldRefreshManagedRuntime(
        {
          managedRuntime: true,
          activeSessionCount: 0,
          runtimeVersion: '0.6.11'
        },
        '0.6.11'
      )
    ).toBe(false);
  });
});
