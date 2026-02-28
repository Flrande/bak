import WebSocket from 'ws';
import { JSON_RPC_VERSION, type JsonRpcResponse } from '@bak/protocol';

export async function callRpc(method: string, params: Record<string, unknown>, port: number): Promise<unknown> {
  const url = `ws://127.0.0.1:${port}/rpc`;
  const socket = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  const id = `call_${Date.now()}`;
  const payload = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params
  };

  const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`RPC timeout ${method}`));
    }, 15_000);

    socket.on('message', (data) => {
      try {
        const parsed = JSON.parse(String(data)) as JsonRpcResponse;
        if (parsed.id !== id) {
          return;
        }
        clearTimeout(timer);
        resolve(parsed);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });

    socket.send(JSON.stringify(payload));
  });

  socket.close();

  if ('error' in response) {
    throw new Error(`${response.error.data?.bakCode ?? response.error.code}: ${response.error.message}`);
  }

  return response.result;
}
