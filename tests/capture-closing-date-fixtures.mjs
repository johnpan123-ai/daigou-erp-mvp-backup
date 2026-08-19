import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/closing-date/dataset.json', import.meta.url));
const baseUrlArg = process.argv.find(arg => arg.startsWith('--base-url='));
const baseUrl = baseUrlArg?.slice('--base-url='.length) || process.env.CLOSING_DATE_CATALOG_BASE_URL || 'http://127.0.0.1:4192';
const shouldWrite = process.argv.includes('--write');
const refresh = process.argv.includes('--refresh');

assert(!/supabase/i.test(baseUrl), 'Capture base URL must not be Supabase');

const dataset = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
const capturedAt = new Date().toISOString();

for (const testCase of dataset.cases) {
  if (testCase.captureSource === 'offline-regression-fixture') continue;
  if (!refresh && testCase.catalogResponses?.length > 0) continue;

  const responses = [];
  for (const query of testCase.queries) {
    const url = `${baseUrl}/api/catalog/search?q=${encodeURIComponent(query)}&pageSize=8`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`${testCase.caseId}: ${url} -> HTTP ${response.status}`);
    const body = await response.json();
    responses.push({
      query,
      status: response.status,
      products: Array.isArray(body.products)
        ? body.products.map(product => ({
          id: product.id ?? null,
          name: product.name ?? product.title ?? null,
          url: product.url ?? null,
          slug: product.slug ?? null,
          sku: product.sku ?? null,
          janCode: product.janCode ?? null,
          manufacturer: product.manufacturer ?? null,
          brand: product.brand ? { name: product.brand.name ?? null } : null,
          catalog: product.catalog
            ? {
              supplier: product.catalog.supplier ? { code: product.catalog.supplier.code ?? null } : null,
              deadlineAt: product.catalog.deadlineAt ?? null,
            }
            : null,
        }))
        : [],
    });
  }
  testCase.catalogResponses = responses;
  testCase.capturedAt = capturedAt;
}

if (shouldWrite) {
  await writeFile(FIXTURE_PATH, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  console.log(`WROTE ${FIXTURE_PATH}`);
} else {
  console.log(JSON.stringify(dataset, null, 2));
  console.log('DRY RUN: no fixture file was written; pass --write to update tests/fixtures only.');
}
