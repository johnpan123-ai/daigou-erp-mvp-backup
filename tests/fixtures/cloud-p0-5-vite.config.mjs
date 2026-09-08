import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const fixturePath = fileURLToPath(new URL('./cloud-p0-5-auth-harness.html', import.meta.url));
const appRoutes = new Set(['/', '/login', '/dashboard', '/auth/recovery']);

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'cloud-p0-5-auth-history-fallback',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
          if (!appRoutes.has(pathname)) return next();
          const source = await readFile(fixturePath, 'utf8');
          const html = await server.transformIndexHtml(request.url ?? pathname, source);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        });
      },
    },
  ],
});
