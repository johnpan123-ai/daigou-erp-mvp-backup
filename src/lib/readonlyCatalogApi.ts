export const CATALOG_SERVICE_UNAVAILABLE_MESSAGE = '商品目錄查詢服務目前無法連線，未修改任何結單日。';

type ReadonlyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CatalogServiceErrorCategory = 'TIMEOUT' | 'SERVICE_ERROR' | 'ABORTED';

const isAbortError = (error: unknown): boolean => error instanceof DOMException
  ? error.name === 'AbortError'
  : error instanceof Error && error.name === 'AbortError';

export class CatalogServiceError extends Error {
  readonly url: string;
  readonly status: number | null;
  readonly category: CatalogServiceErrorCategory;

  constructor(
    url: string,
    status: number | null,
    category: CatalogServiceErrorCategory,
    cause?: unknown,
  ) {
    const detail = status === null ? 'network failure' : `HTTP ${status}`;
    super(`${CATALOG_SERVICE_UNAVAILABLE_MESSAGE} (${detail})`, { cause });
    this.name = 'CatalogServiceError';
    this.url = url;
    this.status = status;
    this.category = category;
  }
}

const fetchReadonlyResponse = async (
  url: string,
  fetcher: ReadonlyFetch,
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET' });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new CatalogServiceError(url, null, 'SERVICE_ERROR', cause);
  }

  if (!response.ok) {
    const category: CatalogServiceErrorCategory = response.status === 504
      ? 'TIMEOUT'
      : response.status === 499
        ? 'ABORTED'
        : 'SERVICE_ERROR';
    throw new CatalogServiceError(url, response.status, category);
  }
  return response;
};

export async function fetchReadonlyCatalogJson<T>(
  url: string,
  fetcher: ReadonlyFetch = fetch,
): Promise<T> {
  const response = await fetchReadonlyResponse(url, fetcher);
  try {
    return await response.json() as T;
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new CatalogServiceError(url, response.status, 'SERVICE_ERROR', cause);
  }
}

export async function fetchReadonlyCatalogText(
  url: string,
  fetcher: ReadonlyFetch = fetch,
): Promise<string> {
  const response = await fetchReadonlyResponse(url, fetcher);
  try {
    return await response.text();
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new CatalogServiceError(url, response.status, 'SERVICE_ERROR', cause);
  }
}
