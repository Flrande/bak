import type { Server } from 'node:http';
import WebSocket, { type WebSocketServer } from 'ws';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 500;

function waitForSocketClose(socket: WebSocket, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('close', finish);
      resolve();
    };

    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // Ignore termination failures during shutdown.
      }
      finish();
    }, timeoutMs);

    socket.once('close', finish);

    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1001, 'server stopping');
      }
    } catch {
      finish();
    }
  });
}

export async function stopWebSocketServer(
  wss: WebSocketServer | null,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
): Promise<void> {
  if (!wss) {
    return;
  }

  const clients = [...wss.clients];
  await Promise.all(clients.map(async (client) => await waitForSocketClose(client, timeoutMs)));

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // Ignore termination failures during shutdown.
        }
      }
      finish();
    }, timeoutMs);

    try {
      wss.close(() => finish());
    } catch {
      finish();
    }
  });
}

export async function stopHttpServer(server: Server | null, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        // Ignore force-close failures during shutdown.
      }
      finish();
    }, timeoutMs);

    try {
      server.close(() => finish());
    } catch {
      finish();
    }
  });
}
