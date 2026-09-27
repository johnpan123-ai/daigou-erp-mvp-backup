const RESTORE_RPC_NAMES = new Set([
  'erp_prove_cloud_restore_candidate_v2',
  'erp_prepare_cloud_restore_attempt',
  'erp_restore_proven_cloud_snapshot_attempt',
  'erp_reconcile_cloud_restore_attempt',
]);

export type CloudRestoreRpcTransportOutcome =
  | 'EXECUTE_NOT_DISPATCHED'
  | 'EXECUTE_DISPATCHED_NO_RESPONSE'
  | 'EXECUTE_ABORTED_CLIENT'
  | 'EXECUTE_HTTP_ERROR'
  | 'EXECUTE_RESPONSE_RECEIVED';

export interface CloudRestoreRpcTransportDiagnostic {
  requestId: string;
  rpcName: string;
  traceId?: string;
  attemptId?: string;
  executionId?: string;
  dispatchStartedAt?: string;
  responseHeadersAt?: string;
  responseCompletedAt?: string;
  abortAt?: string;
  abortReason?: string;
  requestBodyBytes: number;
  httpStatus?: number;
  elapsedMs?: number;
  cfRay?: string;
  gatewayRequestId?: string;
  serverTiming?: string;
  outcome: CloudRestoreRpcTransportOutcome;
}

const STORAGE_KEY = 'hippo-cloud-restore-rpc-transport-v1';
const MAX_RECORDS = 24;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const SAFE_TEXT_LIMIT = 256;

const safeUuid = (value: unknown): string | undefined => (
  typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined
);

const safeHeader = (value: string | null): string | undefined => {
  if (!value) return undefined;
  return value.slice(0, SAFE_TEXT_LIMIT);
};

const readRecords = (): CloudRestoreRpcTransportDiagnostic[] => {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.slice(-MAX_RECORDS) : [];
  } catch {
    return [];
  }
};

const writeRecord = (record: CloudRestoreRpcTransportDiagnostic): void => {
  if (typeof window === 'undefined') return;
  try {
    const records = readRecords();
    const index = records.findIndex(value => value.requestId === record.requestId);
    if (index >= 0) records[index] = record;
    else records.push(record);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
  } catch {
    // Observability must never alter Restore control flow.
  }
  console.info('[Cloud Restore Transport]', {
    requestId: record.requestId,
    rpcName: record.rpcName,
    traceId: record.traceId,
    attemptId: record.attemptId,
    executionId: record.executionId,
    requestBodyBytes: record.requestBodyBytes,
    httpStatus: record.httpStatus,
    elapsedMs: record.elapsedMs,
    outcome: record.outcome,
  });
};

export const getCloudRestoreRpcTransportDiagnostics = (): CloudRestoreRpcTransportDiagnostic[] => readRecords();

export const resetCloudRestoreRpcTransportDiagnosticsForTests = (): void => {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(STORAGE_KEY);
};

export const recordCloudRestoreRpcIntent = (input: {
  requestId: string;
  rpcName: string;
  traceId?: string;
  attemptId?: string;
  executionId?: string;
}): void => {
  writeRecord({
    ...input,
    requestBodyBytes: 0,
    outcome: 'EXECUTE_NOT_DISPATCHED',
  });
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const requestBodyText = (input: RequestInfo | URL, init?: RequestInit): string | null => {
  if (typeof init?.body === 'string') return init.body;
  if (typeof Request !== 'undefined' && input instanceof Request && !input.bodyUsed) return null;
  return null;
};

const rpcNameFromUrl = (value: string): string | null => {
  try {
    const match = new URL(value, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
      .pathname.match(/\/rest\/v1\/rpc\/([^/?]+)/u);
    if (!match) return null;
    const name = decodeURIComponent(match[1]);
    return RESTORE_RPC_NAMES.has(name) ? name : null;
  } catch {
    return null;
  }
};

const safeIdsFromBody = (body: string | null): {
  requestId?: string; traceId?: string; attemptId?: string; executionId?: string;
} => {
  if (!body) return {};
  const find = (key: string): string | undefined => {
    const match = body.match(new RegExp(`"${key}"\\s*:\\s*"([0-9a-f-]{36})"`, 'iu'));
    return safeUuid(match?.[1]);
  };
  return {
    requestId: find('p_request_id'),
    traceId: find('p_trace_id'),
    attemptId: find('p_attempt_id'),
    executionId: find('p_execution_id'),
  };
};

const requestSignal = (input: RequestInfo | URL, init?: RequestInit): AbortSignal | null => {
  if (init?.signal) return init.signal;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.signal;
  return null;
};

const requestHeaders = (input: RequestInfo | URL, init?: RequestInit): Headers => {
  const headers = new Headers(typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
};

export async function fetchWithCloudRestoreRpcObservation(
  fetchImplementation: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const rpcName = rpcNameFromUrl(requestUrl(input));
  if (!rpcName) return fetchImplementation(input, init);

  const body = requestBodyText(input, init);
  const ids = safeIdsFromBody(body);
  const requestId = ids.requestId ?? crypto.randomUUID();
  const bodyBytes = body === null ? 0 : new TextEncoder().encode(body).byteLength;
  const started = performance.now();
  const headers = requestHeaders(input, init);
  headers.set('x-restore-request-id', requestId);
  const nextInit: RequestInit = { ...init, headers };
  const signal = requestSignal(input, init);
  const record: CloudRestoreRpcTransportDiagnostic = {
    requestId,
    rpcName,
    traceId: ids.traceId,
    attemptId: ids.attemptId,
    executionId: ids.executionId,
    dispatchStartedAt: new Date().toISOString(),
    requestBodyBytes: bodyBytes,
    outcome: 'EXECUTE_DISPATCHED_NO_RESPONSE',
  };
  writeRecord(record);

  const onAbort = (): void => {
    record.abortAt = new Date().toISOString();
    record.abortReason = safeHeader(typeof signal?.reason === 'string' ? signal.reason : signal?.reason instanceof Error
      ? signal.reason.name : 'abort-signal');
    record.elapsedMs = Math.round(performance.now() - started);
    record.outcome = 'EXECUTE_ABORTED_CLIENT';
    writeRecord(record);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImplementation(input, nextInit);
    record.responseHeadersAt = new Date().toISOString();
    record.httpStatus = response.status;
    record.elapsedMs = Math.round(performance.now() - started);
    record.cfRay = safeHeader(response.headers.get('cf-ray'));
    record.gatewayRequestId = safeHeader(
      response.headers.get('x-request-id')
      ?? response.headers.get('x-kong-request-id')
      ?? response.headers.get('sb-request-id'),
    );
    record.serverTiming = safeHeader(response.headers.get('server-timing'));
    record.outcome = response.ok ? 'EXECUTE_RESPONSE_RECEIVED' : 'EXECUTE_HTTP_ERROR';
    writeRecord(record);
    void response.clone().arrayBuffer().then(() => {
      record.responseCompletedAt = new Date().toISOString();
      record.elapsedMs = Math.round(performance.now() - started);
      writeRecord(record);
    }).catch(() => {
      record.elapsedMs = Math.round(performance.now() - started);
      if (record.outcome === 'EXECUTE_RESPONSE_RECEIVED') record.outcome = 'EXECUTE_DISPATCHED_NO_RESPONSE';
      writeRecord(record);
    });
    return response;
  } catch (error) {
    record.elapsedMs = Math.round(performance.now() - started);
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      record.abortAt ??= new Date().toISOString();
      record.abortReason ??= 'fetch-abort';
      record.outcome = 'EXECUTE_ABORTED_CLIENT';
    } else {
      record.outcome = 'EXECUTE_DISPATCHED_NO_RESPONSE';
    }
    writeRecord(record);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
