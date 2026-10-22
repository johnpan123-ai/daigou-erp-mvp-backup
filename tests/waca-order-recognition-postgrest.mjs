import assert from 'node:assert/strict';
import pg from 'pg';
import { recognitionDatabase } from './helpers/waca-recognition-isolated.mjs';
import { owner,viewer,uuid } from './helpers/saveability-isolated.mjs';
const db=await recognitionDatabase(),checks={};
const pass=(name,evidence=true)=>{checks[name]=evidence;console.log('PASS '+name);};
const reject=async(rpc,args,code,message,actor=owner)=>{
  const before=await db.state(),r=await db.http(rpc,args,actor);
  assert.ok(r.status>=400,JSON.stringify(r));assert.equal(r.data.code,code,JSON.stringify(r));assert.match(r.data.message,new RegExp(message));
  assert.deepEqual(await db.state(),before,'All 24 resources + revision + epoch + generation unchanged');return r;
};
try {
  const start=(await db.q('select pg_postmaster_start_time() s')).rows[0].s.toISOString();
  await db.q(`create function public.erp_test_recognition_safeupdate() returns text language sql security definer set search_path=pg_catalog as $$
    select current_setting('safeupdate.enabled',true) $$; revoke all on function public.erp_test_recognition_safeupdate() from public,anon;
    grant execute on function public.erp_test_recognition_safeupdate() to authenticated`);
  await db.stopPostgrest(); await db.startPostgrest();
  assert.deepEqual(await db.http('erp_test_recognition_safeupdate',{}),{status:200,data:'on'});pass('safeupdate authenticated PostgREST');
  await db.importRows([db.row('ORDER-A',2),db.row('ORDER-A',3,'完成付款','G-SECOND'),db.row('ORDER-B',1)]);
  assert.equal(await db.display(),13);assert.equal(await db.display('G-SECOND'),23);
  const bBefore=(await db.snapshot()).items.find(i=>i.orderKey==='WACA::ORDER-B');
  const first=await db.manage('ORDER-A',[['G-SYNTHETIC','INCLUDED']]);
  assert.equal(first.plan.quantities[0].before,13);assert.equal(first.plan.quantities[0].after,11);assert.equal(await db.display(),11);
  assert.equal(await db.display('G-SECOND'),23);assert.deepEqual((await db.snapshot()).items.find(i=>i.key===bBefore.key),bBefore);
  pass('single / multi SKU / same SKU other order isolated');
  const beforeReplay=await db.state();await db.commit(first.request,first.plan);assert.deepEqual(await db.state(),beforeReplay);pass('request replay no writes');
  await reject('erp_commit_waca_recognition',{p_request:{...first.request,reason:'different request content'},p_expected_plan:first.plan},'23000','WACA_RECOGNITION_REQUEST_REUSED');pass('request identity collision fail closed');
  const noop=await db.manage('ORDER-A',[['G-SYNTHETIC','INCLUDED']]);assert.equal(noop.result.status,'NO_CHANGE');assert.deepEqual(await db.state(),beforeReplay);pass('same setting no receipt / no revision');
  const immutableBefore=(await db.q('select to_jsonb(b) r from public.waca_import_batches b where batch_key=$1',[first.request.requestId])).rows[0].r;
  const full=await db.snapshot();full.masterLinks.push({mainCode:'GP-LOCAL',childCode:'G-SYNTHETIC',productVariantId:uuid(2)});
  assert.equal((await db.http('erp_commit_waca_snapshot',{p_snapshot:full,p_expected_revision:full.revision,p_update_auto_quantity:false})).status,200);
  const whole=await db.snapshot();
  assert.equal((await db.http('erp_commit_waca_counted_snapshot',{p_snapshot:whole,p_expected_revision:whole.revision,p_plan:{contract:'waca-counted-import-v1',restoreEpoch:(await db.epoch()).epoch,overwriteVariantIds:[],expectedDisplay:{}}})).status,200);
  assert.deepEqual((await db.q('select to_jsonb(b) r from public.waca_import_batches b where batch_key=$1',[first.request.requestId])).rows[0].r,immutableBefore);
  assert.equal(await db.display(),11);pass('legacy full-snapshot metadata / counted callers preserve immutable history');
  await db.importRows([db.row('ORDER-A',2)]);assert.equal(await db.display(),11);pass('reimport preserves INCLUDED');
  await db.manage('ORDER-A',[['G-SYNTHETIC','COUNT']]);assert.equal(await db.display(),13);pass('INCLUDED -> COUNT');
  await db.manage('ORDER-A',[['G-SYNTHETIC','HOLD']]);assert.equal(await db.display(),11);pass('COUNT -> HOLD safe reverse');
  const heldBefore=await db.state();const holdNoop=await db.manage('ORDER-A',[['G-SYNTHETIC','HOLD']]);assert.equal(holdNoop.result.status,'NO_CHANGE');assert.deepEqual(await db.state(),heldBefore);
  await db.importRows([db.row('ORDER-A',2)]);assert.equal(await db.display(),11);pass('HOLD persists / repeat no-op');
  await db.manage('ORDER-A',[['G-SYNTHETIC','COUNT']]);assert.equal(await db.display(),13);pass('HOLD -> COUNT');
  await db.importRows([db.row('ORDER-A',1)]);assert.equal(await db.display(),12);pass('COUNT source reduction one safe reversal');
  await db.importRows([db.row('ORDER-A',1,'取消'),db.row('ORDER-A',3,'取消','G-SECOND')]);assert.equal(await db.display(),11);
  await db.importRows([db.row('ORDER-A',1,'取消')]);assert.equal(await db.display(),11);pass('cancel / repeat cancel once');
  const inactive=await db.makeRequest('ORDER-A',[['G-SYNTHETIC','COUNT']]);await reject('erp_preview_waca_recognition',{p_request:inactive},'23000','WACA_INACTIVE_ORDER_NOT_COUNTABLE');pass('inactive cannot count');
  await db.importRows([db.row('ORDER-A',2)]);assert.equal(await db.display(),13);pass('reactivation follows preserved COUNT');
  await db.manage('ORDER-A',[['G-SYNTHETIC','INCLUDED']]);assert.equal(await db.display(),11);
  await db.importRows([db.row('ORDER-A',1,'取消')]);assert.equal(await db.display(),11);pass('already reversed cancellation never deducts again');
  await db.importRows([db.row('ORDER-A',4)]);assert.equal(await db.display(),11);
  assert.equal((await db.snapshot()).items.find(i=>i.orderKey==='WACA::ORDER-A'&&i.productVariantId===uuid(2)).countedReview,'OWNER_SOURCE_CHANGED');pass('INCLUDED changed source stays review, not added');
  await db.manage('ORDER-A',[['G-SYNTHETIC','COUNT']]);assert.equal(await db.display(),15);
  const manualRequest=await db.makeRequest('ORDER-A',[['G-SYNTHETIC','HOLD']]);const oldPlan=await db.preview(manualRequest);
  await db.q('update public.product_variants set waca_manual_adjustment=waca_manual_adjustment+1,version=version+1,updated_at=clock_timestamp() where id=$1',[uuid(2)]);
  await reject('erp_commit_waca_recognition',{p_request:manualRequest,p_expected_plan:oldPlan},'23000','WACA_REVERSAL_PROOF_REQUIRED');pass('manual adjustment invalidates negative proof');
  // New controlled import creates a fresh proof; no manual changes are erased.
  await db.importRows([db.row('ORDER-A',5)]);assert.equal(await db.display(),17);
  await reject('erp_preview_waca_recognition',{p_request:await db.makeRequest('ORDER-A',[['G-SYNTHETIC','HOLD']])},'23000','WACA_REVERSAL_PROOF_REQUIRED');pass('later import cannot launder manual-offset old credit');
  await db.importRows([db.row('ORDER-D',1)]);
  const stale=await db.makeRequest('ORDER-D',[['G-SYNTHETIC','HOLD']]),stalePlan=await db.preview(stale);
  await db.importRows([db.row('ORDER-B',2)]);
  await reject('erp_commit_waca_recognition',{p_request:stale,p_expected_plan:stalePlan},'PT409','WACA_STALE_REVISION');pass('revision CAS');
  const epochRequest=await db.makeRequest('ORDER-D',[['G-SYNTHETIC','HOLD']]),epochPlan=await db.preview(epochRequest);
  // An authenticated caller must not bypass the client's restored-decision check
  // by rebinding a formerly valid import plan to the new Epoch.
  const restoredDecisionImport=await db.prepareImport([db.row('ORDER-A',6)]);
  await db.q('update public.erp_cloud_restore_epoch set epoch=epoch+1 where singleton');
  await reject('erp_commit_waca_recognition',{p_request:epochRequest,p_expected_plan:epochPlan},'PT409','WACA_RESTORE_EPOCH_CHANGED');
  await reject('erp_preview_waca_recognition',{p_request:await db.makeRequest('ORDER-A',[['G-SYNTHETIC','HOLD']])},'23000','WACA_REVERSAL_PROOF_REQUIRED');pass('epoch old request / old quantity evidence rejected');
  restoredDecisionImport.p_plan.restoreEpoch=(await db.epoch()).epoch;
  await reject('erp_commit_waca_counted_snapshot',restoredDecisionImport,'23000','WACA_MANAGED_RESTORE_REVIEW_REQUIRED');
  pass('server rejects restored decision quantity drift even with current import epoch');
  // Safe isolated fixture: fresh normal source write in this generation, then manage that new order.
  await db.importRows([db.row('ORDER-C',1)]);
  const secure=await db.makeRequest('ORDER-C',[['G-SYNTHETIC','HOLD']]),securePlan=await db.preview(secure);
  for(const actor of [viewer,uuid(999),null]) await reject('erp_commit_waca_recognition',{p_request:secure,p_expected_plan:securePlan},'42501',actor?'WACA_OWNER_REQUIRED':'permission denied',actor);
  await reject('erp_preview_waca_recognition',{p_request:secure},'42501','WACA_OWNER_REQUIRED',viewer);pass('Owner / anon / unknown / preview permissions');
  for(const rpc of ['erp_commit_waca_snapshot_v044','erp_commit_waca_counted_snapshot_v074','erp_plan_waca_recognition','erp_waca_reversal_proven']) {
    assert.equal((await db.q("select has_function_privilege('authenticated',p.oid,'execute') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",[rpc])).rows[0].allowed,false);
  }pass('delegates / proof helpers private');
  const lock=new pg.Client({connectionString:db.url.toString()});await lock.connect();
  try {await lock.query("select pg_advisory_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0))");await reject('erp_commit_waca_recognition',{p_request:secure,p_expected_plan:securePlan},'55006','CLOUD_RESTORE_MAINTENANCE_LOCKED');} finally{await lock.end();}pass('Restore lock');
  const bad=structuredClone(securePlan);bad.quantities[0].after++;
  await reject('erp_commit_waca_recognition',{p_request:secure,p_expected_plan:bad},'PT409','WACA_RECOGNITION_PREVIEW_CHANGED');pass('exact preview / submit parity');
  await db.q(`create function public.erp_test_recognition_failure() returns trigger language plpgsql as $$ begin
    if new.payload->'recognition' is not null then raise exception 'FORCED_RECOGNITION_FAILURE' using errcode='23514';end if;return new;end $$;
    create trigger erp_test_recognition_failure before insert on public.waca_import_batches for each row execute function public.erp_test_recognition_failure()`);
  await reject('erp_commit_waca_recognition',{p_request:secure,p_expected_plan:securePlan},'23514','FORCED_RECOGNITION_FAILURE');
  await db.q('drop trigger erp_test_recognition_failure on public.waca_import_batches;drop function public.erp_test_recognition_failure()');pass('late failure all 24 resources rollback');
  let writes=0;
  const verified=await db.management.commitAndVerifyWacaRecognition({getNextWacaSnapshot:db.snapshot,getAuthoritativeWacaVariants:db.variants,readWacaRestoreEpoch:db.epoch,
    commitWacaRecognition:async(r,p)=>{writes++;await db.commit(r,p);throw new Error('RESPONSE_LOST');}},secure,securePlan);
  assert.equal(writes,1);assert.equal(verified.result.status,'COMMITTED');pass('response loss receipt reconcile / replay 0');
  const forged=await db.prepareImport([db.row('ORDER-C',1)]);forged.p_snapshot.items=(await db.snapshot()).items.filter(i=>i.orderKey==='WACA::ORDER-C').map(i=>({...i,recognition:undefined,countedQuantity:99}));
  await reject('erp_commit_waca_counted_snapshot',forged,'23000','WACA_OWNER_DECISION_IMMUTABLE');pass('old import cannot erase manual evidence');
  const audit=await db.snapshot();assert.equal(audit.batches.filter(b=>b.id===secure.requestId).length,1);assert.ok(audit.batches.find(b=>b.id===first.request.requestId).recognition);
  await db.importRows([db.row('MULTI',1),db.row('MULTI',2,'完成付款','G-SECOND')]);
  const multi=await db.manage('MULTI',[['G-SYNTHETIC','HOLD'],['G-SECOND','INCLUDED']]);
  assert.equal(multi.plan.lines.length,2);assert.equal(multi.plan.quantities.length,2);pass('one atomic management transaction / two independent SKUs');
  const fakeReceipt={...(await db.prepareImport([db.row('MULTI',1)]))};fakeReceipt.p_snapshot.batches=[{...audit.batches.find(b=>b.id===secure.requestId),fileName:'tampered'}];
  await reject('erp_commit_waca_counted_snapshot',fakeReceipt,'23000','WACA_RECOGNITION_RECEIPT_IMMUTABLE');pass('old management receipt immutable');
  const fakeProof=await db.prepareImport([db.row('MULTI',1)]);fakeProof.p_snapshot.cutoverAudit=(await db.snapshot()).cutoverAudit.map(a=>({...a,recognitionContinuity:{epoch:999}}));
  await reject('erp_commit_waca_counted_snapshot',fakeProof,'23000','WACA_RECOGNITION_PROOF_IMMUTABLE');pass('continuity proof cannot be client rewritten');
  assert.equal((await db.q('select pg_postmaster_start_time() s')).rows[0].s.toISOString(),start);pass('audit retained / no duplicate / restart 0');
  console.log(JSON.stringify({result:'PASS',checks,cloudWrites:0,liveMigration:0,partialWrite:0},null,2));
} finally {await db.close();}
