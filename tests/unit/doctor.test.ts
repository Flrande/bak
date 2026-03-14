import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../packages/protocol/src/types.js';
import {
  assessPortAvailability,
  assessProtocolCompatibility,
  assessRuntimeInfoHealth,
  assessRuntimeVersionCompatibility,
  assessVersionCompatibility,
  buildDoctorDiagnosis,
  buildDoctorNextActions
} from '../../packages/cli/src/doctor.js';

describe('doctor runtime.info health assessment', () => {
  it('passes when connected and heartbeat is healthy', () => {
    const check = assessRuntimeInfoHealth({
      extensionConnected: true,
      connectionState: 'connected',
      connectionReason: null,
      heartbeatStale: false,
      heartbeatAgeMs: 1200,
      staleAfterMs: 30000
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('healthy');
  });

  it('fails when heartbeat is stale', () => {
    const check = assessRuntimeInfoHealth({
      extensionConnected: false,
      connectionState: 'disconnected',
      connectionReason: 'heartbeat-timeout',
      heartbeatStale: true,
      heartbeatAgeMs: 45000,
      staleAfterMs: 30000
    });

    expect(check.ok).toBe(false);
    expect(check.message).toContain('stale');
  });

  it('fails when bridge is not connected', () => {
    const check = assessRuntimeInfoHealth({
      extensionConnected: false,
      connectionState: 'disconnected',
      connectionReason: 'socket-closed',
      heartbeatStale: false
    });

    expect(check.ok).toBe(false);
    expect(check.message).toContain('not connected');
  });

  it('detects aligned cli/extension versions', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: '0.6.1'
      },
      '0.6.1'
    );

    expect(check.ok).toBe(true);
    expect(check.message).toContain('aligned');
  });

  it('flags version drift', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: '0.4.9'
      },
      '0.6.1'
    );

    expect(check.ok).toBe(false);
    expect(check.message).toContain('drift');
    expect(check.severity).toBe('warn');
  });

  it('warns when extension version is missing', () => {
    const check = assessVersionCompatibility({}, '0.6.1');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('missing');
    expect(check.severity).toBe('warn');
  });

  it('warns when semver format is invalid', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: 'dev-build'
      },
      '0.6.0-dev'
    );

    expect(check.ok).toBe(false);
    expect(check.message).toContain('unable to compare');
    expect(check.severity).toBe('warn');
  });

  it('detects aligned cli/runtime versions', () => {
    const check = assessRuntimeVersionCompatibility(
      {
        runtimeVersion: '0.6.1'
      },
      '0.6.1'
    );

    expect(check.ok).toBe(true);
    expect(check.message).toContain('aligned');
  });

  it('fails when runtime version is missing', () => {
    const check = assessRuntimeVersionCompatibility({}, '0.6.1');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('missing');
  });

  it('flags cli/runtime version drift', () => {
    const check = assessRuntimeVersionCompatibility(
      {
        runtimeVersion: '0.4.9'
      },
      '0.6.1'
    );

    expect(check.ok).toBe(false);
    expect(check.message).toContain('drift');
  });

  it('detects aligned protocol versions', () => {
    const check = assessProtocolCompatibility({
      protocolVersion: PROTOCOL_VERSION
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('aligned');
  });

  it('warns when protocol version is missing', () => {
    const check = assessProtocolCompatibility({});

    expect(check.ok).toBe(false);
    expect(check.message).toContain('missing');
    expect(check.severity).toBe('warn');
  });

  it('passes when protocol versions are compatible', () => {
    const check = assessProtocolCompatibility({
      protocolVersion: 'v2',
      compatibleProtocolVersions: ['v2', PROTOCOL_VERSION]
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('compatible');
  });

  it('warns when protocol version mismatches', () => {
    const check = assessProtocolCompatibility({
      protocolVersion: 'v0'
    });

    expect(check.ok).toBe(false);
    expect(check.message).toContain('mismatch');
    expect(check.severity).toBe('warn');
  });

  it('treats bound port as healthy in runtime mode', () => {
    const check = assessPortAvailability(17373, false, 'runtime', 'EADDRINUSE');

    expect(check.ok).toBe(true);
    expect(check.message).toContain('runtime expected');
  });

  it('flags available port as issue in runtime mode', () => {
    const check = assessPortAvailability(17373, true, 'runtime');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('runtime expects daemon binding');
  });

  it('treats available port as healthy in preflight mode', () => {
    const check = assessPortAvailability(17373, true, 'preflight');

    expect(check.ok).toBe(true);
    expect(check.message).toContain('available');
  });

  it('flags occupied port in preflight mode', () => {
    const check = assessPortAvailability(17373, false, 'preflight', 'EADDRINUSE');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('already in use');
  });
});

describe('doctor diagnosis classification', () => {
  function createDiagnosisInput(): Parameters<typeof buildDoctorDiagnosis>[0] {
    return {
      cliVersion: '0.6.11',
      port: 17373,
      rpcWsPort: 17374,
      pairing: {
        paired: true,
        createdAt: '2026-03-14T00:00:00.000Z',
        expiresAt: '2026-04-14T00:00:00.000Z',
        expired: false,
        revoked: false,
        tokenPreview: 'bak_abcd',
        reason: 'paired'
      },
      runtimeInfo: null,
      runtimeState: null,
      runtimeStateRunning: false,
      extensionPort: {
        available: true
      },
      rpcPort: {
        available: true
      },
      versionCompatibility: {
        ok: true,
        message: 'cli and extension versions are aligned'
      },
      runtimeVersionCompatibility: {
        ok: true,
        message: 'cli and runtime versions are aligned'
      }
    };
  }

  it('classifies missing pairing and suggests setup', () => {
    const diagnosis = buildDoctorDiagnosis({
      ...createDiagnosisInput(),
      pairing: {
        paired: false,
        createdAt: null,
        expiresAt: null,
        expired: false,
        revoked: false,
        tokenPreview: 'not-paired',
        reason: 'missing'
      }
    });

    expect(diagnosis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PAIRING_MISSING',
          severity: 'error',
          canAutoFix: false
        }),
        expect.objectContaining({
          code: 'RUNTIME_STOPPED',
          canAutoFix: true
        })
      ])
    );

    const nextActions = buildDoctorNextActions(diagnosis, {
      dataDir: 'C:\\bak-data',
      port: 17373,
      rpcWsPort: 17374
    });
    expect(nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PAIRING_MISSING',
          kind: 'command',
          command: expect.stringContaining('bak setup')
        }),
        expect.objectContaining({
          code: 'RUNTIME_STOPPED',
          kind: 'command',
          command: expect.stringContaining('bak doctor --fix')
        })
      ])
    );
  });

  it('classifies token mismatch and version drift without duplicating disconnected bridge guidance', () => {
    const diagnosis = buildDoctorDiagnosis({
      ...createDiagnosisInput(),
      runtimeInfo: {
        extensionConnected: false,
        connectionState: 'disconnected',
        connectionReason: 'token-rejected',
        heartbeatStale: false,
        runtimeVersion: '0.6.10',
        extensionVersion: '0.6.10',
        bridgeLastError: 'token-mismatch'
      },
      versionCompatibility: {
        ok: false,
        message: 'cli/extension version drift detected (same major)',
        severity: 'warn'
      },
      runtimeVersionCompatibility: {
        ok: false,
        message: 'cli/runtime version drift detected'
      }
    });

    expect(diagnosis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PAIRING_TOKEN_MISMATCH',
          severity: 'error'
        }),
        expect.objectContaining({
          code: 'EXTENSION_VERSION_DRIFT',
          severity: 'warn'
        }),
        expect.objectContaining({
          code: 'RUNTIME_VERSION_DRIFT',
          severity: 'error'
        })
      ])
    );
    expect(diagnosis.some((item) => item.code === 'EXTENSION_NOT_CONNECTED')).toBe(false);
  });

  it('classifies stale runtime metadata and port conflicts deterministically', () => {
    const diagnosis = buildDoctorDiagnosis({
      ...createDiagnosisInput(),
      runtimeState: {
        version: 1,
        pid: 4242,
        managed: true,
        mode: 'background',
        port: 17373,
        rpcWsPort: 17374,
        startedAt: '2026-03-14T00:00:00.000Z',
        stdoutLogPath: null,
        stderrLogPath: null
      },
      runtimeStateRunning: false,
      extensionPort: {
        available: false,
        code: 'EADDRINUSE'
      },
      rpcPort: {
        available: false,
        code: 'EADDRINUSE'
      }
    });

    expect(diagnosis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RUNTIME_STALE_METADATA',
          severity: 'warn',
          canAutoFix: true
        }),
        expect.objectContaining({
          code: 'PORT_CONFLICT',
          severity: 'error',
          canAutoFix: false
        })
      ])
    );
    expect(diagnosis.some((item) => item.code === 'RUNTIME_STOPPED')).toBe(false);
  });
});
