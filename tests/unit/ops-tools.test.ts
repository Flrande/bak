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
    expect(report.ok).toBe(false);

    rmSync(dataDir, { recursive: true, force: true });
  });
});
