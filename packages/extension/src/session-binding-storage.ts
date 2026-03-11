import type { WorkspaceRecord } from './workspace.js';

export const STORAGE_KEY_SESSION_BINDINGS = 'sessionBindings';
export const LEGACY_STORAGE_KEY_WORKSPACES = 'agentWorkspaces';
export const LEGACY_STORAGE_KEY_WORKSPACE = 'agentWorkspace';

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.tabIds) &&
    (typeof candidate.windowId === 'number' || candidate.windowId === null) &&
    (typeof candidate.groupId === 'number' || candidate.groupId === null) &&
    (typeof candidate.activeTabId === 'number' || candidate.activeTabId === null) &&
    (typeof candidate.primaryTabId === 'number' || candidate.primaryTabId === null)
  );
}

function cloneWorkspaceRecord(state: WorkspaceRecord): WorkspaceRecord {
  return {
    ...state,
    tabIds: [...state.tabIds]
  };
}

function normalizeWorkspaceRecordMap(value: unknown): { found: boolean; map: Record<string, WorkspaceRecord> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      found: false,
      map: {}
    };
  }
  const normalizedEntries: Array<readonly [string, WorkspaceRecord]> = [];
  for (const [workspaceId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isWorkspaceRecord(entry)) {
      continue;
    }
    normalizedEntries.push([workspaceId, cloneWorkspaceRecord(entry)] as const);
  }
  return {
    found: true,
    map: Object.fromEntries(normalizedEntries)
  };
}

export function resolveSessionBindingStateMap(stored: Record<string, unknown>): Record<string, WorkspaceRecord> {
  const current = normalizeWorkspaceRecordMap(stored[STORAGE_KEY_SESSION_BINDINGS]);
  if (current.found) {
    return current.map;
  }

  const legacyMap = normalizeWorkspaceRecordMap(stored[LEGACY_STORAGE_KEY_WORKSPACES]);
  if (legacyMap.found) {
    return legacyMap.map;
  }

  const legacySingle = stored[LEGACY_STORAGE_KEY_WORKSPACE];
  if (isWorkspaceRecord(legacySingle)) {
    return {
      [legacySingle.id]: cloneWorkspaceRecord(legacySingle)
    };
  }

  return {};
}
