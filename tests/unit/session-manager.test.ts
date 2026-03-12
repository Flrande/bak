import { describe, expect, it } from 'vitest';
import { SessionManager, type SessionState } from '../../packages/cli/src/session-manager.js';

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: overrides.sessionId ?? 'session-a',
    bindingId: overrides.bindingId ?? 'binding-a',
    bindingInitialized: overrides.bindingInitialized ?? false,
    clientName: overrides.clientName,
    createdAt: overrides.createdAt ?? '2026-03-11T00:00:00.000Z',
    lastSeenAt: overrides.lastSeenAt ?? '2026-03-11T00:00:00.000Z',
    activeTabId: overrides.activeTabId ?? null,
    traceId: overrides.traceId ?? 'trace-a',
    contextsByTab:
      overrides.contextsByTab ??
      new Map([
        [
          101,
          {
            framePath: ['#frame-a'],
            shadowPath: ['#shadow-a']
          }
        ]
      ])
  };
}

describe('session manager', () => {
  it('maintains independent active tabs and contexts across sessions', () => {
    const manager = new SessionManager();
    manager.create(makeSession({ sessionId: 'session-a', bindingId: 'binding-a', activeTabId: 101, traceId: 'trace-a' }));
    manager.create(
      makeSession({
        sessionId: 'session-b',
        bindingId: 'binding-b',
        activeTabId: 202,
        traceId: 'trace-b',
        contextsByTab: new Map([
          [
            202,
            {
              framePath: ['#frame-b'],
              shadowPath: ['#shadow-b']
            }
          ]
        ])
      })
    );

    const first = manager.getContext('session-a');
    const second = manager.getContext('session-b');

    expect(first).toEqual({
      tabId: 101,
      framePath: ['#frame-a'],
      shadowPath: ['#shadow-a']
    });
    expect(second).toEqual({
      tabId: 202,
      framePath: ['#frame-b'],
      shadowPath: ['#shadow-b']
    });

    manager.setContext('session-a', {
      tabId: 101,
      framePath: ['#frame-a', '#child-frame'],
      shadowPath: ['#shadow-a']
    });

    expect(manager.getContext('session-a')).toEqual({
      tabId: 101,
      framePath: ['#frame-a', '#child-frame'],
      shadowPath: ['#shadow-a']
    });
    expect(manager.getContext('session-b')).toEqual(second);
  });

  it('syncs binding tab ownership without leaking stale tab contexts', () => {
    const manager = new SessionManager();
    manager.create(
      makeSession({
        activeTabId: 101,
        contextsByTab: new Map([
          [101, { framePath: ['#frame-a'], shadowPath: [] }],
          [102, { framePath: ['#frame-b'], shadowPath: ['#shadow-b'] }]
        ])
      })
    );

    const updated = manager.syncBinding('session-a', {
      id: 'binding-a',
      tabIds: [102, 103],
      activeTabId: 103
    });

    expect(updated.activeTabId).toBe(103);
    expect(updated.contextsByTab.has(101)).toBe(false);
    expect(updated.contextsByTab.get(102)).toEqual({
      framePath: ['#frame-b'],
      shadowPath: ['#shadow-b']
    });
    expect(updated.contextsByTab.get(103)).toEqual({
      framePath: [],
      shadowPath: []
    });
  });

  it('keeps the existing session current tab when binding metadata reports a different browser-active tab', () => {
    const manager = new SessionManager();
    manager.create(
      makeSession({
        activeTabId: 102,
        contextsByTab: new Map([
          [101, { framePath: ['#frame-a'], shadowPath: [] }],
          [102, { framePath: ['#frame-b'], shadowPath: ['#shadow-b'] }]
        ])
      })
    );

    const updated = manager.syncBinding('session-a', {
      id: 'binding-a',
      tabIds: [101, 102, 103],
      activeTabId: 103
    });

    expect(updated.activeTabId).toBe(102);
    expect(updated.contextsByTab.get(102)).toEqual({
      framePath: ['#frame-b'],
      shadowPath: ['#shadow-b']
    });
  });

  it('stores context snapshots without requiring a public binding identifier', () => {
    const manager = new SessionManager();
    manager.create(makeSession({ activeTabId: 101 }));

    manager.setContext('session-a', {
      tabId: 101,
      framePath: [],
      shadowPath: []
    });

    expect(manager.getContext('session-a')).toEqual({
      tabId: 101,
      framePath: [],
      shadowPath: []
    });
  });

  it('clears active tab and saved contexts when the binding disappears', () => {
    const manager = new SessionManager();
    manager.create(makeSession({ bindingInitialized: true, activeTabId: 101 }));

    const cleared = manager.clearBinding('session-a');

    expect(cleared.bindingInitialized).toBe(false);
    expect(cleared.activeTabId).toBeNull();
    expect(cleared.contextsByTab.size).toBe(0);
    expect(manager.getContext('session-a')).toEqual({
      tabId: null,
      framePath: [],
      shadowPath: []
    });
  });
});
