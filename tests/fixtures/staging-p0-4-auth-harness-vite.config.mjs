import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isProductionFixture = process.env.P0_4_HARNESS_FIXTURE_TARGET === 'production';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(isProductionFixture
      ? 'https://twzpqyesbtnfxdkorluf.supabase.co'
      : 'https://rhfdjsklfrgpoqsaqpkn.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-browser-fixture'),
    'import.meta.env.VITE_DEPLOYMENT_ENV': JSON.stringify(isProductionFixture ? 'production' : 'staging'),
    'import.meta.env.VITE_SANDBOX_ENV': JSON.stringify('experimental'),
    'import.meta.env.VITE_CLOUD_REALTIME_PREVIEW': JSON.stringify('true'),
  },
  server: { host: '127.0.0.1' },
});
