import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../packages/cli/src/memory/store.js';

describe('MemoryStore CRUD', () => {
  it('creates and fetches skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bak-memory-'));
    const store = new MemoryStore(dir);

    const created = store.createSkill({
      domain: 'example.com',
      intent: 'fill form',
      description: 'demo',
      plan: [],
      paramsSchema: { fields: {} },
      healing: { retries: 1 }
    });

    const loaded = store.getSkill(created.id);
    expect(loaded?.intent).toBe('fill form');

    const removed = store.deleteSkill(created.id);
    expect(removed).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('stores episodes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bak-episode-'));
    const store = new MemoryStore(dir);

    const episode = store.createEpisode({
      domain: 'example.com',
      startUrl: 'http://example.com/form',
      intent: 'save profile',
      steps: [],
      anchors: ['save'],
      outcome: 'success'
    });

    expect(episode.id.startsWith('episode_')).toBe(true);
    expect(store.listEpisodes().length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });
});
