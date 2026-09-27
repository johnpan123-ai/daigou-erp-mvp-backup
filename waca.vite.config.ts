import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Separate entry: no ERP route, provider, Catalog proxy, or Supabase client. */
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/waca-preview', rollupOptions: { input: 'waca-preview.html' } },
  server: { host: '127.0.0.1', port: 4194, strictPort: true },
});
