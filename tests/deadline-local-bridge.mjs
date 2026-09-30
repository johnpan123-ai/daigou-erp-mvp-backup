import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CANONICAL_ERP2_TARGET } from '../scripts/promotion-safety.mjs';
import { verifyDeadlineSidecar } from '../tools/pre-adoption-recovery/contract.mjs';
import { runDeadlineLocalBridge } from '../tools/pre-adoption-recovery/deadlineLocalBridgeServer.mjs';
import {
  DEADLINE_LOCAL_BRIDGE_ATTACHMENT,
  DEADLINE_LOCAL_BRIDGE_CHUNK_BYTES,
  DEADLINE_LOCAL_BRIDGE_PROTOCOL,
  acceptDeadlineBridgeChunk,
  assertDeadlineBridgeOrigin,
  createDeadlineBridgeAccumulator,
  deadlineBridgeSha256,
  finalizeDeadlineBridgeAccumulator,
} from '../tools/pre-adoption-recovery/deadlineLocalBridgeProtocol.mjs';
import { loadProductContracts } from '../tools/pre-adoption-recovery/productContracts.mjs';

const root = resolve('.');
const contracts = await loadProductContracts(root);
const target = CANONICAL_ERP2_TARGET;
const identity = {
  attachment: DEADLINE_LOCAL_BRIDGE_ATTACHMENT,
  accountId: target.accountId,
  project: target.project,
  domain: target.domain,
  supabaseProject: target.supabaseProject,
  publicFingerprint: target.publicFingerprint,
};
const fixture = {
  deadlineVerifiedMappings: [{ id: 'mapping-1', mapping: { verified: true } }],
  deadlineApplyBatches: [{ id: 'batch-1', result: 'PASS' }],
  deadlineApplyItems: [{ id: 'item-1', applyBatchId: 'batch-1' }],
};

const makeTransfer = (payload = fixture, chunkBytes = 19) => {
  const transferId = 'fixture-transfer';
  const sessionId = 'fixture-session';
  const stores = {};
  const chunks = [];
  for (const [key, physicalName] of Object.entries(contracts.deadlineStoreNames)) {
    const bytes = Buffer.from(JSON.stringify(payload[key]), 'utf8');
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) parts.push(bytes.subarray(offset, offset + chunkBytes));
    stores[key] = {
      physicalName, rowCount: payload[key].length, totalBytes: bytes.length,
      totalChunks: parts.length, sha256: deadlineBridgeSha256(bytes),
    };
    parts.forEach((part, sequence) => chunks.push({
      protocol: DEADLINE_LOCAL_BRIDGE_PROTOCOL,
      type: 'ERP2_DEADLINE_BRIDGE_CHUNK',
      sessionId, transferId, store: key, rowCount: payload[key].length,
      sequence, totalChunks: parts.length, checksum: deadlineBridgeSha256(part),
      payload: part.toString('base64'),
    }));
  }
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const meta = {
    protocol: DEADLINE_LOCAL_BRIDGE_PROTOCOL,
    type: 'ERP2_DEADLINE_BRIDGE_META',
    sessionId, transferId, identity, stores, fileSha256: deadlineBridgeSha256(serialized),
  };
  const complete = {
    protocol: DEADLINE_LOCAL_BRIDGE_PROTOCOL,
    type: 'ERP2_DEADLINE_BRIDGE_COMPLETE',
    sessionId, transferId, fileSha256: meta.fileSha256,
  };
  return { sessionId, meta, chunks, complete, serialized };
};

const valid = makeTransfer();
const accumulator = createDeadlineBridgeAccumulator(valid.meta, {
  sessionId: valid.sessionId, expected: target, contracts,
});
for (const chunk of valid.chunks) acceptDeadlineBridgeChunk(accumulator, chunk);
const finalized = finalizeDeadlineBridgeAccumulator(accumulator, valid.complete);
assert.equal(finalized.serialized, valid.serialized);
assert.deepEqual(finalized.payload, fixture);
console.log('PASS deterministic chunks reconstruct the canonical Deadline JSON independent of chunk boundaries');

for (const [label, mutate, code] of [
  ['wrong account', meta => { meta.identity.accountId = 'wrong'; }, 'CLOUDFLARE_ACCOUNT_MISMATCH'],
  ['wrong project', meta => { meta.identity.project = 'wrong'; }, 'PAGES_PROJECT_MISMATCH'],
  ['wrong domain', meta => { meta.identity.domain = 'wrong.example'; }, 'PAGES_DOMAIN_MISMATCH'],
  ['wrong Supabase ref', meta => { meta.identity.supabaseProject = 'wrong'; }, 'SUPABASE_PROJECT_MISMATCH'],
  ['wrong fingerprint', meta => { meta.identity.publicFingerprint = 'WRONG'; }, 'PUBLIC_FINGERPRINT_MISMATCH'],
  ['isolated evaluator', meta => { meta.identity.attachment = 'ISOLATED_BROWSER_EVALUATE'; }, 'ISOLATED_WORLD_REJECTED'],
]) {
  const changed = structuredClone(valid.meta);
  mutate(changed);
  assert.throws(() => createDeadlineBridgeAccumulator(changed, {
    sessionId: valid.sessionId, expected: target, contracts,
  }), new RegExp(code, 'u'), label);
}
assert.throws(() => assertDeadlineBridgeOrigin('https://evil.example', 'a'.repeat(32)), /EXTENSION_ORIGIN_REJECTED/u);
assert.throws(() => assertDeadlineBridgeOrigin('', ''), /EXTENSION_ID_REJECTED/u);
assert.deepEqual(assertDeadlineBridgeOrigin('', 'a'.repeat(32)),
  { extensionId: 'a'.repeat(32), origin: null });
assert.deepEqual(assertDeadlineBridgeOrigin(`chrome-extension://${'a'.repeat(32)}`, 'a'.repeat(32)),
  { extensionId: 'a'.repeat(32), origin: `chrome-extension://${'a'.repeat(32)}` });
console.log('PASS wrong identity and isolated-world senders fail closed');

const corruptAccumulator = createDeadlineBridgeAccumulator(valid.meta, {
  sessionId: valid.sessionId, expected: target, contracts,
});
const corruptChunk = { ...valid.chunks[0], payload: Buffer.from('corrupt').toString('base64') };
assert.throws(() => acceptDeadlineBridgeChunk(corruptAccumulator, corruptChunk), /CHUNK_CORRUPT/u);
const missingAccumulator = createDeadlineBridgeAccumulator(valid.meta, {
  sessionId: valid.sessionId, expected: target, contracts,
});
for (const chunk of valid.chunks.slice(1)) {
  if (chunk.sequence === 0) acceptDeadlineBridgeChunk(missingAccumulator, chunk);
}
assert.throws(() => finalizeDeadlineBridgeAccumulator(missingAccumulator, valid.complete), /CHUNK_MISSING/u);
console.log('PASS corrupt and missing chunks fail closed');

const extensionRoot = resolve(root, 'tools/pre-adoption-recovery/deadline-local-bridge-extension');
const manifest = JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'));
const mainWorld = await readFile(resolve(extensionRoot, 'main-world.js'), 'utf8');
const isolated = await readFile(resolve(extensionRoot, 'content-script.js'), 'utf8');
const background = await readFile(resolve(extensionRoot, 'service-worker.js'), 'utf8');
assert.deepEqual(manifest.content_scripts.map(row => row.world), ['MAIN', 'ISOLATED']);
assert.deepEqual(manifest.content_scripts.flatMap(row => row.matches), [
  `https://${target.domain}/settings*`, `https://${target.domain}/settings*`,
]);
assert.match(mainWorld, /transaction\(Object\.values\(stores\), 'readonly'\)/u);
assert.match(mainWorld, /indexedDB\.databases\(\)/u);
assert.match(mainWorld, /DEADLINE_DATABASE_MISSING/u);
for (const source of [mainWorld, isolated, background]) {
  assert.doesNotMatch(source, /document\.cookie|chrome\.cookies|localStorage|sessionStorage|Authorization/u);
}
for (const mutation of ['readwrite', '.put(', '.add(', '.clear(', 'createObjectStore', 'deleteDatabase']) {
  assert.equal(mainWorld.includes(mutation), false, `main-world source must exclude ${mutation}`);
}
assert.doesNotMatch(mainWorld, /objectStore\([^)]*\)\.delete\(/u);
assert.match(background, /credentials: 'omit'/u);
assert.equal(DEADLINE_LOCAL_BRIDGE_CHUNK_BYTES, 128 * 1024);
console.log('PASS MAIN/ISOLATED worlds, readonly enforcement, missing DB guard, and no credential access are explicit');

const temporaryRoot = await mkdtemp(join(tmpdir(), 'erp2-deadline-local-bridge-'));
const output = join(temporaryRoot, 'erp2-deadline-durable-recovery.json');
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(error => (error ? reject(error) : resolvePort(address.port)));
  });
});
const receiver = runDeadlineLocalBridge({
  output, contracts,
  cloudflareProof: { accountId: target.accountId, project: target.project, domain: target.domain },
  expected: target, port, timeoutMs: 20_000,
});
const extensionOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const commonHeaders = {
  Origin: extensionOrigin,
  'X-ERP2-Deadline-Bridge-Protocol': DEADLINE_LOCAL_BRIDGE_PROTOCOL,
  'X-ERP2-Deadline-Extension-Id': 'a'.repeat(32),
};
let sessionResponse;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    sessionResponse = await fetch(`http://127.0.0.1:${port}/v1/session`, { headers: commonHeaders });
    if (sessionResponse.ok) break;
  } catch { /* wait for the loopback listener */ }
  await delay(20);
}
assert.equal(sessionResponse?.ok, true);
const session = await sessionResponse.json();
const e2e = makeTransfer(fixture, 17);
e2e.meta.sessionId = session.sessionId;
e2e.complete.sessionId = session.sessionId;
for (const chunk of e2e.chunks) chunk.sessionId = session.sessionId;
const post = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: {
      ...commonHeaders, 'Content-Type': 'application/json',
      'X-ERP2-Deadline-Bridge-Token': session.bridgeToken,
    }, body: JSON.stringify(body),
  });
  assert.equal(response.ok, true, await response.text());
};
await post('/v1/meta', e2e.meta);
for (const chunk of e2e.chunks) await post('/v1/chunk', chunk);
await post('/v1/complete', e2e.complete);
const result = await receiver;
assert.equal(result.result, 'PASS');
assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), fixture);
assert.equal(verifyDeadlineSidecar(fixture, contracts).result, 'PASS');
await rm(temporaryRoot, { recursive: true, force: true });
console.log('PASS loopback receiver writes one create-only verified file without browser download polling');

await assert.rejects(() => runDeadlineLocalBridge({
  output: join(tmpdir(), 'must-not-exist.json'), contracts,
  cloudflareProof: { accountId: 'wrong', project: target.project, domain: target.domain },
  expected: target, port,
}), /CLOUDFLARE_ACCOUNT_MISMATCH/u);

console.log(JSON.stringify({
  result: 'PASS', mainWorld: true, isolatedWorldRejected: true, readonly: true,
  chunkCorruptionRejected: true, missingChunkRejected: true, credentialAccess: false,
  browserDownloadPolling: false, liveMutation: 0,
}));
