import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
const migration='064_restore_bounded_chunk_batch_and_identity_profile.sql';
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.filter(f=>f!==migration)});
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try{
 const restore=await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
 const upload=await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreStagedUpload.ts');
 const c=await restore.prepareCloudRestoreSnapshot(await readFile(process.env.ERP2_CHAOS_BASELINE_B,'utf8'));
 for(const id of new Set(Object.values(c.data).flatMap(rows=>rows.map(x=>x.updated_by).filter(Boolean))))await db.sql.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3) on conflict do nothing',[id,'fixture@example.invalid',{}]);
 await db.sql.query("select set_config('request.headers',$1,false)",[JSON.stringify({host:'rhfdjsklfrgpoqsaqpkn.supabase.co'})]);
 const proof=(await db.sql.query('select public.erp_prove_cloud_restore_candidate_v2($1,$2,$3,$4,$5) r',[c.data,c.manifest,'strict','isolated',randomUUID()])).rows[0].r;
 const profiles=async()=>Object.fromEntries(await Promise.all(restore.CLOUD_RESTORE_TABLES.map(async([,resource])=>[resource,(await db.sql.query('select public.erp_cloud_restore_prepared_profile($1,$2) r',[proof.proof_id,resource])).rows[0].r])));
 const before=await profiles();const business=(await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d;
 await db.sql.query(await readFile('supabase/sql/'+migration,'utf8'));
 assert.deepEqual(await profiles(),before);assert.deepEqual((await db.sql.query('select public.erp_cloud_restore_snapshot() d')).rows[0].d,business);
 const req=randomUUID();await db.sql.query('select public.erp_begin_restore_upload($1,$2,$3,$4)',[req,c.manifest,'strict','isolated']);
 const parts=[{p_resource:'inventory_items',p_ordinal:0,p_rows:c.data.inventory_items.slice(0,512)},
  {p_resource:'inventory_items',p_ordinal:1,p_rows:c.data.inventory_items.slice(512,1024)}];
 const bad=structuredClone(parts);bad[1].p_ordinal=9999;
 await assert.rejects(()=>db.sql.query('select public.erp_upload_restore_chunk_batch($1,$2)',[req,JSON.stringify(bad)]),/CLOUD_RESTORE_UPLOAD_CHUNK_COUNT_MISMATCH/u);
 assert.equal((await db.sql.query('select count(*)::int n from public.erp_restore_upload_chunks where request_id=$1',[req])).rows[0].n,0);
 const result=(await db.sql.query('select public.erp_upload_restore_chunk_batch($1,$2) r',[req,JSON.stringify(parts)])).rows[0].r;
 assert.equal(result.chunks.length,2);assert.equal((await db.sql.query('select count(*)::int n from public.erp_restore_upload_chunks where request_id=$1',[req])).rows[0].n,2);
 await db.sql.query('select public.erp_upload_restore_chunk_batch($1,$2)',[req,JSON.stringify(parts)]);
 assert.equal((await db.sql.query('select count(*)::int n from public.erp_restore_upload_chunks where request_id=$1',[req])).rows[0].n,2);
 await assert.rejects(()=>db.sql.query('select public.erp_upload_restore_chunk_batch($1,$2)',[req,JSON.stringify([...parts,...parts,parts[0]])]),/CLOUD_RESTORE_UPLOAD_BATCH_INVALID/u);
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[viewer]);
 await assert.rejects(()=>db.sql.query('select public.erp_upload_restore_chunk_batch($1,$2)',[req,JSON.stringify(parts)]),e=>e.code==='42501');
 await db.sql.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 assert.equal((await db.sql.query("select has_function_privilege('anon','public.erp_upload_restore_chunk_batch(uuid,jsonb)','execute') a")).rows[0].a,false);
 let uploadRequests=0,uploadedChunks=0,split=0;const rpc=async(name,args)=>{
  if(name==='erp_upload_restore_chunk_batch'){
   assert.ok(args.p_chunks.length<=4);assert.ok(Buffer.byteLength(JSON.stringify(args.p_chunks))<=1024*1024);
   if(split===0){split++;return {data:null,error:{message:'CLOUD_RESTORE_UPLOAD_BATCH_SIZE_LIMIT'}};}
   uploadRequests++;uploadedChunks+=args.p_chunks.length;
  }else if(name==='erp_upload_restore_chunk'){uploadRequests++;uploadedChunks++;}
  return {data:{ok:true},error:null};
 };
 await upload.uploadCloudRestoreCandidate(rpc,c,c.data,'strict',randomUUID());
 const expected=Object.values(c.data).reduce((n,rows)=>n+Math.ceil(rows.length/512),0);
 assert.equal(uploadedChunks,expected);assert.ok(uploadRequests<expected);assert.equal(split,1);
 for(const error of [{message:'CLOUD_RESTORE_UPLOAD_BATCH_INVALID'},{code:'42501'},new Error('response lost')]){
  let replay=0;await assert.rejects(()=>upload.uploadCloudRestoreCandidate(async(name)=>{if(name==='erp_upload_restore_chunk_batch'){replay++;throw error;}return {data:{},error:null};},c,c.data,'strict',randomUUID()));assert.ok(replay<=4);
 }
 console.log(JSON.stringify({profileParity:'EXACT',migrationBusinessMutation:0,batchAtomicRollback:'PASS',chunkIdempotency:'PASS',viewerDenied:'PASS',anonDenied:'PASS',zeroInsertSizeSplit:'PASS',unknownResponseNoRetry:'PASS',expectedChunks:expected,uploadRequests}));
}finally{await vite.close();await db.close();}
