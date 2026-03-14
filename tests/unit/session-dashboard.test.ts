import { describe, expect, it } from 'vitest';
import {
  buildSessionDashboard,
  buildSessionDashboardEntry,
  trimRuntimeInfo
} from '../../packages/cli/src/session-dashboard.js';

describe('session dashboard helpers', () => {
  it('marks a session as attached when it still owns live tabs', () => {
    const entry = buildSessionDashboardEntry({
      summary: {
        sessionId: 'session_1',
        clientName: 'agent-a',
        activeTab: null
      } as never,
      info: {
        session: {
          sessionId: 'session_1',
          clientName: 'agent-a'
        },
        activeTab: null,
        currentContext: {
          tabId: 21,
          framePath: ['#frame-a'],
          shadowPath: ['#shadow-host']
        }
      } as never,
      tabsListing: {
        browser: {
          windowId: 7,
          groupId: 12,
          tabIds: [21],
          activeTabId: 21,
          primaryTabId: 21
        },
        tabs: [
          {
            id: 21,
            title: 'Orders',
            url: 'https://example.com/orders',
            active: true,
            windowId: 7,
            groupId: 12
          }
        ]
      }
    });

    expect(entry.attached).toBe(true);
    expect(entry.detached).toBe(false);
    expect(entry.activeTab?.id).toBe(21);
    expect(entry.tabs).toHaveLength(1);
    expect(entry.frameDepth).toBe(1);
    expect(entry.shadowDepth).toBe(1);
  });

  it('returns a stable detached entry when tab ownership is unavailable', () => {
    const entry = buildSessionDashboardEntry({
      summary: {
        sessionId: 'session_2',
        clientName: 'agent-b',
        activeTab: {
          id: 99,
          title: 'Recovered tab',
          url: 'https://example.com/recovered',
          active: true,
          windowId: 4,
          groupId: null
        }
      } as never,
      info: {
        session: {
          sessionId: 'session_2',
          clientName: 'agent-b'
        },
        activeTab: null,
        currentContext: {
          tabId: null,
          framePath: [],
          shadowPath: []
        }
      } as never,
      tabsListing: null
    });

    expect(entry.attached).toBe(false);
    expect(entry.detached).toBe(true);
    expect(entry.activeTab?.id).toBe(99);
    expect(entry.tabs).toEqual([]);
    expect(entry.frameDepth).toBe(0);
    expect(entry.shadowDepth).toBe(0);
  });

  it('trims runtime info and preserves the dashboard shape', () => {
    const runtime = trimRuntimeInfo({
      paired: true,
      extensionConnected: false,
      connectionState: 'disconnected',
      connectionReason: 'socket-closed',
      runtimeVersion: '0.6.11',
      extensionVersion: '0.6.11',
      heartbeatStale: false,
      heartbeatAgeMs: null,
      managedRuntime: true,
      idleStopArmed: false,
      activeSessionCount: 1
    } as never);

    const dashboard = buildSessionDashboard(
      {
        ...runtime,
        protocolVersion: 'v1',
        compatibleProtocolVersions: ['v1'],
        staleAfterMs: 30_000,
        bridgeLastError: null
      } as never,
      [
        {
          summary: {
            sessionId: 'session_3',
            clientName: 'agent-c',
            activeTab: null
          } as never,
          info: {
            session: {
              sessionId: 'session_3',
              clientName: 'agent-c'
            },
            activeTab: null,
            currentContext: {
              tabId: null,
              framePath: [],
              shadowPath: []
            }
          } as never,
          tabsListing: null
        }
      ]
    );

    expect(runtime).toEqual({
      paired: true,
      extensionConnected: false,
      connectionState: 'disconnected',
      connectionReason: 'socket-closed',
      runtimeVersion: '0.6.11',
      extensionVersion: '0.6.11',
      heartbeatStale: false,
      heartbeatAgeMs: null,
      managedRuntime: true,
      idleStopArmed: false,
      activeSessionCount: 1
    });
    expect(dashboard.runtime).toEqual(runtime);
    expect(dashboard.sessions).toHaveLength(1);
    expect(dashboard.sessions[0]).toMatchObject({
      attached: false,
      detached: true,
      frameDepth: 0,
      shadowDepth: 0
    });
  });
});
