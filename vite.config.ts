import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const catalogProxyTarget = process.env.CATALOG_API_PROXY_TARGET?.trim()
  || 'https://xiaohebo-catalog-beta.comiindex-hippo.workers.dev'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api/catalog': {
        target: catalogProxyTarget,
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
