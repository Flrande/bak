import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BridgeError, ExtensionBridge } from '../../packages/cli/src/drivers/extension-bridge.js';
import { PairingStore } from '../../packages/cli/src/pairing-store.js';

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

describe('ExtensionBridge reliability', () => {
  it('fails fast with E_NOT_READY when not connected', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-bridge-notready-'));
    const store = new PairingStore(dataDir);
    store.createToken();
    const bridge = new ExtensionBridge(17373, store);

    await expect(bridge.request('session.ping')).rejects.toMatchObject({
      code: 'E_NOT_READY'
    });

    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects in-flight requests when socket closes', async () => {
    const port = await getFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), 'bak-bridge-close-'));
    const store = new PairingStore(dataDir);
    const created = store.createToken();
    const token = created.token;
    const bridge = new ExtensionBridge(port, store);
    await bridge.start();

    const client = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    const pending = bridge.request('tabs.list', {}, 10_000);

    setTimeout(() => {
      client.close();
    }, 50);

    const error = await pending.catch((value) => value as BridgeError);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error.code).toBe('E_NOT_READY');

    await new Promise<void>((resolve) => {
      if (client.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      client.once('close', () => resolve());
    });
    await bridge.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
