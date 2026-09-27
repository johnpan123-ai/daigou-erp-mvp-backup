import {
  proxyCatalogRequest,
  resolveCatalogUpstreamUrl,
  resolveCatalogProxyTimeoutMs,
} from '../../catalogProxyRuntime';

export const onRequest: PagesFunction = async (context) => {
  const incoming = context.request;
  const env = context.env as Record<string, unknown>;
  return proxyCatalogRequest({
    incoming,
    upstreamUrl: resolveCatalogUpstreamUrl(incoming.url, context.params.path as string[]),
    timeoutMs: resolveCatalogProxyTimeoutMs(env.CATALOG_PROXY_TIMEOUT_MS),
  });
};
