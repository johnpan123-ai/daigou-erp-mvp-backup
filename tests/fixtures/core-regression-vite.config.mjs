import { defineConfig, mergeConfig } from 'vite';
import rootConfigFactory from '../../vite.config.ts';
import { CORE_TEST_IDENTITY_PROTOCOL } from '../helpers/core-test-server.mjs';

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default defineConfig(async environment => {
  const runId = process.env.CORE_TEST_RUN_ID?.trim() ?? '';
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('CORE_TEST_RUN_ID_INVALID');
  }

  const rootConfig = typeof rootConfigFactory === 'function'
    ? await rootConfigFactory(environment)
    : rootConfigFactory;

  return mergeConfig(rootConfig, {
    plugins: [{
      name: 'core-regression-server-identity',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
          if (path !== '/__core_test_identity') {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({
            protocol: CORE_TEST_IDENTITY_PROTOCOL,
            runId,
            entry: '/src/main.tsx',
            mode: environment.mode,
          }));
        });
      },
    }],
  });
});
