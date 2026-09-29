import { CANONICAL_ERP2_TARGET } from '../../scripts/promotion-safety.mjs';

export function assertCanonicalDeadlineCloudflareProof(proof, expected) {
  const fail = code => { throw new Error(`DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:${code}`); };
  if (!proof || proof.accountId !== expected.accountId) fail('CLOUDFLARE_ACCOUNT_MISMATCH');
  if (proof.project !== expected.project) fail('PAGES_PROJECT_MISMATCH');
  if (String(proof.domain ?? '').toLowerCase() !== String(expected.domain ?? '').toLowerCase()) {
    fail('PAGES_DOMAIN_MISMATCH');
  }
  return { accountId: proof.accountId, project: proof.project, domain: proof.domain };
}

export function assertCanonicalDeadlineRuntimeIdentity(input, expected) {
  const fail = code => { throw new Error(`DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:${code}`); };
  const manifest = input?.manifest;
  const target = manifest?.target ?? null;
  const cloudflare = input?.cloudflareProof;
  const system = input?.systemInformation;
  const hostname = String(input?.hostname ?? '').trim().toLowerCase();
  const expectedHostname = String(expected?.domain ?? '').trim().toLowerCase();
  if (!expectedHostname || !cloudflare || !system) fail('RUNTIME_EVIDENCE_INVALID');
  if (hostname !== expectedHostname) fail('PAGES_DOMAIN_MISMATCH');
  if (cloudflare.accountId !== expected.accountId) fail('CLOUDFLARE_ACCOUNT_MISMATCH');
  if (cloudflare.project !== expected.project || system['Cloudflare Project'] !== expected.project) {
    fail('PAGES_PROJECT_MISMATCH');
  }
  if (String(cloudflare.domain ?? '').toLowerCase() !== expectedHostname) fail('PAGES_DOMAIN_MISMATCH');
  if (system['Supabase Project'] !== expected.supabaseProject) fail('SUPABASE_PROJECT_MISMATCH');
  if (system['Public Fingerprint'] !== expected.publicFingerprint) fail('PUBLIC_FINGERPRINT_MISMATCH');
  if (manifest) {
    if (manifest.schemaVersion !== 2 || !target) fail('MANIFEST_INVALID');
    if (target.accountId !== expected.accountId) fail('CLOUDFLARE_ACCOUNT_MISMATCH');
    if (target.project !== expected.project) fail('PAGES_PROJECT_MISMATCH');
    if (target.supabaseProject !== expected.supabaseProject) fail('SUPABASE_PROJECT_MISMATCH');
    if (target.publicFingerprint !== expected.publicFingerprint) fail('PUBLIC_FINGERPRINT_MISMATCH');
    if (target.role !== expected.role) fail('TARGET_ROLE_MISMATCH');
  }
  return {
    accountId: cloudflare.accountId,
    project: system['Cloudflare Project'],
    supabaseProject: system['Supabase Project'],
    publicFingerprint: system['Public Fingerprint'],
    runtimeLabel: system['Environment Role'] ?? system.Runtime ?? target?.runtimeMarker ?? null,
    manifestVerified: Boolean(manifest),
  };
}

/** Build a browser-console script from the product's actual Deadline registry. */
export function buildDeadlineSidecarReadScript(contracts, options = {}) {
  const expected = options.expected ?? CANONICAL_ERP2_TARGET;
  const cloudflareProof = assertCanonicalDeadlineCloudflareProof(options.cloudflareProof, expected);
  const databaseName = JSON.stringify(contracts.deadlineDatabaseName);
  const stores = JSON.stringify(contracts.deadlineStoreNames);
  const expectedIdentity = JSON.stringify({
    role: expected.role,
    accountId: expected.accountId,
    project: expected.project,
    domain: expected.domain,
    supabaseProject: expected.supabaseProject,
    publicFingerprint: expected.publicFingerprint,
  });
  const verifiedCloudflareProof = JSON.stringify(cloudflareProof);
  const identityAssertion = assertCanonicalDeadlineRuntimeIdentity.toString();
  return `// ERP 2.0 pre-adoption Deadline durable export (READ-ONLY)\n(async () => {\n`
    + `  const databaseName = ${databaseName};\n  const stores = ${stores};\n`
    + `  const expectedIdentity = ${expectedIdentity};\n`
    + `  const cloudflareProof = ${verifiedCloudflareProof};\n`
    + `  const assertCanonicalDeadlineRuntimeIdentity = ${identityAssertion};\n`
    + `  const systemInformation = Object.fromEntries(Array.from(document.querySelectorAll('[aria-label="系統資訊"] dt')).map(term => [\n`
    + `    term.textContent?.trim() ?? '', term.nextElementSibling?.textContent?.trim() ?? '',\n  ]));\n`
    + `  if (!systemInformation['Cloudflare Project'] || !systemInformation['Supabase Project']\n`
    + `    || !systemInformation['Public Fingerprint']) {\n`
    + `    throw new Error('DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:SYSTEM_INFORMATION_REQUIRED');\n  }\n`
    + `  const identityResponse = await fetch('/erp-build-identity.json', {\n`
    + `    method: 'GET', credentials: 'same-origin', cache: 'no-store',\n`
    + `    headers: { Accept: 'application/json' },\n  });\n`
    + `  let manifest = null;\n`
    + `  if (identityResponse.ok && (identityResponse.headers.get('content-type') ?? '').includes('application/json')) {\n`
    + `    manifest = await identityResponse.json();\n`
    + `    if (!globalThis.crypto?.subtle) throw new Error('DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:WEB_CRYPTO_REQUIRED');\n`
    + `    const { identity, ...identityEvidence } = manifest;\n`
    + `    const identityBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identityEvidence)));\n`
    + `    const computedIdentity = Array.from(new Uint8Array(identityBytes), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();\n`
    + `    if (!identity || identity !== computedIdentity) throw new Error('DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:MANIFEST_IDENTITY_MISMATCH');\n`
    + `  } else if (!identityResponse.ok && identityResponse.status !== 404) {\n`
    + `    throw new Error('DEADLINE_RECOVERY_IDENTITY_FAILED_CLOSED:MANIFEST_READ_FAILED');\n  }\n`
    + `  const verifiedIdentity = assertCanonicalDeadlineRuntimeIdentity({\n`
    + `    hostname: location.hostname, cloudflareProof, systemInformation, manifest,\n  }, expectedIdentity);\n`
    + `  if (typeof indexedDB.databases !== 'function') throw new Error('INDEXEDDB_CATALOG_READ_REQUIRED');\n`
    + `  const catalog = await indexedDB.databases();\n`
    + `  if (!catalog.some(entry => entry.name === databaseName)) throw new Error('DEADLINE_SIDECAR_DATABASE_MISSING');\n`
    + `  const db = await new Promise((resolve, reject) => {\n`
    + `    const request = indexedDB.open(databaseName);\n`
    + `    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('DEADLINE_SIDECAR_CREATE_BLOCKED')); };\n`
    + `    request.onsuccess = () => resolve(request.result);\n`
    + `    request.onerror = () => reject(request.error);\n  });\n`
    + `  const result = await new Promise((resolve, reject) => {\n`
    + `    const tx = db.transaction(Object.values(stores), 'readonly');\n`
    + `    const data = {};\n`
    + `    for (const [key, store] of Object.entries(stores)) {\n`
    + `      const request = tx.objectStore(store).getAll();\n`
    + `      request.onsuccess = () => { data[key] = request.result; };\n    }\n`
    + `    tx.oncomplete = () => resolve(data);\n`
    + `    tx.onerror = () => reject(tx.error);\n`
    + `    tx.onabort = () => reject(tx.error);\n  });\n`
    + `  db.close();\n`
    + `  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });\n`
    + `  const url = URL.createObjectURL(blob);\n`
    + `  const anchor = document.createElement('a');\n`
    + `  anchor.href = url; anchor.download = 'erp2-deadline-durable-recovery.json';\n`
    + `  document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);\n`
    + `  console.info('Deadline durable recovery export complete:', {\n`
    + `    target: verifiedIdentity,\n`
    + `    counts: Object.fromEntries(Object.entries(result).map(([key, rows]) => [key, rows.length])),\n`
    + `  });\n`
    + `})();\n`;
}
