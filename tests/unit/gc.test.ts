import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRetentionConfig, runGc } from '../../packages/cli/src/gc.js';

const DAY = 24 * 60 * 60 * 1000;

function setMtime(path: string, timestampMs: number): void {
  const atime = new Date(timestampMs);
  const mtime = new Date(timestampMs);
  utimesSync(path, atime, mtime);
}

function createTrace(dataDir: string, fileName: string, mtimeMs: number): string {
  const tracesDir = join(dataDir, 'traces');
  mkdirSync(tracesDir, { recursive: true });
  const path = join(tracesDir, fileName);
  writeFileSync(path, '{"ok":true}\n', 'utf8');
  setMtime(path, mtimeMs);
  return path;
}

function createSnapshotDir(dataDir: string, dirName: string, mtimeMs: number): string {
  const snapshotsDir = join(dataDir, 'snapshots', dirName);
  mkdirSync(snapshotsDir, { recursive: true });
  writeFileSync(join(snapshotsDir, 'meta.txt'), 'snapshot', 'utf8');
  setMtime(snapshotsDir, mtimeMs);
  return snapshotsDir;
}

describe('bak gc', () => {
  it('selects retention candidates in dry-run mode without deleting files', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-gc-dry-'));
    const nowMs = Date.now();

    const oldTrace = createTrace(dataDir, 'old.jsonl', nowMs - 20 * DAY);
    createTrace(dataDir, 'new.jsonl', nowMs - DAY);
    const oldSnapshot = createSnapshotDir(dataDir, 'trace_old', nowMs - 30 * DAY);
    createSnapshotDir(dataDir, 'trace_new', nowMs - DAY);

    const result = runGc({
      dataDir,
      traceDays: 7,
      snapshotDays: 7,
      traceKeep: 10,
      snapshotKeep: 10,
      nowMs
    });

    expect(result.mode).toBe('dry-run');
    expect(result.requiresForce).toBe(true);
    expect(result.deletedCount).toBe(0);
    expect(result.candidates.map((item) => item.relativePath)).toContain('traces/old.jsonl');
    expect(result.candidates.map((item) => item.relativePath)).toContain('snapshots/trace_old');
    expect(existsSync(oldTrace)).toBe(true);
    expect(existsSync(oldSnapshot)).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('deletes selected files when force is enabled', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-gc-force-'));
    const nowMs = Date.now();

    const tracePath = createTrace(dataDir, 'drop.jsonl', nowMs - DAY);
    const snapshotPath = createSnapshotDir(dataDir, 'drop_snapshot', nowMs - DAY);

    const result = runGc({
      dataDir,
      traceDays: 0,
      snapshotDays: 0,
      traceKeep: 0,
      snapshotKeep: 0,
      force: true,
      nowMs
    });

    expect(result.mode).toBe('execute');
    expect(result.deletedCount).toBeGreaterThanOrEqual(2);
    expect(existsSync(tracePath)).toBe(false);
    expect(existsSync(snapshotPath)).toBe(false);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('loads retention values from config file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-gc-config-'));
    writeFileSync(
      join(dataDir, 'retention.json'),
      JSON.stringify({
        traceDays: 3,
        snapshotDays: 5,
        traceKeep: 12,
        snapshotKeep: 15
      }),
      'utf8'
    );

    const retention = resolveRetentionConfig(dataDir, {});
    expect(retention).toEqual({
      traceDays: 3,
      snapshotDays: 5,
      traceKeep: 12,
      snapshotKeep: 15
    });

    rmSync(dataDir, { recursive: true, force: true });
  });
});
