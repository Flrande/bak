import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fromDir = resolve(root, 'public');
const distDir = resolve(root, 'dist');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const extensionVersion = String(packageJson.version ?? '').trim();

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

if (!extensionVersion) {
  throw new Error('Cannot determine extension version from package.json');
}

const manifestTemplate = readFileSync(resolve(fromDir, 'manifest.json'), 'utf8');
writeFileSync(
  resolve(distDir, 'manifest.json'),
  manifestTemplate.replace('__BAK_EXTENSION_VERSION__', extensionVersion),
  'utf8'
);
cpSync(resolve(fromDir, 'popup.html'), resolve(distDir, 'popup.html'), { force: true });

console.log('Copied extension assets to dist');
