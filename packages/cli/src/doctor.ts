import { createServer } from 'node:net';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { callRpc } from './rpc/client.js';
import { PairingStore } from './pairing-store.js';
import { ensureDir, resolveDataDir } from './utils.js';

export interface DoctorOptions {
  dataDir?: string;
  port: number;
  rpcWsPort: number;
}

interface DoctorCheck {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  ok: boolean;
  timestamp: string;
  nodeVersion: string;
  dataDir: string;
  checks: {
    dataDirWritable: DoctorCheck;
    pairing: DoctorCheck;
    extensionBridgePort: DoctorCheck;
    rpcPort: DoctorCheck;
    rpcSessionInfo: DoctorCheck;
    rpcConnectionHealth: DoctorCheck;
  };
}

async function probePortAvailable(port: number): Promise<DoctorCheck> {
  return new Promise<DoctorCheck>((resolveCheck) => {
    const server = createServer();
    server.once('error', (error) => {
      resolveCheck({
        ok: false,
        message: `port ${port} already in use`,
        details: {
          code: (error as NodeJS.ErrnoException).code
        }
      });
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolveCheck({
          ok: true,
          message: `port ${port} is available`
        });
      });
    });
  });
}

function checkDataDirWritable(dataDir: string): DoctorCheck {
  try {
    ensureDir(dataDir);
    const probeFile = join(dataDir, `doctor-${Date.now()}.tmp`);
    writeFileSync(probeFile, 'ok', 'utf8');
    unlinkSync(probeFile);
    return { ok: true, message: 'dataDir is writable' };
  } catch (error) {
    return {
      ok: false,
      message: 'dataDir is not writable',
      details: {
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function checkPairing(dataDir: string): DoctorCheck {
  try {
    const pairing = new PairingStore(dataDir);
    const status = pairing.status();
    if (status.paired) {
      return {
        ok: true,
        message: 'pair token is active',
        details: status
      };
    }
    if (status.expired) {
      return {
        ok: false,
        message: 'pair token expired, rotate with `bak pair`',
        details: status
      };
    }
    return {
      ok: false,
      message: 'pair token missing or revoked, run `bak pair`',
      details: status
    };
  } catch (error) {
    return {
      ok: false,
      message: 'unable to read pairing state',
      details: {
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function checkRpcSessionInfo(rpcWsPort: number): Promise<DoctorCheck> {
  try {
    const info = (await callRpc('session.info', {}, rpcWsPort)) as Record<string, unknown>;
    return {
      ok: true,
      message: 'rpc session.info reachable',
      details: info
    };
  } catch (error) {
    return {
      ok: false,
      message: 'rpc session.info unavailable',
      details: {
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export function assessSessionInfoHealth(info: Record<string, unknown>): DoctorCheck {
  const state = typeof info.connectionState === 'string' ? info.connectionState : 'unknown';
  const reason = typeof info.connectionReason === 'string' ? info.connectionReason : null;
  const extensionConnected = info.extensionConnected === true;
  const heartbeatStale = info.heartbeatStale === true;
  const heartbeatAgeMs = typeof info.heartbeatAgeMs === 'number' ? info.heartbeatAgeMs : null;
  const staleAfterMs = typeof info.staleAfterMs === 'number' ? info.staleAfterMs : null;

  if (extensionConnected && state === 'connected' && !heartbeatStale) {
    return {
      ok: true,
      message: 'extension bridge connected and heartbeat healthy',
      details: {
        state,
        reason,
        extensionConnected,
        heartbeatStale,
        heartbeatAgeMs,
        staleAfterMs
      }
    };
  }

  if (heartbeatStale) {
    return {
      ok: false,
      message: 'extension heartbeat is stale',
      details: {
        state,
        reason,
        extensionConnected,
        heartbeatStale,
        heartbeatAgeMs,
        staleAfterMs
      }
    };
  }

  return {
    ok: false,
    message: 'extension bridge is not connected',
    details: {
      state,
      reason,
      extensionConnected,
      heartbeatStale,
      heartbeatAgeMs,
      staleAfterMs
    }
  };
}

async function checkRpcConnectionHealth(rpcWsPort: number): Promise<DoctorCheck> {
  try {
    const info = (await callRpc('session.info', {}, rpcWsPort)) as Record<string, unknown>;
    return assessSessionInfoHealth(info);
  } catch (error) {
    return {
      ok: false,
      message: 'rpc connection health unavailable',
      details: {
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();

  const checks = {
    dataDirWritable: checkDataDirWritable(dataDir),
    pairing: checkPairing(dataDir),
    extensionBridgePort: await probePortAvailable(options.port),
    rpcPort: await probePortAvailable(options.rpcWsPort),
    rpcSessionInfo: await checkRpcSessionInfo(options.rpcWsPort),
    rpcConnectionHealth: await checkRpcConnectionHealth(options.rpcWsPort)
  };

  const ok = Object.values(checks).every((check) => check.ok);
  return {
    ok,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    dataDir,
    checks
  };
}
