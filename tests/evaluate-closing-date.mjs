import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4265;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/closing-date/dataset.json', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const forbiddenRequests = [];
  page.on('request', request => {
    if (/\/api\/|\.supabase\.co\//i.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const results = await page.evaluate(async (input) => {
    const matching = await import('/src/lib/proxyProductIdentity.ts');
    const formatDate = (raw) => {
      if (!raw) return null;
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return null;
      date.setDate(date.getDate() - 2);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    const output = [];
    for (const testCase of input.cases) {
      const candidates = testCase.catalogResponses.flatMap(response => response.products || []);
      const selection = matching.selectProxyCatalogCandidate(testCase.erpProduct.title, candidates);
      const status = selection.status === 'match' ? 'MATCH' : selection.status === 'ambiguous' ? 'AMBIGUOUS' : 'NOT_FOUND';
      const candidate = selection.status === 'match' ? selection.candidate : null;
      output.push({
        caseId: testCase.caseId,
        status,
        candidateId: candidate?.id ?? null,
        supplier: candidate?.catalog?.supplier?.code ?? null,
        rawDeadline: candidate?.catalog?.deadlineAt ?? null,
        closingDate: formatDate(candidate?.catalog?.deadlineAt),
        confidence: selection.confidence,
        reason: selection.status === 'match' ? null : selection.message,
      });
    }
    return output;
  }, fixture);

  const summary = { total: results.length, pass: 0, knownFailure: 0, ambiguous: 0, regression: 0 };
  for (const result of results) {
    const expected = fixture.cases.find(item => item.caseId === result.caseId).expected;
    if (expected.status === 'KNOWN_FAILURE') {
      summary.knownFailure += 1;
      assert.equal(result.status, 'NOT_FOUND', `${result.caseId} known failure must remain explicit NOT_FOUND`);
      console.log(`KNOWN FAILURE ${result.caseId}: retrieval missing; no write candidate`);
      continue;
    }
    if (result.status === 'AMBIGUOUS') summary.ambiguous += 1;
    const matches = expected.status === result.status
      && (expected.candidateId === undefined || expected.candidateId === result.candidateId)
      && (expected.supplier === undefined || expected.supplier === result.supplier)
      && (expected.rawDeadline === undefined || expected.rawDeadline === result.rawDeadline)
      && (expected.closingDate === undefined || expected.closingDate === result.closingDate);
    if (matches) {
      summary.pass += 1;
      console.log(`PASS ${result.caseId}: ${result.status} ${result.candidateId || ''}`.trim());
    } else {
      summary.regression += 1;
      console.log(`REGRESSION ${result.caseId}: expected ${JSON.stringify(expected)} got ${JSON.stringify(result)}`);
    }
  }

  assert.deepEqual(forbiddenRequests, [], 'Offline replay must not call Catalog API or Supabase');
  assert.equal(summary.regression, 0, 'Offline evaluation found a regression');
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  console.log('PASS offline replay issued 0 Catalog / Supabase network requests');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
