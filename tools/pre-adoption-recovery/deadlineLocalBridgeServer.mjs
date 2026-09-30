import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { CANONICAL_ERP2_TARGET } from '../../scripts/promotion-safety.mjs';
import { verifyDeadlineSidecar } from './contract.mjs';
import {
  DEADLINE_LOCAL_BRIDGE_ATTACHMENT,
  DEADLINE_LOCAL_BRIDGE_HOST,
  DEADLINE_LOCAL_BRIDGE_PORT,
  DEADLINE_LOCAL_BRIDGE_PROTOCOL,
  acceptDeadlineBridgeChunk,
  assertDeadlineBridgeOrigin,
  assertDeadlineBridgeRuntimeIdentity,
  createDeadlineBridgeAccumulator,
  deadlineBridgeSha256,
  finalizeDeadlineBridgeAccumulator,
} from './deadlineLocalBridgeProtocol.mjs';

const fail = code => { throw new Error(`DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:${code}`); };
const MAX_REQUEST_BYTES = 1024 * 1024;

const readJsonBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  let bytes = 0;
  request.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      reject(new Error('DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:REQUEST_TOO_LARGE'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(new Error('DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:REQUEST_JSON_INVALID')); }
  });
  request.on('error', reject);
});

const sendJson = (response, status, body, origin) => {
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.writeHead(status);
  response.end(JSON.stringify(body));
};

export async function runDeadlineLocalBridge({
  output,
  contracts,
  cloudflareProof,
  expected = CANONICAL_ERP2_TARGET,
  host = DEADLINE_LOCAL_BRIDGE_HOST,
  port = DEADLINE_LOCAL_BRIDGE_PORT,
  timeoutMs = 10 * 60 * 1000,
}) {
  if (host !== DEADLINE_LOCAL_BRIDGE_HOST) fail('LOOPBACK_REQUIRED');
  const identity = assertDeadlineBridgeRuntimeIdentity({
    attachment: DEADLINE_LOCAL_BRIDGE_ATTACHMENT,
    accountId: cloudflareProof?.accountId,
    project: cloudflareProof?.project,
    domain: cloudflareProof?.domain,
    supabaseProject: expected.supabaseProject,
    publicFingerprint: expected.publicFingerprint,
  }, expected);
  const sessionId = randomUUID();
  const bridgeToken = randomBytes(32).toString('hex');
  let accumulator = null;
  let settled = false;
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const closeWithError = error => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin ?? '';
    try {
      if (request.method === 'OPTIONS') {
        if (!/^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) fail('EXTENSION_ORIGIN_REJECTED');
        if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ERP2-Deadline-Bridge-Protocol, X-ERP2-Deadline-Bridge-Token, X-ERP2-Deadline-Extension-Id');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Vary', 'Origin');
        response.writeHead(204);
        response.end();
        return;
      }
      assertDeadlineBridgeOrigin(origin, request.headers['x-erp2-deadline-extension-id']);
      if (request.headers['x-erp2-deadline-bridge-protocol'] !== DEADLINE_LOCAL_BRIDGE_PROTOCOL) fail('PROTOCOL_MISMATCH');
      const url = new URL(request.url ?? '/', `http://${host}:${port}`);
      if (request.method === 'GET' && url.pathname === '/v1/session') {
        sendJson(response, 200, {
          protocol: DEADLINE_LOCAL_BRIDGE_PROTOCOL,
          sessionId,
          bridgeToken,
          expected: identity,
          databaseName: contracts.deadlineDatabaseName,
          stores: contracts.deadlineStoreNames,
        }, origin);
        return;
      }
      if (request.method !== 'POST' || request.headers['x-erp2-deadline-bridge-token'] !== bridgeToken) fail('SESSION_TOKEN_MISMATCH');
      const body = await readJsonBody(request);
      if (url.pathname === '/v1/error') {
        if (body?.protocol !== DEADLINE_LOCAL_BRIDGE_PROTOCOL || body?.sessionId !== sessionId
          || typeof body?.code !== 'string' || body.code.length > 240) fail('REMOTE_ERROR_INVALID');
        fail(`REMOTE_MAIN_WORLD_ERROR:${body.code}`);
      }
      if (url.pathname === '/v1/meta') {
        if (accumulator) fail('TRANSFER_ALREADY_STARTED');
        accumulator = createDeadlineBridgeAccumulator(body, { sessionId, expected, contracts });
        sendJson(response, 200, { result: 'PASS', ack: 'meta' }, origin);
        return;
      }
      if (url.pathname === '/v1/chunk') {
        if (!accumulator) fail('TRANSFER_NOT_STARTED');
        const ack = acceptDeadlineBridgeChunk(accumulator, body);
        sendJson(response, 200, { result: 'PASS', ack }, origin);
        return;
      }
      if (url.pathname === '/v1/complete') {
        if (!accumulator) fail('TRANSFER_NOT_STARTED');
        const { payload, serialized } = finalizeDeadlineBridgeAccumulator(accumulator, body);
        const verified = verifyDeadlineSidecar(payload, contracts);
        await writeFile(output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        const result = {
          result: 'PASS', output, bytes: Buffer.byteLength(serialized),
          fileSha256: deadlineBridgeSha256(serialized), verifierChecksum: verified.checksum,
          counts: verified.counts, totalRows: verified.totalRows,
          identity, attachment: DEADLINE_LOCAL_BRIDGE_ATTACHMENT, transactionMode: 'readonly',
        };
        sendJson(response, 200, { result: 'PASS', ack: 'complete' }, origin);
        if (!settled) { settled = true; resolveResult(result); }
        return;
      }
      fail('ROUTE_REJECTED');
    } catch (error) {
      sendJson(response, 400, { result: 'FAIL', code: String(error?.message ?? error) }, origin);
      closeWithError(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const timer = setTimeout(() => closeWithError(new Error('DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:TIMEOUT')), timeoutMs);
  try { return await resultPromise; }
  finally {
    clearTimeout(timer);
    await new Promise(resolve => server.close(resolve));
  }
}
