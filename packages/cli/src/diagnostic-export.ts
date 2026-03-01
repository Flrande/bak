import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createMemoryStoreResolved, exportMemory, resolveMemoryBackend } from './memory/factory.js';
import { redactText } from './privacy.js';
import { ensureDir, resolveDataDir } from './utils.js';

export interface DiagnosticExportOptions {
  dataDir?: string;
  outPath?: string;
  traceId?: string;
  doctorReport?: unknown;
  includeMemory?: boolean;
  memoryBackend?: string;
}

export interface DiagnosticExportResult {
  outPath: string;
  dataDir: string;
  redacted: true;
  traceCount: number;
  snapshotCount: number;
  includesDoctorReport: boolean;
  includesIndex: boolean;
  includesMemory: boolean;
  memoryBackend: string | null;
  memoryExportError?: string;
  warnings: string[];
  fileCount: number;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function extractVersionCompatibilityWarning(doctorReport: unknown): string | null {
  const report = asRecord(doctorReport);
  const checks = asRecord(report.checks);
  const versionCheck = asRecord(checks.versionCompatibility);
  const ok = versionCheck.ok === true;
  const message = typeof versionCheck.message === 'string' ? versionCheck.message : null;
  if (ok || !message) {
    return null;
  }
  return message;
}

function extractMemoryBackendWarning(doctorReport: unknown): string | null {
  const report = asRecord(doctorReport);
  const checks = asRecord(report.checks);
  const memoryBackendCheck = asRecord(checks.memoryBackend);
  const ok = memoryBackendCheck.ok === true;
  const severity = memoryBackendCheck.severity;
  const message = typeof memoryBackendCheck.message === 'string' ? memoryBackendCheck.message : null;
  if (ok || severity !== 'warn' || !message) {
    return null;
  }
  return message;
}

function assertWithinDataDir(dataDir: string, candidate: string): void {
  const rel = relative(resolve(dataDir), resolve(candidate));
  if (rel.startsWith('..') || rel.includes(':')) {
    throw new Error(`Refusing to include path outside dataDir: ${candidate}`);
  }
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactUnknown(item);
    }
    return output;
  }
  return value;
}

function copyAndRedactTrace(sourcePath: string, targetPath: string): void {
  const lines = readFileSync(sourcePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return JSON.stringify(redactUnknown(parsed));
      } catch {
        return redactText(line);
      }
    });
  writeFileSync(targetPath, `${lines.join('\n')}\n`, 'utf8');
}

function escapePwshLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function createZip(stageDir: string, outPath: string): void {
  const escapedStage = escapePwshLiteral(stageDir);
  const escapedOut = escapePwshLiteral(outPath);
  const command = `
$ErrorActionPreference = 'Stop'
$source = '${escapedStage}'
$dest = '${escapedOut}'
$items = Get-ChildItem -LiteralPath $source -Force | Select-Object -ExpandProperty FullName
if (-not $items) { throw 'No files available for diagnostic export' }
Compress-Archive -LiteralPath $items -DestinationPath $dest -Force
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Compress-Archive failed');
  }
}

function listFilesRecursive(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const stack = [root];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  return files;
}

function readCliPackageVersion(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const packagePath = resolve(currentDir, '../package.json');
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function exportDiagnosticZip(options: DiagnosticExportOptions = {}): DiagnosticExportResult {
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  ensureDir(dataDir);
  const outPath = options.outPath
    ? resolve(options.outPath)
    : join(dataDir, `bak-diagnostic-${Date.now()}.zip`);

  const stageRoot = mkdtempSync(join(tmpdir(), 'bak-diag-'));
  const stageDir = join(stageRoot, 'diagnostic');
  mkdirSync(stageDir, { recursive: true });

  try {
    let includesDoctorReport = false;
    let includesMemory = false;
    let memoryBackend: string | null = null;
    let memoryExportError: string | undefined;
    const warnings: string[] = [];
    const tracesSource = join(dataDir, 'traces');
    const tracesTarget = join(stageDir, 'traces');
    mkdirSync(tracesTarget, { recursive: true });

    const snapshotSource = join(dataDir, 'snapshots');
    const snapshotTarget = join(stageDir, 'snapshots');
    mkdirSync(snapshotTarget, { recursive: true });

    const traceFiles = existsSync(tracesSource)
      ? readdirSync(tracesSource).filter((name) => name.endsWith('.jsonl'))
      : [];
    const selectedTraceFiles = options.traceId
      ? traceFiles.filter((name) => name === `${options.traceId}.jsonl`)
      : traceFiles;

    for (const fileName of selectedTraceFiles) {
      const sourcePath = join(tracesSource, fileName);
      assertWithinDataDir(dataDir, sourcePath);
      copyAndRedactTrace(sourcePath, join(tracesTarget, fileName));
    }

    const snapshotDirs = existsSync(snapshotSource)
      ? readdirSync(snapshotSource, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    const selectedSnapshotDirs = options.traceId
      ? snapshotDirs.filter((entry) => entry.name === options.traceId)
      : snapshotDirs;

    for (const entry of selectedSnapshotDirs) {
      const sourcePath = join(snapshotSource, entry.name);
      assertWithinDataDir(dataDir, sourcePath);
      cpSync(sourcePath, join(snapshotTarget, entry.name), { recursive: true });
    }

    const policyPath = join(dataDir, '.bak-policy.json');
    if (existsSync(policyPath)) {
      assertWithinDataDir(dataDir, policyPath);
      cpSync(policyPath, join(stageDir, '.bak-policy.json'));
    }

    if (options.doctorReport) {
      const doctorPath = join(stageDir, 'doctor.json');
      writeFileSync(doctorPath, `${JSON.stringify(redactUnknown(options.doctorReport), null, 2)}\n`, 'utf8');
      includesDoctorReport = true;
    }

    if (options.includeMemory === true) {
      const resolvedBackend = resolveMemoryBackend(options.memoryBackend);
      try {
        const resolution = createMemoryStoreResolved({
          dataDir,
          backend: resolvedBackend
        });
        memoryBackend = resolution.backend;
        if (resolution.fallbackReason) {
          warnings.push(
            `memory backend fallback: requested=${resolution.requestedBackend} actual=${resolution.backend} reason=${resolution.fallbackReason}`
          );
        }
        const payload = exportMemory(resolution.store, resolution.backend);
        writeFileSync(join(stageDir, 'memory.json'), `${JSON.stringify(redactUnknown(payload), null, 2)}\n`, 'utf8');
        includesMemory = true;
      } catch (error) {
        memoryBackend = resolvedBackend;
        memoryExportError = error instanceof Error ? error.message : String(error);
        warnings.push(`memory export skipped: ${memoryExportError}`);
      }
    }

    const versionWarning = extractVersionCompatibilityWarning(options.doctorReport);
    if (versionWarning) {
      warnings.push(`version compatibility warning: ${versionWarning}`);
    }

    const memoryBackendWarning = extractMemoryBackendWarning(options.doctorReport);
    if (memoryBackendWarning) {
      warnings.push(`memory backend warning: ${memoryBackendWarning}`);
    }

    const indexPath = join(stageDir, 'index.json');
    writeFileSync(
      indexPath,
      `${JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          redacted: true,
          includesDoctorReport,
          includesMemory,
          memoryBackend,
          memoryExportError: memoryExportError ?? null,
          warnings,
          traceFiles: selectedTraceFiles,
          snapshotDirs: selectedSnapshotDirs.map((entry) => entry.name),
          hasPolicyFile: existsSync(policyPath)
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const versionsPath = join(stageDir, 'versions.json');
    writeFileSync(
      versionsPath,
      `${JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          cliVersion: readCliPackageVersion()
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    createZip(stageDir, outPath);
    const fileCount = listFilesRecursive(stageDir).length;

    return {
      outPath,
      dataDir,
      redacted: true,
      traceCount: selectedTraceFiles.length,
      snapshotCount: selectedSnapshotDirs.length,
      includesDoctorReport,
      includesIndex: true,
      includesMemory,
      memoryBackend,
      memoryExportError,
      warnings,
      fileCount
    };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
