import { MemoryStore } from './memory/store.js';
import { PairingStore } from './pairing-store.js';
import { ExtensionBridge } from './drivers/extension-bridge.js';
import { ExtensionDriver } from './drivers/extension-driver.js';
import { RpcServer } from './rpc/server.js';
import { BakService } from './service.js';
import { TraceStore } from './trace-store.js';

export interface BakDaemon {
  service: BakService;
  stop(): Promise<void>;
}

export async function startBakDaemon(port: number, rpcWsPort: number): Promise<BakDaemon> {
  const pairingStore = new PairingStore();
  const traceStore = new TraceStore();
  const memoryStore = new MemoryStore();

  const bridge = new ExtensionBridge(port, pairingStore);
  await bridge.start();

  const driver = new ExtensionDriver(bridge);
  const service = new BakService(driver, pairingStore, traceStore, memoryStore);
  service.seedSessionIfNeeded();

  const rpcServer = new RpcServer(service, rpcWsPort);
  await rpcServer.start();

  const stop = async (): Promise<void> => {
    await rpcServer.stop();
    await bridge.stop();
  };

  return { service, stop };
}
