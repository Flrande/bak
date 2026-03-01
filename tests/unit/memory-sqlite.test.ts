import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, migrateMemoryJsonToSqlite } from '../../packages/cli/src/memory/factory.js';
import { MemoryStore } from '../../packages/cli/src/memory/store.js';

describe('SqliteMemoryStore', () => {
  it('supports CRUD through backend factory', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-sqlite-crud-'));
    const store = createMemoryStore({ dataDir, backend: 'sqlite' });

    const episode = store.createEpisode({
      domain: 'example.com',
      startUrl: 'http://example.com/form',
      intent: 'fill form',
      steps: [],
      anchors: ['form'],
      outcome: 'success'
    });

    const skill = store.createSkill({
      domain: 'example.com',
      intent: 'fill form',
      description: 'demo',
      plan: [],
      paramsSchema: { fields: {} },
      healing: { retries: 1 }
    });

    expect(episode.id.startsWith('episode_')).toBe(true);
    expect(store.getSkill(skill.id)?.id).toBe(skill.id);
    expect(store.listSkills().length).toBe(1);
    expect(store.listEpisodes().length).toBe(1);

    store.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('migrates memory.json to sqlite idempotently', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-sqlite-migrate-'));
    const jsonStore = new MemoryStore(dataDir);

    jsonStore.createEpisode({
      domain: 'example.com',
      startUrl: 'http://example.com/start',
      intent: 'intent',
      steps: [],
      anchors: ['a'],
      outcome: 'success'
    });
    jsonStore.createSkill({
      domain: 'example.com',
      intent: 'intent',
      description: 'skill',
      plan: [],
      paramsSchema: { fields: {} },
      healing: { retries: 1 }
    });

    const first = migrateMemoryJsonToSqlite(dataDir);
    const second = migrateMemoryJsonToSqlite(dataDir);
    const sqliteStore = createMemoryStore({ dataDir, backend: 'sqlite' });

    expect(first.importedEpisodes).toBe(1);
    expect(first.importedSkills).toBe(1);
    expect(second.importedEpisodes).toBe(0);
    expect(second.importedSkills).toBe(0);
    expect(second.skippedEpisodes).toBe(1);
    expect(second.skippedSkills).toBe(1);
    expect(sqliteStore.listEpisodes().length).toBe(1);
    expect(sqliteStore.listSkills().length).toBe(1);

    sqliteStore.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
