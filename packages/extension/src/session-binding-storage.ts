import type { SessionBindingRecord } from './session-binding.js';

export const STORAGE_KEY_SESSION_BINDINGS = 'sessionBindings';

function isSessionBindingRecord(value: unknown): value is SessionBindingRecord {
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

function cloneSessionBindingRecord(state: SessionBindingRecord): SessionBindingRecord {
  return {
    ...state,
    tabIds: [...state.tabIds]
  };
}

function normalizeSessionBindingRecordMap(value: unknown): { found: boolean; map: Record<string, SessionBindingRecord> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      found: false,
      map: {}
    };
  }
  const normalizedEntries: Array<readonly [string, SessionBindingRecord]> = [];
  for (const [bindingId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isSessionBindingRecord(entry)) {
      continue;
    }
    normalizedEntries.push([bindingId, cloneSessionBindingRecord(entry)] as const);
  }
  return {
    found: true,
    map: Object.fromEntries(normalizedEntries)
  };
}

export function resolveSessionBindingStateMap(stored: Record<string, unknown>): Record<string, SessionBindingRecord> {
  const current = normalizeSessionBindingRecordMap(stored[STORAGE_KEY_SESSION_BINDINGS]);
  return current.found ? current.map : {};
}
