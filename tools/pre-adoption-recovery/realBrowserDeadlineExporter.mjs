import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { CANONICAL_ERP2_TARGET } from '../../scripts/promotion-safety.mjs';
import { verifyDeadlineSidecar } from './contract.mjs';
import { assertCanonicalDeadlineRuntimeIdentity } from './deadlineSidecarReadScript.mjs';

export const REAL_BROWSER_ATTACHMENT_METHOD = 'PLAYWRIGHT_CONNECT_OVER_CDP';

const fail = code => { throw new Error(`DEADLINE_REAL_BROWSER_EXPORT_FAILED_CLOSED:${code}`); };

const parseLoopbackEndpoint = value => {
  let endpoint;
  try { endpoint = new URL(value); }
  catch { fail('CDP_ENDPOINT_INVALID'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)) fail('CDP_ENDPOINT_INVALID');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) fail('CDP_ENDPOINT_NOT_LOOPBACK');
  return endpoint.href;
};

export function assertRealBrowserAttachment(input) {
  if (input?.method !== REAL_BROWSER_ATTACHMENT_METHOD) fail('ISOLATED_CONTEXT_REJECTED');
  return { method: input.method, endpoint: parseLoopbackEndpoint(input.endpoint) };
}

const readRuntimeEvidence = async page => page.evaluate(async () => {
  const systemInformation = Object.fromEntries(Array.from(
    document.querySelectorAll('[aria-label="系統資訊"] dt'),
  ).map(term => [term.textContent?.trim() ?? '', term.nextElementSibling?.textContent?.trim() ?? '']));
  const response = await fetch('/erp-build-identity.json', {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
  });
  let manifest = null;
  if (response.ok && (response.headers.get('content-type') ?? '').includes('application/json')) {
    manifest = await response.json();
    if (!crypto?.subtle) throw new Error('DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:WEB_CRYPTO_REQUIRED');
    const { identity, ...identityEvidence } = manifest;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identityEvidence)));
    const computed = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (!identity || identity !== computed) {
      throw new Error('DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:MANIFEST_IDENTITY_MISMATCH');
    }
  } else if (!response.ok && response.status !== 404) {
    throw new Error('DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:MANIFEST_READ_FAILED');
  }
  return {
    hostname: location.hostname,
    origin: location.origin,
    indexedDBAvailable: typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function',
    systemInformation,
    manifest,
  };
});

const readDurableStores = async (page, contracts) => page.evaluate(async ({ databaseName, stores }) => {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('DEADLINE_REAL_BROWSER_EXPORT_FAILED_CLOSED:INDEXEDDB_CATALOG_UNAVAILABLE');
  }
  const catalog = await indexedDB.databases();
  if (!catalog.some(entry => entry.name === databaseName)) {
    throw new Error('DEADLINE_REAL_BROWSER_EXPORT_FAILED_CLOSED:DEADLINE_DATABASE_MISSING');
  }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error('DEADLINE_REAL_BROWSER_EXPORT_FAILED_CLOSED:DATABASE_CREATION_BLOCKED'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(Object.values(stores), 'readonly');
      const result = {};
      for (const [key, storeName] of Object.entries(stores)) {
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => { result[key] = request.result; };
        request.onerror = () => reject(request.error);
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}, {
  databaseName: contracts.deadlineDatabaseName,
  stores: contracts.deadlineStoreNames,
});

export async function exportDeadlineSidecarFromPage({
  page,
  contracts,
  cloudflareProof,
  output,
  attachment,
  expected = CANONICAL_ERP2_TARGET,
}) {
  const verifiedAttachment = assertRealBrowserAttachment(attachment);
  const runtime = await readRuntimeEvidence(page);
  if (runtime.origin !== `https://${expected.domain}` || !runtime.indexedDBAvailable) {
    fail('REAL_ERP2_ORIGIN_CONTEXT_REQUIRED');
  }
  const identity = assertCanonicalDeadlineRuntimeIdentity({
    hostname: runtime.hostname,
    cloudflareProof,
    systemInformation: runtime.systemInformation,
    manifest: runtime.manifest,
  }, expected);
  const payload = await readDurableStores(page, contracts);
  const verified = verifyDeadlineSidecar(payload, contracts);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return {
    result: 'PASS',
    output,
    bytes: Buffer.byteLength(serialized),
    fileSha256: createHash('sha256').update(serialized).digest('hex'),
    verifierChecksum: verified.checksum,
    counts: verified.counts,
    totalRows: verified.totalRows,
    identity,
    attachment: verifiedAttachment,
    transactionMode: 'readonly',
  };
}

export async function exportDeadlineSidecarFromCdp({
  cdpUrl,
  contracts,
  cloudflareProof,
  output,
  expected = CANONICAL_ERP2_TARGET,
}) {
  const attachment = assertRealBrowserAttachment({
    method: REAL_BROWSER_ATTACHMENT_METHOD,
    endpoint: cdpUrl,
  });
  let browser;
  try {
    browser = await chromium.connectOverCDP(attachment.endpoint);
  } catch {
    fail('CDP_CONNECTION_UNAVAILABLE');
  }
  let createdPage = null;
  try {
    const contexts = browser.contexts();
    const pages = contexts.flatMap(context => context.pages());
    const matching = pages.filter(page => {
      try { return new URL(page.url()).hostname === expected.domain; }
      catch { return false; }
    });
    let page = matching.find(candidate => new URL(candidate.url()).pathname === '/settings') ?? matching[0];
    if (!page) {
      const context = contexts[0];
      if (!context) fail('CHROME_CONTEXT_NOT_FOUND');
      createdPage = await context.newPage();
      await createdPage.goto(`https://${expected.domain}/settings`, { waitUntil: 'domcontentloaded' });
      page = createdPage;
    }
    return await exportDeadlineSidecarFromPage({
      page, contracts, cloudflareProof, output, attachment, expected,
    });
  } finally {
    if (createdPage) await createdPage.close();
    // For a connected Browser, Playwright close() disconnects from the browser
    // server; it does not terminate the externally launched Chrome process.
    await browser.close();
  }
}
