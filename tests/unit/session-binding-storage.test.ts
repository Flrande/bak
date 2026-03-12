import { describe, expect, it } from 'vitest';
import {
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
  it('reads current sessionBindings state', () => {
    const stateMap = resolveSessionBindingStateMap({
      [STORAGE_KEY_SESSION_BINDINGS]: {
        'session-a': bindingRecord
      }
    });

    expect(Object.keys(stateMap)).toEqual(['session-a']);
    expect(stateMap['session-a']).toEqual(bindingRecord);
  });

  it('returns an empty map when the current key is missing', () => {
    const stateMap = resolveSessionBindingStateMap({
      otherKey: bindingRecord
    });

    expect(stateMap).toEqual({});
  });

  it('returns an empty map when the current key is present but empty', () => {
    const stateMap = resolveSessionBindingStateMap({
      [STORAGE_KEY_SESSION_BINDINGS]: {}
    });

    expect(stateMap).toEqual({});
  });
});
