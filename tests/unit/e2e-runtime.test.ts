import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessArtifactFreshness,
  detectRuntimeBuildPlan,
  ensureE2ERuntimeFresh,
  resolveRuntimeBuildPlan,
  type RuntimeBuildRunner,
  type RuntimeTargetName
} from '../e2e/helpers/runtime';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bak-e2e-runtime-'));
  tempRoots.push(root);
  return root;
}

function writeFile(path: string, content: string, mtimeMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  const time = new Date(mtimeMs);
  utimesSync(path, time, time);
}

function setDirTime(path: string, mtimeMs: number): void {
  mkdirSync(path, { recursive: true });
  const time = new Date(mtimeMs);
  utimesSync(path, time, time);
}

function seedProjectRoot(root: string): void {
  writeFile(join(root, 'packages', 'protocol', 'src', 'index.ts'), 'export const protocol = true;', 1_000);
  writeFile(join(root, 'packages', 'protocol', 'package.json'), '{}', 1_000);
  writeFile(join(root, 'packages', 'protocol', 'tsconfig.json'), '{}', 1_000);
  writeFile(join(root, 'packages', 'protocol', 'dist', 'index.js'), 'export const protocol = true;', 2_000);
  writeFile(join(root, 'packages', 'protocol', 'dist', '.bak-e2e-build-stamp'), 'stamp', 2_000);

  writeFile(join(root, 'packages', 'cli', 'src', 'index.ts'), 'export const cli = true;', 1_000);
  writeFile(join(root, 'packages', 'cli', 'package.json'), '{}', 1_000);
  writeFile(join(root, 'packages', 'cli', 'tsconfig.json'), '{}', 1_000);
  writeFile(join(root, 'packages', 'cli', 'dist', 'bin.js'), 'import { cli } from "./chunk-FAKE.js"; console.log(cli);', 2_000);
  writeFile(join(root, 'packages', 'cli', 'dist', 'index.js'), 'export const cli = true;', 2_000);
  writeFile(join(root, 'packages', 'cli', 'dist', 'chunk-FAKE.js'), 'export const cli = true;', 2_000);
  writeFile(join(root, 'packages', 'cli', 'dist', '.bak-e2e-build-stamp'), 'stamp', 2_000);

  writeFile(join(root, 'packages', 'extension', 'src', 'content.ts'), 'const ext = true;', 1_000);
  writeFile(join(root, 'packages', 'extension', 'package.json'), '{}', 1_000);
  writeFile(join(root, 'packages', 'extension', 'tsconfig.json'), '{}', 1_000);
  setDirTime(join(root, 'packages', 'extension', 'scripts'), 1_000);
  writeFile(join(root, 'packages', 'extension', 'public', 'manifest.json'), '{"manifest_version":3}', 1_000);
  writeFile(join(root, 'packages', 'extension', 'public', 'popup.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'packages', 'extension', 'dist', 'background.global.js'), 'const background = true;', 2_000);
  writeFile(join(root, 'packages', 'extension', 'dist', 'content.global.js'), 'const ext = true;', 2_000);
  writeFile(join(root, 'packages', 'extension', 'dist', 'popup.global.js'), 'const popup = true;', 2_000);
  writeFile(join(root, 'packages', 'extension', 'dist', 'manifest.json'), '{"manifest_version":3}', 2_000);
  writeFile(join(root, 'packages', 'extension', 'dist', 'popup.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'packages', 'extension', 'dist', '.bak-e2e-build-stamp'), 'stamp', 2_000);

  writeFile(join(root, 'apps', 'test-sites', 'src', 'main.ts'), 'export const site = true;', 1_000);
  setDirTime(join(root, 'apps', 'test-sites', 'public'), 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'package.json'), '{}', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'tsconfig.json'), '{}', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'vite.config.ts'), 'export default {};', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'index.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'form.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'controlled.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'iframe-child.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'iframe-host.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'network.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'shadow.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'spa.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'table.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'upload.html'), '<!doctype html>', 1_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'index.html'), '<!doctype html><script type="module" src="/assets/main-test.js"></script>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'form.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'table.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'controlled.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'spa.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'iframe-host.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'iframe-child.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'shadow.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'upload.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'network.html'), '<!doctype html>', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', 'assets', 'main-test.js'), 'console.log("site");', 2_000);
  writeFile(join(root, 'apps', 'test-sites', 'dist', '.bak-e2e-build-stamp'), 'stamp', 2_000);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('e2e runtime freshness helper', () => {
  it('treats missing outputs as stale', () => {
    const root = makeTempRoot();
    const source = join(root, 'source.ts');
    writeFile(source, 'export const value = 1;', 2_000);

    const freshness = assessArtifactFreshness([source], [join(root, 'dist')]);
    expect(freshness.stale).toBe(true);
    expect(freshness.oldestOutputMtimeMs).toBeNull();
  });

  it('treats newer source inputs as stale even when outputs exist', () => {
    const root = makeTempRoot();
    const source = join(root, 'src', 'index.ts');
    const output = join(root, 'dist', 'index.js');
    writeFile(output, 'export {};', 1_000);
    writeFile(source, 'export const fresh = true;', 2_000);

    const freshness = assessArtifactFreshness([join(root, 'src')], [join(root, 'dist')]);
    expect(freshness.stale).toBe(true);
    expect(freshness.oldestOutputMtimeMs).not.toBeNull();
    expect(freshness.newestSourceMtimeMs).toBeGreaterThan(freshness.oldestOutputMtimeMs ?? 0);
  });

  it('treats newer outputs as fresh', () => {
    const root = makeTempRoot();
    const source = join(root, 'src', 'index.ts');
    const output = join(root, 'dist', 'index.js');
    writeFile(source, 'export const fresh = false;', 1_000);
    writeFile(output, 'export const fresh = true;', 2_000);

    const freshness = assessArtifactFreshness([join(root, 'src')], [join(root, 'dist')]);
    expect(freshness.stale).toBe(false);
  });

  it('propagates protocol staleness to both cli and extension rebuilds', () => {
    const plan = resolveRuntimeBuildPlan({
      protocolStale: true,
      cliStale: false,
      extensionStale: false
    });

    expect(plan).toEqual({
      protocol: true,
      cli: true,
      extension: true,
      testSites: false
    });
  });

  it('detects a stale cli dist without forcing an extension rebuild', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    writeFile(join(root, 'packages', 'cli', 'src', 'index.ts'), 'export const cli = "updated";', 3_000);

    const plan = detectRuntimeBuildPlan(root);
    expect(plan).toEqual({
      protocol: false,
      cli: true,
      extension: false,
      testSites: false
    });
  });

  it('detects extension public asset changes and plans an extension rebuild', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    writeFile(join(root, 'packages', 'extension', 'public', 'manifest.json'), '{"manifest_version":3,"name":"Updated"}', 3_000);

    const plan = detectRuntimeBuildPlan(root);
    expect(plan).toEqual({
      protocol: false,
      cli: false,
      extension: true,
      testSites: false
    });
  });

  it('treats missing cli runtime outputs as stale even when the build stamp exists', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    rmSync(join(root, 'packages', 'cli', 'dist', 'bin.js'));

    const plan = detectRuntimeBuildPlan(root);
    expect(plan).toEqual({
      protocol: false,
      cli: true,
      extension: false,
      testSites: false
    });
  });

  it('reuses fresh runtime outputs even when build stamps are missing', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    rmSync(join(root, 'packages', 'protocol', 'dist', '.bak-e2e-build-stamp'));
    rmSync(join(root, 'packages', 'cli', 'dist', '.bak-e2e-build-stamp'));
    rmSync(join(root, 'packages', 'extension', 'dist', '.bak-e2e-build-stamp'));
    rmSync(join(root, 'apps', 'test-sites', 'dist', '.bak-e2e-build-stamp'));

    const plan = detectRuntimeBuildPlan(root, { includeTestSites: true });
    expect(plan).toEqual({
      protocol: false,
      cli: false,
      extension: false,
      testSites: false
    });
  });

  it('treats missing cli chunk outputs as stale even when the build stamp exists', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    rmSync(join(root, 'packages', 'cli', 'dist', 'chunk-FAKE.js'));

    const plan = detectRuntimeBuildPlan(root);
    expect(plan).toEqual({
      protocol: false,
      cli: true,
      extension: false,
      testSites: false
    });
  });

  it('treats missing extension runtime outputs as stale even when the build stamp exists', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    rmSync(join(root, 'packages', 'extension', 'dist', 'manifest.json'));

    const plan = detectRuntimeBuildPlan(root);
    expect(plan).toEqual({
      protocol: false,
      cli: false,
      extension: true,
      testSites: false
    });
  });

  it('detects stale test-site dist without forcing unrelated rebuilds', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    writeFile(join(root, 'apps', 'test-sites', 'src', 'main.ts'), 'export const site = "updated";', 3_000);

    const plan = detectRuntimeBuildPlan(root, { includeTestSites: true });
    expect(plan).toEqual({
      protocol: false,
      cli: false,
      extension: false,
      testSites: true
    });
  });

  it('treats missing Playwright-used controlled page output as stale even when index form spa and the build stamp remain', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    rmSync(join(root, 'apps', 'test-sites', 'dist', 'controlled.html'));

    const plan = detectRuntimeBuildPlan(root, { includeTestSites: true });
    expect(plan).toEqual({
      protocol: false,
      cli: false,
      extension: false,
      testSites: true
    });
  });

  it('treats missing Playwright-used iframe host output as stale even when index form spa and the build stamp remain', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    rmSync(join(root, 'apps', 'test-sites', 'dist', 'iframe-host.html'));

    const plan = detectRuntimeBuildPlan(root, { includeTestSites: true });
    expect(plan).toEqual({
      protocol: false,
      cli: false,
      extension: false,
      testSites: true
    });
  });

  it('treats missing test-site built assets as stale even when html and the build stamp exist', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    rmSync(join(root, 'apps', 'test-sites', 'dist', 'assets', 'main-test.js'));

    const plan = detectRuntimeBuildPlan(root, { includeTestSites: true });
    expect(plan).toEqual({
      protocol: false,
      cli: false,
      extension: false,
      testSites: true
    });
  });

  it('rechecks freshness on repeated calls within one process', () => {
    const root = makeTempRoot();
    seedProjectRoot(root);
    const builtTargets: RuntimeTargetName[] = [];
    const runner: RuntimeBuildRunner = (_root, target) => {
      builtTargets.push(target);
      const outputTime = builtTargets.length * 1_000 + 4_000;
      switch (target) {
        case 'protocol':
          writeFile(join(root, 'packages', 'protocol', 'dist', 'index.js'), 'export const protocol = "rebuilt";', outputTime);
          break;
        case 'cli':
          writeFile(join(root, 'packages', 'cli', 'dist', 'bin.js'), 'import { cli } from "./chunk-FAKE.js"; console.log(cli);', outputTime);
          writeFile(join(root, 'packages', 'cli', 'dist', 'index.js'), 'export const cli = "rebuilt";', outputTime);
          writeFile(join(root, 'packages', 'cli', 'dist', 'chunk-FAKE.js'), 'export const cli = "rebuilt";', outputTime);
          break;
        case 'extension':
          writeFile(join(root, 'packages', 'extension', 'dist', 'content.global.js'), 'const ext = "rebuilt";', outputTime);
          writeFile(join(root, 'packages', 'extension', 'dist', 'background.global.js'), 'const background = "rebuilt";', outputTime);
          writeFile(join(root, 'packages', 'extension', 'dist', 'popup.global.js'), 'const popup = "rebuilt";', outputTime);
          writeFile(join(root, 'packages', 'extension', 'dist', 'manifest.json'), '{"manifest_version":3,"name":"rebuilt"}', outputTime);
          writeFile(join(root, 'packages', 'extension', 'dist', 'popup.html'), '<!doctype html><title>rebuilt</title>', outputTime);
          break;
        case 'testSites':
          writeFile(
            join(root, 'apps', 'test-sites', 'dist', 'index.html'),
            '<!doctype html><title>rebuilt</title><script type="module" src="/assets/main-test.js"></script>',
            outputTime
          );
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'form.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'table.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'controlled.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'spa.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'iframe-host.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'iframe-child.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'shadow.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'upload.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'network.html'), '<!doctype html>', outputTime);
          writeFile(join(root, 'apps', 'test-sites', 'dist', 'assets', 'main-test.js'), 'console.log("rebuilt");', outputTime);
          break;
      }
    };

    const firstPlan = ensureE2ERuntimeFresh(root, { includeTestSites: true }, runner);
    expect(firstPlan).toEqual({
      protocol: false,
      cli: false,
      extension: false,
      testSites: false
    });
    expect(builtTargets).toEqual([]);

    writeFile(join(root, 'packages', 'cli', 'src', 'index.ts'), 'export const cli = "changed later";', 5_000);
    writeFile(join(root, 'apps', 'test-sites', 'src', 'main.ts'), 'export const site = "changed later";', 6_000);

    const secondPlan = ensureE2ERuntimeFresh(root, { includeTestSites: true }, runner);
    expect(secondPlan).toEqual({
      protocol: false,
      cli: true,
      extension: false,
      testSites: true
    });
    expect(builtTargets).toEqual(['cli', 'testSites']);
  });
});
