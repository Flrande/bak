import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportDiagnosticZip } from '../../packages/cli/src/diagnostic-export.js';
import { runDoctor } from '../../packages/cli/src/doctor.js';

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
      traceId: 'trace_demo'
    });

    expect(result.traceCount).toBe(1);
    expect(result.snapshotCount).toBe(1);
    expect(result.includesDoctorReport).toBe(false);
    expect(result.includesIndex).toBe(true);
    expect(result.includesMemory).toBe(false);
    expect(result.memoryBackend).toBeNull();
    expect(result.redacted).toBe(true);
    expect(existsSync(outPath)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('doctor reports missing pairing/rpc when daemon is not running', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-doctor-test-'));
    const report = await runDoctor({
      dataDir,
      port: 29973,
      rpcWsPort: 29974
    });

    expect(report.checks.dataDirWritable.ok).toBe(true);
    expect(report.checks.pairing.ok).toBe(false);
    expect(report.checks.rpcSessionInfo.ok).toBe(false);
    expect(report.checks.rpcConnectionHealth.ok).toBe(false);
    expect(report.checks.versionCompatibility.ok).toBe(false);
    expect(report.checks.versionCompatibility.severity).toBe('warn');
    expect(report.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.ok).toBe(false);

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
          rpcConnectionHealth: {
            ok: false,
            message: 'extension heartbeat is stale'
          }
        }
      }
    });

    expect(result.includesDoctorReport).toBe(true);
    expect(result.includesIndex).toBe(true);
    expect(result.includesMemory).toBe(false);
    expect(result.memoryBackend).toBeNull();
    expect(existsSync(outPath)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('includes memory snapshot when includeMemory is enabled', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-diag-memory-test-'));
    const outPath = join(dataDir, 'diag-memory.zip');
    writeFileSync(
      join(dataDir, 'memory.json'),
      JSON.stringify({
        episodes: [],
        skills: [
          {
            id: 'skill_demo',
            domain: 'example.com',
            intent: 'send report to alice@example.com',
            description: 'send report',
            plan: [],
            paramsSchema: { fields: {} },
            healing: { retries: 1 },
            stats: { runs: 0, success: 0, failure: 0 },
            createdAt: new Date().toISOString()
          }
        ]
      }),
      'utf8'
    );

    const result = exportDiagnosticZip({
      dataDir,
      outPath,
      includeMemory: true,
      memoryBackend: 'json'
    });

    expect(result.includesMemory).toBe(true);
    expect(result.memoryBackend).toBe('json');
    expect(result.memoryExportError).toBeUndefined();
    expect(existsSync(outPath)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });
});
