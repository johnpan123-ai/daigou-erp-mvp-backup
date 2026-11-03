// P0-2 Phase 1a C1f (M-2) exact Realtime context guard: positive, negative and anti-over-blocking proof.
// Pure source analysis (no network, no browser, no production access).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertP02FreshHoldCallers, assertP02RealtimeContextContract, assertP02SrcTreeModes, P02_SRC_SCRIPT, p02RealtimeContextDigests, P02_REALTIME_CONTEXT_FILES } from '../scripts/post-adoption-descendant.mjs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const CTX = 'src/contexts/CloudRealtimeSyncContext.tsx';
const PRES = 'src/contexts/globalSyncPresentation.ts';
const POL = 'src/contexts/realtimeRecoveryPolicy.ts';
const ctx = read(CTX), pres = read(PRES), pol = read(POL);
const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, ok: true }); console.log('PASS', name); } catch (error) { results.push({ name, ok: false, error: String(error.message) }); console.log('FAIL', name, error.message); } };
const mutate = (source, from, to) => { assert.equal(source.split(from).length, 2, `mutation anchor must be unique: ${from.slice(0, 60)}`); return source.replace(from, to); };
const accepts = (name, file, source) => check(`POS ${name}`, () => assertP02RealtimeContextContract(file, source));
const rejects = (name, file, source, pattern) => check(`NEG ${name}`, () => assert.throws(() => assertP02RealtimeContextContract(file, source), pattern));

// ---- positive: the exact reviewed C1f sources
assert.deepEqual([...P02_REALTIME_CONTEXT_FILES], [CTX, PRES, POL]);
for (const file of P02_REALTIME_CONTEXT_FILES) accepts(`exact reviewed source accepted: ${file}`, file, read(file));

// ---- negative: completeness hold / readiness proof / fresh / epoch (N1-N8)
const ENGINE = /realtime sync engine drifted/u;
rejects('N1 completeness hold at subscribe removed', CTX, mutate(ctx, "      holdCompleteness('pending', 'realtime-readiness-pending');\n", ''), ENGINE);
rejects('N2 SUBSCRIBED releases the hold without the system ok proof', CTX, mutate(ctx, '            markRealtimeSubscribed(gen);\n', '            markRealtimeSubscribed(gen);\n            releaseCompleteness();\n'), ENGINE);
rejects('N3 proof no longer requires the ready generation', CTX, mutate(ctx, 'attempt.readStartSeq > ready!.seq && isRealtimeReadyGeneration(gen)', 'attempt.readStartSeq > ready!.seq'), ENGINE);
rejects('N4 markCloudReadFresh called outside the sync engine', CTX, `${ctx}\nexport function leakFresh() { markCloudReadFresh(); }\n`, /protected identifier outside the reviewed pieces: markCloudReadFresh/u);
rejects('N5 epoch barrier removed', CTX, mutate(ctx, '        raiseCloudCacheEpochBarrier(knownEpoch ? epoch : null);\n', ''), ENGINE);
rejects('N6 presentation shows unproven as synced', PRES, mutate(pres, "  status: 'cached', label: REALTIME_UNPROVEN_LABEL, tone: 'warning', writeAllowed: false,", "  status: 'fresh', label: GLOBAL_SYNC_LABELS.fresh, tone: 'success', writeAllowed: true,"), /presentation statement drifted: realtimeUnprovenView/u);
rejects('N7 new helper outside the engine releases Fresh', CTX, mutate(ctx, '  const isEditing = useCallback(', "  const unlockFresh = () => releaseCloudFresh('realtime-completeness');\n  void unlockFresh;\n  const isEditing = useCallback("), /protected identifier outside the reviewed pieces: releaseCloudFresh/u);
rejects('N8 COMPLETENESS_HOLD renamed', CTX, mutate(ctx, "const COMPLETENESS_HOLD = 'realtime-completeness';", "const COMPLETENESS_HOLD = 'realtime-completeness-v2';"), /top-level statement drifted: COMPLETENESS_HOLD/u);

// ---- negative: C1f reconnect / generation / recovery (N9-N13)
rejects('N9 status handler accepts events of a replaced generation', CTX, mutate(ctx, "        nextChannel.subscribe(status => {\n          if (disposed || generation !== channelGeneration || channel !== nextChannel) return;", "        nextChannel.subscribe(status => {\n          if (disposed) return;"), ENGINE);
rejects('N10 channel replacement releases the hold without proof', CTX, mutate(ctx, "      holdCompleteness('unproven', `realtime-recovering-${cause}`);", '      releaseCompleteness();'), ENGINE);
rejects('N11 pending-limit timer unlocks instead of showing unproven', CTX, mutate(ctx, "        holdCompleteness('unproven', reason);\n        reconnect.markNeeded('channel-interrupted');", "        releaseCompleteness();\n        reconnect.markNeeded('channel-interrupted');"), ENGINE);
rejects('N12 recovery keeps running after proof (shouldRecover bypass)', CTX, mutate(ctx, 'shouldRecover: () => !disposed && !faultDisconnected && completenessHeld,', 'shouldRecover: () => true,'), ENGINE);
rejects('N12b recovery of a ready channel releases instead of proving by catch-up', CTX, mutate(ctx, "            if (!result.proven) throw new Error('P0_2_REALTIME_CATCH_UP_NOT_PROVEN');", '            releaseCompleteness();'), ENGINE);
rejects('N13 manual reconnect declares Fresh outside the engine', CTX, mutate(ctx, '  const reconnectRealtime = useCallback(() => { realtimeReconnectRef.current?.(); }, []);', '  const reconnectRealtime = useCallback(() => { realtimeReconnectRef.current?.(); setRealtimeUnproven(false); }, []);'), /protected identifier outside the reviewed pieces: setRealtimeUnproven/u);
rejects('N13b recovery SDK grace removed from the policy', POL, mutate(pol, 'sdkRejoinGraceMs: 12_000,', 'sdkRejoinGraceMs: 0,'), /recovery policy differs from its exact review/u);
rejects('N13c pending limit changed', POL, mutate(pol, 'pendingLimitMs: 15_000,', 'pendingLimitMs: 1,'), /recovery policy differs from its exact review/u);
rejects('N13d SDK rejoin drops the pending-limit replacement again (round-2 MINOR-2 regression)', POL, mutate(pol, '    } else if (this.timer !== null && !this.pendingBeyondSdkWait) {', '    } else if (this.timer !== null) {'), /recovery policy differs from its exact review/u);
rejects('N13e SUBSCRIBED handler cancels every recovery request (round-1 behaviour)', CTX, mutate(ctx, '            recovery?.noteSdkRejoined();', '            recovery?.cancel();'), /sync engine|drifted/u);

// ---- negative: presentation / rendering / aliasing / boundary inputs
rejects('N14 banner status attribute no longer the presentation status', CTX, mutate(ctx, 'data-global-sync-banner={syncPresentation.status}', 'data-global-sync-banner="fresh"'), /global sync banner drifted/u);
rejects('N14b Provider value overrides the presentation as synced', CTX, mutate(ctx, '    syncPresentation,\n    connectivity,\n    realtimeRecovery,', "    syncPresentation: { ...syncPresentation, status: 'fresh', label: '已' + '同步', writeAllowed: true },\n    connectivity,\n    realtimeRecovery,"), /boundary statement drifted: value/u);
rejects('N14c protected module imported through an alternative specifier', CTX, mutate(ctx, "import { holdCloudFresh, markCloudReconnectPending as markCloudResyncPending, releaseCloudFresh } from '../providers/cloud/cloudConnectivity';",
  "import { holdCloudFresh, markCloudReconnectPending as markCloudResyncPending, releaseCloudFresh } from '../providers/cloud/cloudConnectivity';\nimport { GLOBAL_SYNC_LABELS } from '../contexts/globalSyncPresentation';"), /protected import changed/u);
rejects('N14d unproven reconnect UI removed from the banner', CTX, mutate(ctx, "          {syncPresentation.action === 'realtime-reconnect' && (", "          {false && syncPresentation.action === 'realtime-reconnect' && ("), /global sync banner drifted/u);
rejects('N14e presentation rendered elsewhere outside the pinned banner', CTX, mutate(ctx, '      {children}\n', '      <b>{syncPresentation.label}</b>\n      {children}\n'), /protected identifier outside the reviewed pieces: syncPresentation/u);
rejects('N15 synced label rendered outside the presentation', CTX, mutate(ctx, '      {children}\n', '      <span>已同步</span>\n      {children}\n'), /renders a synced label outside the presentation/u);
rejects('N16 protected identifier aliased through a string', CTX, `${ctx}\nexport const alias = 'releaseCloudFresh';\n`, /protected identifier used as a string/u);
rejects('N17 dynamic import of a protected module', CTX, `${ctx}\nexport const lazy = () => import('../providers/cloud/cloudConnectivity');\n`, /dynamic import/u);
rejects('N18 readiness wait constant changed', CTX, mutate(ctx, 'const REALTIME_READINESS_WAIT_MS = 3000;', 'const REALTIME_READINESS_WAIT_MS = 1;'), /top-level statement drifted: REALTIME_READINESS_WAIT_MS/u);
rejects('N19 test bridge gating changed', CTX, mutate(ctx, "const enabled = (getProviderMode() === 'cloud' || Boolean(testBridge)) && Boolean(user);", 'const enabled = Boolean(user);'), /boundary statement drifted: enabled/u);
rejects('N20 presentation input no longer carries the unproven evidence', CTX, mutate(ctx, '{ unproven: realtimeUnproven }', '{ unproven: false }'), /boundary statement drifted: syncPresentation/u);
rejects('N21 protected import changed (extra binding)', CTX, mutate(ctx, "import { markAllCloudTablesUnresolved } from '../providers/cloud/cloudTargetedCache';", "import { markAllCloudTablesUnresolved, __resetUnresolvedCloudTablesForTests } from '../providers/cloud/cloudTargetedCache';"), /protected import changed/u);
rejects('N22 presentation gains an unreviewed runtime statement', PRES, `${pres}\nexport const alwaysWritable = () => true;\n`, /presentation unreviewed top-level statement/u);
rejects('N23 presentation gains a runtime import', PRES, `import { assertCloudWriteAllowed } from '../providers/cloud/cloudConnectivity';\n${pres}`, /presentation runtime import/u);
rejects('N24 useGlobalSyncControl fallback changed', CTX, mutate(ctx, '    refreshAll: context?.refreshAll,\n  };', "    refreshAll: context?.refreshAll,\n    writeAllowed: true,\n  };"), /top-level statement drifted: useGlobalSyncControl/u);

// ---- negative: Fresh hold outside the boundary anywhere in src
check('NEG N25 another src file releases Fresh', () => assert.throws(() => assertP02FreshHoldCallers([['src/pages/Leak.tsx', "import { releaseCloudFresh } from '../providers/cloud/cloudConnectivity';\nreleaseCloudFresh('realtime-completeness');"]]), /Fresh hold used outside the reviewed boundary/u));
check('NEG N26 connectivity module aliased as a namespace', () => assert.throws(() => assertP02FreshHoldCallers([['src/lib/x.ts', "import * as connectivity from '../providers/cloud/cloudConnectivity';\nconnectivity['release' + 'CloudFresh']('k');"]]), /connectivity module aliased/u));
check('NEG N27b connectivity module re-exported through a barrel', () => assert.throws(() => assertP02FreshHoldCallers([['src/lib/barrel.ts', "export * from '../providers/cloud/cloudConnectivity';"]]), /connectivity module aliased/u));
check('NEG N27 connectivity module imported dynamically', () => assert.throws(() => assertP02FreshHoldCallers([['src/lib/y.ts', "export const load = () => import('../providers/cloud/cloudConnectivity');"]]), /connectivity module aliased/u));
// Round-2 review MAJOR-1: forms the text regex missed; the AST scan must reject each of them.
const callerRejects = (name, file, text) => check(`NEG ${name}`, () => assert.throws(() => assertP02FreshHoldCallers([[file, text]]), /connectivity module aliased/u));
callerRejects('N27c namespace re-export barrel (export * as)', 'src/lib/cc.ts', "export * as cc from '../providers/cloud/cloudConnectivity';");
callerRejects('N27d namespace import with .ts extension', 'src/lib/z.ts', "import * as c from '../providers/cloud/cloudConnectivity.ts';\nc['release' + 'CloudFresh']('realtime-completeness');");
callerRejects('N27e named re-export of a non-Fresh member', 'src/lib/re.ts', "export { getCloudConnectivitySnapshot } from '../providers/cloud/cloudConnectivity';");
callerRejects('N27f default import of the module', 'src/lib/d.ts', "import cc from '../providers/cloud/cloudConnectivity.js';\nexport const x = cc;");
callerRejects('N27g named default binding', 'src/lib/e.ts', "import { default as cc } from '../providers/cloud/cloudConnectivity';\nexport const x = cc;");
callerRejects('N27h query suffix on the specifier', 'src/lib/q.ts', "import * as c from '../providers/cloud/cloudConnectivity?t=1';\nexport const x = c;");
callerRejects('N27i non-relative alias specifier', 'src/lib/a.ts', "import * as c from '@/providers/cloud/cloudConnectivity';\nexport const x = c;");
callerRejects('N27j require of the module', 'src/lib/r.ts', "const c = require('../providers/cloud/cloudConnectivity');\nexport const x = c;");
callerRejects('N27k import-equals require', 'src/lib/ie.ts', "import c = require('../providers/cloud/cloudConnectivity');\nexport const x = c;");
callerRejects('N27l dynamic import with a computed specifier', 'src/lib/dyn.ts', "const p = '../providers/cloud/' + 'cloudConnectivity';\nexport const load = () => import(p);");
callerRejects('N27m dynamic import through a template literal', 'src/lib/tpl.ts', "export const load = () => import(`../providers/cloud/cloudConnectivity`);");
callerRejects('N27n side-effect import of the module', 'src/lib/se.ts', "import '../providers/cloud/cloudConnectivity';");
// Round-3 review MAJOR-1 residual: decoded names, Vite glob imports, trailing-slash specifiers.
const holdRejects = (name, file, text) => check(`NEG ${name}`, () => assert.throws(() => assertP02FreshHoldCallers([[file, text]]), /Fresh hold used outside the reviewed boundary/u));
const metaRejects = (name, file, text) => check(`NEG ${name}`, () => assert.throws(() => assertP02FreshHoldCallers([[file, text]]), /import\.meta used beyond import\.meta\.env/u));
holdRejects('N27o escaped import name', 'src/lib/esc.ts', "import { \\u0072eleaseCloudFresh as r } from '../providers/cloud/cloudConnectivity';\nr('realtime-completeness');");
holdRejects('N27p string-literal import name', 'src/lib/lit.ts', "import { 'releaseCloudFresh' as r } from '../providers/cloud/cloudConnectivity';\nr('realtime-completeness');");
holdRejects('N27q escaped hold name in an unrelated module', 'src/lib/esc2.ts', "export const \\u0068oldCloudFresh = 1;");
metaRejects('N27r import.meta.glob of the module', 'src/lib/glob.ts', "const mods = import.meta.glob('../providers/cloud/cloudConn*.ts', { eager: true });\nexport const x = mods;");
metaRejects('N27s import.meta.glob inside the context file', CTX, `${ctx}\nconst __m = import.meta.glob('../providers/cloud/cloudConn*.ts', { eager: true });\nexport const __x = __m;\n`);
metaRejects('N27t import.meta element access', 'src/lib/meta.ts', "export const g = (import.meta as unknown as Record<string, unknown>)['glob'];");
callerRejects('N27u trailing-slash / sub-path specifier', 'src/lib/slash.ts', "import * as c from '../providers/cloud/cloudConnectivity/';\nexport const x = c;");
// Round-4 review MAJOR-R4: scan scope (non-TS scripts, modules outside src) and code from strings.
const scopeRejects = (name, files, pattern) => check(`NEG ${name}`, () => assert.throws(() => assertP02FreshHoldCallers(files), pattern));
scopeRejects('N28a plain .js file in src releasing through a namespace', [['src/lib/leak.js', "import * as c from '../providers/cloud/cloudConnectivity.ts';\nexport const go = () => c['release' + 'CloudFresh']('realtime-completeness');"]], /non-TypeScript script in src/u);
scopeRejects('N28b .jsx / .mjs / .cjs scripts in src', [['src/lib/a.jsx', 'export const a = 1;'], ['src/lib/b.mjs', 'export const b = 1;']], /non-TypeScript script in src/u);
scopeRejects('N28c .ts file importing a module outside src (relative)', [['src/lib/go.ts', "import { go } from '../../scripts/leak';\nexport const run = go;"]], /src module imports outside src/u);
scopeRejects('N28d root-absolute specifier outside /src/', [['src/lib/go2.ts', "import { go } from '/scripts/leak.js';\nexport const run = go;"]], /src module imports outside src/u);
scopeRejects('N28e dynamic import outside src', [['src/lib/go3.ts', "export const run = () => import('../../tools/leak');"]], /src module imports outside src/u);
scopeRejects('N28f eval in src', [['src/lib/ev.ts', "export const run = (s: string) => eval(s);"]], /eval \/ Function constructor/u);
scopeRejects('N28g new Function in src', [['src/lib/fn.ts', "export const run = new Function('return 1');"]], /eval \/ Function constructor/u);
scopeRejects('N28h globalThis eval by element access', [['src/lib/ev2.ts', "export const run = (s: string) => (globalThis as any)['eval'](s);"]], /eval \/ Function constructor/u);
scopeRejects('N28i eval inside the context file', [[CTX, `${ctx}\nexport const __e = (s: string) => eval(s);\n`]], /eval \/ Function constructor/u);
scopeRejects('N28j context file importing outside src', [[CTX, `import { go } from '../../scripts/leak';\n${ctx}\nexport const __g = go;\n`]], /src module imports outside src/u);
// Round-5 review M-R5 / minor: root-absolute escapes, backslashes, shallow eval forms, uppercase extensions.
scopeRejects('N29a root-absolute /src/../ escape', [['src/lib/abs.ts', "// @ts-ignore\nimport { go } from '/src/../tools/leak.ts';\nexport const run = go;"]], /src module imports outside src/u);
scopeRejects('N29b root-absolute /src/./../ escape', [['src/lib/abs2.ts', "import { go } from '/src/./../functions/x';\nexport const run = go;"]], /src module imports outside src/u);
scopeRejects('N29c backslash specifier', [['src/lib/bs.ts', "import { go } from '..\\\\..\\\\tools\\\\leak.ts';\nexport const run = go;"]], /src module imports outside src/u);
scopeRejects('N29d eval referenced as a value', [['src/lib/ev3.ts', "const e = eval;\nexport const run = (s: string) => e(s);"]], /eval \/ Function constructor/u);
scopeRejects('N29e Reflect.apply(eval)', [['src/lib/ev4.ts', "export const run = (s: string) => Reflect.apply(eval, undefined, [s]);"]], /eval \/ Function constructor/u);
scopeRejects('N29f code-string timer', [['src/lib/t.ts', "export const run = () => window.setTimeout('doIt()', 1);"]], /eval \/ Function constructor/u);
scopeRejects('N29g constructor.constructor', [['src/lib/cc.ts', "export const F = [].constructor.constructor;"]], /eval \/ Function constructor/u);
scopeRejects('N29h uppercase-extension script in src', [['src/lib/LEAK.JS', 'export const a = 1;']], /non-TypeScript script in src/u);
// Guard r7 (final review round 6, E1/E2/E3/E5): URL schemes, symlinks/submodules, known channel proof forgery.
scopeRejects('N30a data: URL module (E1)', [['src/lib/data.ts', "// @ts-ignore\nimport 'data:text/javascript;base64,ZXhwb3J0IGNvbnN0IHggPSAxOw==';"]], /src module imports outside src/u);
scopeRejects('N30b data: URL in the context file (E1)', [[CTX, `import 'data:text/javascript,export{}';\n${ctx}`]], /src module imports outside src/u);
scopeRejects('N30c file:// URL module (E2)', [['src/lib/file.ts', "// @ts-ignore\nimport { go } from 'file:///opt/buildhome/repo/tests/leak.ts';\nexport const run = go;"]], /src module imports outside src/u);
scopeRejects('N30d https: and virtual: specifiers', [['src/lib/net.ts', "export const load = () => import('https://example.invalid/x.js');"]], /src module imports outside src/u);
scopeRejects('N30e virtual: specifier', [['src/lib/virt.ts', "import x from 'virtual:leak';\nexport const y = x;"]], /src module imports outside src/u);
check('NEG N30f symlink in src (E3)', () => assert.throws(() => assertP02SrcTreeModes('100644 blob aaaa\tsrc/a.ts\n120000 blob bbbb\tsrc/providers/cloud/connectivityState.ts\n'), /symlink or submodule in src: src\/providers\/cloud\/connectivityState\.ts/u));
check('NEG N30g directory symlink in src (E3)', () => assert.throws(() => assertP02SrcTreeModes('120000 blob cccc\tsrc/shared\n'), /symlink or submodule in src/u));
check('NEG N30h submodule in src (E3)', () => assert.throws(() => assertP02SrcTreeModes('160000 commit dddd\tsrc/vendor\n'), /symlink or submodule in src/u));
const channelRejects = (name, text) => check(`NEG ${name}`, () => assert.throws(() => assertP02FreshHoldCallers([['src/lib/forge.ts', text]]), /Realtime channel API used outside the context/u));
channelRejects('N30i forged system ok through getChannels/channelAdapter (E5)', "import { supabase } from './supabase';\nsupabase.getChannels()[0].channelAdapter.channel.trigger('system', { extension: 'postgres_changes', status: 'ok' });");
channelRejects('N30j same-topic channel() handle (E5)', "import { supabase } from './supabase';\nexport const c = supabase.channel('erp-cloud-realtime');");
channelRejects('N30k realtime client internals (E5)', "import { supabase } from './supabase';\nexport const c = supabase.realtime;");
channelRejects('N30l element access to getChannels (E5)', "import { supabase } from './supabase';\nexport const c = (supabase as any)['getChannels']();");
channelRejects('N30m removeChannels outside the context (E5)', "import { supabase } from './supabase';\nexport const c = () => supabase.removeChannels();");
check('POS A18 the context file keeps its channel API; current src tree has no symlink/submodule entries', () => {
  assertP02FreshHoldCallers([[CTX, ctx]]);
  assertP02SrcTreeModes(execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', 'src'], { cwd: fileURLToPath(new URL('..', import.meta.url)) }).toString());
  assertP02SrcTreeModes('100644 blob aaaa\tsrc/a.ts\n100755 blob bbbb\tsrc/b.ts\n');
});
check('POS A19 unrelated "trigger" members and ordinary package imports stay allowed', () => assertP02FreshHoldCallers([['src/lib/sched.ts',
  "import { useState } from 'react';\nexport class S { private trigger = 'online'; run(trigger: string) { this.trigger = trigger; return useState; } }"]]));
check('POS A17 ordinary timers and absolute /src/ paths pass', () => assertP02FreshHoldCallers([['src/lib/ok2.ts',
  "import { x } from '/src/lib/x';\nconst done = () => x;\nexport const a = setTimeout(done, 1);\nexport const b = window.setTimeout(() => done(), 2);\nexport const c = setInterval(done.bind(null), 3);"]]));
check('POS A16 package and /src/ specifiers pass; the dispatch scope covers every script-like src file', () => {
  assertP02FreshHoldCallers([['src/lib/pkg.ts', "import { useState } from 'react';\nimport { x } from '/src/lib/x';\nimport type { Y } from '../types/y';\nexport const a = [useState, x] as unknown as Y;"]]);
  for (const f of ['src/a.ts', 'src/a.tsx', 'src/a.js', 'src/a.jsx', 'src/a.mjs', 'src/a.cjs', 'src/a.mts', 'src/a.cts', 'src/x/y.d.ts']) assert.ok(P02_SRC_SCRIPT.test(f), f);
  for (const f of ['src/a.css', 'src/a.svg', 'scripts/a.ts']) assert.ok(!P02_SRC_SCRIPT.test(f), f);
});
check('POS A15 import.meta.env reads pass the caller scan (context file included)', () => assertP02FreshHoldCallers([['src/lib/env.ts', "export const mode = import.meta.env.MODE;\nexport const all = import.meta.env;"], [CTX, ctx]]));

// ---- re-pinned probes: prove the executable presentation invariant and the policy I/O rule themselves
const guardPath = fileURLToPath(new URL('../scripts/post-adoption-descendant.mjs', import.meta.url));
const guardSource = readFileSync(guardPath, 'utf8');
let probeSeq = 0;
const probe = async (file, mutated, repin) => {
  let text = guardSource;
  for (const [from, to] of repin) { assert.equal(text.split(from).length, 2, `pin appears exactly once: ${from.slice(0, 12)}`); text = text.replace(from, to); }
  const temp = fileURLToPath(new URL(`../scripts/.p02-ctx-probe-${process.pid}-${probeSeq += 1}.mjs`, import.meta.url));
  writeFileSync(temp, text);
  try { (await import(pathToFileURL(temp).href)).assertP02RealtimeContextContract(file, mutated); return null; } catch (error) { return error; } finally { unlinkSync(temp); }
};
const presentationProbe = async (name, mutated, pattern) => {
  const before = p02RealtimeContextDigests(PRES, pres).statements, after = p02RealtimeContextDigests(PRES, mutated).statements;
  const repin = Object.keys(before).filter(key => before[key] !== after[key]).map(key => [before[key], after[key]]);
  const error = await probe(PRES, mutated, repin);
  check(`${pattern ? 'NEG' : 'POS'} re-pinned presentation: ${name}`, () => { if (pattern) assert.match(String(error?.message), pattern); else assert.equal(error, null); });
};
const policyProbe = async (name, mutated, pattern) => {
  const error = await probe(POL, mutated, [[p02RealtimeContextDigests(POL, pol).module, p02RealtimeContextDigests(POL, mutated).module]]);
  check(`${pattern ? 'NEG' : 'POS'} re-pinned policy: ${name}`, () => { if (pattern) assert.match(String(error?.message), pattern); else assert.equal(error, null); });
};
await presentationProbe('probe sanity (unchanged)', pres, null);
await presentationProbe('unproven view writable even if someone re-pins it', mutate(pres, "  status: 'cached', label: REALTIME_UNPROVEN_LABEL, tone: 'warning', writeAllowed: false,", "  status: 'cached', label: REALTIME_UNPROVEN_LABEL, tone: 'warning', writeAllowed: true,"), /shows an unproven state as synced or writable/u);
await presentationProbe('stale-cache shown as synced even if re-pinned', mutate(pres, '  if (fresh && !refreshFailed) {', "  if ((fresh || connectivity.readStatus === 'stale-cache') && !refreshFailed) {"), /shows an unproven state as synced or writable/u);
await presentationProbe('unproven read-only state hidden even if re-pinned', mutate(pres, '  if (realtime?.unproven && !fresh) return realtimeUnprovenView();\n', ''), /hides the unproven read-only state/u);
await policyProbe('probe sanity (unchanged)', pol, null);
await policyProbe('policy gains network I/O', `${pol}\nexport const leak = () => fetch('https://x.invalid');\n`, /network\/persistence I\/O/u);
await policyProbe('policy gains an import', `import { markCloudReadFresh } from '../providers/cloud/cloudConnectivity';\n${pol}`, /recovery policy dependency changed/u);
await policyProbe('policy uses window', `${pol}\nexport const w = () => window.location.href;\n`, /network\/persistence I\/O/u);

// ---- anti-over-blocking: legitimate unrelated changes still pass without a new review
accepts('A1 comment inside the sync engine', CTX, mutate(ctx, '    cache.initializeCursor();\n', '    // reviewed comment: cursor starts from the cache\n    cache.initializeCursor();\n'));
accepts('A2 formatting inside the sync engine', CTX, mutate(ctx, '    let attemptIds = 0;\n', '    let   attemptIds   =   0 ;\n\n'));
accepts('A3 conflict alert wording changed (outside the pinned banner)', CTX, mutate(ctx, '資料已被其他使用者更新；目前編輯內容未被覆蓋，結束編輯後會自動更新。', '資料已被其他使用者更新；你的編輯內容未被覆蓋，結束編輯後會自動更新。'));
rejects('A3-limit banner colour change now needs a review (banner element is pinned)', CTX, mutate(ctx, "            background: syncPresentation.tone === 'success' ? '#065f46'", "            background: syncPresentation.tone === 'success' ? '#047857'"), /global sync banner drifted/u);
accepts('A4 unrelated effect added to the boundary', CTX, mutate(ctx, '  const isEditing = useCallback(', "  useEffect(() => { document.title = document.title || 'ERP'; }, []);\n  const isEditing = useCallback("));
accepts('A5 refresh message text changed', CTX, mutate(ctx, "        let message = '已更新至最新資料';", "        let message = '已更新為最新資料';"));
accepts('A6 unrelated top-level helper added', CTX, `${ctx}\nexport const formatSyncTime = (at: number) => new Date(at).toLocaleTimeString();\n`);
accepts('A7 presentation type declaration extended', PRES, mutate(pres, '  restorePending?: boolean;\n}', '  restorePending?: boolean;\n  /** reviewed: optional trace id */\n  traceId?: string;\n}'));
accepts('A8 comments in the policy module', POL, `// note for maintainers\n${pol}\n// end\n`);
accepts('A9 conflict close-button label changed', CTX, mutate(ctx, 'aria-label="關閉衝突提示"', 'aria-label="關閉資料衝突提示"'));
accepts('A11 context value type extended (type-only)', CTX, mutate(ctx, '  connectivity: CloudConnectivitySnapshot;\n  /** C1f', '  connectivity: CloudConnectivitySnapshot;\n  /** reviewed: optional */\n  syncPresentationNote?: string;\n  /** C1f'));
check('POS A12 named, aliased-named and type-only imports of other members pass the caller scan', () => assertP02FreshHoldCallers([
  ['src/components/M.tsx', "import { CloudOfflineWriteError } from '../providers/cloud/cloudConnectivity';\nexport const e = CloudOfflineWriteError;"],
  ['src/providers/p.ts', "import { assertCloudWriteAllowed as guard } from './cloud/cloudConnectivity';\nexport const g = guard;"],
  ['src/lib/t.ts', "import type { CloudReadFreshnessStatus } from '../providers/cloud/cloudConnectivity';\nexport type S = CloudReadFreshnessStatus;\nexport type M = typeof import('../providers/cloud/cloudConnectivity');"],
  ['src/lib/ok.ts', "export * from './unrelatedBarrel';\nexport const load = () => import('../pages/Dashboard');"],
]));
check('POS A13 type-only re-export of the module passes the caller scan', () => assertP02FreshHoldCallers([['src/lib/types.ts', "export type { CloudConnectivitySnapshot } from '../providers/cloud/cloudConnectivity';"]]));
check('POS A14 the whole current src tree passes the caller scan', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const list = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src'], { cwd: root }).toString().trim().split('\n').filter(f => /\.(?:ts|tsx)$/u.test(f));
  assert.ok(list.length > 100, 'src files listed');
  assertP02FreshHoldCallers(list.map(f => [f, readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')]));
});
check('POS A10 unrelated src files pass the Fresh hold caller scan', () => assertP02FreshHoldCallers([['src/pages/Dashboard.tsx', "import { getCloudConnectivitySnapshot } from '../providers/cloud/cloudConnectivity';\nexport const s = getCloudConnectivitySnapshot();"], [CTX, ctx]]));

// ---- dispatch: the contract runs inside the release inspection for every changed context file
check('POS dispatch is wired into inspectSafeDescendant before the parity verdicts', () => {
  const start = guardSource.indexOf('export function inspectSafeDescendant('), end = guardSource.indexOf('\nexport function verifySafeDescendant(');
  const body = guardSource.slice(start, end);
  const block = body.slice(body.indexOf('// ---- BEGIN p02-1a realtime context contract dispatch ----'), body.indexOf('// ---- END p02-1a realtime context contract dispatch ----'));
  assert.ok(block.length > 0, 'dispatch block inside inspectSafeDescendant');
  assert.match(block, /assertP02RealtimeContextContract\(file, source\(candidate\.head, file, true\)\)/u);
  assert.match(block, /assertP02FreshHoldCallers\(/u);
  assert.match(block, /assertP02FreshHoldCallers\(newFiles\.filter\(file => P02_SRC_SCRIPT\.test\(file\)\)/u, 'caller scan covers every script-like src file');
  assert.match(block, /assertP02SrcTreeModes\(git\(\['ls-tree', '-r', candidate\.head, '--', 'src'\]\)\)/u, 'src tree modes are checked on every inspection');
  assert.ok(body.indexOf('// ---- END p02-1a realtime context contract dispatch ----') < body.indexOf("if (!backupParity) fail("), 'runs before the verdicts');
  assert.equal(guardSource.split('// ---- BEGIN p02-1a realtime context contract').length, 3, 'exactly two marked blocks');
});

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ suite: 'P02_1A_CONTEXT_GUARD', total: results.length, passed: results.length - failed.length, failed: failed.length,
  limit: 'AST pins + syntactic containment + executable presentation invariant; not a general control-flow proof' }, null, 1));
process.exit(failed.length ? 1 : 0);
