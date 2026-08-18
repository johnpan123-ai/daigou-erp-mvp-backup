export const CATALOG_SERVICE_UNAVAILABLE_MESSAGE = '商品目錄查詢服務目前無法連線，未修改任何結單日。';

type ReadonlyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CatalogServiceError extends Error {
  readonly url: string;
  readonly status: number | null;

  constructor(url: string, status: number | null, cause?: unknown) {
    const detail = status === null ? 'network failure' : `HTTP ${status}`;
    super(`${CATALOG_SERVICE_UNAVAILABLE_MESSAGE} (${detail})`, { cause });
    this.name = 'CatalogServiceError';
    this.url = url;
    this.status = status;
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
    throw new CatalogServiceError(url, null, cause);
  }

  if (!response.ok) {
    throw new CatalogServiceError(url, response.status);
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
    throw new CatalogServiceError(url, response.status, cause);
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
    throw new CatalogServiceError(url, response.status, cause);
  }
}
