import { describe, expect, it } from 'vitest';
import { assessSessionInfoHealth, assessVersionCompatibility } from '../../packages/cli/src/doctor.js';

describe('doctor session.info health assessment', () => {
  it('passes when connected and heartbeat is healthy', () => {
    const check = assessSessionInfoHealth({
      extensionConnected: true,
      connectionState: 'connected',
      connectionReason: null,
      heartbeatStale: false,
      heartbeatAgeMs: 1200,
      staleAfterMs: 30000
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('healthy');
  });

  it('fails when heartbeat is stale', () => {
    const check = assessSessionInfoHealth({
      extensionConnected: false,
      connectionState: 'disconnected',
      connectionReason: 'heartbeat-timeout',
      heartbeatStale: true,
      heartbeatAgeMs: 45000,
      staleAfterMs: 30000
    });

    expect(check.ok).toBe(false);
    expect(check.message).toContain('stale');
  });

  it('fails when bridge is not connected', () => {
    const check = assessSessionInfoHealth({
      extensionConnected: false,
      connectionState: 'disconnected',
      connectionReason: 'socket-closed',
      heartbeatStale: false
    });

    expect(check.ok).toBe(false);
    expect(check.message).toContain('not connected');
  });

  it('detects aligned cli/extension versions', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: '0.1.0'
      },
      '0.1.0'
    );

    expect(check.ok).toBe(true);
    expect(check.message).toContain('aligned');
  });

  it('flags version drift', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: '0.2.0'
      },
      '0.1.0'
    );

    expect(check.ok).toBe(false);
    expect(check.message).toContain('drift');
  });
});
