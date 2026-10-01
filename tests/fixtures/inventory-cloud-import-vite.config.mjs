import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  cacheDir: '.vite-cache/inventory-cloud-import-test',
  optimizeDeps: { noDiscovery: true, include: ['react','react-dom/client','react/jsx-runtime','react-router-dom','lucide-react','@supabase/supabase-js'] },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://rhfdjsklfrgpoqsaqpkn.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-no-network-public-key'),
    'import.meta.env.VITE_DEPLOYMENT_ENV': JSON.stringify('staging'),
    'import.meta.env.VITE_SANDBOX_ENV': JSON.stringify(''),
    'import.meta.env.VITE_CLOUD_REALTIME_PREVIEW': JSON.stringify('true'),
  },
  server: { host: '127.0.0.1' },
});
