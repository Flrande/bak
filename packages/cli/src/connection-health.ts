import type { BridgeConnectionState } from './drivers/extension-bridge.js';
import type { DriverConnectionStatus } from './drivers/browser-driver.js';

export interface ConnectionHealth {
  extensionConnected: boolean;
  connectionState: BridgeConnectionState;
  connectionReason: string | null;
  heartbeatStale: boolean;
  heartbeatAgeMs: number | null;
}

export function evaluateConnectionHealth(
  connection: DriverConnectionStatus,
  nowTs: number,
  staleAfterMs: number
): ConnectionHealth {
  const referenceTs = connection.lastHeartbeatTs ?? connection.connectedAtTs ?? connection.lastSeenTs;
  const heartbeatAgeMs = typeof referenceTs === 'number' ? Math.max(0, nowTs - referenceTs) : null;
  const heartbeatStale =
    connection.state === 'connected' &&
    typeof heartbeatAgeMs === 'number' &&
    heartbeatAgeMs > staleAfterMs;

  if (heartbeatStale) {
    return {
      extensionConnected: false,
      connectionState: 'disconnected',
      connectionReason: 'heartbeat-timeout',
      heartbeatStale: true,
      heartbeatAgeMs
    };
  }

  return {
    extensionConnected: connection.state === 'connected',
    connectionState: connection.state,
    connectionReason: connection.reason,
    heartbeatStale: false,
    heartbeatAgeMs
  };
}
