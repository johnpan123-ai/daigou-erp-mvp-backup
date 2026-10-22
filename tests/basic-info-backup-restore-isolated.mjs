// 官方結單日 / 發售月份 / 官網網址: Backup / Restore compatibility in a disposable PostgreSQL (canonical fresh install, no Live).
// 1. seed with the real ERP2 v2 backup (strict Restore);
// 2. edit the three fields of one product group through the same field-CAS path the UI uses
//    (toCloudFieldRow -> buildCloudCollectionMutationPlan -> erp_apply_field_mutations), once per edit;
// 3. a stale edit (old base) is rejected by CAS / revision;
// 4. full backup exactly like the app (erp_export_cloud_restore_snapshot_json -> buildCloudRestoreManifest -> file JSON);
//    the file format matches the existing backup file (same top-level keys, same product_groups columns);
// 5. edit the fields again, then Restore the backup (strict, atomic, verified): the fields return to the backup values,
//    the epoch advances, every resource matches the backup, and an edit based on pre-Restore data is rejected;
// 6. the restored row renders the same on level 1 and level 2 (React harness, restored values).
// Real business snapshots stay outside Git (ERP2_V2_DUPSKU_SNAPSHOT).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';

const v2Path = process.env.ERP2_V2_DUPSKU_SNAPSHOT;
assert.ok(v2Path, 'ERP2_V2_DUPSKU_SNAPSHOT is required');
const sha = v => createHash('sha256').update(v).digest('hex');
const v2Raw = await readFile(v2Path);
assert.equal(sha(v2Raw), 'c80a4e533723f0da1d3b092b789d8c1186f07c4a08d86ae75d632819dac45eac', 'EXACT_ERP2_FILE_REQUIRED');
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const db = await isolatedDatabase();
const summary = { liveConnections: 0, liveRestore: 0 };
const instant = v => { const f = (String(v).match(/\.(\d+)/u)?.[1] ?? '').padEnd(6, '0').slice(0, 6); return (BigInt(Math.floor(Date.parse(v) / 1000)) * 1000000n + BigInt(f || '0')).toString(); };
const canonical = (v, k = '') => Array.isArray(v) ? v.map(x => canonical(x)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key], key)]))
    : k.endsWith('_at') && typeof v === 'string' && Number.isFinite(Date.parse(v)) ? instant(v) : v;
const hash = v => sha(JSON.stringify(canonical(v)));
try {
  const r = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const upload = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
  const payload = await vite.ssrLoadModule('/src/providers/cloud/cloudEntityPayload.ts');
  const cas = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const epoch = async () => Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch')).rows[0].epoch);
  const restore = async candidate => {
    const request = randomUUID(), attempt = randomUUID(), trace = randomUUID();
    const proof = await upload.uploadCloudRestoreCandidate(async (name, args) => {
      const keys = { erp_begin_restore_upload: ['p_request_id', 'p_manifest', 'p_restore_mode', 'p_source_environment'],
        erp_upload_restore_chunk: ['p_request_id', 'p_resource', 'p_ordinal', 'p_rows'], erp_upload_restore_chunk_batch: ['p_request_id', 'p_chunks'],
        erp_stage_restore_upload_resource: ['p_request_id', 'p_resource'], erp_finalize_restore_upload: ['p_request_id'] };
      const values = keys[name].map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
      return { data: (await db.sql.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) result`, values)).rows[0].result, error: null };
    }, { ...candidate, sourceEnvironment: 'isolated' }, candidate.sourceData ?? candidate.data, 'strict', request);
    assert.equal(proof.ok, true);
    await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',
      [attempt, trace, candidate.manifest.snapshotFingerprint, candidate.manifest.snapshotFingerprint, 'strict', 'rhfdjsklfrgpoqsaqpkn', 120000, 'postgresql-statement-timeout-v1']);
    const body = [attempt, trace, randomUUID(), proof.proof_id, request];
    const result = (await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result', body)).rows[0].result;
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
    const verified = (await db.sql.query('select public.erp_verify_committed_cloud_restore($1,$2,$3) result', body.slice(0, 3))).rows[0].result;
    assert.equal(verified.status, 'RESTORE_COMMITTED_VERIFIED'); assert.equal(verified.generationCertified, true);
    return result;
  };
  // Backup exactly like supabaseProvider's download. The deadline sidecar lives in browser storage, not in the database:
  // the one from the seed backup is carried over (as the same browser would provide it).
  const backupFile = async sidecar => {
    const raw = (await db.sql.query(`select public.${r.CLOUD_RESTORE_SNAPSHOT_RPC}() data`)).rows[0].data;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const prepared = await r.buildCloudRestoreManifest(parsed, parsed);
    const fileData = Object.fromEntries(r.CLOUD_RESTORE_TABLES.map(([collection, table]) => [collection, prepared.data[table]]));
    return JSON.stringify({ schemaVersion: r.CLOUD_RESTORE_SCHEMA_VERSION, sourceEnvironment: 'cloud-authoritative', manifest: prepared.manifest, data: fileData, deadlineSidecar: sidecar }, null, 2);
  };
  const groupRow = async id => (await db.sql.query('select * from public.product_groups where id=$1', [id])).rows[0];
  const applyEdit = async (baseRow, changes) => {
    const base = payload.toCloudFieldRow('product_groups', baseRow);
    const ops = cas.buildCloudCollectionMutationPlan('product_groups', [base], [{ ...base, ...changes }], { deleteMissing: false });
    const result = (await db.sql.query('select public.erp_apply_field_mutations($1,$2::jsonb) result', ['product_groups', JSON.stringify(ops)])).rows[0].result;
    return { ops, result };
  };
  await db.sql.query("select set_config('request.headers',$1,false)", [JSON.stringify({ host: 'rhfdjsklfrgpoqsaqpkn.supabase.co' })]);

  // 1) Seed with the real ERP2 v2 backup.
  const seed = await r.prepareCloudRestoreSnapshot(JSON.parse(v2Raw.toString('utf8')), { sourceFileSha256: sha(v2Raw) });
  if (seed.data.dashboard_category_images.every(row => !Object.hasOwn(row, 'local_id') && !Object.hasOwn(row, 'version')))
    await db.sql.query('alter table public.dashboard_category_images drop column local_id,drop column version');
  for (const uid of new Set(Object.values(seed.data).flatMap(rows => rows.map(x => x.updated_by).filter(Boolean))))
    await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing', [uid, 'isolated@example.invalid']);
  await restore(seed);
  const target = (await db.sql.query("select id from public.product_groups where deleted_at is null and id <> '00000000-0000-4000-a000-000000000000' and coalesce(title,'') <> '' order by id limit 1")).rows[0].id;
  const original = await groupRow(target);
  summary.target = { id: target, before: { closing_date: original.closing_date, release_month: original.release_month, product_url: original.product_url, version: Number(original.version) } };

  // 2) Edit each field once, the way level 1 / level 2 commit (one RPC per Blur / Enter).
  const edits = [{ closing_date: '2027/03/15' }, { release_month: '2027-03' }, { product_url: 'https://example.com/backup-restore' }];
  let base = original; const rpcPerEdit = [];
  for (const change of edits) {
    const { ops, result } = await applyEdit(base, change);
    assert.equal(ops.length, 1); assert.deepEqual(Object.keys(ops[0].changes), Object.keys(change), 'only the edited field is sent');
    assert.equal(result.ok, true, JSON.stringify(result));
    rpcPerEdit.push(1);
    base = await groupRow(target);
  }
  const edited = await groupRow(target);
  summary.edited = { closing_date: edited.closing_date, release_month: edited.release_month, product_url: edited.product_url, version: Number(edited.version), rpcPerEdit };
  assert.deepEqual([edited.closing_date, edited.release_month, edited.product_url], ['2027/03/15', '2027-03', 'https://example.com/backup-restore']);
  // Unchanged value: no operation at all.
  assert.equal(cas.buildCloudCollectionMutationPlan('product_groups', [payload.toCloudFieldRow('product_groups', edited)], [payload.toCloudFieldRow('product_groups', edited)], { deleteMissing: false }).length, 0);

  // 3) Stale edit (based on the original row) is rejected; the newer value stays.
  const stale = await applyEdit(original, { product_url: 'https://example.com/stale-overwrite' });
  summary.staleEdit = { ok: stale.result.ok, code: stale.result.code ?? stale.result.error ?? null };
  assert.notEqual(stale.result.ok, true, 'stale CAS edit must be rejected');
  assert.equal((await groupRow(target)).product_url, 'https://example.com/backup-restore');

  // 4) Full backup like the app; format matches the existing backup file.
  const reference = JSON.parse(v2Raw.toString('utf8'));
  const backupText = await backupFile(reference.deadlineSidecar);
  const backup = JSON.parse(backupText);
  summary.backupFormat = {
    topLevelKeys: Object.keys(backup).sort(), referenceTopLevelKeys: Object.keys(reference).sort(),
    collections: Object.keys(backup.data).sort().join(',') === Object.keys(reference.data).sort().join(','),
    productGroupColumns: Object.keys(backup.data.productGroups[0]).sort().join(',') === Object.keys(reference.data.productGroups[0]).sort().join(','),
    schemaVersion: backup.schemaVersion === reference.schemaVersion,
  };
  assert.deepEqual(summary.backupFormat.topLevelKeys, summary.backupFormat.referenceTopLevelKeys);
  assert.ok(summary.backupFormat.collections && summary.backupFormat.productGroupColumns && summary.backupFormat.schemaVersion);
  const inBackup = backup.data.productGroups.find(g => g.id === target);
  summary.inBackup = { closing_date: inBackup.closing_date, release_month: inBackup.release_month, product_url: inBackup.product_url };
  assert.deepEqual(summary.inBackup, { closing_date: '2027/03/15', release_month: '2027-03', product_url: 'https://example.com/backup-restore' });

  // 5) Change again, then Restore the backup.
  await applyEdit(await groupRow(target), { closing_date: '2028/01/01', release_month: '2028-01', product_url: 'https://example.com/after-backup' });
  const preRestore = await groupRow(target);
  assert.equal(preRestore.product_url, 'https://example.com/after-backup');
  const epochBefore = await epoch();
  const candidate = await r.prepareCloudRestoreSnapshot(backup, { sourceFileSha256: sha(Buffer.from(backupText)) });
  await restore(candidate);
  const restored = await groupRow(target);
  const readback = await r.buildCloudRestoreManifest((await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data);
  summary.restore = {
    epochBefore, epochAfter: await epoch(),
    fields: { closing_date: restored.closing_date, release_month: restored.release_month, product_url: restored.product_url },
    parity: hash(readback.data) === hash(candidate.data),
    identityKept: restored.id === target && restored.local_id === original.local_id,
  };
  assert.ok(summary.restore.epochAfter > epochBefore, 'Restore epoch advances');
  assert.deepEqual(summary.restore.fields, summary.inBackup);
  assert.equal(summary.restore.parity, true, 'every resource equals the backup after Restore');
  assert.equal(summary.restore.identityKept, true, 'UUID / local identity unchanged');
  // An edit based on pre-Restore data is rejected; one based on the restored row is accepted.
  const preRestoreEdit = await applyEdit(preRestore, { product_url: 'https://example.com/pre-restore-draft' });
  summary.restore.preRestoreEdit = { ok: preRestoreEdit.result.ok, code: preRestoreEdit.result.code ?? preRestoreEdit.result.error ?? null };
  assert.notEqual(preRestoreEdit.result.ok, true, 'pre-Restore based edit must be rejected');
  assert.equal((await groupRow(target)).product_url, 'https://example.com/backup-restore');
  const postRestoreEdit = await applyEdit(restored, { release_month: '2027-04' });
  assert.equal(postRestoreEdit.result.ok, true);
  summary.restore.postRestoreEdit = 'accepted';
  await applyEdit(await groupRow(target), { release_month: '2027-03' }); // back to the restored value for the UI check

  // 6) Restored values render the same on level 1 and level 2 (harness page, restored field values).
  if (existsSync(CHROME)) {
    const PORT = process.env.BASIC_INFO_RESTORE_UI_PORT || '4730';
    const ROOT = fileURLToPath(new URL('../', import.meta.url));
    const ui = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    try {
      const URL_ = `http://127.0.0.1:${PORT}/tests/fixtures/cloud-p0-2-react-harness.html`;
      for (let i = 0; i < 80; i += 1) { try { if ((await fetch(URL_)).ok) break; } catch { /* starting */ } await new Promise(res => setTimeout(res, 250)); }
      const browser = await chromium.launch({ executablePath: CHROME, headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        await page.addInitScript(() => { localStorage.setItem('erp_provider_mode', 'experimental'); localStorage.setItem('purchase_management_edit_mode', 'false'); });
        await page.goto(`${URL_}?route=${encodeURIComponent('/purchase-records/g-holo')}&uuidFixtures=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
        const fields = summary.restore.fields;
        await page.evaluate(async value => {
          const h = window.__P0_REACT_HARNESS__;
          await h.emitUpsert('product_groups', { ...h.server.productGroups.find(g => g.id === h.fixtureId('g-holo')), ...value, updated_at: new Date().toISOString() });
        }, fields);
        await page.getByText('結單日：2027/03/15').waitFor();
        const level2 = { info: (await page.getByTestId('purchase-group-info-line').innerText()).replace(/\s+/gu, ' '), href: await page.getByTestId('purchase-group-official-link').getAttribute('href') };
        await page.evaluate(() => window.__P0_REACT_HARNESS__.navigate('/purchase-records'));
        const row = page.getByRole('row').filter({ hasText: 'hololive active' }).first(); await row.waitFor();
        const level1 = { text: (await row.innerText()).replace(/\s+/gu, ' ').match(/結單 \S+ 發售：\S+ 🔗 官網/u)?.[0], href: await row.locator('a', { hasText: '官網' }).getAttribute('href') };
        summary.uiAfterRestore = { level1, level2 };
        assert.match(level2.info, /結單日：2027\/03\/15 發售月份：2027\/03/u); assert.equal(level2.href, 'https://example.com/backup-restore');
        assert.equal(level1.text, '結單 03/15 發售：2027年03月 🔗 官網'); assert.equal(level1.href, 'https://example.com/backup-restore');
      } finally { await browser.close(); }
    } finally { ui.kill(); }
  } else summary.uiAfterRestore = 'NOT RUN (no Chrome)';
  console.log(JSON.stringify({ result: 'PASS', ...summary }, null, 1));
} finally {
  await db.close(); await vite.close();
}
