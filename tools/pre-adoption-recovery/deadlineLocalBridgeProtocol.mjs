import { createHash } from 'node:crypto';

export const DEADLINE_LOCAL_BRIDGE_PROTOCOL = 'ERP2_DEADLINE_LOCAL_BRIDGE_V1';
export const DEADLINE_LOCAL_BRIDGE_ATTACHMENT = 'MAIN_WORLD_EXTENSION_LOOPBACK';
export const DEADLINE_LOCAL_BRIDGE_HOST = '127.0.0.1';
export const DEADLINE_LOCAL_BRIDGE_PORT = 45173;
export const DEADLINE_LOCAL_BRIDGE_CHUNK_BYTES = 128 * 1024;

const fail = code => { throw new Error(`DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:${code}`); };

export const deadlineBridgeSha256 = value => createHash('sha256').update(value).digest('hex');

export function assertDeadlineBridgeOrigin(origin, extensionId) {
  if (!/^[a-p]{32}$/u.test(extensionId ?? '')) fail('EXTENSION_ID_REJECTED');
  const expectedOrigin = `chrome-extension://${extensionId}`;
  if (origin && origin !== expectedOrigin) fail('EXTENSION_ORIGIN_REJECTED');
  return { extensionId, origin: origin || null };
}

export function assertDeadlineBridgeRuntimeIdentity(input, expected) {
  if (input?.attachment !== DEADLINE_LOCAL_BRIDGE_ATTACHMENT) fail('ISOLATED_WORLD_REJECTED');
  if (input?.accountId !== expected.accountId) fail('CLOUDFLARE_ACCOUNT_MISMATCH');
  if (input?.project !== expected.project) fail('PAGES_PROJECT_MISMATCH');
  if (input?.domain !== expected.domain) fail('PAGES_DOMAIN_MISMATCH');
  if (input?.supabaseProject !== expected.supabaseProject) fail('SUPABASE_PROJECT_MISMATCH');
  if (input?.publicFingerprint !== expected.publicFingerprint) fail('PUBLIC_FINGERPRINT_MISMATCH');
  return {
    accountId: input.accountId,
    project: input.project,
    domain: input.domain,
    supabaseProject: input.supabaseProject,
    publicFingerprint: input.publicFingerprint,
  };
}

const exactKeys = (value, expected, code) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
};

export function createDeadlineBridgeAccumulator(meta, { sessionId, expected, contracts }) {
  if (meta?.protocol !== DEADLINE_LOCAL_BRIDGE_PROTOCOL || meta?.sessionId !== sessionId) {
    fail('SESSION_MISMATCH');
  }
  assertDeadlineBridgeRuntimeIdentity(meta.identity, expected);
  const storeKeys = Object.keys(contracts.deadlineStoreNames);
  exactKeys(meta.stores, storeKeys, 'STORE_COVERAGE_MISMATCH');
  if (!/^[a-f0-9]{64}$/u.test(meta.fileSha256 ?? '')) fail('FILE_CHECKSUM_INVALID');
  const stores = {};
  for (const key of storeKeys) {
    const store = meta.stores[key];
    if (store?.physicalName !== contracts.deadlineStoreNames[key]
      || !Number.isSafeInteger(store.rowCount) || store.rowCount < 0
      || !Number.isSafeInteger(store.totalBytes) || store.totalBytes < 2
      || !Number.isSafeInteger(store.totalChunks) || store.totalChunks < 1
      || !/^[a-f0-9]{64}$/u.test(store.sha256 ?? '')) fail('STORE_META_INVALID');
    stores[key] = { ...store, chunks: [], receivedBytes: 0 };
  }
  return { meta, storeKeys, stores, completed: false };
}

export function acceptDeadlineBridgeChunk(accumulator, chunk) {
  if (accumulator.completed) fail('TRANSFER_ALREADY_COMPLETED');
  if (chunk?.protocol !== DEADLINE_LOCAL_BRIDGE_PROTOCOL
    || chunk?.sessionId !== accumulator.meta.sessionId
    || chunk?.transferId !== accumulator.meta.transferId) fail('SESSION_MISMATCH');
  const store = accumulator.stores[chunk.store];
  if (!store) fail('UNKNOWN_STORE');
  if (chunk.rowCount !== store.rowCount || chunk.sequence !== store.chunks.length
    || chunk.totalChunks !== store.totalChunks || !/^[a-f0-9]{64}$/u.test(chunk.checksum ?? '')
    || typeof chunk.payload !== 'string') fail('CHUNK_META_INVALID');
  const bytes = Buffer.from(chunk.payload, 'base64');
  if (deadlineBridgeSha256(bytes) !== chunk.checksum) fail('CHUNK_CORRUPT');
  if (bytes.length === 0 || bytes.length > DEADLINE_LOCAL_BRIDGE_CHUNK_BYTES) fail('CHUNK_SIZE_INVALID');
  store.chunks.push(bytes);
  store.receivedBytes += bytes.length;
  return { store: chunk.store, sequence: chunk.sequence };
}

export function finalizeDeadlineBridgeAccumulator(accumulator, complete) {
  if (accumulator.completed) fail('TRANSFER_ALREADY_COMPLETED');
  if (complete?.protocol !== DEADLINE_LOCAL_BRIDGE_PROTOCOL
    || complete?.sessionId !== accumulator.meta.sessionId
    || complete?.transferId !== accumulator.meta.transferId
    || complete?.fileSha256 !== accumulator.meta.fileSha256) fail('SESSION_MISMATCH');
  const payload = {};
  for (const key of accumulator.storeKeys) {
    const store = accumulator.stores[key];
    if (store.chunks.length !== store.totalChunks) fail('CHUNK_MISSING');
    const bytes = Buffer.concat(store.chunks);
    if (bytes.length !== store.totalBytes || store.receivedBytes !== store.totalBytes) fail('STORE_SIZE_MISMATCH');
    if (deadlineBridgeSha256(bytes) !== store.sha256) fail('STORE_CHECKSUM_MISMATCH');
    let rows;
    try { rows = JSON.parse(bytes.toString('utf8')); }
    catch { fail('STORE_JSON_INVALID'); }
    if (!Array.isArray(rows) || rows.length !== store.rowCount) fail('STORE_ROW_COUNT_MISMATCH');
    payload[key] = rows;
  }
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (deadlineBridgeSha256(serialized) !== accumulator.meta.fileSha256) fail('FILE_CHECKSUM_MISMATCH');
  accumulator.completed = true;
  return { payload, serialized };
}
