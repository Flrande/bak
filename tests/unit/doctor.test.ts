import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../packages/protocol/src/types.js';
import {
  assessActiveTabTelemetry,
  assessPortAvailability,
  assessProtocolCompatibility,
  assessSessionInfoHealth,
  assessVersionCompatibility
} from '../../packages/cli/src/doctor.js';

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
        extensionVersion: '0.4.0'
      },
      '0.4.0'
    );

    expect(check.ok).toBe(true);
    expect(check.message).toContain('aligned');
  });

  it('flags version drift', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: '0.3.8'
      },
      '0.4.0'
    );

    expect(check.ok).toBe(false);
    expect(check.message).toContain('drift');
    expect(check.severity).toBe('warn');
  });

  it('warns when extension version is missing', () => {
    const check = assessVersionCompatibility({}, '0.4.0');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('missing');
    expect(check.severity).toBe('warn');
  });

  it('warns when semver format is invalid', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: 'dev-build'
      },
      '0.4.0-dev'
    );

    expect(check.ok).toBe(false);
    expect(check.message).toContain('unable to compare');
    expect(check.severity).toBe('warn');
  });

  it('detects aligned protocol versions', () => {
    const check = assessProtocolCompatibility({
      protocolVersion: PROTOCOL_VERSION
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('aligned');
  });

  it('warns when protocol version is missing', () => {
    const check = assessProtocolCompatibility({});

    expect(check.ok).toBe(false);
    expect(check.message).toContain('missing');
    expect(check.severity).toBe('warn');
  });

  it('passes when protocol versions are compatible', () => {
    const check = assessProtocolCompatibility({
      protocolVersion: 'v2',
      compatibleProtocolVersions: ['v2', PROTOCOL_VERSION]
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('compatible');
  });

  it('warns when protocol version mismatches', () => {
    const check = assessProtocolCompatibility({
      protocolVersion: 'v0'
    });

    expect(check.ok).toBe(false);
    expect(check.message).toContain('mismatch');
    expect(check.severity).toBe('warn');
  });

  it('passes when active tab telemetry is present while connected', () => {
    const check = assessActiveTabTelemetry({
      extensionConnected: true,
      connectionState: 'connected',
      activeTab: {
        id: 42,
        url: 'https://example.com/form',
        title: 'Example'
      }
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('available');
  });

  it('warns when connected session has no active tab telemetry', () => {
    const check = assessActiveTabTelemetry({
      extensionConnected: true,
      connectionState: 'connected',
      activeTab: null
    });

    expect(check.ok).toBe(false);
    expect(check.severity).toBe('warn');
    expect(check.message).toContain('missing');
  });

  it('skips active tab telemetry when disconnected', () => {
    const check = assessActiveTabTelemetry({
      extensionConnected: false,
      connectionState: 'disconnected',
      activeTab: null
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('skipped');
  });

  it('treats bound port as healthy in runtime mode', () => {
    const check = assessPortAvailability(17373, false, 'runtime', 'EADDRINUSE');

    expect(check.ok).toBe(true);
    expect(check.message).toContain('runtime expected');
  });

  it('flags available port as issue in runtime mode', () => {
    const check = assessPortAvailability(17373, true, 'runtime');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('runtime expects daemon binding');
  });

  it('treats available port as healthy in preflight mode', () => {
    const check = assessPortAvailability(17373, true, 'preflight');

    expect(check.ok).toBe(true);
    expect(check.message).toContain('available');
  });

  it('flags occupied port in preflight mode', () => {
    const check = assessPortAvailability(17373, false, 'preflight', 'EADDRINUSE');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('already in use');
  });
});
