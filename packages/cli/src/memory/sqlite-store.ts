import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  CaptureEvent,
  CaptureSession,
  DraftMemory,
  DurableMemory,
  MemoryPlan,
  MemoryRevision,
  MemoryRun,
  PageFingerprint,
  PatchSuggestion
} from '@flrande/bak-protocol';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import { ensureDir, id, nowIso, resolveDataDir } from '../utils.js';
import type { MemoryStoreBackend, MemoryStoreSnapshot } from './store.js';

const require = createRequire(import.meta.url);

function createDatabase(path: string): DatabaseSyncType {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => DatabaseSyncType };
  return new sqlite.DatabaseSync(path);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  return JSON.parse(value) as T;
}

interface FingerprintRow {
  id: string;
  payload_json: string;
}

interface CaptureSessionRow {
  id: string;
  goal: string;
  status: CaptureSession['status'];
  outcome: CaptureSession['outcome'] | null;
  tab_id: number | null;
  started_at: string;
  ended_at: string | null;
  start_fingerprint_id: string | null;
  end_fingerprint_id: string | null;
  labels_json: string;
  event_count: number;
}

interface CaptureEventRow {
  id: string;
  capture_session_id: string;
  at: string;
  kind: CaptureEvent['kind'];
  label: string | null;
  note: string | null;
  role: CaptureEvent['role'] | null;
  step_json: string | null;
  page_fingerprint_id: string | null;
}

interface DraftRow {
  id: string;
  capture_session_id: string;
  kind: DraftMemory['kind'];
  status: DraftMemory['status'];
  title: string;
  goal: string;
  description: string;
  steps_json: string;
  parameter_schema_json: string;
  tags_json: string;
  rationale_json: string;
  risk_notes_json: string;
  entry_fingerprint_id: string | null;
  target_fingerprint_id: string | null;
  source_event_ids_json: string;
  created_at: string;
  discarded_at: string | null;
  promoted_at: string | null;
}

interface MemoryRow {
  id: string;
  kind: DurableMemory['kind'];
  status: DurableMemory['status'];
  title: string;
  goal: string;
  description: string;
  tags_json: string;
  latest_revision_id: string;
  created_at: string;
  updated_at: string;
  deprecated_reason: string | null;
}

interface RevisionRow {
  id: string;
  memory_id: string;
  revision: number;
  kind: MemoryRevision['kind'];
  title: string;
  goal: string;
  description: string;
  steps_json: string;
  parameter_schema_json: string;
  entry_fingerprint_id: string | null;
  target_fingerprint_id: string | null;
  tags_json: string;
  rationale_json: string;
  risk_notes_json: string;
  change_summary_json: string;
  created_at: string;
  created_from_draft_id: string | null;
  supersedes_revision_id: string | null;
}

interface PlanRow {
  id: string;
  kind: MemoryPlan['kind'];
  mode: MemoryPlan['mode'];
  status: MemoryPlan['status'];
  route_revision_id: string | null;
  procedure_revision_id: string | null;
  revision_ids_json: string;
  parameters_json: string;
  entry_fingerprint_id: string | null;
  target_fingerprint_id: string | null;
  applicability_status: MemoryPlan['applicabilityStatus'];
  applicability_summary: string;
  checks_json: string;
  steps_json: string;
  created_at: string;
  last_run_id: string | null;
}

interface RunRow {
  id: string;
  plan_id: string;
  mode: MemoryRun['mode'];
  status: MemoryRun['status'];
  revision_ids_json: string;
  started_at: string;
  ended_at: string | null;
  patch_suggestion_ids_json: string;
  result_summary: string;
  steps_json: string;
}

interface PatchRow {
  id: string;
  memory_id: string;
  base_revision_id: string;
  status: PatchSuggestion['status'];
  title: string;
  summary: string;
  reason: string;
  affected_step_indexes_json: string;
  change_summary_json: string;
  proposed_revision_json: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
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

  getPath(): string {
    return this.sqlitePath;
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS page_fingerprints (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capture_sessions (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        tab_id INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        start_fingerprint_id TEXT,
        end_fingerprint_id TEXT,
        labels_json TEXT NOT NULL,
        event_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capture_events (
        id TEXT PRIMARY KEY,
        capture_session_id TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT,
        note TEXT,
        role TEXT,
        step_json TEXT,
        page_fingerprint_id TEXT
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        capture_session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        description TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        parameter_schema_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        rationale_json TEXT NOT NULL,
        risk_notes_json TEXT NOT NULL,
        entry_fingerprint_id TEXT,
        target_fingerprint_id TEXT,
        source_event_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        discarded_at TEXT,
        promoted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        latest_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deprecated_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        description TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        parameter_schema_json TEXT NOT NULL,
        entry_fingerprint_id TEXT,
        target_fingerprint_id TEXT,
        tags_json TEXT NOT NULL,
        rationale_json TEXT NOT NULL,
        risk_notes_json TEXT NOT NULL,
        change_summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_from_draft_id TEXT,
        supersedes_revision_id TEXT
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        route_revision_id TEXT,
        procedure_revision_id TEXT,
        revision_ids_json TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        entry_fingerprint_id TEXT,
        target_fingerprint_id TEXT,
        applicability_status TEXT NOT NULL,
        applicability_summary TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        revision_ids_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        patch_suggestion_ids_json TEXT NOT NULL,
        result_summary TEXT NOT NULL,
        steps_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patches (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        base_revision_id TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        reason TEXT NOT NULL,
        affected_step_indexes_json TEXT NOT NULL,
        change_summary_json TEXT NOT NULL,
        proposed_revision_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_capture_events_session ON capture_events(capture_session_id, at);
      CREATE INDEX IF NOT EXISTS idx_drafts_session ON drafts(capture_session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_kind_status ON memories(kind, status);
      CREATE INDEX IF NOT EXISTS idx_revisions_memory ON revisions(memory_id, revision);
      CREATE INDEX IF NOT EXISTS idx_runs_plan ON runs(plan_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_patches_memory ON patches(memory_id, created_at);
    `);
    this.db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)').run('schema_version', '3');
  }

  private toCaptureSession(row: CaptureSessionRow): CaptureSession {
    return {
      id: row.id,
      goal: row.goal,
      status: row.status,
      outcome: row.outcome ?? undefined,
      tabId: row.tab_id ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      startFingerprintId: row.start_fingerprint_id ?? undefined,
      endFingerprintId: row.end_fingerprint_id ?? undefined,
      labels: parseJson(row.labels_json, []),
      eventCount: row.event_count
    };
  }

  private toCaptureEvent(row: CaptureEventRow): CaptureEvent {
    return {
      id: row.id,
      captureSessionId: row.capture_session_id,
      at: row.at,
      kind: row.kind,
      label: row.label ?? undefined,
      note: row.note ?? undefined,
      role: row.role ?? undefined,
      step: row.step_json ? parseJson(row.step_json, undefined) : undefined,
      pageFingerprintId: row.page_fingerprint_id ?? undefined
    };
  }

  private toDraft(row: DraftRow): DraftMemory {
    return {
      id: row.id,
      captureSessionId: row.capture_session_id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      goal: row.goal,
      description: row.description,
      steps: parseJson(row.steps_json, []),
      parameterSchema: parseJson(row.parameter_schema_json, {}),
      tags: parseJson(row.tags_json, []),
      rationale: parseJson(row.rationale_json, []),
      riskNotes: parseJson(row.risk_notes_json, []),
      entryFingerprintId: row.entry_fingerprint_id ?? undefined,
      targetFingerprintId: row.target_fingerprint_id ?? undefined,
      sourceEventIds: parseJson(row.source_event_ids_json, []),
      createdAt: row.created_at,
      discardedAt: row.discarded_at ?? undefined,
      promotedAt: row.promoted_at ?? undefined
    };
  }

  private toMemory(row: MemoryRow): DurableMemory {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      goal: row.goal,
      description: row.description,
      tags: parseJson(row.tags_json, []),
      latestRevisionId: row.latest_revision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deprecatedReason: row.deprecated_reason ?? undefined
    };
  }

  private toRevision(row: RevisionRow): MemoryRevision {
    return {
      id: row.id,
      memoryId: row.memory_id,
      revision: row.revision,
      kind: row.kind,
      title: row.title,
      goal: row.goal,
      description: row.description,
      steps: parseJson(row.steps_json, []),
      parameterSchema: parseJson(row.parameter_schema_json, {}),
      entryFingerprintId: row.entry_fingerprint_id ?? undefined,
      targetFingerprintId: row.target_fingerprint_id ?? undefined,
      tags: parseJson(row.tags_json, []),
      rationale: parseJson(row.rationale_json, []),
      riskNotes: parseJson(row.risk_notes_json, []),
      changeSummary: parseJson(row.change_summary_json, []),
      createdAt: row.created_at,
      createdFromDraftId: row.created_from_draft_id ?? undefined,
      supersedesRevisionId: row.supersedes_revision_id ?? undefined
    };
  }

  private toPlan(row: PlanRow): MemoryPlan {
    return {
      id: row.id,
      kind: row.kind,
      mode: row.mode,
      status: row.status,
      routeRevisionId: row.route_revision_id ?? undefined,
      procedureRevisionId: row.procedure_revision_id ?? undefined,
      revisionIds: parseJson(row.revision_ids_json, []),
      parameters: parseJson(row.parameters_json, {}),
      entryFingerprintId: row.entry_fingerprint_id ?? undefined,
      targetFingerprintId: row.target_fingerprint_id ?? undefined,
      applicabilityStatus: row.applicability_status,
      applicabilitySummary: row.applicability_summary,
      checks: parseJson(row.checks_json, []),
      steps: parseJson(row.steps_json, []),
      createdAt: row.created_at,
      lastRunId: row.last_run_id ?? undefined
    };
  }

  private toRun(row: RunRow): MemoryRun {
    return {
      id: row.id,
      planId: row.plan_id,
      mode: row.mode,
      status: row.status,
      revisionIds: parseJson(row.revision_ids_json, []),
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      patchSuggestionIds: parseJson(row.patch_suggestion_ids_json, []),
      resultSummary: row.result_summary,
      steps: parseJson(row.steps_json, [])
    };
  }

  private toPatch(row: PatchRow): PatchSuggestion {
    return {
      id: row.id,
      memoryId: row.memory_id,
      baseRevisionId: row.base_revision_id,
      status: row.status,
      title: row.title,
      summary: row.summary,
      reason: row.reason,
      affectedStepIndexes: parseJson(row.affected_step_indexes_json, []),
      changeSummary: parseJson(row.change_summary_json, []),
      proposedRevision: parseJson(row.proposed_revision_json, null as never),
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolutionNote: row.resolution_note ?? undefined
    };
  }

  createPageFingerprint(input: Omit<PageFingerprint, 'id'>): PageFingerprint {
    const fingerprint: PageFingerprint = {
      ...input,
      id: id('fingerprint')
    };
    this.db.prepare('INSERT INTO page_fingerprints (id, payload_json) VALUES (?, ?)').run(
      fingerprint.id,
      JSON.stringify(fingerprint)
    );
    return fingerprint;
  }

  getPageFingerprint(idValue: string): PageFingerprint | null {
    const row = this.db.prepare('SELECT * FROM page_fingerprints WHERE id = ?').get(idValue) as FingerprintRow | undefined;
    return row ? parseJson<PageFingerprint>(row.payload_json, null as never) : null;
  }

  createCaptureSession(input: Omit<CaptureSession, 'id' | 'startedAt' | 'status' | 'eventCount'>): CaptureSession {
    const session: CaptureSession = {
      ...input,
      id: id('capture'),
      startedAt: nowIso(),
      status: 'capturing',
      eventCount: 0
    };
    this.db
      .prepare(
        `INSERT INTO capture_sessions (
          id, goal, status, outcome, tab_id, started_at, ended_at, start_fingerprint_id, end_fingerprint_id, labels_json, event_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.goal,
        session.status,
        session.outcome ?? null,
        session.tabId ?? null,
        session.startedAt,
        session.endedAt ?? null,
        session.startFingerprintId ?? null,
        session.endFingerprintId ?? null,
        JSON.stringify(session.labels),
        session.eventCount
      );
    return session;
  }

  updateCaptureSession(session: CaptureSession): CaptureSession {
    const result = this.db
      .prepare(
        `UPDATE capture_sessions SET
          goal = ?, status = ?, outcome = ?, tab_id = ?, ended_at = ?, start_fingerprint_id = ?, end_fingerprint_id = ?, labels_json = ?, event_count = ?
        WHERE id = ?`
      )
      .run(
        session.goal,
        session.status,
        session.outcome ?? null,
        session.tabId ?? null,
        session.endedAt ?? null,
        session.startFingerprintId ?? null,
        session.endFingerprintId ?? null,
        JSON.stringify(session.labels),
        session.eventCount,
        session.id
      );
    if (result.changes === 0) {
      throw new Error(`Capture session not found: ${session.id}`);
    }
    return session;
  }

  getCaptureSession(idValue: string): CaptureSession | null {
    const row = this.db.prepare('SELECT * FROM capture_sessions WHERE id = ?').get(idValue) as CaptureSessionRow | undefined;
    return row ? this.toCaptureSession(row) : null;
  }

  listCaptureSessions(limit = 50): CaptureSession[] {
    const rows = this.db
      .prepare('SELECT * FROM capture_sessions ORDER BY started_at DESC LIMIT ?')
      .all(limit) as unknown as CaptureSessionRow[];
    return rows.map((row) => this.toCaptureSession(row));
  }

  createCaptureEvent(input: Omit<CaptureEvent, 'id' | 'at'>): CaptureEvent {
    const event: CaptureEvent = {
      ...input,
      id: id('capture_event'),
      at: nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO capture_events (
          id, capture_session_id, at, kind, label, note, role, step_json, page_fingerprint_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.captureSessionId,
        event.at,
        event.kind,
        event.label ?? null,
        event.note ?? null,
        event.role ?? null,
        event.step ? JSON.stringify(event.step) : null,
        event.pageFingerprintId ?? null
      );
    this.db.prepare('UPDATE capture_sessions SET event_count = event_count + 1 WHERE id = ?').run(event.captureSessionId);
    return event;
  }

  listCaptureEvents(captureSessionId: string): CaptureEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM capture_events WHERE capture_session_id = ? ORDER BY at ASC')
      .all(captureSessionId) as unknown as CaptureEventRow[];
    return rows.map((row) => this.toCaptureEvent(row));
  }

  createDraftMemory(input: Omit<DraftMemory, 'id' | 'createdAt' | 'status'>): DraftMemory {
    const draft: DraftMemory = {
      ...input,
      id: id('draft'),
      status: 'draft',
      createdAt: nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO drafts (
          id, capture_session_id, kind, status, title, goal, description, steps_json, parameter_schema_json, tags_json,
          rationale_json, risk_notes_json, entry_fingerprint_id, target_fingerprint_id, source_event_ids_json, created_at,
          discarded_at, promoted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        draft.id,
        draft.captureSessionId,
        draft.kind,
        draft.status,
        draft.title,
        draft.goal,
        draft.description,
        JSON.stringify(draft.steps),
        JSON.stringify(draft.parameterSchema),
        JSON.stringify(draft.tags),
        JSON.stringify(draft.rationale),
        JSON.stringify(draft.riskNotes),
        draft.entryFingerprintId ?? null,
        draft.targetFingerprintId ?? null,
        JSON.stringify(draft.sourceEventIds),
        draft.createdAt,
        draft.discardedAt ?? null,
        draft.promotedAt ?? null
      );
    return draft;
  }

  updateDraftMemory(draft: DraftMemory): DraftMemory {
    const result = this.db
      .prepare(
        `UPDATE drafts SET
          kind = ?, status = ?, title = ?, goal = ?, description = ?, steps_json = ?, parameter_schema_json = ?, tags_json = ?,
          rationale_json = ?, risk_notes_json = ?, entry_fingerprint_id = ?, target_fingerprint_id = ?, source_event_ids_json = ?,
          discarded_at = ?, promoted_at = ?
        WHERE id = ?`
      )
      .run(
        draft.kind,
        draft.status,
        draft.title,
        draft.goal,
        draft.description,
        JSON.stringify(draft.steps),
        JSON.stringify(draft.parameterSchema),
        JSON.stringify(draft.tags),
        JSON.stringify(draft.rationale),
        JSON.stringify(draft.riskNotes),
        draft.entryFingerprintId ?? null,
        draft.targetFingerprintId ?? null,
        JSON.stringify(draft.sourceEventIds),
        draft.discardedAt ?? null,
        draft.promotedAt ?? null,
        draft.id
      );
    if (result.changes === 0) {
      throw new Error(`Draft not found: ${draft.id}`);
    }
    return draft;
  }

  getDraftMemory(idValue: string): DraftMemory | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(idValue) as DraftRow | undefined;
    return row ? this.toDraft(row) : null;
  }

  listDraftMemories(filters?: { captureSessionId?: string; kind?: DraftMemory['kind']; status?: DraftMemory['status']; limit?: number }): DraftMemory[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filters?.captureSessionId) {
      where.push('capture_session_id = ?');
      args.push(filters.captureSessionId);
    }
    if (filters?.kind) {
      where.push('kind = ?');
      args.push(filters.kind);
    }
    if (filters?.status) {
      where.push('status = ?');
      args.push(filters.status);
    }
    const limit = Math.max(1, filters?.limit ?? 50);
    const query = `SELECT * FROM drafts ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(query).all(...args, limit) as unknown as DraftRow[];
    return rows.map((row) => this.toDraft(row));
  }

  createMemory(input: Omit<DurableMemory, 'id' | 'createdAt' | 'updatedAt' | 'latestRevisionId' | 'status'>): DurableMemory {
    const timestamp = nowIso();
    const memory: DurableMemory = {
      ...input,
      id: id('memory'),
      status: 'active',
      latestRevisionId: '',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db
      .prepare(
        `INSERT INTO memories (
          id, kind, status, title, goal, description, tags_json, latest_revision_id, created_at, updated_at, deprecated_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memory.id,
        memory.kind,
        memory.status,
        memory.title,
        memory.goal,
        memory.description,
        JSON.stringify(memory.tags),
        memory.latestRevisionId,
        memory.createdAt,
        memory.updatedAt,
        memory.deprecatedReason ?? null
      );
    return memory;
  }

  updateMemory(memory: DurableMemory): DurableMemory {
    const updated: DurableMemory = {
      ...memory,
      updatedAt: nowIso()
    };
    const result = this.db
      .prepare(
        `UPDATE memories SET
          kind = ?, status = ?, title = ?, goal = ?, description = ?, tags_json = ?, latest_revision_id = ?, updated_at = ?, deprecated_reason = ?
        WHERE id = ?`
      )
      .run(
        updated.kind,
        updated.status,
        updated.title,
        updated.goal,
        updated.description,
        JSON.stringify(updated.tags),
        updated.latestRevisionId,
        updated.updatedAt,
        updated.deprecatedReason ?? null,
        updated.id
      );
    if (result.changes === 0) {
      throw new Error(`Memory not found: ${updated.id}`);
    }
    return updated;
  }

  getMemory(idValue: string): DurableMemory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(idValue) as MemoryRow | undefined;
    return row ? this.toMemory(row) : null;
  }

  listMemories(filters?: { kind?: DurableMemory['kind']; status?: DurableMemory['status']; limit?: number }): DurableMemory[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filters?.kind) {
      where.push('kind = ?');
      args.push(filters.kind);
    }
    if (filters?.status) {
      where.push('status = ?');
      args.push(filters.status);
    }
    const limit = Math.max(1, filters?.limit ?? 100);
    const query = `SELECT * FROM memories ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
    const rows = this.db.prepare(query).all(...args, limit) as unknown as MemoryRow[];
    return rows.map((row) => this.toMemory(row));
  }

  deleteMemory(idValue: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(idValue);
    return result.changes > 0;
  }

  createRevision(
    input: Omit<MemoryRevision, 'id' | 'createdAt' | 'revision'> & {
      revision?: number;
    }
  ): MemoryRevision {
    const nextRevision =
      input.revision ??
      ((this.db.prepare('SELECT MAX(revision) AS value FROM revisions WHERE memory_id = ?').get(input.memoryId) as { value: number | null })
        .value ?? 0) + 1;
    const revision: MemoryRevision = {
      ...input,
      id: id('revision'),
      revision: nextRevision,
      createdAt: nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO revisions (
          id, memory_id, revision, kind, title, goal, description, steps_json, parameter_schema_json, entry_fingerprint_id,
          target_fingerprint_id, tags_json, rationale_json, risk_notes_json, change_summary_json, created_at,
          created_from_draft_id, supersedes_revision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        revision.id,
        revision.memoryId,
        revision.revision,
        revision.kind,
        revision.title,
        revision.goal,
        revision.description,
        JSON.stringify(revision.steps),
        JSON.stringify(revision.parameterSchema),
        revision.entryFingerprintId ?? null,
        revision.targetFingerprintId ?? null,
        JSON.stringify(revision.tags),
        JSON.stringify(revision.rationale),
        JSON.stringify(revision.riskNotes),
        JSON.stringify(revision.changeSummary),
        revision.createdAt,
        revision.createdFromDraftId ?? null,
        revision.supersedesRevisionId ?? null
      );
    this.db
      .prepare('UPDATE memories SET latest_revision_id = ?, updated_at = ? WHERE id = ?')
      .run(revision.id, revision.createdAt, revision.memoryId);
    return revision;
  }

  getRevision(idValue: string): MemoryRevision | null {
    const row = this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(idValue) as RevisionRow | undefined;
    return row ? this.toRevision(row) : null;
  }

  listRevisions(memoryId: string): MemoryRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM revisions WHERE memory_id = ? ORDER BY revision DESC')
      .all(memoryId) as unknown as RevisionRow[];
    return rows.map((row) => this.toRevision(row));
  }

  createPlan(input: Omit<MemoryPlan, 'id' | 'createdAt'>): MemoryPlan {
    const plan: MemoryPlan = {
      ...input,
      id: id('plan'),
      createdAt: nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO plans (
          id, kind, mode, status, route_revision_id, procedure_revision_id, revision_ids_json, parameters_json, entry_fingerprint_id,
          target_fingerprint_id, applicability_status, applicability_summary, checks_json, steps_json, created_at, last_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        plan.id,
        plan.kind,
        plan.mode,
        plan.status,
        plan.routeRevisionId ?? null,
        plan.procedureRevisionId ?? null,
        JSON.stringify(plan.revisionIds),
        JSON.stringify(plan.parameters),
        plan.entryFingerprintId ?? null,
        plan.targetFingerprintId ?? null,
        plan.applicabilityStatus,
        plan.applicabilitySummary,
        JSON.stringify(plan.checks),
        JSON.stringify(plan.steps),
        plan.createdAt,
        plan.lastRunId ?? null
      );
    return plan;
  }

  updatePlan(plan: MemoryPlan): MemoryPlan {
    const result = this.db
      .prepare(
        `UPDATE plans SET
          kind = ?, mode = ?, status = ?, route_revision_id = ?, procedure_revision_id = ?, revision_ids_json = ?, parameters_json = ?,
          entry_fingerprint_id = ?, target_fingerprint_id = ?, applicability_status = ?, applicability_summary = ?, checks_json = ?,
          steps_json = ?, last_run_id = ?
        WHERE id = ?`
      )
      .run(
        plan.kind,
        plan.mode,
        plan.status,
        plan.routeRevisionId ?? null,
        plan.procedureRevisionId ?? null,
        JSON.stringify(plan.revisionIds),
        JSON.stringify(plan.parameters),
        plan.entryFingerprintId ?? null,
        plan.targetFingerprintId ?? null,
        plan.applicabilityStatus,
        plan.applicabilitySummary,
        JSON.stringify(plan.checks),
        JSON.stringify(plan.steps),
        plan.lastRunId ?? null,
        plan.id
      );
    if (result.changes === 0) {
      throw new Error(`Plan not found: ${plan.id}`);
    }
    return plan;
  }

  getPlan(idValue: string): MemoryPlan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(idValue) as PlanRow | undefined;
    return row ? this.toPlan(row) : null;
  }

  createRun(input: Omit<MemoryRun, 'id' | 'startedAt'>): MemoryRun {
    const run: MemoryRun = {
      ...input,
      id: id('run'),
      startedAt: nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO runs (
          id, plan_id, mode, status, revision_ids_json, started_at, ended_at, patch_suggestion_ids_json, result_summary, steps_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.planId,
        run.mode,
        run.status,
        JSON.stringify(run.revisionIds),
        run.startedAt,
        run.endedAt ?? null,
        JSON.stringify(run.patchSuggestionIds),
        run.resultSummary,
        JSON.stringify(run.steps)
      );
    return run;
  }

  updateRun(run: MemoryRun): MemoryRun {
    const result = this.db
      .prepare(
        `UPDATE runs SET
          plan_id = ?, mode = ?, status = ?, revision_ids_json = ?, ended_at = ?, patch_suggestion_ids_json = ?, result_summary = ?, steps_json = ?
        WHERE id = ?`
      )
      .run(
        run.planId,
        run.mode,
        run.status,
        JSON.stringify(run.revisionIds),
        run.endedAt ?? null,
        JSON.stringify(run.patchSuggestionIds),
        run.resultSummary,
        JSON.stringify(run.steps),
        run.id
      );
    if (result.changes === 0) {
      throw new Error(`Run not found: ${run.id}`);
    }
    return run;
  }

  getRun(idValue: string): MemoryRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(idValue) as RunRow | undefined;
    return row ? this.toRun(row) : null;
  }

  listRuns(filters?: { memoryId?: string; planId?: string; status?: MemoryRun['status']; limit?: number }): MemoryRun[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filters?.planId) {
      where.push('plan_id = ?');
      args.push(filters.planId);
    }
    if (filters?.status) {
      where.push('status = ?');
      args.push(filters.status);
    }
    const limit = Math.max(1, filters?.limit ?? 100);
    const query = `SELECT * FROM runs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
    const rows = this.db.prepare(query).all(...args, limit) as unknown as RunRow[];
    const runs = rows.map((row) => this.toRun(row));
    if (!filters?.memoryId) {
      return runs;
    }

    return runs.filter((run) =>
      run.revisionIds.some((revisionId) => {
        const revision = this.getRevision(revisionId);
        return revision?.memoryId === filters.memoryId;
      })
    );
  }

  createPatchSuggestion(input: Omit<PatchSuggestion, 'id' | 'createdAt' | 'status'>): PatchSuggestion {
    const patch: PatchSuggestion = {
      ...input,
      id: id('patch'),
      status: 'open',
      createdAt: nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO patches (
          id, memory_id, base_revision_id, status, title, summary, reason, affected_step_indexes_json, change_summary_json,
          proposed_revision_json, created_at, resolved_at, resolution_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        patch.id,
        patch.memoryId,
        patch.baseRevisionId,
        patch.status,
        patch.title,
        patch.summary,
        patch.reason,
        JSON.stringify(patch.affectedStepIndexes),
        JSON.stringify(patch.changeSummary),
        JSON.stringify(patch.proposedRevision),
        patch.createdAt,
        patch.resolvedAt ?? null,
        patch.resolutionNote ?? null
      );
    return patch;
  }

  updatePatchSuggestion(patch: PatchSuggestion): PatchSuggestion {
    const result = this.db
      .prepare(
        `UPDATE patches SET
          status = ?, title = ?, summary = ?, reason = ?, affected_step_indexes_json = ?, change_summary_json = ?,
          proposed_revision_json = ?, resolved_at = ?, resolution_note = ?
        WHERE id = ?`
      )
      .run(
        patch.status,
        patch.title,
        patch.summary,
        patch.reason,
        JSON.stringify(patch.affectedStepIndexes),
        JSON.stringify(patch.changeSummary),
        JSON.stringify(patch.proposedRevision),
        patch.resolvedAt ?? null,
        patch.resolutionNote ?? null,
        patch.id
      );
    if (result.changes === 0) {
      throw new Error(`Patch not found: ${patch.id}`);
    }
    return patch;
  }

  getPatchSuggestion(idValue: string): PatchSuggestion | null {
    const row = this.db.prepare('SELECT * FROM patches WHERE id = ?').get(idValue) as PatchRow | undefined;
    return row ? this.toPatch(row) : null;
  }

  listPatchSuggestions(filters?: { memoryId?: string; status?: PatchSuggestion['status']; limit?: number }): PatchSuggestion[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filters?.memoryId) {
      where.push('memory_id = ?');
      args.push(filters.memoryId);
    }
    if (filters?.status) {
      where.push('status = ?');
      args.push(filters.status);
    }
    const limit = Math.max(1, filters?.limit ?? 100);
    const query = `SELECT * FROM patches ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(query).all(...args, limit) as unknown as PatchRow[];
    return rows.map((row) => this.toPatch(row));
  }

  exportSnapshot(): MemoryStoreSnapshot {
    const pageFingerprintsRows = this.db.prepare('SELECT * FROM page_fingerprints ORDER BY id ASC').all() as unknown as FingerprintRow[];
    const captureSessionRows = this.db.prepare('SELECT * FROM capture_sessions ORDER BY started_at DESC').all() as unknown as CaptureSessionRow[];
    const captureEventRows = this.db.prepare('SELECT * FROM capture_events ORDER BY at ASC').all() as unknown as CaptureEventRow[];
    const draftRows = this.db.prepare('SELECT * FROM drafts ORDER BY created_at DESC').all() as unknown as DraftRow[];
    const memoryRows = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as unknown as MemoryRow[];
    const revisionRows = this.db.prepare('SELECT * FROM revisions ORDER BY created_at DESC').all() as unknown as RevisionRow[];
    const planRows = this.db.prepare('SELECT * FROM plans ORDER BY created_at DESC').all() as unknown as PlanRow[];
    const runRows = this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all() as unknown as RunRow[];
    const patchRows = this.db.prepare('SELECT * FROM patches ORDER BY created_at DESC').all() as unknown as PatchRow[];

    return {
      captureSessions: captureSessionRows.map((row) => this.toCaptureSession(row)),
      captureEvents: captureEventRows.map((row) => this.toCaptureEvent(row)),
      pageFingerprints: pageFingerprintsRows.map((row) => parseJson<PageFingerprint>(row.payload_json, null as never)),
      drafts: draftRows.map((row) => this.toDraft(row)),
      memories: memoryRows.map((row) => this.toMemory(row)),
      revisions: revisionRows.map((row) => this.toRevision(row)),
      plans: planRows.map((row) => this.toPlan(row)),
      runs: runRows.map((row) => this.toRun(row)),
      patches: patchRows.map((row) => this.toPatch(row))
    };
  }

  close(): void {
    this.db.close();
  }
}
