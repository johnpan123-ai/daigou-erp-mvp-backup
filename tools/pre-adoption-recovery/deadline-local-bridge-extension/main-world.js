(() => {
  const PROTOCOL = 'ERP2_DEADLINE_LOCAL_BRIDGE_V1';
  const ATTACHMENT = 'MAIN_WORLD_EXTENSION_LOOPBACK';
  const ERP2_ORIGIN = 'https://hippo-erp-realtime-preview.pages.dev';
  const CHUNK_BYTES = 128 * 1024;
  const pendingAcks = new Map();
  let running = false;

  const fail = code => { throw new Error(`DEADLINE_LOCAL_BRIDGE_FAILED_CLOSED:${code}`); };
  const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const toBase64 = bytes => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary);
  };
  const systemInformation = () => Object.fromEntries(Array.from(
    document.querySelectorAll('[aria-label="系統資訊"] dt'),
  ).map(term => [term.textContent?.trim() ?? '', term.nextElementSibling?.textContent?.trim() ?? '']));

  const assertRuntimeIdentity = async expected => {
    if (location.origin !== ERP2_ORIGIN || location.pathname !== '/settings') fail('PAGES_DOMAIN_MISMATCH');
    const system = systemInformation();
    if (expected?.domain !== location.hostname || expected?.project !== system['Cloudflare Project']) fail('PAGES_PROJECT_MISMATCH');
    if (expected?.supabaseProject !== system['Supabase Project']) fail('SUPABASE_PROJECT_MISMATCH');
    if (expected?.publicFingerprint !== system['Public Fingerprint']) fail('PUBLIC_FINGERPRINT_MISMATCH');
    const response = await fetch('/erp-build-identity.json', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.includes('application/json')) {
      const manifest = await response.json();
      const target = manifest?.target;
      if (manifest?.schemaVersion !== 2 || target?.accountId !== expected.accountId
        || target?.project !== expected.project || target?.supabaseProject !== expected.supabaseProject
        || target?.publicFingerprint !== expected.publicFingerprint) fail('MANIFEST_IDENTITY_MISMATCH');
    } else if (!response.ok && response.status !== 404) fail('MANIFEST_READ_FAILED');
    return system;
  };

  const readStoresReadonly = async ({ databaseName, stores }) => {
    if (typeof indexedDB?.databases !== 'function') fail('INDEXEDDB_CATALOG_UNAVAILABLE');
    const catalog = await indexedDB.databases();
    if (!catalog.some(entry => entry.name === databaseName)) fail('DEADLINE_DATABASE_MISSING');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('DATABASE_CREATION_BLOCKED')); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      for (const store of Object.values(stores)) if (!db.objectStoreNames.contains(store)) fail('DURABLE_STORE_MISSING');
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(Object.values(stores), 'readonly');
        const result = {};
        for (const [key, store] of Object.entries(stores)) {
          const request = tx.objectStore(store).getAll();
          request.onsuccess = () => { result[key] = request.result; };
          request.onerror = () => reject(request.error);
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  };

  const postWithAck = payload => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingAcks.delete(payload.ackKey); reject(new Error('ACK_TIMEOUT')); }, 30_000);
    pendingAcks.set(payload.ackKey, () => { clearTimeout(timer); resolve(); });
    window.postMessage(payload, ERP2_ORIGIN);
  });

  const run = async start => {
    if (running) return;
    running = true;
    const transferId = crypto.randomUUID();
    try {
      await assertRuntimeIdentity(start.expected);
      const payload = await readStoresReadonly(start);
      const encoder = new TextEncoder();
      const storeMeta = {};
      const storeChunks = {};
      for (const [key, physicalName] of Object.entries(start.stores)) {
        const rows = payload[key];
        if (!Array.isArray(rows)) fail('DURABLE_STORE_RESULT_INVALID');
        const bytes = encoder.encode(JSON.stringify(rows));
        const chunks = [];
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) chunks.push(bytes.slice(offset, offset + CHUNK_BYTES));
        storeChunks[key] = chunks.length ? chunks : [encoder.encode('[]')];
        storeMeta[key] = {
          physicalName, rowCount: rows.length, totalBytes: bytes.length,
          totalChunks: storeChunks[key].length, sha256: await sha256(bytes),
        };
      }
      const serialized = `${JSON.stringify(payload, null, 2)}\n`;
      const fileSha256 = await sha256(encoder.encode(serialized));
      const metaAck = `meta:${transferId}`;
      await postWithAck({
        protocol: PROTOCOL, type: 'ERP2_DEADLINE_BRIDGE_META', ackKey: metaAck,
        sessionId: start.sessionId, transferId, fileSha256, stores: storeMeta,
        identity: { attachment: ATTACHMENT, ...start.expected },
      });
      for (const [store, chunks] of Object.entries(storeChunks)) {
        for (let sequence = 0; sequence < chunks.length; sequence += 1) {
          const bytes = chunks[sequence];
          const ackKey = `chunk:${transferId}:${store}:${sequence}`;
          await postWithAck({
            protocol: PROTOCOL, type: 'ERP2_DEADLINE_BRIDGE_CHUNK', ackKey,
            sessionId: start.sessionId, transferId, store,
            rowCount: storeMeta[store].rowCount, sequence, totalChunks: chunks.length,
            checksum: await sha256(bytes), payload: toBase64(bytes),
          });
        }
      }
      const completeAck = `complete:${transferId}`;
      await postWithAck({
        protocol: PROTOCOL, type: 'ERP2_DEADLINE_BRIDGE_COMPLETE', ackKey: completeAck,
        sessionId: start.sessionId, transferId, fileSha256,
      });
      window.postMessage({ protocol: PROTOCOL, type: 'ERP2_DEADLINE_BRIDGE_DONE', sessionId: start.sessionId, transferId }, ERP2_ORIGIN);
    } catch (error) {
      window.postMessage({
        protocol: PROTOCOL, type: 'ERP2_DEADLINE_BRIDGE_MAIN_ERROR',
        sessionId: start.sessionId, transferId,
        code: String(error?.message ?? error).slice(0, 240),
      }, ERP2_ORIGIN);
    }
  };

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== ERP2_ORIGIN || event.data?.protocol !== PROTOCOL) return;
    if (event.data.type === 'ERP2_DEADLINE_BRIDGE_ACK') {
      const resolve = pendingAcks.get(event.data.ackKey);
      if (resolve) { pendingAcks.delete(event.data.ackKey); resolve(); }
      return;
    }
    if (event.data.type === 'ERP2_DEADLINE_BRIDGE_START') void run(event.data);
  }, false);
  window.postMessage({ protocol: PROTOCOL, type: 'ERP2_DEADLINE_BRIDGE_READY' }, ERP2_ORIGIN);
})();
