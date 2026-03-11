import { describe, expect, it } from 'vitest';
import {
  LEGACY_STORAGE_KEY_WORKSPACE,
  LEGACY_STORAGE_KEY_WORKSPACES,
  resolveSessionBindingStateMap,
  STORAGE_KEY_SESSION_BINDINGS
} from '../../packages/extension/src/session-binding-storage.js';

const bindingRecord = {
  id: 'session-a',
  label: 'bak agent',
  color: 'blue' as const,
  windowId: 101,
  groupId: 202,
  tabIds: [303],
  activeTabId: 303,
  primaryTabId: 303
};

describe('session binding storage', () => {
  it('prefers current sessionBindings state', () => {
    const stateMap = resolveSessionBindingStateMap({
      [STORAGE_KEY_SESSION_BINDINGS]: {
        'session-a': bindingRecord
      },
      [LEGACY_STORAGE_KEY_WORKSPACES]: {
        'session-b': {
          ...bindingRecord,
          id: 'session-b'
        }
      }
    });

    expect(Object.keys(stateMap)).toEqual(['session-a']);
    expect(stateMap['session-a']).toEqual(bindingRecord);
  });

  it('migrates the legacy single-record agentWorkspace key', () => {
    const stateMap = resolveSessionBindingStateMap({
      [LEGACY_STORAGE_KEY_WORKSPACE]: bindingRecord
    });

    expect(stateMap).toEqual({
      'session-a': bindingRecord
    });
  });

  it('does not fall back to legacy state when the current key is present but empty', () => {
    const stateMap = resolveSessionBindingStateMap({
      [STORAGE_KEY_SESSION_BINDINGS]: {},
      [LEGACY_STORAGE_KEY_WORKSPACE]: bindingRecord
    });

    expect(stateMap).toEqual({});
  });
});
