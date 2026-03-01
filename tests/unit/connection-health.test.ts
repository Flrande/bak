import { describe, expect, it } from 'vitest';
import { evaluateConnectionHealth } from '../../packages/cli/src/connection-health.js';

describe('connection health', () => {
  it('keeps connected state when heartbeat is fresh', () => {
    const now = 10_000;
    const health = evaluateConnectionHealth(
      {
        state: 'connected',
        reason: null,
        extensionVersion: '0.1.0',
        lastSeenTs: 9_900,
        lastRequestTs: 9_800,
        lastResponseTs: 9_850,
        lastHeartbeatTs: 9_700,
        lastError: null,
        connectedAtTs: 9_000,
        disconnectedAtTs: null,
        pendingRequests: 0
      },
      now,
      1_000
    );

    expect(health.extensionConnected).toBe(true);
    expect(health.connectionState).toBe('connected');
    expect(health.heartbeatStale).toBe(false);
    expect(health.heartbeatAgeMs).toBe(300);
  });

  it('downgrades to disconnected when heartbeat is stale', () => {
    const now = 20_000;
    const health = evaluateConnectionHealth(
      {
        state: 'connected',
        reason: null,
        extensionVersion: '0.1.0',
        lastSeenTs: 12_000,
        lastRequestTs: 12_000,
        lastResponseTs: 12_000,
        lastHeartbeatTs: 10_000,
        lastError: null,
        connectedAtTs: 9_000,
        disconnectedAtTs: null,
        pendingRequests: 2
      },
      now,
      5_000
    );

    expect(health.extensionConnected).toBe(false);
    expect(health.connectionState).toBe('disconnected');
    expect(health.connectionReason).toBe('heartbeat-timeout');
    expect(health.heartbeatStale).toBe(true);
    expect(health.heartbeatAgeMs).toBe(10_000);
  });

  it('propagates non-connected state without stale transform', () => {
    const health = evaluateConnectionHealth(
      {
        state: 'connecting',
        reason: 'listening',
        extensionVersion: null,
        lastSeenTs: null,
        lastRequestTs: null,
        lastResponseTs: null,
        lastHeartbeatTs: null,
        lastError: null,
        connectedAtTs: null,
        disconnectedAtTs: 5_000,
        pendingRequests: 0
      },
      7_000,
      5_000
    );

    expect(health.extensionConnected).toBe(false);
    expect(health.connectionState).toBe('connecting');
    expect(health.connectionReason).toBe('listening');
    expect(health.heartbeatStale).toBe(false);
    expect(health.heartbeatAgeMs).toBeNull();
  });
});
