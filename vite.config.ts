import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api/catalog': {
        target: 'https://xiaohebo-catalog-beta.onrender.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/catalog/, '/api'),
      },
      '/api/hololive': {
        target: 'https://shop.hololivepro.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hololive/, ''),
      },
      '/api/vspo': {
        target: 'https://store.vspo.jp',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/vspo/, ''),
      },
    },
  },
})