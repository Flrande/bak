import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ensureDir, resolveDataDir } from './utils.js';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

interface RetentionConfigFile {
  traceDays?: number;
  snapshotDays?: number;
  traceKeep?: number;
  snapshotKeep?: number;
}

export interface RetentionConfig {
  traceDays: number;
  snapshotDays: number;
  traceKeep: number;
  snapshotKeep: number;
}

export interface GcRunOptions {
  dataDir?: string;
  traceDays?: number;
  snapshotDays?: number;
  traceKeep?: number;
  snapshotKeep?: number;
  force?: boolean;
  nowMs?: number;
}

export interface GcCandidate {
  kind: 'trace' | 'snapshot';
  path: string;
  relativePath: string;
  reason: 'age' | 'keep-limit' | 'age+keep-limit';
  mtimeMs: number;
}

export interface GcRunResult {
  dataDir: string;
  mode: 'dry-run' | 'execute';
  retention: RetentionConfig;
  candidates: GcCandidate[];
  deletedCount: number;
  requiresForce: boolean;
}

const DEFAULT_RETENTION: RetentionConfig = {
  traceDays: 14,
  snapshotDays: 14,
  traceKeep: 200,
  snapshotKeep: 100
};

function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readConfigFile(configPath: string): RetentionConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as RetentionConfigFile;
  return parsed ?? {};
}

function validateRetentionValue(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be an integer >= 0`);
  }
  return value;
}

export function resolveRetentionConfig(dataDir: string, options: GcRunOptions): RetentionConfig {
  const configPath = process.env.BAK_RETENTION_CONFIG
    ? resolve(String(process.env.BAK_RETENTION_CONFIG))
    : join(dataDir, 'retention.json');
  const config = readConfigFile(configPath);

  const traceDays = options.traceDays ?? toInt(process.env.BAK_RETENTION_TRACE_DAYS) ?? config.traceDays ?? DEFAULT_RETENTION.traceDays;
  const snapshotDays =
    options.snapshotDays ?? toInt(process.env.BAK_RETENTION_SNAPSHOT_DAYS) ?? config.snapshotDays ?? DEFAULT_RETENTION.snapshotDays;
  const traceKeep = options.traceKeep ?? toInt(process.env.BAK_RETENTION_TRACE_KEEP) ?? config.traceKeep ?? DEFAULT_RETENTION.traceKeep;
  const snapshotKeep =
    options.snapshotKeep ?? toInt(process.env.BAK_RETENTION_SNAPSHOT_KEEP) ?? config.snapshotKeep ?? DEFAULT_RETENTION.snapshotKeep;

  return {
    traceDays: validateRetentionValue('traceDays', traceDays),
    snapshotDays: validateRetentionValue('snapshotDays', snapshotDays),
    traceKeep: validateRetentionValue('traceKeep', traceKeep),
    snapshotKeep: validateRetentionValue('snapshotKeep', snapshotKeep)
  };
}

function assertWithinDataDir(dataDir: string, targetPath: string): string {
  const root = resolve(dataDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || rel.includes(':')) {
    throw new Error(`Refusing to delete outside dataDir: ${target}`);
  }
  return rel.replace(/\\/g, '/');
}

function pickReason(byAge: boolean, byKeep: boolean): GcCandidate['reason'] {
  if (byAge && byKeep) {
    return 'age+keep-limit';
  }
  if (byAge) {
    return 'age';
  }
  return 'keep-limit';
}

interface FileStat {
  path: string;
  mtimeMs: number;
}

function collectTraces(dataDir: string): FileStat[] {
  const dir = join(dataDir, 'traces');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const path = join(dir, name);
      return {
        path,
        mtimeMs: statSync(path).mtimeMs
      };
    });
}

function collectSnapshots(dataDir: string): FileStat[] {
  const dir = join(dataDir, 'snapshots');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory())
    .map((path) => ({
      path,
      mtimeMs: statSync(path).mtimeMs
    }));
}

function selectCandidates(
  dataDir: string,
  files: FileStat[],
  keepLimit: number,
  ageDays: number,
  kind: GcCandidate['kind'],
  nowMs: number
): GcCandidate[] {
  const cutoff = nowMs - ageDays * MILLIS_PER_DAY;
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected: GcCandidate[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const file = sorted[index];
    const byKeep = index >= keepLimit;
    const byAge = file.mtimeMs < cutoff;
    if (!byKeep && !byAge) {
      continue;
    }

    selected.push({
      kind,
      path: file.path,
      relativePath: assertWithinDataDir(dataDir, file.path),
      reason: pickReason(byAge, byKeep),
      mtimeMs: file.mtimeMs
    });
  }

  return selected;
}

export function runGc(options: GcRunOptions = {}): GcRunResult {
  const dataDir = ensureDir(options.dataDir ? resolve(options.dataDir) : resolveDataDir());
  const nowMs = options.nowMs ?? Date.now();
  const retention = resolveRetentionConfig(dataDir, options);

  const traceCandidates = selectCandidates(
    dataDir,
    collectTraces(dataDir),
    retention.traceKeep,
    retention.traceDays,
    'trace',
    nowMs
  );
  const snapshotCandidates = selectCandidates(
    dataDir,
    collectSnapshots(dataDir),
    retention.snapshotKeep,
    retention.snapshotDays,
    'snapshot',
    nowMs
  );

  const candidates = [...traceCandidates, ...snapshotCandidates].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const execute = options.force === true;
  if (execute) {
    for (const candidate of candidates) {
      assertWithinDataDir(dataDir, candidate.path);
      rmSync(candidate.path, { recursive: candidate.kind === 'snapshot', force: true });
    }
  }

  return {
    dataDir,
    mode: execute ? 'execute' : 'dry-run',
    retention,
    candidates,
    deletedCount: execute ? candidates.length : 0,
    requiresForce: !execute
  };
}
