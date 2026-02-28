import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode, Skill } from '@bak/protocol';
import { ensureDir, id, nowIso, resolveDataDir } from '../utils.js';

interface MemoryState {
  episodes: Episode[];
  skills: Skill[];
}

export class MemoryStore {
  private readonly path: string;
  private cache: MemoryState | null = null;

  constructor(dataDir = resolveDataDir()) {
    ensureDir(dataDir);
    this.path = join(dataDir, 'memory.json');
  }

  private load(): MemoryState {
    if (this.cache) {
      return this.cache;
    }

    if (!existsSync(this.path)) {
      this.cache = { episodes: [], skills: [] };
      return this.cache;
    }

    this.cache = JSON.parse(readFileSync(this.path, 'utf8')) as MemoryState;
    return this.cache;
  }

  private persist(state: MemoryState): void {
    this.cache = state;
    writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  createEpisode(input: Omit<Episode, 'id' | 'createdAt'>): Episode {
    const state = this.load();
    const episode: Episode = {
      ...input,
      id: id('episode'),
      createdAt: nowIso()
    };
    state.episodes.push(episode);
    this.persist(state);
    return episode;
  }

  listEpisodes(): Episode[] {
    return this.load().episodes.slice().reverse();
  }

  createSkill(input: Omit<Skill, 'id' | 'createdAt' | 'stats'>): Skill {
    const state = this.load();
    const skill: Skill = {
      ...input,
      id: id('skill'),
      createdAt: nowIso(),
      stats: {
        runs: 0,
        success: 0,
        failure: 0
      }
    };
    state.skills.push(skill);
    this.persist(state);
    return skill;
  }

  updateSkill(skill: Skill): Skill {
    const state = this.load();
    const index = state.skills.findIndex((item) => item.id === skill.id);
    if (index < 0) {
      throw new Error(`Skill not found: ${skill.id}`);
    }
    state.skills[index] = skill;
    this.persist(state);
    return skill;
  }

  listSkills(filters?: { domain?: string; intent?: string }): Skill[] {
    const state = this.load();
    return state.skills
      .filter((skill) => {
        if (filters?.domain && skill.domain !== filters.domain) {
          return false;
        }
        if (filters?.intent && !skill.intent.toLowerCase().includes(filters.intent.toLowerCase())) {
          return false;
        }
        return true;
      })
      .slice()
      .reverse();
  }

  getSkill(idValue: string): Skill | null {
    return this.load().skills.find((skill) => skill.id === idValue) ?? null;
  }

  deleteSkill(idValue: string): boolean {
    const state = this.load();
    const before = state.skills.length;
    state.skills = state.skills.filter((item) => item.id !== idValue);
    const changed = state.skills.length !== before;
    if (changed) {
      this.persist(state);
    }
    return changed;
  }
}
