import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner} from './helpers/saveability-isolated.mjs';
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const db=await isolatedDatabase();
const report={};
try{
 await db.sql.query("set timezone='UTC'");
 const restore=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const portability=await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
 const bridge=await vite.ssrLoadModule('/src/providers/cloud/cloudBackupToNext.ts');
 const inventory=await vite.ssrLoadModule('/src/providers/cloud/inventoryImportPlan.ts');
 const catalog=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
 const currentRaw=readFileSync(process.env.ERP2_CURRENT_REAL_SNAPSHOT,'utf8');
 const current=await restore.prepareCloudRestoreSnapshot(currentRaw);
 for(const id of new Set(Object.values(current.data).flatMap(rows=>rows.map(row=>row.updated_by).filter(id=>id&&id!==owner))))
  await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[id,'isolated@example.invalid']);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const rawLegacy=readFileSync(process.env.ERP1_V1_REAL_SNAPSHOT,'utf8');
 const source=JSON.parse(rawLegacy);assert.equal(source.schemaVersion,'cloud-erp-snapshot-v1');
 const legacy=await restore.preserveLegacyCloudDashboardImages(await restore.prepareCloudRestoreSnapshot(rawLegacy),current.data.dashboard_category_images);
 const adapted=await portability.prepareCrossEnvironmentCloudRestoreCandidate(legacy,'rhfdjsklfrgpoqsaqpkn');
 const rpc=async(name,args)=>(await db.sql.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') r',args)).rows[0].r;
 const rows=async table=>(await db.sql.query('select to_jsonb(t) r from public.'+table+' t where deleted_at is null order by id')).rows.map(x=>x.r);
 for(const [label,candidate]of [['erp1',adapted],['erp2',current]]){
  const request=randomUUID(),attempt=randomUUID(),trace=randomUUID();
  const proof=await rpc('erp_prove_cloud_restore_candidate_v2',[candidate.sourceData??candidate.data,candidate.manifest,candidate.portability?'cross-environment':'strict','isolated',request]);
  assert.equal(proof.ok,true);
  await rpc('erp_prepare_cloud_restore_attempt',[attempt,trace,candidate.portability?.sourceSnapshotFingerprint??candidate.manifest.snapshotFingerprint,candidate.manifest.snapshotFingerprint,candidate.portability?.policyVersion??'strict','rhfdjsklfrgpoqsaqpkn',120000,'postgresql-statement-timeout-v1']);
  const body={p_attempt_id:attempt,p_trace_id:trace,p_execution_id:randomUUID(),p_proof_id:proof.proof_id,p_request_id:request};
  assert.equal(Buffer.byteLength(JSON.stringify(body)),269);
  const committed=await rpc('erp_restore_proven_cloud_snapshot_attempt',Object.values(body));assert.equal(committed.ok,true);
  const epoch=Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch where singleton')).rows[0].epoch);
  const batchId='catalog_import_'+randomUUID();
  const input=[{myacg_item_code:'__ISOLATED_RESTORE_IMPORT__'+label,product_title:'__ISOLATED_RESTORE_IMPORT__'+label,raw_variant_name:'A',listing_type:'日本代購',final_price:1,myacg_available_quantity:0,myacg_sold_quantity:2,myacg_listed_at:'',latest_catalog_import_id:batchId,catalog_last_seen_at:new Date().toISOString()}];
  const plan=inventory.planCloudInventoryImport(await rows('inventory_items'),input);
  const requestBody={family:'inventory_import',batchId,restoreEpoch:epoch,operations:plan.operations};
  const key=randomUUID();assert.equal((await rpc('erp_apply_inventory_import',[key,requestBody])).outcome,'COMMITTED');
  assert.equal((await rpc('erp_reconcile_inventory_import',[key,requestBody])).outcome,'COMMITTED');
  const cat=await catalog.planCatalogTransaction({inventory:await rows('inventory_items'),groups:await rows('product_groups'),categories:await rows('product_categories'),variants:await rows('product_variants')},'master',input.map(row=>row.myacg_item_code));
  assert.equal((await rpc('erp_apply_catalog_transaction',[randomUUID(),cat.request])).ok,true);
  const variant=(await rows('product_variants')).filter(row=>row.myacg_item_code===input[0].myacg_item_code);
  assert.equal(variant.length,1);assert.equal(Number(variant[0].myacg_auto_quantity),2);
  report[label]={restore:'PASS',buyAnime:'PASS',executeBytes:269};
 }
 const next=await bridge.prepareCloudBackupForNextRestore(currentRaw);
 assert.equal(next.summary.targetResourceCount,24);assert.equal(next.summary.blockingOrphanCount,0);
 assert.equal(next.workbenchData.wacaCutoverState[0]?.mode,current.data.waca_state[0]?.mode);
 for(const key of ['deadlineVerifiedMappings','deadlineApplyBatches','deadlineApplyItems'])assert.deepEqual(next.workbenchData[key],current.deadlineSidecar?.[key]??[]);
 report.cloudToNext={adapter:'PASS',summary:next.summary,browserReload:'NOT_COVERED_BY_NATIVE_TEST',supabaseRequests:0};
 if(process.env.BUYANIME_PORTABILITY_REPORT)writeFileSync(process.env.BUYANIME_PORTABILITY_REPORT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{await vite.close();await db.close();}
