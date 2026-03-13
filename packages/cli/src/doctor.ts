import { createServer } from 'node:net';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@flrande/bak-protocol';
import { callRpc } from './rpc/client.js';
import { PairingStore } from './pairing-store.js';
import {
  clearRuntimeState,
  ensureRuntime,
  isProcessRunning,
  readRuntimeConfig,
  readRuntimeState,
  resolveRuntimePorts,
  writeRuntimeConfig,
  type RuntimeState
} from './runtime-manager.js';
import { ensureDir, resolveDataDir } from './utils.js';

export interface DoctorOptions {
  dataDir?: string;
  port: number;
  rpcWsPort: number;
  autoStart?: boolean;
  fix?: boolean;
}

interface DoctorCheck {
  ok: boolean;
  message: string;
  severity?: 'warn' | 'error';
  details?: Record<string, unknown>;
}

export type DoctorDiagnosisCode =
  | 'PAIRING_MISSING'
  | 'PAIRING_EXPIRED'
  | 'PAIRING_REVOKED'
  | 'PAIRING_TOKEN_MISMATCH'
  | 'RUNTIME_STOPPED'
  | 'RUNTIME_STALE_METADATA'
  | 'RPC_UNREACHABLE'
  | 'PORT_CONFLICT'
  | 'EXTENSION_NOT_CONNECTED'
  | 'EXTENSION_HEARTBEAT_STALE'
  | 'EXTENSION_VERSION_DRIFT';

export type DoctorFixCode = 'WRITE_RUNTIME_CONFIG' | 'CLEAR_STALE_RUNTIME_STATE' | 'START_MANAGED_RUNTIME';
export type DoctorNextActionKind = 'command' | 'manual' | 'path';

export interface DoctorDiagnosis {
  code: DoctorDiagnosisCode;
  severity: 'warn' | 'error';
  summary: string;
  rootCause: string;
  canAutoFix: boolean;
}

export interface DoctorFixApplied {
  code: DoctorFixCode;
  ok: boolean;
  detail?: string;
}

export interface DoctorNextAction {
  code: DoctorDiagnosisCode;
  title: string;
  kind: DoctorNextActionKind;
  command?: string;
  path?: string;
  note?: string;
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
  diagnosis: DoctorDiagnosis[];
  fixesApplied: DoctorFixApplied[];
  nextActions: DoctorNextAction[];
  checks: {
    dataDirWritable: DoctorCheck;
    pairing: DoctorCheck;
    extensionBridgePort: DoctorCheck;
    rpcPort: DoctorCheck;
    rpcRuntimeInfo: DoctorCheck;
    rpcConnectionHealth: DoctorCheck;
    protocolCompatibility: DoctorCheck;
    versionCompatibility: DoctorCheck;
  };
}

interface RuntimeInfoProbe {
  ok: boolean;
  info?: Record<string, unknown>;
  detail?: string;
}

interface PortProbeResult {
  available: boolean;
  code?: string;
}

interface DoctorAnalysisInput {
  cliVersion: string;
  port: number;
  rpcWsPort: number;
  pairing: ReturnType<PairingStore['status']> | null;
  runtimeInfo: Record<string, unknown> | null;
  runtimeState: RuntimeState | null;
  runtimeStateRunning: boolean;
  extensionPort: PortProbeResult;
  rpcPort: PortProbeResult;
  versionCompatibility: DoctorCheck;
}

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

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
    const probeFile = resolve(dataDir, `doctor-${Date.now()}.tmp`);
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
    if (status.reason === 'expired') {
      return {
        ok: false,
        message: 'pair token expired, rotate with `bak setup`',
        details: status
      };
    }
    if (status.reason === 'revoked') {
      return {
        ok: false,
        message: 'pair token was revoked, create a new one with `bak setup`',
        details: status
      };
    }
    return {
      ok: false,
      message: 'pair token missing or revoked, run `bak setup`',
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

function readPairingStatus(store: PairingStore): ReturnType<PairingStore['status']> | null {
  try {
    return store.status();
  } catch {
    return null;
  }
}

function readCliVersion(): string {
  try {
    const packagePath = resolve(CURRENT_DIR, '../package.json');
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

async function probeRpcRuntimeInfo(rpcWsPort: number): Promise<RuntimeInfoProbe> {
  try {
    const info = (await callRpc('runtime.info', {}, rpcWsPort)) as Record<string, unknown>;
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

function checkRpcRuntimeInfoFromProbe(probe: RuntimeInfoProbe, mode: 'preflight' | 'runtime'): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'rpc runtime.info unavailable',
      severity: mode === 'preflight' ? 'warn' : undefined,
      details: {
        mode,
        detail: probe.detail ?? 'unknown'
      }
    };
  }
  return {
    ok: true,
    message: 'rpc runtime.info reachable',
    details: probe.info
  };
}

export function assessRuntimeInfoHealth(info: Record<string, unknown>): DoctorCheck {
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
      message: 'protocol version missing from runtime.info',
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

function checkProtocolCompatibilityFromProbe(probe: RuntimeInfoProbe, mode: 'preflight' | 'runtime'): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'protocol compatibility unknown (runtime.info unavailable)',
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
  probe: RuntimeInfoProbe,
  cliVersion: string,
  mode: 'preflight' | 'runtime'
): DoctorCheck {
  if (!probe.ok || !probe.info) {
    return {
      ok: false,
      message: 'version compatibility unknown (runtime.info unavailable)',
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

function shouldAttemptManagedRuntimeStart(
  autoStart: boolean,
  runtimeProbe: RuntimeInfoProbe,
  runtimeState: RuntimeState | null,
  rpcPort: PortProbeResult,
  extensionPort: PortProbeResult
): boolean {
  if (!autoStart || (runtimeProbe.ok && runtimeProbe.info)) {
    return false;
  }
  if (runtimeState && isProcessRunning(runtimeState.pid)) {
    return false;
  }
  return rpcPort.available && extensionPort.available;
}

async function recordFix(
  fixesApplied: DoctorFixApplied[],
  code: DoctorFixCode,
  action: () => Promise<string | void> | string | void
): Promise<boolean> {
  try {
    const detail = await action();
    fixesApplied.push({
      code,
      ok: true,
      ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {})
    });
    return true;
  } catch (error) {
    fixesApplied.push({
      code,
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

function createDiagnosis(
  code: DoctorDiagnosisCode,
  severity: DoctorDiagnosis['severity'],
  summary: string,
  rootCause: string,
  canAutoFix: boolean
): DoctorDiagnosis {
  return {
    code,
    severity,
    summary,
    rootCause,
    canAutoFix
  };
}

function portConflictRootCause(port: number, probe: PortProbeResult, label: string): string {
  const code = probe.code ? ` (${probe.code})` : '';
  return `${label} port ${port} is already in use${code}.`;
}

export function buildDoctorDiagnosis(input: DoctorAnalysisInput): DoctorDiagnosis[] {
  const diagnoses: DoctorDiagnosis[] = [];
  const runtimeInfo = input.runtimeInfo;
  const bridgeLastError = runtimeInfo && typeof runtimeInfo.bridgeLastError === 'string' ? runtimeInfo.bridgeLastError : null;
  const hasPortConflict = (!runtimeInfo && !input.extensionPort.available) || (!runtimeInfo && !input.rpcPort.available);
  const runtimeStateStale = input.runtimeState !== null && !input.runtimeStateRunning;

  switch (input.pairing?.reason) {
    case 'missing':
      diagnoses.push(
        createDiagnosis(
          'PAIRING_MISSING',
          'error',
          'No active pairing token is configured.',
          'The bak data directory does not contain an active pairing token.',
          false
        )
      );
      break;
    case 'expired':
      diagnoses.push(
        createDiagnosis(
          'PAIRING_EXPIRED',
          'error',
          'The saved pairing token has expired.',
          'The current pairing token passed its expiry time and can no longer authorize the extension bridge.',
          false
        )
      );
      break;
    case 'revoked':
      diagnoses.push(
        createDiagnosis(
          'PAIRING_REVOKED',
          'error',
          'The last pairing token was revoked.',
          'A previous token was revoked and no replacement token is currently active.',
          false
        )
      );
      break;
    default:
      break;
  }

  if (bridgeLastError === 'token-mismatch') {
    diagnoses.push(
      createDiagnosis(
        'PAIRING_TOKEN_MISMATCH',
        'error',
        'The extension is using a different pairing token than the CLI.',
        'The runtime rejected the extension websocket handshake because the provided token did not match the active pairing token.',
        false
      )
    );
  }

  if (runtimeStateStale) {
    diagnoses.push(
      createDiagnosis(
        'RUNTIME_STALE_METADATA',
        'warn',
        'Runtime metadata points at a dead process.',
        `The stored runtime pid ${input.runtimeState?.pid ?? 'unknown'} is no longer running, so the saved runtime state is stale.`,
        true
      )
    );
  }

  if (!runtimeInfo && !input.extensionPort.available) {
    diagnoses.push(
      createDiagnosis(
        'PORT_CONFLICT',
        'error',
        'The extension bridge port is occupied.',
        portConflictRootCause(input.port, input.extensionPort, 'Bridge'),
        false
      )
    );
  }

  if (!runtimeInfo && !input.rpcPort.available) {
    diagnoses.push(
      createDiagnosis(
        'PORT_CONFLICT',
        'error',
        'The RPC port is occupied.',
        portConflictRootCause(input.rpcWsPort, input.rpcPort, 'RPC'),
        false
      )
    );
  }

  if (!runtimeInfo && !hasPortConflict) {
    if (input.runtimeStateRunning) {
      diagnoses.push(
        createDiagnosis(
          'RPC_UNREACHABLE',
          'error',
          'The runtime process is up, but rpc is unreachable.',
          `A runtime process is recorded for rpc port ${input.rpcWsPort}, but runtime.info did not answer.`,
          false
        )
      );
    } else {
      diagnoses.push(
        createDiagnosis(
          'RUNTIME_STOPPED',
          'error',
          'The managed bak runtime is not running.',
          `No runtime answered on rpc port ${input.rpcWsPort}.`,
          true
        )
      );
    }
  }

  if (runtimeInfo) {
    if (runtimeInfo.heartbeatStale === true) {
      diagnoses.push(
        createDiagnosis(
          'EXTENSION_HEARTBEAT_STALE',
          'error',
          'The extension bridge heartbeat is stale.',
          'The paired extension connected previously, but the runtime has not seen a fresh heartbeat within the configured threshold.',
          false
        )
      );
    } else if (runtimeInfo.extensionConnected !== true && bridgeLastError !== 'token-mismatch') {
      const reason = typeof runtimeInfo.connectionReason === 'string' ? runtimeInfo.connectionReason : 'unknown';
      diagnoses.push(
        createDiagnosis(
          'EXTENSION_NOT_CONNECTED',
          'error',
          'The runtime is up, but the extension bridge is not connected.',
          `The runtime is listening, but the extension bridge state is ${String(runtimeInfo.connectionState ?? 'unknown')} (${reason}).`,
          false
        )
      );
    }

    const extensionVersion = typeof runtimeInfo.extensionVersion === 'string' ? runtimeInfo.extensionVersion : null;
    if (extensionVersion && !input.versionCompatibility.ok) {
      diagnoses.push(
        createDiagnosis(
          'EXTENSION_VERSION_DRIFT',
          'warn',
          'CLI and extension versions are out of sync.',
          `The CLI is ${input.cliVersion}, while the connected extension reports ${extensionVersion}.`,
          false
        )
      );
    }
  }

  return diagnoses.filter(
    (diagnosis, index, all) =>
      all.findIndex((candidate) => candidate.code === diagnosis.code && candidate.rootCause === diagnosis.rootCause) === index
  );
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildRuntimeArgs(dataDir: string, port: number, rpcWsPort: number): string[] {
  const args = ['--port', `${port}`, '--rpc-ws-port', `${rpcWsPort}`];
  if (dataDir !== resolveDataDir()) {
    args.push('--data-dir', quotePowerShell(dataDir));
  }
  return args;
}

function buildCommand(command: string, args: string[]): string {
  return ['bak', command, ...args].join(' ');
}

function resolveExtensionDistPath(): string | null {
  const candidates = [
    resolve(CURRENT_DIR, '..', '..', 'bak-extension', 'dist'),
    resolve(CURRENT_DIR, '..', '..', '..', 'extension', 'dist'),
    resolve(process.cwd(), 'node_modules', '@flrande', 'bak-extension', 'dist'),
    resolve(process.cwd(), 'packages', 'extension', 'dist')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function buildDoctorNextActions(
  diagnosis: DoctorDiagnosis[],
  options: { dataDir: string; port: number; rpcWsPort: number }
): DoctorNextAction[] {
  const extensionDistPath = resolveExtensionDistPath();
  const runtimeArgs = buildRuntimeArgs(options.dataDir, options.port, options.rpcWsPort);
  const nextActions = new Map<string, DoctorNextAction>();

  const setAction = (action: DoctorNextAction): void => {
    const key = `${action.code}:${action.title}`;
    if (!nextActions.has(key)) {
      nextActions.set(key, action);
    }
  };

  for (const item of diagnosis) {
    switch (item.code) {
      case 'PAIRING_MISSING':
      case 'PAIRING_EXPIRED':
      case 'PAIRING_REVOKED':
        setAction({
          code: item.code,
          title: 'Create a fresh pairing token',
          kind: 'command',
          command: buildCommand('setup', runtimeArgs),
          note: 'After setup, open the extension popup, paste the token if needed, then save the same bridge port.'
        });
        break;
      case 'PAIRING_TOKEN_MISMATCH':
        setAction({
          code: item.code,
          title: 'Resync the popup token',
          kind: 'command',
          command: buildCommand('pair status', options.dataDir !== resolveDataDir() ? ['--data-dir', quotePowerShell(options.dataDir)] : []),
          note: 'Open the extension popup, paste the active token shown by `bak pair status`, keep the same port, then click Save settings.'
        });
        break;
      case 'RUNTIME_STOPPED':
      case 'RUNTIME_STALE_METADATA':
        setAction({
          code: item.code,
          title: 'Run doctor with safe fixes enabled',
          kind: 'command',
          command: buildCommand('doctor', ['--fix', ...runtimeArgs]),
          note: 'This only repairs local runtime metadata/config and can restart the managed runtime if the ports are free.'
        });
        break;
      case 'RPC_UNREACHABLE':
        setAction({
          code: item.code,
          title: 'Inspect runtime status and restart cleanly',
          kind: 'command',
          command: buildCommand('status', runtimeArgs),
          note: `If the runtime still looks degraded, run ${buildCommand('stop', runtimeArgs)} and then ${buildCommand('doctor', runtimeArgs)}.`
        });
        break;
      case 'PORT_CONFLICT':
        setAction({
          code: item.code,
          title: 'Free or change the occupied port',
          kind: 'manual',
          note: `Another process is already bound to port ${options.port} or ${options.rpcWsPort}. Stop the conflicting process or rerun bak with a different port pair.`
        });
        break;
      case 'EXTENSION_NOT_CONNECTED':
      case 'EXTENSION_HEARTBEAT_STALE':
        setAction({
          code: item.code,
          title: 'Reconnect the paired extension',
          kind: 'manual',
          note: 'Open the Browser Agent Kit popup, confirm the token and port, then use Save settings or Reconnect bridge.'
        });
        break;
      case 'EXTENSION_VERSION_DRIFT':
        setAction({
          code: item.code,
          title: 'Reload the unpacked extension',
          kind: extensionDistPath ? 'path' : 'manual',
          ...(extensionDistPath ? { path: extensionDistPath } : {}),
          note: 'Reload Browser Agent Kit from chrome://extensions or edge://extensions, then rerun bak doctor.'
        });
        break;
      default:
        break;
    }
  }

  return [...nextActions.values()];
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const autoStart = options.autoStart !== false;
  const fix = options.fix === true;
  const cliVersion = readCliVersion();
  const resolution = resolveRuntimePorts({
    dataDir,
    port: options.port,
    rpcWsPort: options.rpcWsPort
  });
  const fixesApplied: DoctorFixApplied[] = [];
  const pairingStore = new PairingStore(dataDir);
  const initialRuntimeState = readRuntimeState(dataDir);
  const initialConfig = readRuntimeConfig(dataDir);
  const initialRuntimeInfo = await probeRpcRuntimeInfo(options.rpcWsPort);
  const [initialExtensionPort, initialRpcPort] = await Promise.all([
    probePortState(options.port),
    probePortState(options.rpcWsPort)
  ]);

  if (fix && (!initialConfig || initialConfig.port !== options.port || initialConfig.rpcWsPort !== options.rpcWsPort)) {
    await recordFix(fixesApplied, 'WRITE_RUNTIME_CONFIG', () => {
      writeRuntimeConfig(resolution, 'auto-start');
      return `saved port ${options.port} and rpc ${options.rpcWsPort}`;
    });
  }

  if (fix && initialRuntimeState && !isProcessRunning(initialRuntimeState.pid)) {
    await recordFix(fixesApplied, 'CLEAR_STALE_RUNTIME_STATE', () => {
      clearRuntimeState(dataDir);
      return `removed stale runtime metadata for pid ${initialRuntimeState.pid}`;
    });
  }

  if (
    shouldAttemptManagedRuntimeStart(
      autoStart,
      initialRuntimeInfo,
      readRuntimeState(dataDir),
      initialRpcPort,
      initialExtensionPort
    )
  ) {
    if (fix) {
      await recordFix(fixesApplied, 'START_MANAGED_RUNTIME', async () => {
        await ensureRuntime(resolution);
        return `runtime ready on rpc port ${options.rpcWsPort}`;
      });
    } else {
      try {
        await ensureRuntime(resolution);
      } catch {
        // Leave startup failures to the final diagnostic pass so doctor can still classify the issue.
      }
    }
  }

  const pairing = checkPairing(dataDir);
  const pairingStatus = readPairingStatus(pairingStore);
  const runtimeState = readRuntimeState(dataDir);
  const runtimeStateRunning = runtimeState ? isProcessRunning(runtimeState.pid) : false;
  const runtimeInfo = await probeRpcRuntimeInfo(options.rpcWsPort);
  const runtimeExpected = pairing.ok || runtimeStateRunning;
  const portMode: 'preflight' | 'runtime' =
    runtimeInfo.ok && runtimeInfo.info ? 'runtime' : runtimeExpected ? 'runtime' : 'preflight';
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
    rpcRuntimeInfo: checkRpcRuntimeInfoFromProbe(runtimeInfo, portMode),
    rpcConnectionHealth:
      runtimeInfo.ok && runtimeInfo.info
        ? assessRuntimeInfoHealth(runtimeInfo.info)
        : {
            ok: false,
            message: 'rpc connection health unavailable (runtime.info unavailable)',
            severity: unavailableSeverity,
            details: {
              mode: portMode,
              detail: runtimeInfo.detail ?? 'unknown'
            }
          },
    protocolCompatibility: checkProtocolCompatibilityFromProbe(runtimeInfo, portMode),
    versionCompatibility: checkVersionCompatibilityFromProbe(runtimeInfo, cliVersion, portMode)
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

  const diagnosis = buildDoctorDiagnosis({
    cliVersion,
    port: options.port,
    rpcWsPort: options.rpcWsPort,
    pairing: pairingStatus,
    runtimeInfo: runtimeInfo.ok && runtimeInfo.info ? runtimeInfo.info : null,
    runtimeState,
    runtimeStateRunning,
    extensionPort,
    rpcPort,
    versionCompatibility: checks.versionCompatibility
  });

  return {
    ok: summary.errorChecks.length === 0,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    cliVersion,
    dataDir,
    summary,
    diagnosis,
    fixesApplied,
    nextActions: buildDoctorNextActions(diagnosis, resolution),
    checks
  };
}
