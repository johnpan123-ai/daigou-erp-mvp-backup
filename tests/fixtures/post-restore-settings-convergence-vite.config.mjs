import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://rhfdjsklfrgpoqsaqpkn.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-no-network-public-key'),
    'import.meta.env.VITE_DEPLOYMENT_ENV': JSON.stringify('staging'),
    'import.meta.env.VITE_SANDBOX_ENV': JSON.stringify(''),
    'import.meta.env.VITE_CLOUD_REALTIME_PREVIEW': JSON.stringify('true'),
  },
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1' },
});
