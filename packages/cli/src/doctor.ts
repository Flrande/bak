import { createServer } from 'node:net';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  cliVersion: string;
  dataDir: string;
  checks: {
    dataDirWritable: DoctorCheck;
    pairing: DoctorCheck;
    extensionBridgePort: DoctorCheck;
    rpcPort: DoctorCheck;
    rpcSessionInfo: DoctorCheck;
    rpcConnectionHealth: DoctorCheck;
    versionCompatibility: DoctorCheck;
  };
}

interface SessionInfoProbe {
  ok: boolean;
  info?: Record<string, unknown>;
  detail?: string;
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

function readCliVersion(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const packagePath = resolve(currentDir, '../package.json');
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

async function probeRpcSessionInfo(rpcWsPort: number): Promise<SessionInfoProbe> {
  try {
    const info = (await callRpc('session.info', {}, rpcWsPort)) as Record<string, unknown>;
    return {
      ok: true,
      info
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function checkRpcSessionInfoFromProbe(probe: SessionInfoProbe): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'rpc session.info unavailable',
      details: {
        detail: probe.detail ?? 'unknown'
      }
    };
  }
  return {
    ok: true,
    message: 'rpc session.info reachable',
    details: probe.info
  };
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

export function assessVersionCompatibility(info: Record<string, unknown>, cliVersion: string): DoctorCheck {
  const extensionVersion = typeof info.extensionVersion === 'string' ? info.extensionVersion : null;
  const cliSemver = parseSemver(cliVersion);
  const extSemver = extensionVersion ? parseSemver(extensionVersion) : null;

  if (!extensionVersion) {
    return {
      ok: false,
      message: 'extension version missing from bridge handshake',
      details: {
        cliVersion
      }
    };
  }

  if (extensionVersion === cliVersion) {
    return {
      ok: true,
      message: 'cli and extension versions are aligned',
      details: {
        cliVersion,
        extensionVersion
      }
    };
  }

  if (!cliSemver || !extSemver) {
    return {
      ok: false,
      message: 'unable to compare cli/extension versions',
      details: {
        cliVersion,
        extensionVersion
      }
    };
  }

  if (cliSemver.major !== extSemver.major) {
    return {
      ok: false,
      message: 'cli/extension major versions mismatch',
      details: {
        cliVersion,
        extensionVersion
      }
    };
  }

  return {
    ok: false,
    message: 'cli/extension version drift detected (same major)',
    details: {
      cliVersion,
      extensionVersion
    }
  };
}

function checkVersionCompatibilityFromProbe(probe: SessionInfoProbe, cliVersion: string): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'version compatibility unknown (session.info unavailable)',
      details: {
        cliVersion,
        detail: probe.detail ?? 'unknown'
      }
    };
  }
  return assessVersionCompatibility(probe.info, cliVersion);
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const cliVersion = readCliVersion();
  const sessionInfo = await probeRpcSessionInfo(options.rpcWsPort);

  const checks = {
    dataDirWritable: checkDataDirWritable(dataDir),
    pairing: checkPairing(dataDir),
    extensionBridgePort: await probePortAvailable(options.port),
    rpcPort: await probePortAvailable(options.rpcWsPort),
    rpcSessionInfo: checkRpcSessionInfoFromProbe(sessionInfo),
    rpcConnectionHealth: sessionInfo.ok && sessionInfo.info
      ? assessSessionInfoHealth(sessionInfo.info)
      : {
          ok: false,
          message: 'rpc connection health unavailable',
          details: {
            detail: sessionInfo.detail ?? 'unknown'
          }
        },
    versionCompatibility: checkVersionCompatibilityFromProbe(sessionInfo, cliVersion)
  };

  const ok =
    checks.dataDirWritable.ok &&
    checks.pairing.ok &&
    checks.extensionBridgePort.ok &&
    checks.rpcPort.ok &&
    checks.rpcSessionInfo.ok &&
    checks.rpcConnectionHealth.ok;
  return {
    ok,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    cliVersion,
    dataDir,
    checks
  };
}
