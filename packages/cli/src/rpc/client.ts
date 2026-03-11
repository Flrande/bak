import WebSocket from 'ws';
import { JSON_RPC_VERSION, type JsonRpcResponse } from '@flrande/bak-protocol';
import { markRpcMethodInvoked } from '../e2e-method-status.js';

const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const NAVIGATION_RPC_TIMEOUT_MS = 45_000;
const NAVIGATION_METHODS = new Set(['page.goto', 'session.openTab', 'session.ensure', 'session.reset']);

export class RpcClientError extends Error {
  readonly rpcCode?: number;
  readonly bakCode?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: { rpcCode?: number; bakCode?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.rpcCode = options.rpcCode;
    this.bakCode = options.bakCode;
    this.details = options.details;
  }
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }
  socket.terminate();
}

export function resolveRpcTimeoutMs(method: string, params: Record<string, unknown>): number {
  let timeoutMs = NAVIGATION_METHODS.has(method) ? NAVIGATION_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS;
  const requested = params.timeoutMs;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    timeoutMs = Math.max(timeoutMs, Math.floor(requested) + 10_000);
  }
  return timeoutMs;
}

export async function callRpc(method: string, params: Record<string, unknown>, port: number): Promise<unknown> {
  markRpcMethodInvoked(method);
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

    const timeoutMs = resolveRpcTimeoutMs(method, params);
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => {
          closeSocket(socket);
          reject(new Error(`RPC timeout ${method}`));
        });
      }, timeoutMs);

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
      throw new RpcClientError(`${response.error.data?.bakCode ?? response.error.code}: ${response.error.message}`, {
        rpcCode: response.error.code,
        bakCode: typeof response.error.data?.bakCode === 'string' ? response.error.data.bakCode : undefined,
        details: response.error.data
      });
    }

    return response.result;
  } finally {
    closeSocket(socket);
  }
}


