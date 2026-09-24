export const DEFAULT_CATALOG_PROXY_TIMEOUT_MS = 30_000;
const MIN_CATALOG_PROXY_TIMEOUT_MS = 1_000;
const MAX_CATALOG_PROXY_TIMEOUT_MS = 120_000;

type ProxyAbortCategory = 'CLIENT_ABORT' | 'TIMEOUT' | null;
type ProxyLog = Record<string, string | number | boolean | null>;

export function resolveCatalogProxyTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_CATALOG_PROXY_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed)
    && parsed >= MIN_CATALOG_PROXY_TIMEOUT_MS
    && parsed <= MAX_CATALOG_PROXY_TIMEOUT_MS
    ? parsed
    : DEFAULT_CATALOG_PROXY_TIMEOUT_MS;
}

function resolveRequestId(request: Request): string {
  const supplied = request.headers.get('X-Request-ID')?.trim();
  if (supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

async function hashQuery(request: Request): Promise<string> {
  const query = new URL(request.url).searchParams.get('q') ?? '';
  const normalized = query.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

function createDeadline(
  clientSignal: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  category: () => ProxyAbortCategory;
  dispose: () => void;
} {
  const controller = new AbortController();
  let category: ProxyAbortCategory = null;
  const onClientAbort = (): void => {
    if (controller.signal.aborted) return;
    category = 'CLIENT_ABORT';
    controller.abort(clientSignal.reason ?? new DOMException('Client cancelled request', 'AbortError'));
  };
  if (clientSignal.aborted) onClientAbort();
  else clientSignal.addEventListener('abort', onClientAbort, { once: true });

  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    category = 'TIMEOUT';
    controller.abort(new DOMException('Catalog proxy deadline exceeded', 'TimeoutError'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    category: () => category,
    dispose: () => {
      clearTimeout(timer);
      clientSignal.removeEventListener('abort', onClientAbort);
    },
  };
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return Response.json(
    { error: { code, message, requestId } },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Request-ID': requestId,
      },
    },
  );
}

function responseHeaders(upstream: Response, requestId: string): Headers {
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Request-ID': requestId,
  });
  for (const name of ['Server-Timing', 'X-Search-Query-Count']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function proxyCatalogRequest(options: {
  incoming: Request;
  upstreamUrl: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
  log?: (entry: ProxyLog) => void;
  now?: () => number;
}): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const requestId = resolveRequestId(options.incoming);
  const queryHash = await hashQuery(options.incoming);
  const deadline = createDeadline(options.incoming.signal, options.timeoutMs);
  let upstreamStatus: number | null = null;

  log({
    scope: 'catalog_proxy',
    event: 'request_start',
    request_id: requestId,
    query_hash: queryHash,
    timeout_ms: options.timeoutMs,
  });
  log({
    scope: 'catalog_proxy',
    event: 'upstream_start',
    request_id: requestId,
    query_hash: queryHash,
  });

  try {
    const upstream = await fetcher(options.upstreamUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        'X-Request-ID': requestId,
      },
      signal: deadline.signal,
    });
    upstreamStatus = upstream.status;

    // Search responses are bounded JSON. Materializing bytes (without text
    // decode/re-encode) keeps the deadline active through body consumption so
    // a stalled body can still become an unambiguous 504 before forwarding.
    const body = await upstream.arrayBuffer();
    const elapsedMs = now() - startedAt;
    log({
      scope: 'catalog_proxy',
      event: 'upstream_end',
      request_id: requestId,
      query_hash: queryHash,
      elapsed_ms: Math.round(elapsedMs),
      status: upstream.status,
      outcome: upstream.ok ? 'SUCCESS' : 'UPSTREAM_ERROR',
    });
    log({
      scope: 'catalog_proxy',
      event: 'request_end',
      request_id: requestId,
      query_hash: queryHash,
      elapsed_ms: Math.round(elapsedMs),
      status: upstream.status,
      outcome: upstream.ok ? 'SUCCESS' : 'UPSTREAM_ERROR',
    });
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream, requestId),
    });
  } catch (error) {
    const elapsedMs = now() - startedAt;
    const abortCategory = deadline.category();
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const status = abortCategory === 'TIMEOUT' ? 504 : abortCategory === 'CLIENT_ABORT' ? 499 : 502;
    const outcome = abortCategory ?? 'UPSTREAM_CONNECTION_ERROR';
    log({
      scope: 'catalog_proxy',
      event: 'upstream_end',
      request_id: requestId,
      query_hash: queryHash,
      elapsed_ms: Math.round(elapsedMs),
      status,
      upstream_status: upstreamStatus,
      outcome,
      error_name: errorName,
    });
    log({
      scope: 'catalog_proxy',
      event: 'request_end',
      request_id: requestId,
      query_hash: queryHash,
      elapsed_ms: Math.round(elapsedMs),
      status,
      outcome,
      error_name: errorName,
    });
    if (abortCategory === 'TIMEOUT') {
      return errorResponse(504, 'CATALOG_PROXY_TIMEOUT', 'Catalog upstream timed out.', requestId);
    }
    if (abortCategory === 'CLIENT_ABORT') {
      return errorResponse(499, 'CATALOG_PROXY_ABORTED', 'Catalog request was cancelled.', requestId);
    }
    return errorResponse(502, 'CATALOG_PROXY_UPSTREAM_ERROR', 'Catalog upstream request failed.', requestId);
  } finally {
    deadline.dispose();
  }
}
