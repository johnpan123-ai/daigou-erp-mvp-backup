import { getProviderMode } from '../providers/providerMode';

export class TestSandboxCloudWriteBlockedError extends Error {
  constructor(method: string, url: string) {
    super(`測試模式禁止寫入正式雲端：${method.toUpperCase()} ${url}`);
    this.name = 'TestSandboxCloudWriteBlockedError';
  }
}

const getRequestMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
};

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

export function isBlockedSupabaseWrite(_method: string, requestUrl: string, supabaseUrl: string): boolean {
  if (getProviderMode() !== 'test') return false;
  if (!supabaseUrl) return false;

  try {
    return new URL(requestUrl, window.location.origin).origin === new URL(supabaseUrl).origin;
  } catch {
    // An invalid URL cannot be identified as the configured Production host.
    return false;
  }
}

export function createGuardedSupabaseFetch(
  supabaseUrl: string,
  fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = getRequestMethod(input, init);
    const requestUrl = getRequestUrl(input);
    if (isBlockedSupabaseWrite(method, requestUrl, supabaseUrl)) {
      const error = new TestSandboxCloudWriteBlockedError(method, requestUrl);
      console.error('[Test Sandbox Guard]', error.message);
      throw error;
    }
    return fetchImplementation(input, init);
  };
}
