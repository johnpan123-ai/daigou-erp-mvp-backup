import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const db=await isolatedDatabase();
try {
 const restore=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const portability=await vite.ssrLoadModule('/src/providers/cloud/cloudRestorePortability.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const candidate=await restore.prepareCloudRestoreSnapshot(await readFile(process.env.ERP2_CHAOS_BASELINE_B,'utf8'));
 for(const actorId of new Set(Object.values(candidate.data).flatMap(rows=>rows.map(row=>row.updated_by).filter(Boolean))))
  await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',[actorId,'fixture@example.invalid',{}]);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const fullAudit=(await db.sql.query('select public.erp_cloud_restore_audit_dataset($1) r',[candidate.data])).rows[0].r;
 const fullRelationship=(await db.sql.query('select public.erp_cloud_restore_relationship_hash($1) h',[candidate.data])).rows[0].h;
 const before=(await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d;
 const request=randomUUID();
 const rpc=async(name,args)=>{
  const keys={erp_begin_restore_upload:['p_request_id','p_manifest','p_restore_mode','p_source_environment'],
   erp_upload_restore_chunk:['p_request_id','p_resource','p_ordinal','p_rows'],
   erp_stage_restore_upload_resource:['p_request_id','p_resource'],erp_finalize_restore_upload:['p_request_id']};
  const values=keys[name].map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
  if(name==='erp_finalize_restore_upload') {
   const p=(await db.sql.query('select prepared_payload_hash,source_generation,expected_relationship_hash from public.erp_cloud_restore_candidate_proofs where proof_id=$1',[request])).rows[0];
   assert.deepEqual(p,{prepared_payload_hash:null,source_generation:null,expected_relationship_hash:null});
   await assert.rejects(()=>db.sql.query('select public.erp_restore_staged_cloud_snapshot($1,$2,$3,$4,$5)',
    [randomUUID(),request,candidate.manifest.snapshotFingerprint,candidate.manifest,'isolated']),/CLOUD_RESTORE_STAGED_PROOF_MISMATCH/u);
   const d=(await db.sql.query('select json_object_agg(resource,validation_rows)::jsonb d from public.erp_restore_upload_resource_proofs where request_id=$1',[request])).rows[0].d;
   assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_audit_dataset($1) r',[d])).rows[0].r,fullAudit);
   assert.equal((await db.sql.query('select public.erp_cloud_restore_relationship_hash($1) h',[d])).rows[0].h,fullRelationship);
   assert.ok(Buffer.byteLength(JSON.stringify(d))<Buffer.byteLength(JSON.stringify(candidate.data))/3);
  }
  return {data:(await db.sql.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) r`,values)).rows[0].r,error:null};
 };
 const proof=await upload.uploadCloudRestoreCandidate(rpc,candidate,candidate.data,'strict',request);
 assert.equal(proof.ok,true);assert.deepEqual(proof.integrity,fullAudit.integrity);
 assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d,before);
 assert.equal((await db.sql.query('select count(*)::int n from public.erp_restore_upload_resource_proofs where request_id=$1',[request])).rows[0].n,0);
 // Cross-environment preserves exact original-source vs effective distinction.
 const portable=await portability.prepareCrossEnvironmentCloudRestoreCandidate(candidate,'rhfdjsklfrgpoqsaqpkn');
 const effective=await portability.assertCloudRestoreEffectiveCandidate(portable);
 const portableRequest=randomUUID();
 const portableProof=await upload.uploadCloudRestoreCandidate(async(name,args)=>{
  const values=Object.values(args).map(v=>typeof v==='object'?JSON.stringify(v):v);
  return {data:(await db.sql.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) r`,values)).rows[0].r,error:null};
 },portable,effective.sourceData,effective.mode,portableRequest);
 assert.equal(portableProof.source_fingerprint,portable.portability.sourceSnapshotFingerprint);
 assert.equal(portableProof.effective_fingerprint,portable.manifest.snapshotFingerprint);
 const fullPortableProof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r',
  [effective.sourceData,portable.manifest,effective.mode,'isolated',randomUUID()])).rows[0].r;
 assert.equal(portableProof.prepared_payload_hash,fullPortableProof.prepared_payload_hash);
 assert.deepEqual(portableProof.integrity,fullPortableProof.integrity);
 const orphanCount=(await db.sql.query("select count(*)::int n from public.erp_restore_stage_inventory_items where restore_proof_id=$1 and updated_by is not null",[portableRequest])).rows[0].n;
 assert.equal(orphanCount,0);
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[viewer]);
 await assert.rejects(()=>db.sql.query('select public.erp_stage_restore_upload_resource($1,$2)',[request,'inventory_items']),e=>e.code==='42501');
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 // Expiry removes private drafts/stages, never immutable attempt/failure audit.
 await db.sql.query("update public.erp_cloud_restore_candidate_proofs set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where proof_id=$1",[request]);
 await db.sql.query("update public.erp_restore_upload_requests set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where request_id=$1",[request]);
 await db.sql.query('select public.erp_begin_restore_upload($1,$2,$3,$4)',[randomUUID(),candidate.manifest,'strict','isolated']);
 assert.equal((await db.sql.query('select count(*)::int n from public.erp_cloud_restore_candidate_proofs where proof_id=$1',[request])).rows[0].n,0);
 assert.equal((await db.sql.query('select count(*)::int n from public.erp_restore_stage_inventory_items where restore_proof_id=$1',[request])).rows[0].n,0);
 // Freeze projection dependencies: changed canonical validators require review,
 // not silent acceptance of a smaller evidence projection.
 const projectionSql=await readFile('supabase/sql/062_restore_resource_stage_and_projected_proof.sql','utf8');
 const consumed=['id','local_id','inventory_key','latest_catalog_import_id','product_id','normalized_title','title','updated_by',
  'status_changed_at','status','quantity','waca_auto_quantity','order_key','item_key','feature','child_code','batch_key','mode','revision',
  'product_group_id','product_category_id','bundle_variant_id','component_variant_id','purchase_batch_id','product_variant_id',
  'private_order_id','order_id','japan_package_id','purchase_batch_item_id','outbound_shipment_id','japan_package_item_id'];
 for(const field of consumed)assert.ok(projectionSql.includes("'"+field+"'"),field);
 const panel=await readFile('src/components/CloudAtomicRestorePanel.tsx','utf8');
 assert.match(panel,/status === 'error' && visibleError\) return formatCloudRestoreSubmitError\(visibleError\)/u);
 console.log(JSON.stringify({resourceStaging:'PASS',fullVsProjectedAudit:'EXACT',relationshipHash:'EXACT',
  incompleteProofExecute:'FAIL_CLOSED',businessMutationDuringPrepare:0,crossEnvironment:'PASS',
  viewerDenied:'PASS',expiryCleanup:'PASS',humanErrorVisible:'PASS',projectionBytes:proof.validationProjectionBytes}));
} finally {await vite.close();await db.close();}
