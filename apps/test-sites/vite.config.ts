import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function readCookies(request: IncomingMessage): Record<string, string> {
  const cookieHeader = Array.isArray(request.headers.cookie) ? request.headers.cookie.join(';') : request.headers.cookie ?? '';
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((accumulator, part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) {
        return accumulator;
      }
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name) {
        accumulator[name] = value;
      }
      return accumulator;
    }, {});
}

async function handleApiRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!request.url) {
    return false;
  }

  const url = new URL(request.url, 'http://127.0.0.1:4173');
  if (!url.pathname.startsWith('/api/')) {
    return false;
  }

  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');

  if (url.pathname === '/api/slow') {
    const delayMs = Number.parseInt(url.searchParams.get('delay') ?? '0', 10);
    const status = Number.parseInt(url.searchParams.get('status') ?? '200', 10);
    const symbol = url.searchParams.get('symbol') ?? 'QQQ';
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    response.statusCode = Number.isFinite(status) ? status : 200;
    response.end(
      JSON.stringify({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 400,
        symbol,
        generatedAt: new Date().toISOString()
      })
    );
    return true;
  }

  if (url.pathname === '/api/runtime-data') {
    const symbol = url.searchParams.get('symbol') ?? 'QQQ';
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        symbol,
        generatedAt: new Date().toISOString(),
        quotes: {
          changePercent: 1.23,
          last: 512.34
        }
      })
    );
    return true;
  }

  if (url.pathname === '/api/echo') {
    const body = await readBody(request);
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        method: request.method ?? 'GET',
        contentType: request.headers['content-type'] ?? '',
        body,
        generatedAt: new Date().toISOString()
      })
    );
    return true;
  }

  if (url.pathname === '/api/protected-core') {
    const cookies = readCookies(request);
    const cookieToken = cookies['XSRF-TOKEN'] ? decodeURIComponent(cookies['XSRF-TOKEN']) : null;
    const headerToken = request.headers['x-xsrf-token'];
    const resolvedHeaderToken = Array.isArray(headerToken) ? headerToken[0] ?? null : headerToken ?? null;
    const authorized = Boolean(cookieToken && resolvedHeaderToken && cookieToken === resolvedHeaderToken);
    response.statusCode = authorized ? 200 : 419;
    response.end(
      JSON.stringify({
        ok: authorized,
        symbol: url.searchParams.get('symbol') ?? 'QQQ',
        cookieToken,
        headerToken: resolvedHeaderToken,
        generatedAt: new Date().toISOString()
      })
    );
    return true;
  }

  if (url.pathname === '/api/table-rows') {
    response.statusCode = 200;
    response.end(
      JSON.stringify([
        [1, 'Alpha', 'Delete'],
        [2, 'Beta', 'Delete'],
        [3, 'Gamma', 'Delete']
      ])
    );
    return true;
  }

  if (url.pathname === '/api/large-json') {
    const rows = Array.from({ length: 240 }, (_, index) => ({
      id: index + 1,
      symbol: index % 2 === 0 ? 'QQQ' : 'SPY',
      side: index % 3 === 0 ? 'Buy' : 'Sell',
      premium: 1000 + index * 17,
      updatedAt: `2026-03-${String((index % 9) + 1).padStart(2, '0')}`,
      note: `Large payload row ${index + 1} for pagination and summary validation`
    }));
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        rows,
        generatedAt: new Date().toISOString()
      })
    );
    return true;
  }

  if (url.pathname === '/api/network-table-rows') {
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        rows: [
          { id: 101, symbol: 'QQQ', side: 'Buy', premium: 125000 },
          { id: 102, symbol: 'SPY', side: 'Sell', premium: 98000 },
          { id: 103, symbol: 'IWM', side: 'Buy', premium: 64500 }
        ],
        generatedAt: new Date().toISOString()
      })
    );
    return true;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ ok: false, message: 'not found' }));
  return true;
}

function apiPlugin(): Plugin {
  return {
    name: 'bak-test-sites-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleApiRequest(request, response).then((handled) => {
          if (!handled) {
            next();
          }
        });
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleApiRequest(request, response).then((handled) => {
          if (!handled) {
            next();
          }
        });
      });
    }
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        form: resolve(__dirname, 'form.html'),
        table: resolve(__dirname, 'table.html'),
        virtualTable: resolve(__dirname, 'virtual-table.html'),
        networkTable: resolve(__dirname, 'network-table.html'),
        controlled: resolve(__dirname, 'controlled.html'),
        spa: resolve(__dirname, 'spa.html'),
        iframeHost: resolve(__dirname, 'iframe-host.html'),
        iframeChild: resolve(__dirname, 'iframe-child.html'),
        shadow: resolve(__dirname, 'shadow.html'),
        upload: resolve(__dirname, 'upload.html'),
        network: resolve(__dirname, 'network.html')
      }
    }
  }
});
