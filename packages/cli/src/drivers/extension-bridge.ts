import { createServer } from 'node:http';
import { URL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import type { PairingStore } from '../pairing-store.js';

interface BridgeRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    data?: Record<string, unknown>;
  };
}

export class BridgeError extends Error {
  readonly code: string;
  readonly data?: Record<string, unknown>;

  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class ExtensionBridge {
  private readonly pairingStore: PairingStore;
  private readonly port: number;
  private server: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(port: number, pairingStore: PairingStore) {
    this.port = port;
    this.pairingStore = pairingStore;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname !== '/extension') {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get('token') ?? '';
      const expected = this.pairingStore.getToken();

      if (!expected || token !== expected) {
        socket.destroy();
        return;
      }

      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (socket) => {
      this.socket = socket;

      socket.on('message', (payload) => {
        this.handleMessage(String(payload));
      });

      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
        }
      });

      socket.on('error', () => {
        if (this.socket === socket) {
          this.socket = null;
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(this.port, '127.0.0.1', () => resolve());
      this.server?.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new BridgeError('E_NOT_READY', `request cancelled: ${id}`));
      this.pending.delete(id);
    }

    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.wss = null;
    this.server = null;
    this.socket = null;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  getPort(): number {
    return this.port;
  }

  private handleMessage(raw: string): void {
    let message: BridgeResponse;
    try {
      message = JSON.parse(raw) as BridgeResponse;
    } catch {
      return;
    }

    if (!message.id || !this.pending.has(message.id)) {
      return;
    }

    const pending = this.pending.get(message.id)!;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new BridgeError(message.error?.code ?? 'E_INTERNAL', message.error?.message ?? 'unknown', message.error?.data));
  }

  async request<TResult>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<TResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeError('E_NOT_READY', 'Extension is not connected');
    }

    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const payload: BridgeRequest = { id, method, params };

    const responsePromise = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('E_TIMEOUT', `timeout waiting response for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer
      });
    });

    this.socket.send(JSON.stringify(payload));
    return responsePromise;
  }
}
