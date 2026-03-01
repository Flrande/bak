import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Episode, Skill } from '@bak/protocol';
import { resolveDataDir } from '../utils.js';
import { SqliteMemoryStore } from './sqlite-store.js';
import { MemoryStore, type MemoryStoreBackend } from './store.js';

export type MemoryBackend = 'json' | 'sqlite';

export function resolveMemoryBackend(input?: string): MemoryBackend {
  const preferred = (input ?? process.env.BAK_MEMORY_BACKEND ?? 'json').toLowerCase();
  return preferred === 'sqlite' ? 'sqlite' : 'json';
}

export function createMemoryStore(options?: { dataDir?: string; backend?: string }): MemoryStoreBackend {
  const dataDir = options?.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const backend = resolveMemoryBackend(options?.backend);
  if (backend === 'sqlite') {
    return new SqliteMemoryStore(dataDir);
  }
  return new MemoryStore(dataDir);
}

export interface MemoryMigrateResult {
  dataDir: string;
  sqlitePath: string;
  importedEpisodes: number;
  skippedEpisodes: number;
  importedSkills: number;
  skippedSkills: number;
  sourceExists: boolean;
}

export function migrateMemoryJsonToSqlite(dataDirInput?: string): MemoryMigrateResult {
  const dataDir = dataDirInput ? resolve(dataDirInput) : resolveDataDir();
  const sourcePath = join(dataDir, 'memory.json');
  const sourceExists = existsSync(sourcePath);
  const jsonStore = new MemoryStore(dataDir);
  const sqliteStore = new SqliteMemoryStore(dataDir);

  const episodes = jsonStore.listEpisodes();
  const skills = jsonStore.listSkills();

  let importedEpisodes = 0;
  let skippedEpisodes = 0;
  let importedSkills = 0;
  let skippedSkills = 0;

  for (const episode of episodes) {
    if (sqliteStore.importEpisode(episode)) {
      importedEpisodes += 1;
    } else {
      skippedEpisodes += 1;
    }
  }

  for (const skill of skills) {
    if (sqliteStore.importSkill(skill)) {
      importedSkills += 1;
    } else {
      skippedSkills += 1;
    }
  }

  jsonStore.close?.();
  sqliteStore.close?.();

  return {
    dataDir,
    sqlitePath: sqliteStore.getPath(),
    importedEpisodes,
    skippedEpisodes,
    importedSkills,
    skippedSkills,
    sourceExists
  };
}

export interface MemoryExportPayload {
  backend: MemoryBackend;
  exportedAt: string;
  episodes: Episode[];
  skills: Skill[];
}

export function exportMemory(store: MemoryStoreBackend, backend: MemoryBackend): MemoryExportPayload {
  const payload = {
    backend,
    exportedAt: new Date().toISOString(),
    episodes: store.listEpisodes(),
    skills: store.listSkills()
  };
  store.close?.();
  return payload;
}
