import { describe, expect, it } from 'vitest';
import {
  assessActiveTabTelemetry,
  assessMemoryBackendResolution,
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
    expect(check.severity).toBe('warn');
  });

  it('warns when extension version is missing', () => {
    const check = assessVersionCompatibility({}, '0.1.0');

    expect(check.ok).toBe(false);
    expect(check.message).toContain('missing');
    expect(check.severity).toBe('warn');
  });

  it('warns when semver format is invalid', () => {
    const check = assessVersionCompatibility(
      {
        extensionVersion: 'dev-build'
      },
      '0.1.0-dev'
    );

    expect(check.ok).toBe(false);
    expect(check.message).toContain('unable to compare');
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

  it('passes memory backend check when no fallback happened', () => {
    const check = assessMemoryBackendResolution({
      requestedBackend: 'json',
      backend: 'json'
    });

    expect(check.ok).toBe(true);
    expect(check.message).toContain('ready');
  });

  it('warns memory backend check when fallback happened', () => {
    const check = assessMemoryBackendResolution({
      requestedBackend: 'sqlite',
      backend: 'json',
      fallbackReason: 'sqlite unavailable'
    });

    expect(check.ok).toBe(false);
    expect(check.severity).toBe('warn');
    expect(check.message).toContain('fallback');
  });
});
