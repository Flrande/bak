import { createServer } from 'node:net';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@flrande/bak-protocol';
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
  severity?: 'warn' | 'error';
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  ok: boolean;
  timestamp: string;
  nodeVersion: string;
  cliVersion: string;
  dataDir: string;
  summary: {
    errorChecks: string[];
    warningChecks: string[];
  };
  checks: {
    dataDirWritable: DoctorCheck;
    pairing: DoctorCheck;
    extensionBridgePort: DoctorCheck;
    rpcPort: DoctorCheck;
    rpcSessionInfo: DoctorCheck;
    rpcConnectionHealth: DoctorCheck;
    activeTabTelemetry: DoctorCheck;
    protocolCompatibility: DoctorCheck;
    versionCompatibility: DoctorCheck;
  };
}

interface SessionInfoProbe {
  ok: boolean;
  info?: Record<string, unknown>;
  detail?: string;
}

interface PortProbeResult {
  available: boolean;
  code?: string;
}

async function probePortState(port: number): Promise<PortProbeResult> {
  return new Promise<PortProbeResult>((resolveProbe) => {
    const server = createServer();
    server.once('error', (error) => {
      resolveProbe({
        available: false,
        code: (error as NodeJS.ErrnoException).code
      });
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolveProbe({
          available: true
        });
      });
    });
  });
}

export function assessPortAvailability(
  port: number,
  available: boolean,
  mode: 'preflight' | 'runtime',
  code?: string
): DoctorCheck {
  if (mode === 'runtime') {
    if (!available) {
      return {
        ok: true,
        message: `port ${port} is bound (runtime expected)`,
        details: {
          mode,
          code: code ?? null
        }
      };
    }
    return {
      ok: false,
      message: `port ${port} is available but runtime expects daemon binding`,
      details: {
        mode
      }
    };
  }

  if (available) {
    return {
      ok: true,
      message: `port ${port} is available`,
      details: {
        mode
      }
    };
  }

  return {
    ok: false,
    message: `port ${port} already in use`,
    details: {
      mode,
      code: code ?? null
    }
  };
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

function checkRpcSessionInfoFromProbe(probe: SessionInfoProbe, mode: 'preflight' | 'runtime'): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'rpc session.info unavailable',
      severity: mode === 'preflight' ? 'warn' : undefined,
      details: {
        mode,
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

export function assessActiveTabTelemetry(info: Record<string, unknown>): DoctorCheck {
  const extensionConnected = info.extensionConnected === true;
  const state = typeof info.connectionState === 'string' ? info.connectionState : 'unknown';
  const activeTab = typeof info.activeTab === 'object' && info.activeTab !== null
    ? (info.activeTab as Record<string, unknown>)
    : null;

  if (!extensionConnected || state !== 'connected') {
    return {
      ok: true,
      message: 'active tab telemetry skipped while extension is disconnected',
      details: {
        extensionConnected,
        state,
        skipped: true
      }
    };
  }

  const hasValidId = typeof activeTab?.id === 'number';
  const hasValidUrl = typeof activeTab?.url === 'string';
  if (hasValidId && hasValidUrl) {
    return {
      ok: true,
      message: 'active tab telemetry available',
      details: {
        id: activeTab.id,
        url: activeTab.url
      }
    };
  }

  return {
    ok: false,
    message: 'active tab telemetry missing while extension is connected',
    severity: 'warn',
    details: {
      extensionConnected,
      state,
      activeTab
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
      severity: 'warn',
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
      severity: 'warn',
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
      severity: 'warn',
      details: {
        cliVersion,
        extensionVersion
      }
    };
  }

  return {
    ok: false,
    message: 'cli/extension version drift detected (same major)',
    severity: 'warn',
    details: {
      cliVersion,
      extensionVersion
    }
  };
}

export function assessProtocolCompatibility(info: Record<string, unknown>): DoctorCheck {
  const protocolVersion = typeof info.protocolVersion === 'string' ? info.protocolVersion : null;
  const compatibleProtocolVersions = Array.isArray(info.compatibleProtocolVersions)
    ? info.compatibleProtocolVersions.filter((item): item is string => typeof item === 'string')
    : [];

  if (!protocolVersion) {
    return {
      ok: false,
      message: 'protocol version missing from session.info',
      severity: 'warn',
      details: {
        expectedProtocolVersion: PROTOCOL_VERSION
      }
    };
  }

  if (protocolVersion === PROTOCOL_VERSION) {
    return {
      ok: true,
      message: 'protocol versions are aligned',
      details: {
        expectedProtocolVersion: PROTOCOL_VERSION,
        protocolVersion,
        compatibleProtocolVersions
      }
    };
  }

  if (compatibleProtocolVersions.includes(PROTOCOL_VERSION)) {
    return {
      ok: true,
      message: 'protocol versions are compatible',
      details: {
        expectedProtocolVersion: PROTOCOL_VERSION,
        protocolVersion,
        compatibleProtocolVersions
      }
    };
  }

  return {
    ok: false,
    message: 'protocol version mismatch',
    severity: 'warn',
    details: {
      expectedProtocolVersion: PROTOCOL_VERSION,
      protocolVersion,
      compatibleProtocolVersions
    }
  };
}

function checkProtocolCompatibilityFromProbe(probe: SessionInfoProbe, mode: 'preflight' | 'runtime'): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'protocol compatibility unknown (session.info unavailable)',
      severity: mode === 'preflight' ? 'warn' : undefined,
      details: {
        expectedProtocolVersion: PROTOCOL_VERSION,
        mode,
        detail: probe.detail ?? 'unknown'
      }
    };
  }
  return assessProtocolCompatibility(probe.info);
}

function checkVersionCompatibilityFromProbe(
  probe: SessionInfoProbe,
  cliVersion: string,
  mode: 'preflight' | 'runtime'
): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'version compatibility unknown (session.info unavailable)',
      severity: mode === 'preflight' ? 'warn' : undefined,
      details: {
        cliVersion,
        mode,
        detail: probe.detail ?? 'unknown'
      }
    };
  }
  return assessVersionCompatibility(probe.info, cliVersion);
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const cliVersion = readCliVersion();
  const pairing = checkPairing(dataDir);
  const sessionInfo = await probeRpcSessionInfo(options.rpcWsPort);
  const runtimeExpected = pairing.ok;
  const portMode: 'preflight' | 'runtime' = sessionInfo.ok && sessionInfo.info ? 'runtime' : runtimeExpected ? 'runtime' : 'preflight';
  const unavailableSeverity: DoctorCheck['severity'] = portMode === 'preflight' ? 'warn' : undefined;
  const [extensionPort, rpcPort] = await Promise.all([
    probePortState(options.port),
    probePortState(options.rpcWsPort)
  ]);

  const checks: DoctorResult['checks'] = {
    dataDirWritable: checkDataDirWritable(dataDir),
    pairing,
    extensionBridgePort: assessPortAvailability(options.port, extensionPort.available, portMode, extensionPort.code),
    rpcPort: assessPortAvailability(options.rpcWsPort, rpcPort.available, portMode, rpcPort.code),
    rpcSessionInfo: checkRpcSessionInfoFromProbe(sessionInfo, portMode),
    rpcConnectionHealth: sessionInfo.ok && sessionInfo.info
      ? assessSessionInfoHealth(sessionInfo.info)
      : {
          ok: false,
          message: 'rpc connection health unavailable (session.info unavailable)',
          severity: unavailableSeverity,
          details: {
            mode: portMode,
            detail: sessionInfo.detail ?? 'unknown'
          }
        },
    activeTabTelemetry: sessionInfo.ok && sessionInfo.info
      ? assessActiveTabTelemetry(sessionInfo.info)
      : {
          ok: false,
          message: 'active tab telemetry unavailable (session.info unavailable)',
          severity: unavailableSeverity,
          details: {
            mode: portMode,
            detail: sessionInfo.detail ?? 'unknown'
          }
        },
    protocolCompatibility: checkProtocolCompatibilityFromProbe(sessionInfo, portMode),
    versionCompatibility: checkVersionCompatibilityFromProbe(sessionInfo, cliVersion, portMode)
  };

  const summary = {
    errorChecks: [] as string[],
    warningChecks: [] as string[]
  };

  for (const [name, check] of Object.entries(checks)) {
    if (check.ok) {
      continue;
    }
    if (check.severity === 'warn') {
      summary.warningChecks.push(name);
      continue;
    }
    summary.errorChecks.push(name);
  }

  return {
    ok: summary.errorChecks.length === 0,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    cliVersion,
    dataDir,
    summary,
    checks
  };
}
