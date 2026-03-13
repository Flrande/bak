import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportDiagnosticZip } from '../../packages/cli/src/diagnostic-export.js';
import { runDoctor } from '../../packages/cli/src/doctor.js';
import { PairingStore } from '../../packages/cli/src/pairing-store.js';

describe('ops tools', () => {
  it('exports redacted diagnostic zip', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-diag-test-'));
    const tracesDir = join(dataDir, 'traces');
    const snapshotsDir = join(dataDir, 'snapshots', 'trace_demo');
    mkdirSync(tracesDir, { recursive: true });
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(join(tracesDir, 'trace_demo.jsonl'), JSON.stringify({ text: 'alice@example.com' }) + '\n', 'utf8');
    writeFileSync(join(snapshotsDir, 'a.txt'), 'snapshot', 'utf8');

    const outPath = join(dataDir, 'diag.zip');
    const result = exportDiagnosticZip({
      dataDir,
      outPath,
      traceId: 'trace_demo',
      includeSnapshots: true
    });

    expect(result.traceCount).toBe(1);
    expect(result.snapshotCount).toBe(1);
    expect(result.includesSnapshots).toBe(true);
    expect(result.includesDoctorReport).toBe(false);
    expect(result.includesIndex).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.redacted).toBe(true);
    expect(existsSync(outPath)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  }, 20_000);

  it('excludes snapshot images by default and emits warning', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-diag-snapshot-default-test-'));
    const tracesDir = join(dataDir, 'traces');
    const snapshotsDir = join(dataDir, 'snapshots', 'trace_demo');
    mkdirSync(tracesDir, { recursive: true });
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(join(tracesDir, 'trace_demo.jsonl'), JSON.stringify({ text: 'hello' }) + '\n', 'utf8');
    writeFileSync(join(snapshotsDir, 'a.txt'), 'snapshot', 'utf8');

    const outPath = join(dataDir, 'diag-default.zip');
    const result = exportDiagnosticZip({
      dataDir,
      outPath,
      traceId: 'trace_demo'
    });

    expect(result.includesSnapshots).toBe(false);
    expect(result.snapshotCount).toBe(0);
    expect(
      result.warnings.some((message) =>
        message.includes('snapshot images excluded by default')
      )
    ).toBe(true);
    expect(existsSync(outPath)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('doctor reports missing pairing/rpc when daemon is not running', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-doctor-test-'));
    const report = await runDoctor({
      dataDir,
      port: 29973,
      rpcWsPort: 29974,
      autoStart: false
    });

    expect(report.checks.dataDirWritable.ok).toBe(true);
    expect(report.checks.pairing.ok).toBe(false);
    expect(report.checks.rpcRuntimeInfo.ok).toBe(false);
    expect(report.checks.rpcRuntimeInfo.severity).toBe('warn');
    expect(report.checks.rpcConnectionHealth.ok).toBe(false);
    expect(report.checks.rpcConnectionHealth.severity).toBe('warn');
    expect(report.checks.protocolCompatibility.ok).toBe(false);
    expect(report.checks.protocolCompatibility.severity).toBe('warn');
    expect(report.checks.versionCompatibility.ok).toBe(false);
    expect(report.checks.versionCompatibility.severity).toBe('warn');
    expect(report.summary.warningChecks).toContain('protocolCompatibility');
    expect(report.summary.warningChecks).toContain('versionCompatibility');
    expect(report.summary.warningChecks).toContain('rpcRuntimeInfo');
    expect(report.summary.warningChecks).toContain('rpcConnectionHealth');
    expect(report.summary.errorChecks).toContain('pairing');
    expect(report.summary.errorChecks).not.toContain('rpcRuntimeInfo');
    expect(report.diagnosis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PAIRING_MISSING' }),
        expect.objectContaining({ code: 'RUNTIME_STOPPED' })
      ])
    );
    expect(report.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PAIRING_MISSING', command: expect.stringContaining('bak setup') }),
        expect.objectContaining({ code: 'RUNTIME_STOPPED', command: expect.stringContaining('bak doctor --fix') })
      ])
    );
    expect(report.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.ok).toBe(false);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('doctor fails hard when pairing exists but rpc is offline', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-doctor-runtime-test-'));
    const pairing = new PairingStore(dataDir);
    pairing.createToken();

    const report = await runDoctor({
      dataDir,
      port: 29977,
      rpcWsPort: 29978,
      autoStart: false
    });

    expect(report.checks.pairing.ok).toBe(true);
    expect(report.checks.rpcRuntimeInfo.ok).toBe(false);
    expect(report.checks.rpcRuntimeInfo.severity).toBeUndefined();
    expect(report.checks.rpcConnectionHealth.ok).toBe(false);
    expect(report.checks.rpcConnectionHealth.severity).toBeUndefined();
    expect(report.summary.errorChecks).toContain('rpcRuntimeInfo');
    expect(report.summary.errorChecks).toContain('rpcConnectionHealth');
    expect(report.summary.warningChecks).not.toContain('rpcRuntimeInfo');
    expect(report.diagnosis).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'RUNTIME_STOPPED' })])
    );
    expect(report.ok).toBe(false);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('doctor keeps reporting diagnostics when the pairing file is unreadable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-doctor-bad-pairing-test-'));
    writeFileSync(join(dataDir, 'pairing.json'), '{invalid-json', 'utf8');

    const report = await runDoctor({
      dataDir,
      port: 29979,
      rpcWsPort: 29980,
      autoStart: false
    });

    expect(report.checks.pairing.ok).toBe(false);
    expect(report.checks.pairing.message).toContain('unable to read pairing state');
    expect(report.diagnosis.some((item) => item.code === 'PAIRING_MISSING')).toBe(false);
    expect(report.diagnosis).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'RUNTIME_STOPPED' })])
    );

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('embeds doctor report into diagnostic zip when provided', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-diag-doctor-test-'));
    const outPath = join(dataDir, 'diag-doctor.zip');

    const result = exportDiagnosticZip({
      dataDir,
      outPath,
      doctorReport: {
        ok: false,
        checks: {
          protocolCompatibility: {
            ok: false,
            message: 'protocol version mismatch',
            severity: 'warn'
          },
          versionCompatibility: {
            ok: false,
            message: 'cli/extension version drift detected (same major)',
            severity: 'warn'
          },
          rpcConnectionHealth: {
            ok: false,
            message: 'extension heartbeat is stale'
          }
        }
      }
    });

    expect(result.includesDoctorReport).toBe(true);
    expect(result.includesIndex).toBe(true);
    expect(result.warnings).toContain('protocol compatibility warning: protocol version mismatch');
    expect(result.warnings).toContain('version compatibility warning: cli/extension version drift detected (same major)');
    expect(existsSync(outPath)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('surfaces protocol compatibility warning from doctor snapshot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-diag-doctor-protocol-test-'));
    const doctorReport = await runDoctor({
      dataDir,
      port: 29975,
      rpcWsPort: 29976,
      autoStart: false
    });
    const outPath = join(dataDir, 'diag-doctor-protocol.zip');

    const result = exportDiagnosticZip({
      dataDir,
      outPath,
      doctorReport
    });

    expect(result.includesDoctorReport).toBe(true);
    expect(result.warnings.some((message) => message.startsWith('protocol compatibility warning:'))).toBe(true);
    expect(existsSync(outPath)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });
});
