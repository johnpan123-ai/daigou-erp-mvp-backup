// P0-1 Phase 2 (G-1) provider-contract guard closure: positive + negative cases.
// Proves the two exact Restore OPS provider files pass ONLY in their reviewed form,
// that every listed bypass fails closed, that the closure is purely additive
// (no existing guard rule changed or relaxed), and that other provider files
// still fail exactly as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertReviewedProviderContract, assertRestoreOpsMaintenanceContract, classifyDescendantFile } from '../scripts/post-adoption-descendant.mjs';

const adopted = '5f73b2b02d9008dc863cf92978e6ea8e40a850ec'; // adopted v27 schema baseline (guard "before")
const guardBase = '5142c5243b03163e98f9ebc09eff56150e372431'; // last reviewed guard revision before this closure
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
const SCHED = 'src/providers/cloud/cloudRestoreOpsScheduler.ts';
const MAINT = 'src/providers/cloud/cloudRestoreOpsMaintenance.ts';
const sched = readFileSync(SCHED, 'utf8');
const maint = readFileSync(MAINT, 'utf8');
const maintBefore = git(['show', `${adopted}:${MAINT}`]);
assert.throws(() => git(['cat-file', '-e', `${adopted}:${SCHED}`]), 'scheduler must not exist at the adopted baseline');
const ok = (file, before, after) => assert.doesNotThrow(() => assertReviewedProviderContract(file, before, after), `${file} reviewed form must PASS`);
const bad = (label, file, before, after, re = /DEPLOYMENT_GUARD_FAILED_CLOSED/u) => {
  assert.notEqual(after, file === SCHED ? sched : maint, `${label}: mutation must change the source`);
  assert.throws(() => assertReviewedProviderContract(file, before, after), re, `${label} must FAIL`);
  cases.push(label);
};
const cases = [];
const replaceOnce = (source, from, to) => { assert.ok(source.includes(from), `fixture anchor missing: ${from}`); return source.replace(from, to); };

// 1. Reviewed versions PASS (through the real provider-contract dispatcher).
ok(SCHED, null, sched);
ok(MAINT, maintBefore, maint);

// 2. RPC name / argument changes FAIL.
bad('maintenance RPC renamed', MAINT, maintBefore, maint.replace(/'erp_cleanup_expired_restore_ops'/u, "'erp_restore_staged_cloud_snapshot'"));
bad('maintenance RPC argument value changed', MAINT, maintBefore, replaceOnce(maint, '{ p_exclude_request_id: currentRequestId }', '{ p_exclude_request_id: null }'));
bad('maintenance RPC extra argument', MAINT, maintBefore, replaceOnce(maint, '{ p_exclude_request_id: currentRequestId }', '{ p_exclude_request_id: currentRequestId, p_force: true }'));
bad('maintenance second RPC call', MAINT, maintBefore, replaceOnce(maint, '      summary.typedRows += count(data.typedRows);',
  "      summary.typedRows += count(data.typedRows);\n      await rpc('erp_cleanup_expired_restore_ops', { p_exclude_request_id: currentRequestId });"));
bad('maintenance RPC name built by concatenation', MAINT, maintBefore, maint + "\nexport const other = 'erp_' + 'restore_staged_cloud_snapshot';\n");
bad('scheduler holds an RPC-shaped literal', SCHED, null, sched + "\nconst unsafe = 'erp_restore_staged_cloud_snapshot'; void unsafe;\n");

// 3. Direct Supabase business-data access FAILS.
bad('scheduler imports Supabase client', SCHED, null, "import { supabase } from './supabaseClient';\n" + sched + "\nvoid supabase.from('inventory_items').select('*');\n");
bad('scheduler uses a global supabase handle', SCHED, null, sched + "\nvoid (supabase as any).from('product_variants').delete();\n");
bad('maintenance calls supabase.rpc directly', MAINT, maintBefore, maint + "\nvoid supabase.rpc('erp_cleanup_expired_restore_ops', { p_exclude_request_id: null });\n");

// 4. Unauthorized I/O FAILS.
for (const [label, extra] of [['fetch', "void fetch('/x');"], ['localStorage', "localStorage.setItem('a','b');"], ['sessionStorage', "sessionStorage.removeItem('erp_cloud_restore_unresolved_attempt');"],
  ['WebSocket', "new WebSocket('wss://x');"], ['navigator.sendBeacon', "navigator.sendBeacon('/x');"], ['indexedDB', "indexedDB.open('x');"],
  ['XMLHttpRequest', 'new XMLHttpRequest();'], ['BroadcastChannel', "new BroadcastChannel('x');"], ['eval', "eval('1');"], ['globalThis', 'void globalThis;']]) {
  bad(`scheduler ${label}`, SCHED, null, `${sched}\n${extra}\n`);
  bad(`maintenance ${label}`, MAINT, maintBefore, `${maint}\n${extra}\n`);
}

// 5. Indirect bypass through unreviewed dependencies / handles FAILS.
bad('scheduler imports another provider module', SCHED, null, "import { readCloudIds } from './cloudBulkRead';\n" + sched + '\nvoid readCloudIds;\n');
bad('scheduler imports an extra symbol', SCHED, null, replaceOnce(sched, "import { cleanupExpiredRestoreOps, type MaintenanceOptions, type MaintenanceSummary } from './cloudRestoreOpsMaintenance';",
  "import { cleanupExpiredRestoreOps, type MaintenanceOptions, type MaintenanceSummary, unsafeWriter } from './cloudRestoreOpsMaintenance';"));
bad('scheduler dynamic import', SCHED, null, sched + "\nvoid import('./supabaseClient');\n");
bad('scheduler re-export of provider', SCHED, null, sched + "\nexport * from './supabaseProvider';\n");
bad('maintenance gains any import', MAINT, maintBefore, "import { supabase } from './supabaseClient';\n" + maint);
bad('maintenance re-export', MAINT, maintBefore, maint + "\nexport { supabase } from './supabaseClient';\n");
bad('scheduler calls the RPC handle directly', SCHED, null, replaceOnce(sched, '          const summary = await cleanupExpiredRestoreOps(env.rpc, null, options);',
  "          await env.rpc('erp_cleanup_expired_restore_ops', { p_exclude_request_id: null });\n          const summary = await cleanupExpiredRestoreOps(env.rpc, null, options);"));
bad('scheduler passes a non-null exclude id', SCHED, null, replaceOnce(sched, 'cleanupExpiredRestoreOps(env.rpc, null, options)', "cleanupExpiredRestoreOps(env.rpc, 'x', options)"));
bad('scheduler passes a different RPC port', SCHED, null, replaceOnce(sched, 'cleanupExpiredRestoreOps(env.rpc, null, options)', 'cleanupExpiredRestoreOps((n, a) => env.rpc(n, a), null, options)'));
bad('maintenance leaks the rpc handle', MAINT, maintBefore, replaceOnce(maint, '  running = true;', '  running = true;\n  const escaped = rpc; void escaped;'));

// 6. Existing provider contracts and file-level rules FAIL when modified.
bad('maintenance export renamed', MAINT, maintBefore, maint.replace('export async function cleanupExpiredRestoreOps(', 'export async function cleanupAllRestoreOps('));
bad('maintenance parameter contract changed', MAINT, maintBefore, replaceOnce(maint, '  currentRequestId: string | null,\n', ''));
bad('maintenance options made mandatory', MAINT, maintBefore, replaceOnce(maint, '  options?: MaintenanceOptions,', '  options: MaintenanceOptions,'));
bad('maintenance never-throw contract removed', MAINT, maintBefore, maint.replace(/\n  \} catch \{[\s\S]*?\n  \} finally \{/u, '\n  } finally {'));
bad('maintenance new export', MAINT, maintBefore, maint + '\nexport const restoreOpsWriter = 1;\n');
assert.throws(() => assertReviewedProviderContract(SCHED, sched, sched), /needs a new exact review/u, 'any later scheduler edit needs a new exact guard review');
cases.push('scheduler later edit requires new review');
assert.throws(() => assertReviewedProviderContract(MAINT, null, maint), /FAILED_CLOSED/u); cases.push('maintenance without baseline');
assert.throws(() => assertRestoreOpsMaintenanceContract('src/providers/cloud/cloudRestoreOpsSchedulerCopy.ts', null, sched), /FAILED_CLOSED/u);
cases.push('no path-pattern / copy exemption');
// Provider classes keep their pre-existing rules (this closure does not touch them).
const provider = readFileSync('src/providers/cloud/supabaseProvider.ts', 'utf8');
const providerBefore = git(['show', `${adopted}:src/providers/cloud/supabaseProvider.ts`]);
assert.doesNotThrow(() => assertReviewedProviderContract('src/providers/cloud/supabaseProvider.ts', providerBefore, provider), 'released provider still passes');
assert.match(provider, /\n {2}async upsertInventory\(/u, 'fixture anchor');
assert.throws(() => assertReviewedProviderContract('src/providers/cloud/supabaseProvider.ts', providerBefore,
  provider.replace(/(\n {2}async upsertInventory\()/u, "\n  async scheduleRestoreOps() { await supabase.rpc('erp_cleanup_expired_restore_ops', { p_exclude_request_id: null }); }$1")), /FAILED_CLOSED/u);
cases.push('supabaseProvider gains an OPS member');
for (const file of ['src/providers/cloud/unreviewedRestoreOps.ts', 'src/providers/cloud/restoreOpsScheduler.ts', 'src/lib/restoreOpsScheduler.ts']) {
  assert.throws(() => assertReviewedProviderContract(file, null, sched), /unreviewed provider contract exception/u, `${file} still fails closed`);
  assert.equal(classifyDescendantFile(file, null, sched), 'SCHEMA_SENSITIVE_OR_UNREVIEWED');
}
cases.push('other provider/lib files still fail closed');

// 7. Purely additive closure: removing the two marked blocks restores the previous guard byte-for-byte.
const guard = readFileSync('scripts/post-adoption-descendant.mjs', 'utf8').replace(/\r\n?/gu, '\n');
const previousGuard = git(['show', `${guardBase}:scripts/post-adoption-descendant.mjs`]).replace(/\r\n?/gu, '\n');
const strip = (source, name) => {
  const begin = source.indexOf(`// ---- BEGIN ${name}`), end = source.indexOf(`// ---- END ${name}`);
  assert.ok(begin > 0 && end > begin, `marker ${name}`);
  return source.slice(0, source.lastIndexOf('\n', begin) + 1) + source.slice(source.indexOf('\n', end) + 1);
};
// Version compatibility (P0-2 Phase 1a exact review p02-phase1a-c1-c1a-v1): its own two marked
// blocks are removed first; they are proven additive by tests/p02-1a-provider-guard.mjs. The
// restore-ops-g1 comparison below is unchanged and still requires byte-for-byte equality.
const withoutP02 = guard
  .replace(/\/\/ ---- BEGIN p02-1a provider contract function[\s\S]*?\/\/ ---- END p02-1a provider contract function ----\n\n/u, '')
  .replace(/ {2}\/\/ ---- BEGIN p02-1a provider contract dispatch ----\n[\s\S]*? {2}\/\/ ---- END p02-1a provider contract dispatch ----\n/u, '')
  // C1f (exact review p02-phase1a-c1f-guard-v1): realtime context blocks, proven additive by tests/p02-1a-context-guard.mjs.
  .replace(/\/\/ ---- BEGIN p02-1a realtime context contract function[\s\S]*?\/\/ ---- END p02-1a realtime context contract function ----\n\n/u, '')
  .replace(/ {2}\/\/ ---- BEGIN p02-1a realtime context contract dispatch ----\n[\s\S]*? {2}\/\/ ---- END p02-1a realtime context contract dispatch ----\n/u, '');
const restored = strip(strip(withoutP02, 'restore-ops-g1 provider contract function'), 'restore-ops-g1 provider contract dispatch');
assert.equal(restored, previousGuard, 'guard closure must be purely additive (no existing rule changed or relaxed)');
assert.equal((guard.match(/^ *\/\/ ---- (?:BEGIN|END) restore-ops-g1 /gmu) || []).length, 4, 'exactly two marked blocks');
cases.push('additive-only structural proof');

console.log(JSON.stringify({ result: 'PASS', test: 'RESTORE_OPS_PROVIDER_GUARD', negativeCases: cases.length, positiveCases: 2, cases }, null, 1));
