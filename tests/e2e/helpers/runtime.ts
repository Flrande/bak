import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ArtifactFreshness {
  stale: boolean;
  newestSourceMtimeMs: number;
  oldestOutputMtimeMs: number | null;
}

export interface RuntimeStalenessState {
  protocolStale: boolean;
  cliStale: boolean;
  extensionStale: boolean;
  testSitesStale?: boolean;
}

export interface RuntimeBuildPlan {
  protocol: boolean;
  cli: boolean;
  extension: boolean;
  testSites: boolean;
}

interface RuntimeTarget {
  outputDir: string;
  requiredOutputs: string[];
  sourcePaths: string[];
}

export interface RuntimeFreshnessOptions {
  includeTestSites?: boolean;
}

export type RuntimeTargetName = keyof RuntimeBuildPlan;
export type RuntimeBuildRunner = (root: string, target: RuntimeTargetName) => void;

const PLAYWRIGHT_TEST_SITE_PAGES = [
  'index.html',
  'form.html',
  'table.html',
  'controlled.html',
  'spa.html',
  'iframe-host.html',
  'iframe-child.html',
  'shadow.html',
  'upload.html',
  'network.html'
] as const;

function repoRoot(): string {
  return resolve(__dirname, '../..', '..');
}

function buildStampPath(outputDir: string): string {
  return join(outputDir, '.bak-e2e-build-stamp');
}

function hasAllRequiredOutputs(paths: string[]): boolean {
  return paths.every((path) => existsSync(path));
}

function extractReferencedJsOutputs(entryFile: string): string[] {
  if (!existsSync(entryFile)) {
    return [];
  }

  const content = readFileSync(entryFile, 'utf8');
  const matches = [...content.matchAll(/from\s+["'](\.\/[^"']+\.js)["']/g)];
  return matches.map((match) => resolve(dirname(entryFile), match[1]));
}

function extractReferencedHtmlAssets(htmlFile: string, outputDir: string): string[] {
  if (!existsSync(htmlFile)) {
    return [];
  }

  const content = readFileSync(htmlFile, 'utf8');
  const matches = [...content.matchAll(/(?:src|href)=["']\/assets\/([^"']+)["']/g)];
  return matches.map((match) => join(outputDir, 'assets', match[1]));
}

function requiredOutputPathsForTarget(targetName: RuntimeTargetName, target: RuntimeTarget): string[] {
  const base = [...target.requiredOutputs];

  if (targetName === 'cli') {
    return [...base, ...extractReferencedJsOutputs(join(target.outputDir, 'bin.js'))];
  }

  if (targetName === 'testSites') {
    const htmlFiles = target.requiredOutputs.filter((path) => path.endsWith('.html'));
    return [...base, ...htmlFiles.flatMap((htmlFile) => extractReferencedHtmlAssets(htmlFile, target.outputDir))];
  }

  return base;
}

function newestSourceTime(sourcePaths: string[]): number {
  const sourceTimes = sourcePaths
    .map((sourcePath) => targetMtimeMs(sourcePath, 'newest'))
    .filter((value): value is number => value !== null);
  return sourceTimes.length > 0 ? Math.max(...sourceTimes) : 0;
}

function targetMtimeMs(path: string, mode: 'newest' | 'oldest'): number | null {
  if (!existsSync(path)) {
    return null;
  }

  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  const childPaths = readdirSync(path).map((entry) => join(path, entry));
  if (childPaths.length === 0) {
    return null;
  }

  const childTimes = childPaths
    .map((childPath) => targetMtimeMs(childPath, mode))
    .filter((value): value is number => value !== null);

  if (childTimes.length === 0) {
    return null;
  }

  return mode === 'newest' ? Math.max(...childTimes) : Math.min(...childTimes);
}

export function assessArtifactFreshness(sourcePaths: string[], outputPaths: string[]): ArtifactFreshness {
  const sourceTimes = sourcePaths
    .map((sourcePath) => targetMtimeMs(sourcePath, 'newest'))
    .filter((value): value is number => value !== null);
  const newestSourceMtimeMs = sourceTimes.length > 0 ? Math.max(...sourceTimes) : 0;

  const outputTimes = outputPaths
    .map((outputPath) => targetMtimeMs(outputPath, 'oldest'))
    .filter((value): value is number => value !== null);
  const oldestOutputMtimeMs = outputTimes.length === outputPaths.length && outputTimes.length > 0 ? Math.min(...outputTimes) : null;

  return {
    stale: oldestOutputMtimeMs === null || newestSourceMtimeMs > oldestOutputMtimeMs,
    newestSourceMtimeMs,
    oldestOutputMtimeMs
  };
}

function writeBuildStamp(outputDir: string, newestSourceMtimeMs: number): void {
  mkdirSync(outputDir, { recursive: true });
  const stampPath = buildStampPath(outputDir);
  writeFileSync(stampPath, new Date().toISOString(), 'utf8');
  const stampTime = new Date(Math.max(Date.now(), Math.floor(newestSourceMtimeMs) + 1));
  utimesSync(stampPath, stampTime, stampTime);
}

export function resolveRuntimeBuildPlan(state: RuntimeStalenessState): RuntimeBuildPlan {
  return {
    protocol: state.protocolStale,
    cli: state.protocolStale || state.cliStale,
    extension: state.protocolStale || state.extensionStale,
    testSites: state.testSitesStale ?? false
  };
}

function runtimeTargets(root: string, options: RuntimeFreshnessOptions = {}): Partial<Record<RuntimeTargetName, RuntimeTarget>> {
  const targets: Partial<Record<RuntimeTargetName, RuntimeTarget>> = {
    protocol: {
      sourcePaths: [
        join(root, 'packages', 'protocol', 'src'),
        join(root, 'packages', 'protocol', 'package.json'),
        join(root, 'packages', 'protocol', 'tsconfig.json')
      ],
      requiredOutputs: [join(root, 'packages', 'protocol', 'dist', 'index.js')],
      outputDir: join(root, 'packages', 'protocol', 'dist')
    },
    cli: {
      sourcePaths: [
        join(root, 'packages', 'cli', 'src'),
        join(root, 'packages', 'cli', 'package.json'),
        join(root, 'packages', 'cli', 'tsconfig.json')
      ],
      requiredOutputs: [join(root, 'packages', 'cli', 'dist', 'bin.js'), join(root, 'packages', 'cli', 'dist', 'index.js')],
      outputDir: join(root, 'packages', 'cli', 'dist')
    },
    extension: {
      sourcePaths: [
        join(root, 'packages', 'extension', 'src'),
        join(root, 'packages', 'extension', 'scripts'),
        join(root, 'packages', 'extension', 'public'),
        join(root, 'packages', 'extension', 'package.json'),
        join(root, 'packages', 'extension', 'tsconfig.json')
      ],
      requiredOutputs: [
        join(root, 'packages', 'extension', 'dist', 'background.global.js'),
        join(root, 'packages', 'extension', 'dist', 'content.global.js'),
        join(root, 'packages', 'extension', 'dist', 'popup.global.js'),
        join(root, 'packages', 'extension', 'dist', 'manifest.json'),
        join(root, 'packages', 'extension', 'dist', 'popup.html')
      ],
      outputDir: join(root, 'packages', 'extension', 'dist')
    }
  };

  if (options.includeTestSites) {
    targets.testSites = {
      sourcePaths: [
        join(root, 'apps', 'test-sites', 'src'),
        join(root, 'apps', 'test-sites', 'public'),
        join(root, 'apps', 'test-sites', 'package.json'),
        join(root, 'apps', 'test-sites', 'tsconfig.json'),
        join(root, 'apps', 'test-sites', 'vite.config.ts'),
        join(root, 'apps', 'test-sites', 'controlled.html'),
        join(root, 'apps', 'test-sites', 'form.html'),
        join(root, 'apps', 'test-sites', 'iframe-child.html'),
        join(root, 'apps', 'test-sites', 'iframe-host.html'),
        join(root, 'apps', 'test-sites', 'index.html'),
        join(root, 'apps', 'test-sites', 'network.html'),
        join(root, 'apps', 'test-sites', 'shadow.html'),
        join(root, 'apps', 'test-sites', 'spa.html'),
        join(root, 'apps', 'test-sites', 'table.html'),
        join(root, 'apps', 'test-sites', 'upload.html')
      ],
      requiredOutputs: PLAYWRIGHT_TEST_SITE_PAGES.map((file) => join(root, 'apps', 'test-sites', 'dist', file)),
      outputDir: join(root, 'apps', 'test-sites', 'dist')
    };
  }

  return targets;
}

interface RuntimeTargetEvaluation {
  target: RuntimeTarget;
  freshness: ArtifactFreshness;
}

function evaluateRuntimeTargets(root: string, options: RuntimeFreshnessOptions = {}): Record<RuntimeTargetName, RuntimeTargetEvaluation> {
  const targets = runtimeTargets(root, options);
  const protocol = targets.protocol!;
  const cli = targets.cli!;
  const extension = targets.extension!;
  const testSites = targets.testSites;

  return {
    protocol: {
      target: protocol,
      freshness: hasAllRequiredOutputs(requiredOutputPathsForTarget('protocol', protocol))
        ? assessArtifactFreshness(protocol.sourcePaths, [buildStampPath(protocol.outputDir)])
        : { stale: true, newestSourceMtimeMs: newestSourceTime(protocol.sourcePaths), oldestOutputMtimeMs: null }
    },
    cli: {
      target: cli,
      freshness: hasAllRequiredOutputs(requiredOutputPathsForTarget('cli', cli))
        ? assessArtifactFreshness(cli.sourcePaths, [buildStampPath(cli.outputDir)])
        : { stale: true, newestSourceMtimeMs: newestSourceTime(cli.sourcePaths), oldestOutputMtimeMs: null }
    },
    extension: {
      target: extension,
      freshness: hasAllRequiredOutputs(requiredOutputPathsForTarget('extension', extension))
        ? assessArtifactFreshness(extension.sourcePaths, [buildStampPath(extension.outputDir)])
        : { stale: true, newestSourceMtimeMs: newestSourceTime(extension.sourcePaths), oldestOutputMtimeMs: null }
    },
    testSites: {
      target: testSites ?? { sourcePaths: [], requiredOutputs: [], outputDir: join(root, 'apps', 'test-sites', 'dist') },
      freshness: testSites
        ? hasAllRequiredOutputs(requiredOutputPathsForTarget('testSites', testSites))
          ? assessArtifactFreshness(testSites.sourcePaths, [buildStampPath(testSites.outputDir)])
          : { stale: true, newestSourceMtimeMs: newestSourceTime(testSites.sourcePaths), oldestOutputMtimeMs: null }
        : { stale: false, newestSourceMtimeMs: 0, oldestOutputMtimeMs: null }
    }
  };
}

export function detectRuntimeBuildPlan(root = repoRoot(), options: RuntimeFreshnessOptions = {}): RuntimeBuildPlan {
  const evaluations = evaluateRuntimeTargets(root, options);
  return resolveRuntimeBuildPlan({
    protocolStale: evaluations.protocol.freshness.stale,
    cliStale: evaluations.cli.freshness.stale,
    extensionStale: evaluations.extension.freshness.stale,
    testSitesStale: options.includeTestSites ? evaluations.testSites.freshness.stale : false
  });
}

const TARGET_FILTERS: Record<RuntimeTargetName, string> = {
  protocol: '@flrande/bak-protocol',
  cli: '@flrande/bak-cli',
  extension: '@flrande/bak-extension',
  testSites: '@flrande/bak-test-sites'
};

function runBuild(root: string, target: RuntimeTargetName): void {
  const filter = TARGET_FILTERS[target];
  if (process.platform === 'win32') {
    execFileSync(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-Command', `pnpm --filter ${filter} build`],
      {
        cwd: root,
        stdio: 'inherit'
      }
    );
    return;
  }

  execFileSync('pnpm', ['--filter', filter, 'build'], {
    cwd: root,
    stdio: 'inherit'
  });
}

export function ensureE2ERuntimeFresh(
  root = repoRoot(),
  options: RuntimeFreshnessOptions = {},
  buildRunner: RuntimeBuildRunner = runBuild
): RuntimeBuildPlan {
  const evaluations = evaluateRuntimeTargets(root, options);
  const plan = resolveRuntimeBuildPlan({
    protocolStale: evaluations.protocol.freshness.stale,
    cliStale: evaluations.cli.freshness.stale,
    extensionStale: evaluations.extension.freshness.stale,
    testSitesStale: options.includeTestSites ? evaluations.testSites.freshness.stale : false
  });
  for (const target of ['protocol', 'cli', 'extension', 'testSites'] as RuntimeTargetName[]) {
    if (plan[target]) {
      buildRunner(root, target);
      writeBuildStamp(evaluations[target].target.outputDir, evaluations[target].freshness.newestSourceMtimeMs);
    }
  }
  return plan;
}

export function ensurePlaywrightRuntimeFresh(root = repoRoot(), buildRunner: RuntimeBuildRunner = runBuild): RuntimeBuildPlan {
  return ensureE2ERuntimeFresh(root, { includeTestSites: true }, buildRunner);
}

export function cliDistPath(root = repoRoot()): string {
  return join(root, 'packages', 'cli', 'dist', 'bin.js');
}

export function extensionDistPath(root = repoRoot()): string {
  return join(root, 'packages', 'extension', 'dist');
}
