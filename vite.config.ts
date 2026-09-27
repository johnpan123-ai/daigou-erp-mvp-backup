import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolveCatalogUpstreamPath } from './functions/catalogProxyRuntime.ts'
import { assertSupabaseEnvironmentBoundary } from './src/lib/supabaseEnvironmentBoundary'

const catalogProxyTarget = process.env.CATALOG_API_PROXY_TARGET?.trim()
  || 'https://xiaohebo-catalog-beta.comiindex-hippo.workers.dev'

export default defineConfig(({ mode }) => {
  const loadedEnvironment = loadEnv(mode, process.cwd(), '')
  const environment = { ...loadedEnvironment, ...process.env }
  assertSupabaseEnvironmentBoundary({
    supabaseUrl: environment.VITE_SUPABASE_URL || '',
    viteMode: mode,
    sandboxEnvironment: environment.VITE_SANDBOX_ENV,
    deploymentEnvironment: environment.VITE_DEPLOYMENT_ENV,
    cloudPreviewEnabled: environment.VITE_CLOUD_REALTIME_PREVIEW === 'true',
    providerMode: null,
  })

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      allowedHosts: true,
      proxy: {
        '/api/catalog': {
          target: catalogProxyTarget,
          changeOrigin: true,
          rewrite: (path) => {
            const incoming = new URL(path, 'https://erp.invalid')
            const pathSegments = incoming.pathname
              .replace(/^\/api\/catalog\/?/, '')
              .split('/')
              .filter(Boolean)
            return `${resolveCatalogUpstreamPath(pathSegments)}${incoming.search}`
          },
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
  }
})
