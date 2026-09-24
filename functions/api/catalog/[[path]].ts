import {
  proxyCatalogRequest,
  resolveCatalogProxyTimeoutMs,
} from '../../catalogProxyRuntime';

export const onRequest: PagesFunction = async (context) => {
  const path = (context.params.path as string[]).join('/');
  const url = `https://xiaohebo-catalog-beta.comiindex-hippo.workers.dev/api/${path}`;
  const incoming = context.request;
  const searchParams = new URL(incoming.url).search;
  const env = context.env as Record<string, unknown>;
  return proxyCatalogRequest({
    incoming,
    upstreamUrl: `${url}${searchParams}`,
    timeoutMs: resolveCatalogProxyTimeoutMs(env.CATALOG_PROXY_TIMEOUT_MS),
  });
};
