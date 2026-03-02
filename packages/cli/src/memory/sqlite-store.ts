import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Episode, Skill } from '@flrande/bak-protocol';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import { ensureDir, id, nowIso, resolveDataDir } from '../utils.js';
import type { MemoryStoreBackend } from './store.js';

const require = createRequire(import.meta.url);

function createDatabase(path: string): DatabaseSyncType {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => DatabaseSyncType };
  return new sqlite.DatabaseSync(path);
}

interface SqlEpisodeRow {
  id: string;
  created_at: string;
  domain: string;
  start_url: string;
  intent: string;
  outcome: 'success' | 'failed';
  anchors_json: string;
  steps_json: string;
}

interface SqlSkillRow {
  id: string;
  created_at: string;
  domain: string;
  intent: string;
  description: string;
  plan_json: string;
  params_schema_json: string;
  healing_json: string;
  url_patterns_json: string | null;
  preconditions_json: string | null;
  stability: Skill['stability'] | null;
  meta_json: string | null;
  stats_runs: number;
  stats_success: number;
  stats_failure: number;
  stats_heal_attempts: number | null;
  stats_heal_success: number | null;
  stats_retries_total: number | null;
  stats_manual_interventions: number | null;
  stats_last_run_at: string | null;
}

export class SqliteMemoryStore implements MemoryStoreBackend {
  private readonly db: DatabaseSyncType;
  private readonly sqlitePath: string;

  constructor(dataDir = resolveDataDir()) {
    ensureDir(dataDir);
    this.sqlitePath = join(dataDir, 'memory.sqlite');
    this.db = createDatabase(this.sqlitePath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        domain TEXT NOT NULL,
        start_url TEXT NOT NULL,
        intent TEXT NOT NULL,
        outcome TEXT NOT NULL,
        anchors_json TEXT NOT NULL,
        steps_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        domain TEXT NOT NULL,
        intent TEXT NOT NULL,
        description TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        params_schema_json TEXT NOT NULL,
        healing_json TEXT NOT NULL,
        url_patterns_json TEXT,
        preconditions_json TEXT,
        stability TEXT,
        meta_json TEXT,
        stats_runs INTEGER NOT NULL,
        stats_success INTEGER NOT NULL,
        stats_failure INTEGER NOT NULL,
        stats_heal_attempts INTEGER,
        stats_heal_success INTEGER,
        stats_retries_total INTEGER,
        stats_manual_interventions INTEGER,
        stats_last_run_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_skills_domain_intent ON skills(domain, intent);
      CREATE INDEX IF NOT EXISTS idx_episodes_domain_intent ON episodes(domain, intent);
    `);

    this.db
      .prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)')
      .run('schema_version', '1');
    this.ensureSkillColumns();
    this.db.prepare(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`).run();
  }

  private ensureSkillColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const ensureColumn = (name: string, ddl: string): void => {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE skills ADD COLUMN ${ddl}`);
      }
    };

    ensureColumn('url_patterns_json', 'url_patterns_json TEXT');
    ensureColumn('preconditions_json', 'preconditions_json TEXT');
    ensureColumn('stability', 'stability TEXT');
    ensureColumn('meta_json', 'meta_json TEXT');
    ensureColumn('stats_heal_attempts', 'stats_heal_attempts INTEGER');
    ensureColumn('stats_heal_success', 'stats_heal_success INTEGER');
    ensureColumn('stats_retries_total', 'stats_retries_total INTEGER');
    ensureColumn('stats_manual_interventions', 'stats_manual_interventions INTEGER');
    ensureColumn('stats_last_run_at', 'stats_last_run_at TEXT');
  }

  private toSkill(row: SqlSkillRow): Skill {
    const urlPatterns = row.url_patterns_json ? (JSON.parse(row.url_patterns_json) as Skill['urlPatterns']) : undefined;
    const preconditions = row.preconditions_json
      ? (JSON.parse(row.preconditions_json) as Skill['preconditions'])
      : undefined;
    const meta = row.meta_json ? (JSON.parse(row.meta_json) as Skill['meta']) : undefined;

    return {
      id: row.id,
      createdAt: row.created_at,
      domain: row.domain,
      intent: row.intent,
      description: row.description,
      urlPatterns,
      plan: JSON.parse(row.plan_json) as Skill['plan'],
      paramsSchema: JSON.parse(row.params_schema_json) as Skill['paramsSchema'],
      preconditions,
      healing: JSON.parse(row.healing_json) as Skill['healing'],
      stats: {
        runs: row.stats_runs,
        success: row.stats_success,
        failure: row.stats_failure,
        healAttempts: row.stats_heal_attempts ?? undefined,
        healSuccess: row.stats_heal_success ?? undefined,
        retriesTotal: row.stats_retries_total ?? undefined,
        manualInterventions: row.stats_manual_interventions ?? undefined,
        lastRunAt: row.stats_last_run_at ?? undefined
      },
      stability: row.stability ?? undefined,
      meta
    };
  }

  getPath(): string {
    return this.sqlitePath;
  }

  createEpisode(input: Omit<Episode, 'id' | 'createdAt'>): Episode {
    const episode: Episode = {
      ...input,
      id: id('episode'),
      createdAt: nowIso()
    };

    this.db
      .prepare(
        `INSERT INTO episodes (
          id, created_at, domain, start_url, intent, outcome, anchors_json, steps_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        episode.id,
        episode.createdAt,
        episode.domain,
        episode.startUrl,
        episode.intent,
        episode.outcome,
        JSON.stringify(episode.anchors),
        JSON.stringify(episode.steps)
      );
    return episode;
  }

  listEpisodes(): Episode[] {
    const rows = this.db
      .prepare('SELECT * FROM episodes ORDER BY created_at DESC')
      .all() as unknown as SqlEpisodeRow[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      domain: row.domain,
      startUrl: row.start_url,
      intent: row.intent,
      outcome: row.outcome,
      anchors: JSON.parse(row.anchors_json) as string[],
      steps: JSON.parse(row.steps_json) as Episode['steps']
    }));
  }

  createSkill(input: Omit<Skill, 'id' | 'createdAt' | 'stats'>): Skill {
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

    this.db
      .prepare(
        `INSERT INTO skills (
          id, created_at, domain, intent, description, plan_json, params_schema_json, healing_json,
          url_patterns_json, preconditions_json, stability, meta_json,
          stats_runs, stats_success, stats_failure, stats_heal_attempts, stats_heal_success,
          stats_retries_total, stats_manual_interventions, stats_last_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        skill.id,
        skill.createdAt,
        skill.domain,
        skill.intent,
        skill.description,
        JSON.stringify(skill.plan),
        JSON.stringify(skill.paramsSchema),
        JSON.stringify(skill.healing),
        skill.urlPatterns ? JSON.stringify(skill.urlPatterns) : null,
        skill.preconditions ? JSON.stringify(skill.preconditions) : null,
        skill.stability ?? null,
        skill.meta ? JSON.stringify(skill.meta) : null,
        skill.stats.runs,
        skill.stats.success,
        skill.stats.failure,
        skill.stats.healAttempts ?? null,
        skill.stats.healSuccess ?? null,
        skill.stats.retriesTotal ?? null,
        skill.stats.manualInterventions ?? null,
        skill.stats.lastRunAt ?? null
      );
    return skill;
  }

  updateSkill(skill: Skill): Skill {
    const result = this.db
      .prepare(
        `UPDATE skills SET
          domain = ?,
          intent = ?,
          description = ?,
          plan_json = ?,
          params_schema_json = ?,
          healing_json = ?,
          url_patterns_json = ?,
          preconditions_json = ?,
          stability = ?,
          meta_json = ?,
          stats_runs = ?,
          stats_success = ?,
          stats_failure = ?,
          stats_heal_attempts = ?,
          stats_heal_success = ?,
          stats_retries_total = ?,
          stats_manual_interventions = ?,
          stats_last_run_at = ?
        WHERE id = ?`
      )
      .run(
        skill.domain,
        skill.intent,
        skill.description,
        JSON.stringify(skill.plan),
        JSON.stringify(skill.paramsSchema),
        JSON.stringify(skill.healing),
        skill.urlPatterns ? JSON.stringify(skill.urlPatterns) : null,
        skill.preconditions ? JSON.stringify(skill.preconditions) : null,
        skill.stability ?? null,
        skill.meta ? JSON.stringify(skill.meta) : null,
        skill.stats.runs,
        skill.stats.success,
        skill.stats.failure,
        skill.stats.healAttempts ?? null,
        skill.stats.healSuccess ?? null,
        skill.stats.retriesTotal ?? null,
        skill.stats.manualInterventions ?? null,
        skill.stats.lastRunAt ?? null,
        skill.id
      );

    if (result.changes === 0) {
      throw new Error(`Skill not found: ${skill.id}`);
    }
    return skill;
  }

  listSkills(filters?: { domain?: string; intent?: string }): Skill[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];

    if (filters?.domain) {
      where.push('domain = ?');
      args.push(filters.domain);
    }
    if (filters?.intent) {
      where.push('LOWER(intent) LIKE ?');
      args.push(`%${filters.intent.toLowerCase()}%`);
    }

    const query = `
      SELECT * FROM skills
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
    `;

    const rows = this.db.prepare(query).all(...args) as unknown as SqlSkillRow[];
    return rows.map((row) => this.toSkill(row));
  }

  getSkill(idValue: string): Skill | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(idValue) as unknown as SqlSkillRow | undefined;
    if (!row) {
      return null;
    }
    return this.toSkill(row);
  }

  deleteSkill(idValue: string): boolean {
    const result = this.db.prepare('DELETE FROM skills WHERE id = ?').run(idValue);
    return result.changes > 0;
  }

  importEpisode(episode: Episode): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO episodes (
          id, created_at, domain, start_url, intent, outcome, anchors_json, steps_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        episode.id,
        episode.createdAt,
        episode.domain,
        episode.startUrl,
        episode.intent,
        episode.outcome,
        JSON.stringify(episode.anchors),
        JSON.stringify(episode.steps)
      );
    return result.changes > 0;
  }

  importSkill(skill: Skill): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO skills (
          id, created_at, domain, intent, description, plan_json, params_schema_json, healing_json,
          url_patterns_json, preconditions_json, stability, meta_json,
          stats_runs, stats_success, stats_failure, stats_heal_attempts, stats_heal_success,
          stats_retries_total, stats_manual_interventions, stats_last_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        skill.id,
        skill.createdAt,
        skill.domain,
        skill.intent,
        skill.description,
        JSON.stringify(skill.plan),
        JSON.stringify(skill.paramsSchema),
        JSON.stringify(skill.healing),
        skill.urlPatterns ? JSON.stringify(skill.urlPatterns) : null,
        skill.preconditions ? JSON.stringify(skill.preconditions) : null,
        skill.stability ?? null,
        skill.meta ? JSON.stringify(skill.meta) : null,
        skill.stats.runs,
        skill.stats.success,
        skill.stats.failure,
        skill.stats.healAttempts ?? null,
        skill.stats.healSuccess ?? null,
        skill.stats.retriesTotal ?? null,
        skill.stats.manualInterventions ?? null,
        skill.stats.lastRunAt ?? null
      );
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}


