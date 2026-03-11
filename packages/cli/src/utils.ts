import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type ResolveDataDirOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  homeDir?: string;
};

export function defaultDataDir(options: ResolveDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? env.HOME ?? homedir();

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? env.APPDATA;
    if (localAppData) {
      return resolve(localAppData, 'bak');
    }
  }

  if (platform === 'darwin') {
    return resolve(homeDir, 'Library', 'Application Support', 'bak');
  }

  if (env.XDG_DATA_HOME) {
    return resolve(env.XDG_DATA_HOME, 'bak');
  }

  if (homeDir) {
    return resolve(homeDir, '.local', 'share', 'bak');
  }

  return resolve(cwd, '.bak-data');
}

export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const root = env.BAK_DATA_DIR ? resolve(env.BAK_DATA_DIR) : defaultDataDir(options);
  mkdirSync(root, { recursive: true });
  return root;
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function filePath(...parts: string[]): string {
  return join(...parts);
}

export function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

export function redacted(input: string): string {
  if (input.length <= 6) {
    return '***';
  }
  return `${input.slice(0, 3)}***${input.slice(-3)}`;
}

export function quantizedBBoxHash(
  domain: string,
  path: string,
  role: string,
  name: string,
  bbox: { x: number; y: number; width: number; height: number }
): string {
  const qx = Math.round(bbox.x / 10) * 10;
  const qy = Math.round(bbox.y / 10) * 10;
  const qw = Math.round(bbox.width / 10) * 10;
  const qh = Math.round(bbox.height / 10) * 10;
  return `eid_${sha1([domain, path, role, name, `${qx}:${qy}:${qw}:${qh}`].join('|')).slice(0, 16)}`;
}

export function randomToken(): string {
  return randomBytes(24).toString('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

export function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

export function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parentDir(path: string): string {
  return dirname(path);
}
