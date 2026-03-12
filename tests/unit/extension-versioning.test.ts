import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import extensionPackageJson from '../../packages/extension/package.json';
import { EXTENSION_VERSION } from '../../packages/extension/src/version.js';

describe('extension versioning', () => {
  it('keeps the runtime version constant aligned with package.json', () => {
    expect(EXTENSION_VERSION).toBe(extensionPackageJson.version);
  });

  it('uses a manifest template placeholder that copy-assets replaces at build time', () => {
    const manifestTemplate = readFileSync(resolve(__dirname, '..', '..', 'packages', 'extension', 'public', 'manifest.json'), 'utf8');
    expect(manifestTemplate).toContain('__BAK_EXTENSION_VERSION__');
  });
});
