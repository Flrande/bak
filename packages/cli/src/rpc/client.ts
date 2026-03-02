import WebSocket from 'ws';
import { JSON_RPC_VERSION, type JsonRpcResponse } from '@flrande/bak-protocol';

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }
  socket.terminate();
}

export async function callRpc(method: string, params: Record<string, unknown>, port: number): Promise<unknown> {
  const url = `ws://127.0.0.1:${port}/rpc`;
  const socket = new WebSocket(url);

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        socket.off('open', onOpen);
        reject(error);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });

    const id = `call_${Date.now()}`;
    const payload = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      params
    };

    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => {
          closeSocket(socket);
          reject(new Error(`RPC timeout ${method}`));
        });
      }, 15_000);

      const finish = (done: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off('message', onMessage);
        socket.off('error', onError);
        done();
      };

      const onMessage = (data: WebSocket.RawData): void => {
        try {
          const parsed = JSON.parse(String(data)) as JsonRpcResponse;
          if (parsed.id !== id) {
            return;
          }
          finish(() => resolve(parsed));
        } catch (error) {
          finish(() => reject(error));
        }
      };

      const onError = (error: Error): void => {
        finish(() => reject(error));
      };

      socket.on('message', onMessage);
      socket.on('error', onError);
      socket.send(JSON.stringify(payload), (error) => {
        if (!error) {
          return;
        }
        finish(() => reject(error));
      });
    });

    if ('error' in response) {
      throw new Error(`${response.error.data?.bakCode ?? response.error.code}: ${response.error.message}`);
    }

    return response.result;
  } finally {
    closeSocket(socket);
  }
}


