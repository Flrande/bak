import { resolve } from 'node:path';
import { resolveDataDir } from '../utils.js';
import { SqliteMemoryStore } from './sqlite-store.js';
import type { MemoryStoreBackend, MemoryStoreSnapshot } from './store.js';

export type MemoryBackend = 'sqlite';

export function resolveMemoryBackend(): MemoryBackend {
  return 'sqlite';
}

export interface CreateMemoryStoreOptions {
  dataDir?: string;
  sqliteFactory?: (dataDir: string) => MemoryStoreBackend;
}

export interface MemoryStoreResolution {
  store: MemoryStoreBackend;
  backend: MemoryBackend;
  requestedBackend: MemoryBackend;
  fallbackReason?: string;
}

export function createMemoryStoreResolved(options?: CreateMemoryStoreOptions): MemoryStoreResolution {
  const dataDir = options?.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const sqliteFactory = options?.sqliteFactory ?? ((dir: string) => new SqliteMemoryStore(dir));
  return {
    store: sqliteFactory(dataDir),
    backend: 'sqlite',
    requestedBackend: 'sqlite'
  };
}

export function createMemoryStore(options?: CreateMemoryStoreOptions): MemoryStoreBackend {
  return createMemoryStoreResolved(options).store;
}

export interface MemoryExportPayload extends MemoryStoreSnapshot {
  backend: MemoryBackend;
  exportedAt: string;
}

export function exportMemory(store: MemoryStoreBackend, backend: MemoryBackend = 'sqlite'): MemoryExportPayload {
  const snapshot = store.exportSnapshot();
  store.close?.();
  return {
    backend,
    exportedAt: new Date().toISOString(),
    ...snapshot
  };
}
