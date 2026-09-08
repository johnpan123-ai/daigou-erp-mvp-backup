import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';

const fakeSupabase = normalizePath(fileURLToPath(new URL('./staging-p0-4-realtime-fault-supabase.ts', import.meta.url)));

export default defineConfig({
  plugins: [{
    name: 'p0-4-fake-supabase-client',
    enforce: 'pre',
    resolveId(source) {
      return source.endsWith('/supabaseClient') || source.endsWith('/supabaseClient.ts')
        ? fakeSupabase
        : null;
    },
  }, react()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://rhfdjsklfrgpoqsaqpkn.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-browser-fixture'),
    'import.meta.env.VITE_DEPLOYMENT_ENV': JSON.stringify('staging'),
    'import.meta.env.VITE_SANDBOX_ENV': JSON.stringify('experimental'),
    'import.meta.env.VITE_CLOUD_REALTIME_PREVIEW': JSON.stringify('true'),
  },
  server: { host: '127.0.0.1' },
});
