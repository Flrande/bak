import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

let cachedCliVersion: string | null = null;

export function readCliVersion(): string {
  if (cachedCliVersion) {
    return cachedCliVersion;
  }

  try {
    const packagePath = resolve(CURRENT_DIR, '../package.json');
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      cachedCliVersion = parsed.version;
      return cachedCliVersion;
    }
  } catch {
    // ignore and fall back
  }

  cachedCliVersion = '0.0.0';
  return cachedCliVersion;
}
