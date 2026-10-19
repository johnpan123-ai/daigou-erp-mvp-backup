import assert from 'node:assert/strict';
import {recognitionDatabase} from './helpers/waca-recognition-isolated.mjs';
const db=await recognitionDatabase();
try {
  await db.importRows([db.row('PORTABLE',2)]);
  await db.manage('PORTABLE',[['G-SYNTHETIC','HOLD']]);
  const restore=await db.vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const next=await db.vite.ssrLoadModule('/src/providers/cloud/cloudBackupToNext.ts');
  const storage=await db.vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const exported=(await db.q('select public.erp_cloud_restore_snapshot() s')).rows[0].s;
  const built=await restore.buildCloudRestoreManifest(exported,exported);
  assert.equal(built.manifest.resourceCount,24);assert.equal(built.manifest.orphanCount,0);
  const document={schemaVersion:'cloud-erp-snapshot-v2',manifest:built.manifest,
    data:Object.fromEntries(restore.CLOUD_RESTORE_TABLES.map(([collection,table])=>[collection,exported[table]])),
    deadlineSidecar:{deadlineVerifiedMappings:[],deadlineApplyBatches:[],deadlineApplyItems:[]}};
  const source=await db.snapshot(),converted=await next.prepareCloudBackupForNextRestore(document,{fileName:'isolated-managed.json'});
  assert.equal(converted.summary.blockingOrphanCount,0);
  const target=converted.workbenchData;
  assert.deepEqual(target.wacaItems[0].recognition,source.items[0].recognition);
  assert.deepEqual(target.wacaImportBatches.find(b=>b.recognition).recognition,source.batches.find(b=>b.recognition).recognition);
  assert.deepEqual(target.wacaCutoverAudit.find(a=>a.recognitionContinuity).recognitionContinuity,source.cutoverAudit.find(a=>a.recognitionContinuity).recognitionContinuity);
  assert.equal(target.wacaCutoverState[0].mode,'ORDER_DRIVEN_ACTIVE');
  const localSnapshot={...source,items:target.wacaItems,batches:target.wacaImportBatches,cutoverAudit:target.wacaCutoverAudit};
  storage.validateNextWacaSnapshot(localSnapshot,target.productVariants);
  const candidate=await restore.prepareCloudRestoreSnapshot(document);
  await db.q("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
  const epochBefore=(await db.epoch()).epoch;
  const r=(await db.q('select public.erp_restore_cloud_snapshot($1,$2,$3,$4,$5) r',
    [crypto.randomUUID(),candidate.manifest.snapshotFingerprint,candidate.data,candidate.manifest,'isolated-management-roundtrip'])).rows[0].r;
  assert.equal(r.ok,true,JSON.stringify(r));
  const restored=await db.snapshot();
  assert.deepEqual(restored.items,source.items);assert.deepEqual(restored.batches,source.batches);assert.deepEqual(restored.cutoverAudit,source.cutoverAudit);
  assert.ok((await db.epoch()).epoch>epochBefore);assert.equal(await db.display(),10);
  // Restore keeps the decision but invalidates all old transaction plans/credit anchors.
  const stale=await db.makeRequest('PORTABLE',[['G-SYNTHETIC','COUNT']]);stale.restoreEpoch=epochBefore;
  const rejected=await db.http('erp_preview_waca_recognition',{p_request:stale});assert.equal(rejected.data.message,'WACA_RESTORE_EPOCH_CHANGED');
  console.log(JSON.stringify({result:'PASS',resources:24,orphan:0,managementDecisionPreserved:true,immutableReceiptPreserved:true,
    continuityPreserved:true,cloudToNextPreservesSnapshotMode:true,nextManagementReadOnly:true,restoreEpochInvalidatesOldPlan:true,
    deadlineStores:3,cloudRequests:0,productionWrites:0},null,2));
} finally {await db.close();}
