import { PairingStore } from './pairing-store.js';
import { ExtensionBridge } from './drivers/extension-bridge.js';
import { ExtensionDriver } from './drivers/extension-driver.js';
import { RpcServer } from './rpc/server.js';
import { BakService } from './service.js';
import { TraceStore } from './trace-store.js';
import { readEnvInt } from './utils.js';

export interface BakDaemon {
  service: BakService;
  stop(): Promise<void>;
}

export interface StartBakDaemonOptions {
  managedRuntime?: boolean;
  onManagedIdle?: () => void | Promise<void>;
}

export async function startBakDaemon(port: number, rpcWsPort: number, options: StartBakDaemonOptions = {}): Promise<BakDaemon> {
  const pairingStore = new PairingStore();
  const traceStore = new TraceStore();

  const bridge = new ExtensionBridge(port, pairingStore);
  await bridge.start();

  const driver = new ExtensionDriver(bridge);
  const heartbeatIntervalMs = readEnvInt('BAK_HEARTBEAT_MS', 10_000);
  const service = new BakService(driver, pairingStore, traceStore, {
    intervalMs: heartbeatIntervalMs,
    managedRuntime: options.managedRuntime === true,
    onManagedIdle: options.onManagedIdle
  });
  bridge.onEvent((event) => {
    service.handleBridgeEvent(event);
  });
  service.startHeartbeat();

  const rpcServer = new RpcServer(service, rpcWsPort);
  await rpcServer.start();

  const stop = async (): Promise<void> => {
    service.stopHeartbeat();
    await service.shutdown();
    await rpcServer.stop();
    await bridge.stop();
  };

  return { service, stop };
}
