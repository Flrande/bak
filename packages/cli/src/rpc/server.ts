import { createServer } from 'node:http';
import * as readline from 'node:readline';
import { BakErrorCode, fail, ok, type JsonRpcId, parseJsonRpcLine, RpcError } from '@flrande/bak-protocol';
import WebSocket, { WebSocketServer } from 'ws';
import type { BakService } from '../service.js';
import { stopHttpServer, stopWebSocketServer } from '../ws-shutdown.js';

function toRpcFailure(id: JsonRpcId, error: unknown) {
  if (error instanceof RpcError && error.bakCode) {
    return fail(id, error.message, error.bakCode, error.details);
  }

  return fail(id, error instanceof Error ? error.message : String(error), BakErrorCode.E_INTERNAL);
}

export class RpcServer {
  private readonly service: BakService;
  private readonly wsPort: number;
  private wsServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;

  constructor(service: BakService, wsPort: number) {
    this.service = service;
    this.wsPort = wsPort;
  }

  async start(): Promise<void> {
    this.startStdio();
    await this.startWs();
  }

  private async handleRequest(raw: string, send: (payload: string) => void): Promise<void> {
    let request;
    try {
      request = parseJsonRpcLine(raw);
    } catch (error) {
      const response = toRpcFailure(null, error);
      send(JSON.stringify(response));
      return;
    }

    const id = request.id ?? null;

    try {
      const result = await this.service.invokeDynamic(request.method, (request.params ?? {}) as Record<string, unknown>);
      if (request.id !== undefined) {
        send(JSON.stringify(ok(id, result)));
      }
    } catch (error) {
      if (request.id !== undefined) {
        send(JSON.stringify(toRpcFailure(id, error)));
      }
    }
  }

  private startStdio(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Number.POSITIVE_INFINITY
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      void this.handleRequest(trimmed, (payload) => {
        process.stdout.write(`${payload}\n`);
      });
    });
  }

  private async startWs(): Promise<void> {
    this.wsServer = createServer();
    this.wss = new WebSocketServer({ server: this.wsServer, path: '/rpc' });

    this.wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        void this.handleRequest(String(data), (payload) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
          }
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.wsServer?.listen(this.wsPort, '127.0.0.1', () => resolve());
      this.wsServer?.once('error', reject);
    });
  }

  async stop(): Promise<void> {
    await stopWebSocketServer(this.wss);
    await stopHttpServer(this.wsServer);

    this.wss = null;
    this.wsServer = null;
  }
}


