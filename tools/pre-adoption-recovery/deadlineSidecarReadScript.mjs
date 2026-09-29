/** Build a browser-console script from the product's actual Deadline registry. */
export function buildDeadlineSidecarReadScript(contracts) {
  const databaseName = JSON.stringify(contracts.deadlineDatabaseName);
  const stores = JSON.stringify(contracts.deadlineStoreNames);
  return `// ERP 2.0 pre-adoption Deadline durable export (READ-ONLY)\n(async () => {\n`
    + `  const databaseName = ${databaseName};\n  const stores = ${stores};\n`
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
    + `  console.info('Deadline durable recovery export complete:', Object.fromEntries(Object.entries(result).map(([key, rows]) => [key, rows.length])));\n`
    + `})();\n`;
}
