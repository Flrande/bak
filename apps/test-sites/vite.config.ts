import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4173
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  },
  plugins: [
    {
      name: 'bak-test-api',
      configureServer(server) {
        server.middlewares.use('/api/slow', async (req, res) => {
          const url = new URL(req.url ?? '/api/slow', 'http://127.0.0.1:4173');
          const delayMs = Number(url.searchParams.get('delay') ?? '250');
          const status = Number(url.searchParams.get('status') ?? '200');
          const payload = {
            ok: status >= 200 && status < 400,
            delayMs,
            status,
            ts: Date.now()
          };

          await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(payload));
        });
      }
    }
  ]
});
