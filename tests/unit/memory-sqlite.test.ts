import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, createMemoryStoreResolved, migrateMemoryJsonToSqlite } from '../../packages/cli/src/memory/factory.js';
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

  it('falls back to json backend when sqlite initialization fails', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-sqlite-fallback-'));

    const resolved = createMemoryStoreResolved({
      dataDir,
      backend: 'sqlite',
      sqliteFactory: () => {
        throw new Error('sqlite unavailable');
      }
    });

    expect(resolved.requestedBackend).toBe('sqlite');
    expect(resolved.backend).toBe('json');
    expect(resolved.fallbackReason).toContain('sqlite unavailable');

    resolved.store.createSkill({
      domain: 'example.com',
      intent: 'fallback works',
      description: 'json fallback',
      plan: [],
      paramsSchema: { fields: {} },
      healing: { retries: 1 }
    });
    expect(resolved.store.listSkills().length).toBe(1);

    resolved.store.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists full skill fields used by retrieval and telemetry', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-sqlite-skill-fields-'));
    const store = createMemoryStore({ dataDir, backend: 'sqlite' });

    const created = store.createSkill({
      domain: 'example.com',
      intent: 'open billing settings',
      description: 'full payload',
      urlPatterns: ['https://example.com/settings/billing'],
      plan: [{ kind: 'scrollTo', x: 12, y: 340 }],
      paramsSchema: { fields: {} },
      preconditions: {
        urlPattern: 'https://example.com/settings/*',
        requiredText: ['Billing']
      },
      healing: { retries: 2, attempts: 3, successes: 2 },
      stability: 'stable',
      meta: {
        source: 'auto',
        fingerprint: 'abc123',
        learnCount: 4,
        lastLearnedAt: '2026-01-01T00:00:00.000Z'
      }
    });

    const withStats = {
      ...created,
      healing: { ...created.healing, attempts: 5, successes: 4 },
      stats: {
        ...created.stats,
        runs: 7,
        success: 6,
        failure: 1,
        healAttempts: 5,
        healSuccess: 4,
        retriesTotal: 9,
        manualInterventions: 2,
        lastRunAt: '2026-02-02T00:00:00.000Z'
      }
    };
    store.updateSkill(withStats);

    const loaded = store.getSkill(created.id);
    expect(loaded?.urlPatterns).toEqual(['https://example.com/settings/billing']);
    expect(loaded?.preconditions).toEqual({
      urlPattern: 'https://example.com/settings/*',
      requiredText: ['Billing']
    });
    expect(loaded?.stability).toBe('stable');
    expect(loaded?.meta).toMatchObject({
      source: 'auto',
      fingerprint: 'abc123',
      learnCount: 4
    });
    expect(loaded?.healing.attempts).toBe(5);
    expect(loaded?.healing.successes).toBe(4);
    expect(loaded?.stats).toMatchObject({
      runs: 7,
      success: 6,
      failure: 1,
      healAttempts: 5,
      healSuccess: 4,
      retriesTotal: 9,
      manualInterventions: 2,
      lastRunAt: '2026-02-02T00:00:00.000Z'
    });

    const listed = store.listSkills({ domain: 'example.com' });
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.healing.attempts).toBe(5);
    expect(listed[0]?.urlPatterns?.[0]).toBe('https://example.com/settings/billing');

    store.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('throws when strict sqlite mode is enabled', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-sqlite-strict-'));

    expect(() =>
      createMemoryStoreResolved({
        dataDir,
        backend: 'sqlite',
        strictSqlite: true,
        sqliteFactory: () => {
          throw new Error('sqlite init failed');
        }
      })
    ).toThrow('sqlite init failed');

    rmSync(dataDir, { recursive: true, force: true });
  });
});
