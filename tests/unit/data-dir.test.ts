import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDataDir, resolveDataDir } from '../../packages/cli/src/utils.js';

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const target of cleanupPaths) {
    rmSync(target, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe('data directory resolution', () => {
  it('prefers BAK_DATA_DIR over platform defaults', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'bak-data-override-'));
    const configuredDataDir = join(tempRoot, 'custom-data');
    cleanupPaths.add(tempRoot);

    const resolved = resolveDataDir({
      env: {
        BAK_DATA_DIR: configuredDataDir,
        LOCALAPPDATA: join(tempRoot, 'ignored-local-app-data')
      }
    });

    expect(resolved).toBe(resolve(configuredDataDir));
    expect(existsSync(resolved)).toBe(true);
  });

  it('defaults to LOCALAPPDATA on Windows', () => {
    const localAppData = mkdtempSync(join(tmpdir(), 'bak-local-app-data-'));
    cleanupPaths.add(localAppData);

    const resolved = resolveDataDir({
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      cwd: join(localAppData, 'repo')
    });

    expect(resolved).toBe(resolve(localAppData, 'bak'));
    expect(existsSync(resolved)).toBe(true);
  });

  it('falls back to XDG_DATA_HOME on Linux', () => {
    const xdgDataHome = mkdtempSync(join(tmpdir(), 'bak-xdg-data-home-'));
    cleanupPaths.add(xdgDataHome);

    const resolved = defaultDataDir({
      env: { XDG_DATA_HOME: xdgDataHome },
      platform: 'linux',
      cwd: join(xdgDataHome, 'repo'),
      homeDir: join(xdgDataHome, 'home')
    });

    expect(resolved).toBe(resolve(xdgDataHome, 'bak'));
  });

  it('falls back to a home-based data directory when no OS-specific env is set', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'bak-home-dir-'));
    cleanupPaths.add(homeDir);

    const resolved = defaultDataDir({
      env: {},
      platform: 'linux',
      cwd: join(homeDir, 'repo'),
      homeDir
    });

    expect(resolved).toBe(resolve(homeDir, '.local', 'share', 'bak'));
  });
});
