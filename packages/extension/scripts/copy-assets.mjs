import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fromDir = resolve(root, 'public');
const distDir = resolve(root, 'dist');

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

for (const file of ['manifest.json', 'popup.html']) {
  cpSync(resolve(fromDir, file), resolve(distDir, file), { force: true });
}

console.log('Copied extension assets to dist');
