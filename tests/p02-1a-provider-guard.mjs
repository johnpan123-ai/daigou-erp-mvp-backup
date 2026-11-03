// P0-2 Phase 1a (C1 + C1a + C1b + C1d) exact provider guard closure: positive and negative proof.
// + waca-counted-transition-provider-v1 (WACA C17 / 073 provider pieces): positive and negative proof.
// Runs entirely on local Git objects; no network, no production access.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertReviewedProviderContract,
  restoreReviewedBuyAnimeV33ProviderPatch,
} from '../scripts/post-adoption-descendant.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASELINE = '5f73b2b02d9008dc863cf92978e6ea8e40a850ec'; // adopted schema baseline (checkpoint-20261010-buyanime-import-pipeline-stability-v3)
const showAt = (head, file) => execFileSync('git', ['-C', ROOT, 'show', `${head}:${file}`], { encoding: 'utf8' }).replace(/\r\n?/gu, '\n');
const show = file => { try { return showAt(BASELINE, file); } catch { return null; } };
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n?/gu, '\n');
const FILES = ['src/providers/cloud/cloudCacheWriteFence.ts', 'src/providers/cloud/cloudRealtimeReadiness.ts', 'src/providers/cloud/cloudSyncObservability.ts',
  'src/providers/cloud/supabaseProvider.ts', 'src/providers/cloud/cloudTargetedCache.ts', 'src/providers/dataProvider.ts', 'src/providers/cloud/cloudConnectivity.ts'];
const results = [];
const pass = (name, fn) => { try { fn(); results.push({ name, ok: true }); console.log('PASS', name); } catch (e) { results.push({ name, ok: false, error: String(e.message) }); console.log('FAIL', name, e.message); } };
const rejects = (name, file, before, after, pattern) => pass(`NEG ${name}`, () => assert.throws(() => assertReviewedProviderContract(file, before, after), pattern));
const mutate = (source, from, to) => { assert.ok(source.includes(from), `mutation anchor missing: ${from.slice(0, 40)}`); return source.replace(from, to); };

// ---- positive: the exact reviewed C1/C1a/C1b sources pass every provider rule
for (const file of FILES) pass(`POS exact reviewed source accepted: ${file}`, () => {
  const after = restoreReviewedBuyAnimeV33ProviderPatch(file, read(file));
  assertReviewedProviderContract(file, show(file), after);
});
pass('POS guard change is additive (stripping the p02 markers restores the previous guard byte-for-byte)', () => {
  // Prove the original additive patch against its immutable parent. Later guard
  // additions are exercised by the current-source positive and negative cases.
  const historicalAfter = '4de65bd61b4aee546d67ec362fc4353ea860508e';
  const historicalBefore = '78e41fd007ca7f95710f0afd5faa794f818faf09';
  assert.equal(execFileSync('git', ['-C', ROOT, 'rev-parse', `${historicalAfter}^`], { encoding: 'utf8' }).trim(), historicalBefore);
  const historicalSource = head => execFileSync('git', ['-C', ROOT, 'show', `${head}:scripts/post-adoption-descendant.mjs`], { encoding: 'utf8' }).replace(/\r\n?/gu, '\n');
  const current = historicalSource(historicalAfter);
  const original = historicalSource(historicalBefore);
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
const pBefore = show(provider), pCurrent = read(provider);
const pAfter = restoreReviewedBuyAnimeV33ProviderPatch(provider, pCurrent);
pass('POS exact BuyAnime patch restores before historical P02 review', () => {
  assert.notEqual(pAfter, pCurrent);
  assert.match(pCurrent, /import_sort_index: r\.import_sort_index \?\? undefined,/u);
  assert.match(pAfter, /import_sort_index: r\.import_sort_index \|\| undefined,/u);
});
pass('POS exact BuyAnime patch remains accepted against its deployed v33 baseline', () =>
  assertReviewedProviderContract(provider,
    showAt('ea0d5c7faca6e8522a27f2e08d44edf80b742ee2', provider), pCurrent));
rejects('BuyAnime import_sort_index differs from the exact reviewed patch', provider,
  showAt('ea0d5c7faca6e8522a27f2e08d44edf80b742ee2', provider),
  mutate(pCurrent, 'import_sort_index: r.import_sort_index ?? undefined,',
    'import_sort_index: r.import_sort_index ?? 1,'), /FAILED_CLOSED/u);
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
pass('POS original rule still accepts its reviewed patches against their legacy baseline (3347ef8a -> 536e7d69)', () => assertReviewedProviderContract(cache, showAt(LEGACY_BASE, cache), showAt(REVIEWED, cache)));
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

// ---- waca-counted-transition-provider-v1 (exact review): positive + negative proof
const wsp = 'src/providers/cloud/supabaseProvider.ts', wdp = 'src/providers/dataProvider.ts';
const wspAfter = restoreReviewedBuyAnimeV33ProviderPatch(wsp, read(wsp));
const wdpAfter = read(wdp), wspBefore = show(wsp), wdpBefore = show(wdp);
const WACA_DRIFT = name => new RegExp(`waca counted reviewed member drifted: ${name}`, 'u');
// Mutations of the counted write are scoped to that member (the legacy commitWacaSnapshot shares some lines).
const inCounted = (source, from, to) => { const at = source.indexOf('  /** 073 counted transition import'); assert.ok(at > 0, 'counted member anchor missing'); return source.slice(0, at) + mutate(source.slice(at), from, to); };
pass('POS waca counted: reviewed supabaseProvider pieces accepted, remainder judged by the unchanged rules', () => assertReviewedProviderContract(wsp, wspBefore, wspAfter));
pass('POS waca counted: reviewed dataProvider pieces accepted, remainder judged by the unchanged rules', () => assertReviewedProviderContract(wdp, wdpBefore, wdpAfter));
rejects('waca: commitWacaCountedSnapshot drift (message changed)', wsp, wspBefore, inCounted(wspAfter, "throw new Error('WACA 雲端寫入結果無法確認，請先重新讀取訂單與數量。');", "throw new Error('changed');"), WACA_DRIFT('commitWacaCountedSnapshot'));
rejects('waca: counted write calls another RPC', wsp, wspBefore, inCounted(wspAfter, "supabase.rpc('erp_commit_waca_counted_snapshot'", "supabase.rpc('erp_commit_waca_snapshot'"), WACA_DRIFT('commitWacaCountedSnapshot'));
rejects('waca: counted write gains a direct table write', wsp, wspBefore, inCounted(wspAfter, '    await this.requireCloudWritePermission();\n    let data: unknown;', "    await this.requireCloudWritePermission();\n    await supabase.from('product_variants').update({ waca_auto_quantity: 0 });\n    let data: unknown;"), WACA_DRIFT('commitWacaCountedSnapshot'));
rejects('waca: counted write loses the cloud write permission check', wsp, wspBefore, inCounted(wspAfter, '    await this.requireCloudWritePermission();\n    let data: unknown;', '    let data: unknown;'), WACA_DRIFT('commitWacaCountedSnapshot'));
rejects('waca: Restore epoch read gains a write', wsp, wspBefore, mutate(wspAfter, ".from('erp_cloud_restore_epoch').select('epoch,restored_at')", ".from('erp_cloud_restore_epoch').update({ epoch: 0 }).select('epoch,restored_at')"), WACA_DRIFT('readWacaRestoreEpoch'));
rejects('waca: reviewed member duplicated', wsp, wspBefore, mutate(wspAfter, '  async readCloudRestoreIntegrityAudit() {', "  async readWacaRestoreEpoch(): Promise<number> { return 0; }\n  async readCloudRestoreIntegrityAudit() {"), /waca counted reviewed member missing or duplicated: readWacaRestoreEpoch/u);
rejects('waca: reviewed member removed while its import stays', wsp, wspBefore, wspAfter.replace(/ {2}\/\*\* 073 counted transition import[\s\S]*?\n {2}\}\n\n/u, ''), /waca counted reviewed member missing or duplicated: commitWacaCountedSnapshot/u);
rejects('waca: reviewed type-only import turned into a value import', wsp, wspBefore, mutate(wspAfter, "import type { WacaCountedPlan } from '../../waca/countedImport';", "import { WacaCountedPlan } from '../../waca/countedImport';"), /waca counted reviewed import missing or duplicated/u);
rejects('waca: extra unreviewed import next to the reviewed one', wsp, wspBefore, mutate(wspAfter, "import type { WacaCountedPlan } from '../../waca/countedImport';", "import type { WacaCountedPlan } from '../../waca/countedImport';\nimport { planWacaCountedImport } from '../../waca/countedImport';"), /unreviewed top-level statement/u);
rejects('waca: new unreviewed provider member next to the reviewed ones', wsp, wspBefore, mutate(wspAfter, '  async readCloudRestoreIntegrityAudit() {', "  async wacaLeak(): Promise<void> { await supabase.rpc('erp_commit_waca_snapshot', {}); }\n  async readCloudRestoreIntegrityAudit() {"), /unreviewed provider member changed/u);
rejects('waca: unpinned provider member changed while the reviewed pieces are present', wsp, wspBefore, mutate(wspAfter, 'async canWriteCloud(): Promise<boolean> {', 'async canWriteCloud(): Promise<boolean> {\n    void 0;'), /unreviewed provider member changed/u);
rejects('waca: legacy auto-quantity refusal removed', wdp, wdpBefore, mutate(wdpAfter, "      if (updateAutoQuantity) throw new Error('WACA_LEGACY_QUANTITY_COMMIT_DISABLED');\n", ''), WACA_DRIFT('commitNextWacaSnapshot'));
rejects('waca: counted write bypasses the guarded write fence', wdp, wdpBefore, mutate(wdpAfter, 'return this.guardedWrite(() => this.supabaseProvider.commitWacaCountedSnapshot(snapshot, expectedRevision, plan));', 'return this.supabaseProvider.commitWacaCountedSnapshot(snapshot, expectedRevision, plan);'), WACA_DRIFT('commitWacaCountedSnapshot'));
rejects('waca: counted import enabled outside Cloud', wdp, wdpBefore, mutate(wdpAfter, "    return mode === 'cloud' || mode === 'fallback';\n  }\n  async readWacaRestoreEpoch", "    return true;\n  }\n  async readWacaRestoreEpoch"), WACA_DRIFT('supportsWacaCountedImport'));
rejects('waca: dataProvider epoch read drift', wdp, wdpBefore, mutate(wdpAfter, 'return this.supabaseProvider.readWacaRestoreEpoch();', 'return { epoch: 0, restoredAt: null };'), WACA_DRIFT('readWacaRestoreEpoch'));
rejects('waca: previous source of the modified member differs (not the reviewed baseline)', wdp, mutate(wdpBefore, "if (mode !== 'next') throw new Error('WACA_ENVIRONMENT_NOT_SUPPORTED');", "if (mode !== 'next') throw new Error('OTHER');"), wdpAfter, /waca counted reviewed member previous source mismatch: commitNextWacaSnapshot/u);
rejects('waca: reviewed pieces against a source without a previous version', wdp, null, wdpAfter, /unreviewed waca counted provider exception/u);
// The hash pin rejects every mutation first. To prove the explicit rules themselves, a temporary copy of the guard
// with ONLY the member hash comparison disabled judges each mutated source (test-only file, removed afterwards).
const wacaProbe = async (file, mutated) => {
  const anchor = "if (wacaPieceHash(newTree, now[0]) !== pin.after) fail(`waca counted reviewed member drifted: ${name}`);";
  assert.equal(guardSource.split(anchor).length, 2, 'waca hash check anchor must appear exactly once');
  const temp = fileURLToPath(new URL(`../scripts/.waca-rule-probe-${process.pid}-${probeSeq += 1}.mjs`, import.meta.url));
  writeFileSync(temp, guardSource.replace(anchor, '/* hash check disabled for the rule probe */'));
  try { (await import(pathToFileURL(temp).href)).assertReviewedProviderContract(file, file === wsp ? wspBefore : wdpBefore, mutated); return null; }
  catch (error) { return error; } finally { unlinkSync(temp); }
};
const wacaRule = async (name, file, mutated, pattern) => {
  const error = await wacaProbe(file, mutated);
  pass(`${pattern ? 'NEG' : 'POS'} waca rule: ${name}`, () => { if (pattern) assert.match(String(error?.message), pattern); else assert.equal(error, null); });
};
await wacaRule('probe sanity, reviewed supabaseProvider accepted without the hash check', wsp, wspAfter, null);
await wacaRule('probe sanity, reviewed dataProvider accepted without the hash check', wdp, wdpAfter, null);
await wacaRule('counted write may call only erp_commit_waca_counted_snapshot', wsp, inCounted(wspAfter, "supabase.rpc('erp_commit_waca_counted_snapshot'", "supabase.rpc('erp_commit_waca_snapshot'"), /waca counted write may call only erp_commit_waca_counted_snapshot/u);
await wacaRule('counted write may call the RPC only once', wsp, inCounted(wspAfter, '    if (error) { markCloudRequestFailed(error); throw error; }\n    const revision', "    if (error) { markCloudRequestFailed(error); throw error; }\n    await supabase.rpc('erp_commit_waca_counted_snapshot', {});\n    const revision"), /waca counted write may call only erp_commit_waca_counted_snapshot/u);
await wacaRule('counted write never writes a table directly', wsp, inCounted(wspAfter, '    await this.requireCloudWritePermission();\n    let data: unknown;', "    await this.requireCloudWritePermission();\n    await supabase.from('product_variants').update({ waca_auto_quantity: 0 });\n    let data: unknown;"), /waca counted reviewed code writes to Cloud directly: commitWacaCountedSnapshot/u);
await wacaRule('counted write keeps the cloud write permission check', wsp, inCounted(wspAfter, '    await this.requireCloudWritePermission();\n    let data: unknown;', '    let data: unknown;'), /waca counted write lost the cloud write permission check/u);
await wacaRule('Restore epoch read stays read-only (no write)', wsp, mutate(wspAfter, ".from('erp_cloud_restore_epoch').select('epoch,restored_at')", ".from('erp_cloud_restore_epoch').update({ epoch: 0 }).select('epoch,restored_at')"), /waca counted reviewed code writes to Cloud directly: readWacaRestoreEpoch/u);
await wacaRule('Restore epoch read stays read-only (no RPC)', wsp, mutate(wspAfter, "const result = await supabase.from('erp_cloud_restore_epoch')", "await supabase.rpc('erp_reset', {});\n    const result = await supabase.from('erp_cloud_restore_epoch')"), /waca counted reviewed code calls an RPC: readWacaRestoreEpoch/u);
await wacaRule('Restore epoch read reads only erp_cloud_restore_epoch', wsp, mutate(wspAfter, ".from('erp_cloud_restore_epoch').select('epoch,restored_at')", ".from('inventory_items').select('epoch,restored_at')"), /waca restore epoch read is not the exact read-only epoch select/u);
await wacaRule('legacy WACA auto-quantity write stays refused', wdp, mutate(wdpAfter, "      if (updateAutoQuantity) throw new Error('WACA_LEGACY_QUANTITY_COMMIT_DISABLED');\n", ''), /waca legacy auto-quantity write is not refused/u);
await wacaRule('counted write keeps the guarded write fence', wdp, mutate(wdpAfter, 'return this.guardedWrite(() => this.supabaseProvider.commitWacaCountedSnapshot(snapshot, expectedRevision, plan));', 'return this.supabaseProvider.commitWacaCountedSnapshot(snapshot, expectedRevision, plan);'), /waca counted write bypasses the guarded write fence/u);
await wacaRule('dataProvider pieces never call an RPC', wdp, mutate(wdpAfter, 'return this.supabaseProvider.readWacaRestoreEpoch();', "await this.supabaseProvider.rpc('erp_x');\n    return this.supabaseProvider.readWacaRestoreEpoch();"), /waca counted reviewed code calls an RPC: readWacaRestoreEpoch/u);

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ suite: 'P02_1A_PROVIDER_GUARD', total: results.length, passed: results.length - failed.length, failed: failed.length }, null, 1));
process.exit(failed.length ? 1 : 0);
