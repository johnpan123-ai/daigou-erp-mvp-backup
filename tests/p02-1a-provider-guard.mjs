// P0-2 Phase 1a (C1 + C1a + C1b + C1d) exact provider guard closure: positive and negative proof.
// Runs entirely on local Git objects; no network, no production access.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertReviewedProviderContract } from '../scripts/post-adoption-descendant.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASELINE = '5f73b2b02d9008dc863cf92978e6ea8e40a850ec'; // adopted schema baseline (checkpoint-20261010-buyanime-import-pipeline-stability-v3)
const show = file => { try { return execFileSync('git', ['-C', ROOT, 'show', `${BASELINE}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const FILES = ['src/providers/cloud/cloudCacheWriteFence.ts', 'src/providers/cloud/cloudRealtimeReadiness.ts', 'src/providers/cloud/cloudSyncObservability.ts',
  'src/providers/cloud/supabaseProvider.ts', 'src/providers/cloud/cloudTargetedCache.ts', 'src/providers/dataProvider.ts', 'src/providers/cloud/cloudConnectivity.ts'];
const results = [];
const pass = (name, fn) => { try { fn(); results.push({ name, ok: true }); console.log('PASS', name); } catch (e) { results.push({ name, ok: false, error: String(e.message) }); console.log('FAIL', name, e.message); } };
const rejects = (name, file, before, after, pattern) => pass(`NEG ${name}`, () => assert.throws(() => assertReviewedProviderContract(file, before, after), pattern));
const mutate = (source, from, to) => { assert.ok(source.includes(from), `mutation anchor missing: ${from.slice(0, 40)}`); return source.replace(from, to); };

// ---- positive: the exact reviewed C1/C1a/C1b sources pass every provider rule
for (const file of FILES) pass(`POS exact reviewed source accepted: ${file}`, () => assertReviewedProviderContract(file, show(file), read(file)));
pass('POS guard change is additive (stripping the p02 markers restores the previous guard byte-for-byte)', () => {
  const current = read('scripts/post-adoption-descendant.mjs');
  const original = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:scripts/post-adoption-descendant.mjs'], { encoding: 'utf8' });
  const stripped = current
    .replace(/\/\/ ---- BEGIN p02-1a provider contract function[\s\S]*?\/\/ ---- END p02-1a provider contract function ----\n\n/u, '')
    .replace(/ {2}\/\/ ---- BEGIN p02-1a provider contract dispatch ----\n[\s\S]*? {2}\/\/ ---- END p02-1a provider contract dispatch ----\n/u, '')
    // C1f (exact review p02-phase1a-c1f-guard-v1): the realtime context blocks are additive too (tests/p02-1a-context-guard.mjs).
    .replace(/\/\/ ---- BEGIN p02-1a realtime context contract function[\s\S]*?\/\/ ---- END p02-1a realtime context contract function ----\n\n/u, '')
    .replace(/ {2}\/\/ ---- BEGIN p02-1a realtime context contract dispatch ----\n[\s\S]*? {2}\/\/ ---- END p02-1a realtime context contract dispatch ----\n/u, '');
  assert.equal(stripped, original);
});

const fence = 'src/providers/cloud/cloudCacheWriteFence.ts';
const readiness = 'src/providers/cloud/cloudRealtimeReadiness.ts';
const provider = 'src/providers/cloud/supabaseProvider.ts';
const cache = 'src/providers/cloud/cloudTargetedCache.ts';
const data = 'src/providers/dataProvider.ts';

// ---- negative: new modules are pinned byte-for-byte and must stay I/O free
rejects('fence module one-byte drift', fence, null, read(fence) + ' ', /p02 1a module differs/u);
rejects('fence module gains fetch I/O', fence, null, read(fence).replace('export const takeCloudReadToken', "export const leak = () => fetch('https://x.invalid');\nexport const takeCloudReadToken"), /p02 1a module differs/u);
rejects('readiness module treated as an existing file (needs new review)', readiness, read(readiness), read(readiness), /needs a new exact review/u);
rejects('unknown new provider file', 'src/providers/cloud/p02Extra.ts', null, 'export const x = 1;', /unreviewed provider contract exception/u);

// ---- positive: earlier exact reviews of these files are still judged by the unchanged pre-existing rules
pass('POS sources without any p02 piece fall through to the pre-existing rules (baseline vs baseline, provider)', () => assertReviewedProviderContract('src/providers/cloud/supabaseProvider.ts', show('src/providers/cloud/supabaseProvider.ts'), show('src/providers/cloud/supabaseProvider.ts')));

// ---- negative: modified provider files
const pBefore = show(provider), pAfter = read(provider);
rejects('pullCoreProductData gains a Cloud write', provider, pBefore, mutate(pAfter, "let query = supabase.from(table).select('*');", "await supabase.from(table).insert({});\n            let query = supabase.from(table).select('*');"), /reviewed member drifted: pullCoreProductData/u);
rejects('pullCoreProductData gains an RPC', provider, pBefore, mutate(pAfter, "syncRun.realtimeReadiness = readiness.state;", "syncRun.realtimeReadiness = readiness.state;\n          await supabase.rpc('erp_get_sync_token');"), /reviewed member drifted: pullCoreProductData/u);
rejects('awaitCoreSnapshotAfterRealtimeReady drift', provider, pBefore, mutate(pAfter, 'if (evidence.readyAt > evidence.readStartedAt) return false;', 'if (evidence.readyAt > evidence.readStartedAt + 1) return false;'), /reviewed member drifted: awaitCoreSnapshotAfterRealtimeReady/u);
rejects('readiness budget changed without review (C1b pin)', provider, pBefore, mutate(pAfter, 'const CORE_REALTIME_READINESS_WAIT_MS = 3000;', 'const CORE_REALTIME_READINESS_WAIT_MS = 2999;'), /unreviewed top-level statement/u);
rejects('unreviewed top-level statement added', provider, pBefore, mutate(pAfter, 'const KEYSET_PAGE_SIZE = 1000;', "const KEYSET_PAGE_SIZE = 1000;\nconst EXTRA_ENDPOINT = 'https://x.invalid';"), /unreviewed top-level statement/u);
rejects('baseline top-level statement removed', provider, pBefore, mutate(pAfter, "import { checkDataSizeWarnings } from '../../lib/dataSizeAdvisory';\n", ''), /baseline top-level statement removed|unreviewed/u);
rejects('unpinned provider member changed (existing rule still enforced)', provider, pBefore, mutate(pAfter, 'async canWriteCloud(): Promise<boolean> {', 'async canWriteCloud(): Promise<boolean> {\n    void 0;'), /unreviewed provider member changed/u);
rejects('new unreviewed provider member', provider, pBefore, mutate(pAfter, '  async waitForCloudBootstrapConvergence(): Promise<boolean> {', "  async leakRows(): Promise<void> { await supabase.from('inventory_items').delete().neq('id', ''); }\n\n  async waitForCloudBootstrapConvergence(): Promise<boolean> {"), /unreviewed provider member changed/u);

const cBefore = show(cache), cAfter = read(cache);
rejects('merge (pinned) drift', cache, cBefore, mutate(cAfter, 'noteSkippedStaleDelete();\n            continue;', 'continue;'), /reviewed member drifted: merge/u);
rejects('performRefresh (pinned) publishes Fresh without the barrier check', cache, cBefore, mutate(cAfter, "if (!cloudReadPassesEpochBarrier(refreshToken, request.authoritativeEpoch)) {", 'if (false) {'), /reviewed member drifted: performRefresh/u);
rejects('absorbVerifiedRows performs a Supabase read (existing rule)', cache, cBefore, mutate(cAfter, 'const readToken = takeCloudReadToken();', "const readToken = takeCloudReadToken();\n    await supabase.from('inventory_items').select('id');"), /unreviewed read/u);
rejects('protectRows (Draft Protection) changed (existing rule)', cache, cBefore, mutate(cAfter, 'if (cloudBusinessRowsEqual(before, after) || !this.protectsDraft(table, before, after)) continue;', 'continue;'), /draft\/generation\/cache contract changed/u);
rejects('unreviewed top-level helper added to cache', cache, cBefore, mutate(cAfter, 'const AUTHORITATIVE_PAGE_SIZE = 1000;', "const AUTHORITATIVE_PAGE_SIZE = 1000;\nexport const rawWrite = (k: string) => localStorage.setItem(k, '');"), /unreviewed top-level statement/u);

// ---- stale cloudTargetedCache rule: the original semantics are untouched outside the p02 review
const LEGACY_BASE = '3347ef8a'; const REVIEWED = '536e7d69'; // reviews buyanime-simple-flow-performance-v1 (e7185e8b) + buyanime-final-fast-import-v1
const gshow = (rev, file) => execFileSync('git', ['-C', ROOT, 'show', `${rev}:${file}`], { encoding: 'utf8' });
pass('POS original rule still accepts its reviewed patches against their legacy baseline (3347ef8a -> 536e7d69)', () => assertReviewedProviderContract(cache, gshow(LEGACY_BASE, cache), gshow(REVIEWED, cache)));
pass('POS original rule is NOT relaxed for non-p02 sources (unchanged adopted source still fails closed, as before)', () => assert.throws(() => assertReviewedProviderContract(cache, cBefore, cBefore), /draft\/generation\/cache contract changed/u));
rejects('p02 source reverting the adopted e7185e8 line (pinned performRefresh drift)', cache, cBefore, mutate(cAfter, "if (isAuthoritativeResourceRead || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty'))", "if ((!this.protectsDraft && !this.prepareDraftProtection) || (previousStatus !== 'fresh-online' && previousStatus !== 'fresh-empty'))"), /reviewed member drifted: performRefresh/u);

// ---- connectivity (no class, no pre-existing rule): only pinned statements may differ
const conn = 'src/providers/cloud/cloudConnectivity.ts';
const kBefore = show(conn), kAfter = read(conn);
rejects('connectivity: markCloudReadFresh ignores holds', conn, kBefore, mutate(kAfter, '  const held = heldState();\n  if (held) {', '  const held = null;\n  if (held) {'), /unreviewed top-level statement/u);
rejects('connectivity: write gate relaxed (unpinned statement changed)', conn, kBefore, mutate(kAfter, "if (snapshot.status !== 'online' || !hasFreshServerRead) throw new CloudOfflineWriteError();", 'return;'), /unreviewed top-level statement|unreviewed change outside/u);
rejects('connectivity: new network call added', conn, kBefore, mutate(kAfter, 'export const getCloudFreshHolds', "export const leak = () => fetch('https://x.invalid');\nexport const getCloudFreshHolds"), /unreviewed top-level statement/u);

const dBefore = show(data), dAfter = read(data);
rejects('dataProvider reviewed member drift', data, dBefore, mutate(dAfter, "if (getProviderMode() !== 'cloud') return false;\n    return this.supabaseProvider.awaitCoreSnapshotAfterRealtimeReady", "return this.supabaseProvider.awaitCoreSnapshotAfterRealtimeReady"), /reviewed member drifted: awaitCoreSnapshotAfterRealtimeReady|unreviewed provider member changed/u);

// ---- C1d (exact review p02-phase1a-c1d-v1): readiness -> diagnostics exact import only
const observability = 'src/providers/cloud/cloudSyncObservability.ts';
const EXACT_IMPORT = "import { noteRealtimeSystemOk, recordRealtimeSystemAnomaly } from './cloudSyncObservability';";
pass('POS readiness module contains exactly the one reviewed import', () => assert.equal(read(readiness).split('\n').filter(line => /^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/u.test(line)).join('\n'), EXACT_IMPORT));
rejects('readiness module one-byte drift', readiness, null, read(readiness) + ' ', /p02 1a module differs/u);
rejects('observability module gains fetch I/O', observability, null, read(observability).replace('export const noteRealtimeSystemOk', "export const leak = () => fetch('https://x.invalid');\nexport const noteRealtimeSystemOk"), /p02 1a module differs/u);
// The byte pin rejects every mutation first. To prove the import rule itself, each mutated
// source is checked by a temporary copy of this guard whose pin for that one file is the
// mutated source hash (test-only file next to the guard, removed afterwards).
const sha = text => createHash('sha256').update(text).digest('hex');
const guardSource = read('scripts/post-adoption-descendant.mjs');
let probeSeq = 0;
const probe = async (file, mutated) => {
  const pin = sha(read(file));
  assert.equal(guardSource.split(pin).length, 2, `pin for ${file} must appear exactly once`);
  const temp = fileURLToPath(new URL(`../scripts/.p02-import-probe-${process.pid}-${probeSeq += 1}.mjs`, import.meta.url));
  writeFileSync(temp, guardSource.replace(pin, sha(mutated)));
  try {
    const mod = await import(pathToFileURL(temp).href);
    mod.assertReviewedProviderContract(file, null, mutated);
    return null;
  } catch (error) { return error; } finally { unlinkSync(temp); }
};
const probeCase = async (name, file, mutated, pattern) => {
  const error = await probe(file, mutated);
  pass(`${pattern ? 'NEG' : 'POS'} import rule: ${name}`, () => { if (pattern) assert.match(String(error?.message), pattern); else assert.equal(error, null); });
};
const rSrc = read(readiness), oSrc = read(observability), fSrc = read(fence);
await probeCase('probe sanity, re-pinned unchanged readiness accepted', readiness, rSrc, null);
await probeCase('readiness adds a second import', readiness, rSrc.replace(EXACT_IMPORT, `${EXACT_IMPORT}\nimport { markCloudReadFresh } from './cloudConnectivity';`), /p02 1a module dependency changed/u);
await probeCase('readiness imports the recorders from another module', readiness, rSrc.replace("from './cloudSyncObservability';", "from './cloudConnectivity';"), /p02 1a module dependency changed/u);
await probeCase('readiness uses a namespace import', readiness, rSrc.replace(EXACT_IMPORT, "import * as diagnostics from './cloudSyncObservability';"), /p02 1a module dependency changed/u);
await probeCase('readiness imports an extra binding', readiness, rSrc.replace('recordRealtimeSystemAnomaly }', 'recordRealtimeSystemAnomaly, getCloudSyncDiagnostics }'), /p02 1a module dependency changed/u);
await probeCase('readiness adds export-from', readiness, `${rSrc}\nexport * from './cloudSyncObservability';\n`, /p02 1a module dependency changed/u);
await probeCase('readiness adds a dynamic import', readiness, `${rSrc}\nexport const lazy = () => import('./cloudConnectivity');\n`, /p02 1a module dynamic import/u);
await probeCase('observability gains any import (no allowance)', observability, `import { getRealtimeReadiness } from './cloudRealtimeReadiness';\n${oSrc}`, /p02 1a module dependency changed/u);
await probeCase('fence gains any import (no allowance)', fence, `import { noteRealtimeSystemOk } from './cloudSyncObservability';\n${fSrc}`, /p02 1a module dependency changed/u);
await probeCase('observability gains network I/O', observability, `${oSrc}\nexport const leak = () => fetch('https://x.invalid');\n`, /network\/persistence I\/O/u);

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ suite: 'P02_1A_PROVIDER_GUARD', total: results.length, passed: results.length - failed.length, failed: failed.length }, null, 1));
process.exit(failed.length ? 1 : 0);
