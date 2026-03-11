import { describe, expect, it, vi } from 'vitest';
import { ExtensionDriver } from '../../packages/cli/src/drivers/extension-driver.js';

function createBridge() {
  return {
    isConnected: () => true,
    markHeartbeat: () => undefined,
    getStats: () => ({
      state: 'connected' as const,
      reason: null,
      extensionVersion: '0.6.0',
      lastSeenTs: null,
      lastRequestTs: null,
      lastResponseTs: null,
      lastHeartbeatTs: null,
      lastError: null,
      connectedAtTs: null,
      disconnectedAtTs: null,
      pendingRequests: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      totalNotReady: 0
    }),
    request: vi.fn(async () => ({ ok: true }))
  };
}

describe('extension driver timeout propagation', () => {
  it('extends page.wait timeout for bridge requests', async () => {
    const bridge = createBridge();
    const driver = new ExtensionDriver(bridge as never);

    await driver.pageWait('text', 'ready', 20_000, 5);

    expect(bridge.request).toHaveBeenCalledWith(
      'page.wait',
      { mode: 'text', value: 'ready', timeoutMs: 20_000, tabId: 5 },
      21_500
    );
  });

  it('uses params.timeoutMs for rawRequest when explicit timeout is absent', async () => {
    const bridge = createBridge();
    const driver = new ExtensionDriver(bridge as never);

    await driver.rawRequest('network.waitFor', { urlIncludes: '/slow', timeoutMs: 45_000 });

    expect(bridge.request).toHaveBeenCalledWith(
      'network.waitFor',
      { urlIncludes: '/slow', timeoutMs: 45_000 },
      46_500
    );
  });

  it('prefers explicit rawRequest timeout over params.timeoutMs', async () => {
    const bridge = createBridge();
    const driver = new ExtensionDriver(bridge as never);

    await driver.rawRequest('network.waitFor', { urlIncludes: '/slow', timeoutMs: 45_000 }, 2_000);

    expect(bridge.request).toHaveBeenCalledWith(
      'network.waitFor',
      { urlIncludes: '/slow', timeoutMs: 45_000 },
      3_500
    );
  });
});
