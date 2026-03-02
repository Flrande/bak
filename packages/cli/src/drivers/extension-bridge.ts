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

export type BridgeConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface BridgeStats {
  state: BridgeConnectionState;
  reason: string | null;
  extensionVersion: string | null;
  lastSeenTs: number | null;
  lastRequestTs: number | null;
  lastResponseTs: number | null;
  lastHeartbeatTs: number | null;
  lastError: string | null;
  connectedAtTs: number | null;
  disconnectedAtTs: number | null;
  pendingRequests: number;
  totalRequests: number;
  totalFailures: number;
  totalTimeouts: number;
  totalNotReady: number;
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
  private state: BridgeConnectionState = 'disconnected';
  private reason: string | null = 'awaiting-extension';
  private extensionVersion: string | null = null;
  private lastSeenTs: number | null = null;
  private lastRequestTs: number | null = null;
  private lastResponseTs: number | null = null;
  private lastHeartbeatTs: number | null = null;
  private lastError: string | null = null;
  private connectedAtTs: number | null = null;
  private disconnectedAtTs: number | null = null;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalTimeouts = 0;
  private totalNotReady = 0;

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
    this.state = 'connecting';
    this.reason = 'listening';
    this.lastError = null;

    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname !== '/extension') {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get('token') ?? '';
      const validation = this.pairingStore.validateToken(token);
      if (!validation.ok) {
        this.lastError = validation.reason ?? 'pair-token-invalid';
        socket.destroy();
        return;
      }

      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (socket) => {
      const now = Date.now();
      this.socket = socket;
      this.state = 'connected';
      this.reason = null;
      this.extensionVersion = null;
      this.connectedAtTs = now;
      this.lastSeenTs = now;
      this.lastError = null;

      socket.on('message', (payload) => {
        this.handleMessage(String(payload));
      });

      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          this.recordDisconnected('socket-closed');
          this.rejectAllPending(new BridgeError('E_NOT_READY', 'Extension socket closed'));
        }
      });

      socket.on('error', (error) => {
        if (this.socket === socket) {
          this.socket = null;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.recordDisconnected('socket-error');
          this.rejectAllPending(
            new BridgeError('E_NOT_READY', 'Extension socket error', {
              detail: this.lastError
            })
          );
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(this.port, '127.0.0.1', () => resolve());
      this.server?.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    this.rejectAllPending(new BridgeError('E_NOT_READY', 'bridge stopping'));

    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.wss = null;
    this.server = null;
    this.socket = null;
    this.recordDisconnected('bridge-stopped');
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  getPort(): number {
    return this.port;
  }

  getStats(): BridgeStats {
    return {
      state: this.state,
      reason: this.reason,
      extensionVersion: this.extensionVersion,
      lastSeenTs: this.lastSeenTs,
      lastRequestTs: this.lastRequestTs,
      lastResponseTs: this.lastResponseTs,
      lastHeartbeatTs: this.lastHeartbeatTs,
      lastError: this.lastError,
      connectedAtTs: this.connectedAtTs,
      disconnectedAtTs: this.disconnectedAtTs,
      pendingRequests: this.pending.size,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalTimeouts: this.totalTimeouts,
      totalNotReady: this.totalNotReady
    };
  }

  markHeartbeat(ts = Date.now()): void {
    this.lastHeartbeatTs = ts;
    this.lastSeenTs = ts;
  }

  private rejectAllPending(error: BridgeError): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new BridgeError(error.code, `${error.message}: ${id}`, error.data));
      this.pending.delete(id);
      this.totalFailures += 1;
      if (error.code === 'E_NOT_READY') {
        this.totalNotReady += 1;
      }
    }
  }

  private recordDisconnected(reason: string): void {
    this.state = 'disconnected';
    this.reason = reason;
    this.disconnectedAtTs = Date.now();
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    const now = Date.now();
    this.lastSeenTs = now;

    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      const maybeHello = parsed as {
        type?: unknown;
        version?: unknown;
      };
      if (maybeHello.type === 'hello') {
        this.extensionVersion = typeof maybeHello.version === 'string' ? maybeHello.version : null;
        return;
      }
    }

    const message = parsed as BridgeResponse;
    this.lastResponseTs = now;

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
    this.totalFailures += 1;
  }

  async request<TResult>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<TResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.totalNotReady += 1;
      throw new BridgeError('E_NOT_READY', 'Extension is not connected');
    }

    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const payload: BridgeRequest = { id, method, params };
    const requestTs = Date.now();
    this.lastRequestTs = requestTs;
    this.totalRequests += 1;

    const responsePromise = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.totalTimeouts += 1;
        this.totalFailures += 1;
        reject(new BridgeError('E_TIMEOUT', `timeout waiting response for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer
      });
    });

    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      this.totalFailures += 1;
      this.totalNotReady += 1;
      throw new BridgeError('E_NOT_READY', 'Failed to send request to extension', {
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    return responsePromise;
  }
}
