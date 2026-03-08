import type {
  CaptureEvent,
  CaptureSession,
  DraftMemory,
  DraftStatus,
  DurableMemory,
  MemoryKind,
  MemoryPlan,
  MemoryRevision,
  MemoryRun,
  MemoryRunStatus,
  MemoryStatus,
  PageFingerprint,
  PatchSuggestion,
  PatchSuggestionStatus
} from '@flrande/bak-protocol';

export interface MemoryStoreSnapshot {
  captureSessions: CaptureSession[];
  captureEvents: CaptureEvent[];
  pageFingerprints: PageFingerprint[];
  drafts: DraftMemory[];
  memories: DurableMemory[];
  revisions: MemoryRevision[];
  plans: MemoryPlan[];
  runs: MemoryRun[];
  patches: PatchSuggestion[];
}

export interface MemoryStoreBackend {
  createPageFingerprint(input: Omit<PageFingerprint, 'id'>): PageFingerprint;
  getPageFingerprint(idValue: string): PageFingerprint | null;

  createCaptureSession(input: Omit<CaptureSession, 'id' | 'startedAt' | 'status' | 'eventCount'>): CaptureSession;
  updateCaptureSession(session: CaptureSession): CaptureSession;
  getCaptureSession(idValue: string): CaptureSession | null;
  listCaptureSessions(limit?: number): CaptureSession[];

  createCaptureEvent(input: Omit<CaptureEvent, 'id' | 'at'>): CaptureEvent;
  listCaptureEvents(captureSessionId: string): CaptureEvent[];

  createDraftMemory(input: Omit<DraftMemory, 'id' | 'createdAt' | 'status'>): DraftMemory;
  updateDraftMemory(draft: DraftMemory): DraftMemory;
  getDraftMemory(idValue: string): DraftMemory | null;
  listDraftMemories(filters?: { captureSessionId?: string; kind?: MemoryKind; status?: DraftStatus; limit?: number }): DraftMemory[];

  createMemory(input: Omit<DurableMemory, 'id' | 'createdAt' | 'updatedAt' | 'latestRevisionId' | 'status'>): DurableMemory;
  updateMemory(memory: DurableMemory): DurableMemory;
  getMemory(idValue: string): DurableMemory | null;
  listMemories(filters?: { kind?: MemoryKind; status?: MemoryStatus; limit?: number }): DurableMemory[];
  deleteMemory(idValue: string): boolean;

  createRevision(
    input: Omit<MemoryRevision, 'id' | 'createdAt' | 'revision'> & {
      revision?: number;
    }
  ): MemoryRevision;
  getRevision(idValue: string): MemoryRevision | null;
  listRevisions(memoryId: string): MemoryRevision[];

  createPlan(input: Omit<MemoryPlan, 'id' | 'createdAt'>): MemoryPlan;
  updatePlan(plan: MemoryPlan): MemoryPlan;
  getPlan(idValue: string): MemoryPlan | null;

  createRun(input: Omit<MemoryRun, 'id' | 'startedAt'>): MemoryRun;
  updateRun(run: MemoryRun): MemoryRun;
  getRun(idValue: string): MemoryRun | null;
  listRuns(filters?: { memoryId?: string; planId?: string; status?: MemoryRunStatus; limit?: number }): MemoryRun[];

  createPatchSuggestion(input: Omit<PatchSuggestion, 'id' | 'createdAt' | 'status'>): PatchSuggestion;
  updatePatchSuggestion(patch: PatchSuggestion): PatchSuggestion;
  getPatchSuggestion(idValue: string): PatchSuggestion | null;
  listPatchSuggestions(filters?: { memoryId?: string; status?: PatchSuggestionStatus; limit?: number }): PatchSuggestion[];

  exportSnapshot(): MemoryStoreSnapshot;
  close?(): void;
}
