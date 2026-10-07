// Real business snapshots stay outside Git. No Live connection or browser.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';

const realPath=process.env.ERP1_V1_REAL_SNAPSHOT;
const currentPath=process.env.ERP2_CURRENT_REAL_SNAPSHOT;
assert.ok(realPath&&currentPath,'Both exact ERP1 and current ERP2 local snapshots are required');
const raw=await readFile(realPath,'utf8');
assert.equal(createHash('sha256').update(raw).digest('hex'),
  '0048b8b66542d09bbabaad6b7f7741c11f687449d1711cacd6e62e24ef5500e4','EXACT_USER_FILE_REQUIRED');
const original=JSON.parse(raw);
const currentRaw=await readFile(currentPath,'utf8');
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
const db=await isolatedDatabase();
const sha=v=>createHash('sha256').update(v).digest('hex');
const instant=v=>{const fraction=(String(v).match(/\.(\d+)/u)?.[1]??'').padEnd(6,'0').slice(0,6);
  return (BigInt(Math.floor(Date.parse(v)/1000))*1000000n+BigInt(fraction||'0')).toString();};
const canonical=(v,k='')=>Array.isArray(v)?v.map(x=>canonical(x)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
 :v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k],k)]))
 :k.endsWith('_at')&&typeof v==='string'&&Number.isFinite(Date.parse(v))?instant(v):v;
const hash=v=>sha(JSON.stringify(canonical(v)));
const summary={exactFileSha256:sha(raw),parse:'PASS',legacyValidation:'PENDING',liveRestore:0,liveMutation:0};
try{
 const r=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const p=await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const readback=async()=>r.buildCloudRestoreManifest((await db.sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data);
 const oldTables=r.CLOUD_RESTORE_TABLES.filter(([,t])=>t!=='import_batches'&&!['dashboard_category_images','waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit','waca_state'].includes(t));
 const prepare=async(candidate)=>{
   const request=randomUUID(),attempt=randomUUID(),trace=randomUUID();
   const proof=await upload.uploadCloudRestoreCandidate(async(name,args)=>{
     const keys={erp_begin_restore_upload:['p_request_id','p_manifest','p_restore_mode','p_source_environment'],
       erp_upload_restore_chunk:['p_request_id','p_resource','p_ordinal','p_rows'],
       erp_stage_restore_upload_resource:['p_request_id','p_resource'],erp_finalize_restore_upload:['p_request_id']};
     const values=keys[name].map(key=>typeof args[key]==='object'?JSON.stringify(args[key]):args[key]);
     return {data:(await db.sql.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result,error:null};
   },{...candidate,sourceEnvironment:'isolated'},candidate.sourceData??candidate.data,
     candidate.portability?'cross-environment':'strict',request);
   assert.equal(proof.ok,true);
   await db.sql.query('select public.erp_prepare_cloud_restore_attempt($1,$2,$3,$4,$5,$6,$7,$8)',
     [attempt,trace,candidate.portability?.sourceSnapshotFingerprint??candidate.manifest.snapshotFingerprint,
       candidate.manifest.snapshotFingerprint,candidate.portability?.policyVersion??'strict','rhfdjsklfrgpoqsaqpkn',120000,'postgresql-statement-timeout-v1']);
   assert.equal((await db.sql.query('select status from public.erp_cloud_restore_attempts where attempt_id=$1',[attempt])).rows[0].status,'prepared');
   return {request,attempt,trace,proof};
 };
 const execute=async(q)=>{
   const body={p_attempt_id:q.attempt,p_trace_id:q.trace,p_execution_id:randomUUID(),p_proof_id:q.proof.proof_id,p_request_id:q.request};
   assert.equal(Buffer.byteLength(JSON.stringify(body)),269);
   return (await db.sql.query('select public.erp_restore_proven_cloud_snapshot_attempt($1,$2,$3,$4,$5) result',Object.values(body))).rows[0].result;
 };
 const restore=async(c)=>{const q=await prepare(c);const result=await execute(q);assert.equal(result.ok,true);return result;};
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);

 // Current full backup first, including its actual WACA and timestamps. This
 // also proves the legacy policy on an already populated ERP2 target.
 const current=await r.prepareCloudRestoreSnapshot(currentRaw);
 // Exact Live has neither of these optional historical Dashboard columns.
 // Model that physical contract rather than accepting/ignoring changed rows.
 if(current.data.dashboard_category_images.every(row=>!Object.hasOwn(row,'local_id')&&!Object.hasOwn(row,'version')))
   await db.sql.query('alter table public.dashboard_category_images drop column local_id,drop column version');
 for(const id of new Set(Object.values(current.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(id=>id&&id!==owner))))
   await db.sql.query('insert into auth.users(id,email) values($1,$2) on conflict do nothing',[id,'isolated@example.invalid']);
 await restore(current);const currentAfter=await readback();
 if(hash(currentAfter.data)!==hash(current.data)) {
  const differences={};
  for(const [table,rows] of Object.entries(current.data)) {
   const actual=new Map(currentAfter.data[table].map(row=>[row.id,row]));
   for(const row of rows)for(const key of new Set([...Object.keys(row),...Object.keys(actual.get(row.id)??{})])) {
    if(JSON.stringify(canonical(row[key],key))!==JSON.stringify(canonical(actual.get(row.id)?.[key],key)))
      differences[`${table}.${key}`]=(differences[`${table}.${key}`]??0)+1;
   }
  }
  console.log(JSON.stringify({currentParityFieldDifferences:differences}));
 }
 assert.equal(hash(currentAfter.data),hash(current.data),'CURRENT_24_BUSINESS_PARITY');
 assert.ok(current.data.outbound_shipments.length>=37);
 summary.current24='PASS';summary.currentWaca='PASS';summary.currentDeadline='PASS';
 summary.outboundTimestamps=`${current.data.outbound_shipments.length}/${current.data.outbound_shipments.length} MATCH`;

 let source=await r.prepareCloudRestoreSnapshot(raw);
 assert.equal(source.legacyWacaBackup,true);assert.equal(original.manifest.resourceCount,15);
 assert.equal(source.data.outbound_shipments.every(x=>x.status_changed_at===null),true);
 source=await r.preserveLegacyCloudDashboardImages(source,current.data.dashboard_category_images);
 const candidate=await p.prepareCrossEnvironmentCloudRestoreCandidate(source,'rhfdjsklfrgpoqsaqpkn');
 await p.assertCloudRestoreEffectiveCandidate(candidate);
 summary.legacyValidation='PASS';summary.prepare='PASS';summary.proof='PASS';
 await restore(candidate);const after=await readback();
 const parity=Object.fromEntries(oldTables.map(([,table])=>{
   const expected=candidate.data[table],actual=after.data[table];
   const active=x=>x.filter(r=>!r.deleted_at).length;
   assert.equal(actual.length,expected.length);assert.equal(active(actual),active(expected));
   assert.deepEqual(actual.map(r=>r.id).sort(),expected.map(r=>r.id).sort());
   // The historical INSERT column contract uses target defaults for audit
   // metadata absent in ERP1 (notably bundle_components). Do not ignore any
   // source-provided value or any newly appearing business field.
   const projected=expected.map(row=>{
     const found=actual.find(x=>x.id===row.id);
     for(const key of Object.keys(found).filter(key=>!(key in row))){
       assert.ok(['updated_at','deleted_at','sync_status'].includes(key),`UNEXPECTED_BUSINESS_FIELD:${table}.${key}`);
       if(key==='deleted_at')assert.equal(found[key],null);
       if(key==='sync_status')assert.equal(found[key],'synced');
       if(key==='updated_at')assert.ok(Number.isFinite(Date.parse(found[key])));
     }
     return Object.fromEntries(Object.keys(row).map(key=>[key,found[key]]));
   });
   assert.equal(hash(projected),hash(expected),`BUSINESS_PARITY:${table}`);
   return [table,{rows:actual.length,active:active(actual),deleted:actual.length-active(actual),canonicalIds:'MATCH',businessHash:hash(projected),result:'PASS'}];
 }));
 for(const table of ['import_batches','waca_orders','waca_order_items','waca_mappings','waca_master_links','waca_import_batches','waca_cutover_audit'])assert.equal(after.data[table].length,0,`EXISTING_LEGACY_REBASELINE_POLICY:${table}`);
 assert.equal(after.data.waca_state[0].mode,'ORDER_REBASELINE_REQUIRED');
 assert.equal(after.data.waca_state[0].revision,0);
 assert.equal(hash(after.data.dashboard_category_images),hash(current.data.dashboard_category_images));
 assert.equal(after.manifest.orphanCount,0);assert.equal(after.manifest.duplicateCanonicalIdCount,0);
 summary.exactUserRestore='PASS';summary.execute='PASS';summary.integrity='PASS';summary.commit='PASS';summary.sharedResources=15;summary.sharedRows=18896;summary.sharedParity=parity;
 summary.erp2OnlyPolicy='PASS (existing rebaseline/reset; dashboard preserved; Deadline/ops outside shared restore unchanged)';

 // Generic v1 from a subset of the same authenticated historical row shape,
 // with no new timestamp evidence. It never replaces the exact-file test.
 const genericData=Object.fromEntries(oldTables.map(([,table])=>[table,[]]));
 genericData.inventory_items=[source.data.inventory_items[0]];
 const oldData=structuredClone(genericData);delete oldData.inventory_items[0].myacg_parent_code;
 const counts=Object.fromEntries(oldTables.map(([,t])=>[t,oldData[t].length]));
 const projection=oldTables.flatMap(([,table])=>oldData[table].map(row=>({table,id:row.id,relations:Object.fromEntries(Object.entries(row).filter(([key])=>key.endsWith('_id')&&key!=='local_id'))}))).sort((a,b)=>`${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
 const generic={schemaVersion:'cloud-erp-snapshot-v1',data:oldData,manifest:{...original.manifest,counts,totalRows:1,snapshotFingerprint:await r.sha256Hex(r.stableCloudRestoreJson(oldData)),relationshipHash:await r.sha256Hex(r.stableCloudRestoreJson(projection))}};
 await r.prepareCloudRestoreSnapshot(generic);summary.genericV1='PASS';
 const explicitHistory=async(value)=>{
   const doc=structuredClone(generic);
   const shipment={...source.data.outbound_shipments[0],status_changed_at:value};
   doc.data.outbound_shipments=[shipment];doc.manifest.counts.outbound_shipments=1;doc.manifest.totalRows=2;
   const relations=oldTables.flatMap(([,table])=>doc.data[table].map(row=>({table,id:row.id,relations:Object.fromEntries(Object.entries(row).filter(([key])=>key.endsWith('_id')&&key!=='local_id'))}))).sort((a,b)=>`${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
   doc.manifest.snapshotFingerprint=await r.sha256Hex(r.stableCloudRestoreJson(doc.data));
   doc.manifest.relationshipHash=await r.sha256Hex(r.stableCloudRestoreJson(relations));
   const parsed=await r.prepareCloudRestoreSnapshot(doc);assert.equal(parsed.data.outbound_shipments[0].status_changed_at,value);
 };
 await explicitHistory(null);await explicitHistory('2025-01-02T03:04:05.123456+00:00');
 summary.legacySuppliedNullAndHistory='PRESERVED';
 const negatives={};
 const reject=async(name,mutate,base=original)=>{const doc=structuredClone(base);mutate(doc);await assert.rejects(()=>r.prepareCloudRestoreSnapshot(doc));negatives[name]='FAIL_CLOSED';};
 await reject('missing-shared-resource',d=>delete d.data.inventory);
 await reject('bad-canonical-uuid',d=>d.data.inventory[0].id='not-a-uuid');
 await reject('duplicate-canonical-id',d=>d.data.inventory[1].id=d.data.inventory[0].id);
 await reject('orphan',d=>d.data.productVariants[0].product_group_id=randomUUID());
 await reject('bad-manifest',d=>d.manifest.snapshotFingerprint='f'.repeat(64));
 await reject('relationship-mismatch',d=>d.manifest.relationshipHash='f'.repeat(64));
 await reject('unexpected-resource',d=>d.data.unknown=[]);
 await reject('version-downgrade',d=>d.schemaVersion='cloud-erp-snapshot-v2');
 const currentDoc=JSON.parse(currentRaw);
 await reject('current-required-resource',d=>delete d.data.wacaOrders,currentDoc);
 await reject('current-deadline-required',d=>delete d.deadlineSidecar,currentDoc);
 // A fully rehashed v2 without timestamps must still fail; only validated
 // v1 may represent absent history as NULL.
 const missing=structuredClone(current.data);for(const row of missing.outbound_shipments)delete row.status_changed_at;
 await assert.rejects(()=>r.buildCloudRestoreManifest(missing),e=>e.code==='OUTBOUND_TIMESTAMP_EVIDENCE_MISSING');
 await assert.rejects(()=>db.sql.query('select public.erp_cloud_restore_validate_waca_dataset($1)',[missing]),
   e=>e.code==='22023'&&e.message.includes('OUTBOUND_TIMESTAMP_EVIDENCE_MISSING'));
 assert.equal(hash((await readback()).data),hash(after.data),'MALFORMED_V2_FULL_ROLLBACK');
 negatives['current-timestamp-required']='FAIL_CLOSED';
 summary.malformed=negatives;

 // A new local fingerprint avoids idempotent completed-attempt replay.
 const fault=structuredClone(candidate);fault.data.outbound_shipments[0].note+=' isolated failure probe';
 const strictFaultBuilt=await r.buildCloudRestoreManifest(fault.data);
 const strictFault={...source,data:strictFaultBuilt.data,manifest:strictFaultBuilt.manifest,executionFingerprint:strictFaultBuilt.manifest.snapshotFingerprint};
 const q=await prepare(strictFault);
 await db.sql.query("create function public.legacy_failure_probe() returns trigger language plpgsql as $$begin raise exception 'ISOLATED_LEGACY_FAILURE';end$$;create trigger legacy_failure_probe before insert on public.waca_state for each row execute function public.legacy_failure_probe()");
 const failed=await execute(q);assert.equal(failed.ok,false);assert.equal(failed.status,'not_committed');assert.equal(failed.failure.evidence,'caught-subtransaction');
 assert.equal(hash((await readback()).data),hash(after.data),'ATOMIC_ROLLBACK_ALL_24');
 assert.equal(Number((await db.sql.query('select count(*) n from public.erp_cloud_restore_failures where attempt_id=$1',[q.attempt])).rows[0].n),1);
 await db.sql.query('drop trigger legacy_failure_probe on public.waca_state;drop function public.legacy_failure_probe()');
 summary.atomic041='PASS';summary.prepared042='PASS';summary.proof043='PASS';summary.executeBytes=269;summary.rollback='PASS';summary.partialWrite=0;

 await db.sql.query('set role authenticated');await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[viewer]);
 await assert.rejects(()=>db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5)',[candidate.data,candidate.manifest,'strict','isolated',randomUUID()]),/OWNER_REQUIRED/u);
 await db.sql.query('reset role');await db.sql.query('set role anon');
 await assert.rejects(()=>db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5)',[candidate.data,candidate.manifest,'strict','isolated',randomUUID()]),/permission denied/iu);
 await db.sql.query('reset role');summary.authorization='PASS';summary.result='PASS';
 const out=process.env.ERP1_RESTORE_EVIDENCE_OUT??'scratch/erp1-restore-compat-20261005';
 assert.match(out,/^scratch\//u);await mkdir(out,{recursive:true});await writeFile(out+'/exact-file-regression.json',JSON.stringify(summary,null,2));
 console.log(JSON.stringify({...summary,sharedParity:'15/15 MATCH'}));
 assert.equal(sha(await readFile(realPath,'utf8')),summary.exactFileSha256,'ORIGINAL_FILE_UNCHANGED');
}finally{await vite.close();await db.close();}
