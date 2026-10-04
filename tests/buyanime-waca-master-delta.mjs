import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { isolatedDatabase, owner, viewer, uuid } from './helpers/saveability-isolated.mjs';

globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
const db=await isolatedDatabase();
const link=(child,overrides={})=>({mainCode:'GP-SYNTHETIC',childCode:child,productGroupId:uuid(1),
  productVariantId:child==='G-SYNTHETIC'?uuid(2):'',productTitle:'Synthetic group',variantTitle:'A',
  sourceFile:'fixture.xls',sourceFiles:['fixture.xls'],observedAt:'2026-10-04T00:00:00.000Z',...overrides});
const request=(revision,links)=>({family:'waca-master-links',expectedRevision:revision,links});
const sqlMerge=async(key,payload)=>(await db.sql.query(
  'select public.erp_merge_waca_master_links($1::uuid,$2::jsonb) result',[key,JSON.stringify(payload)])).rows[0].result;
try {
  const {planMyAcgMasterLinkDelta}=await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const existing=[link('G-SYNTHETIC')];
  const replay=planMyAcgMasterLinkDelta(existing,[link('G-SYNTHETIC',{observedAt:'2026-10-04T01:00:00.000Z'})]);
  assert.deepEqual({rows:replay.links.length,inserted:replay.inserted,updated:replay.updated,unchanged:replay.unchanged},
    {rows:0,inserted:0,updated:0,unchanged:1},'timestamp-only observation must not churn evidence');
  const newSource=planMyAcgMasterLinkDelta(existing,[link('G-SYNTHETIC',{sourceFile:'new.xls',sourceFiles:['new.xls']})]);
  assert.equal(newSource.links.length,1);assert.deepEqual(newSource.links[0].sourceFiles,['fixture.xls','new.xls']);
  assert.throws(()=>planMyAcgMasterLinkDelta(existing,[link('G-SYNTHETIC',{mainCode:'GP-CONFLICT'})]),/PARENT_CHILD_CONFLICT/u);
  const largeExisting=Array.from({length:10000},(_,i)=>link('G'+i));
  const smallDelta=planMyAcgMasterLinkDelta(largeExisting,[link('G9999'),link('G-NEW')]);
  assert.equal(smallDelta.links.length,1);assert.equal(smallDelta.inserted,1);assert.equal(smallDelta.unchanged,1);

  const firstKey=randomUUID();
  const first=await sqlMerge(firstKey,request(0,[link('G-SYNTHETIC')]));
  assert.equal(first.ok,true);assert.equal(first.inserted,1);assert.equal(first.changed,1);assert.equal(Number(first.revision),1);
  for(let attempt=0;attempt<5;attempt++){
    const same=await sqlMerge(firstKey,request(0,[link('G-SYNTHETIC')]));
    assert.equal(same.ok,true);assert.equal(same.replayed,true);assert.equal(Number(same.revision),1);
  }
  assert.equal(Number((await db.sql.query('select revision from public.waca_state')).rows[0].revision),1);
  assert.equal((await db.sql.query('select count(*)::int n from public.waca_master_links')).rows[0].n,1);
  assert.equal((await db.sql.query('select count(*)::int n from public.erp_idempotency_keys where idempotency_key=$1',[firstKey])).rows[0].n,1);

  const noChange=await sqlMerge(randomUUID(),request(1,[link('G-SYNTHETIC')]));
  assert.equal(noChange.changed,0);assert.equal(noChange.unchanged,1);assert.equal(Number(noChange.revision),1);
  const updated=link('G-SYNTHETIC',{sourceFile:'new.xls',sourceFiles:['fixture.xls','new.xls']});
  const updateResult=await sqlMerge(randomUUID(),request(1,[updated]));
  assert.equal(updateResult.updated,1);assert.equal(Number(updateResult.revision),2);

  const conflictKey=randomUUID();
  const conflict=await sqlMerge(conflictKey,request(2,[link('G-SYNTHETIC',{mainCode:'GP-CONFLICT'})]));
  assert.equal(conflict.ok,false);assert.equal(conflict.code,'WACA_MASTER_LINK_CONFLICT');
  assert.equal((await db.sql.query('select count(*)::int n from public.erp_idempotency_keys where idempotency_key=$1',[conflictKey])).rows[0].n,0);
  const rollbackKey=randomUUID();
  const rollback=await sqlMerge(rollbackKey,request(2,[link('A-ROLLBACK'),link('G-SYNTHETIC',{mainCode:'GP-CONFLICT'})]));
  assert.equal(rollback.ok,false);assert.equal((await db.sql.query("select count(*)::int n from public.waca_master_links where child_code='A-ROLLBACK'")).rows[0].n,0);
  const stale=await sqlMerge(randomUUID(),request(1,[link('STALE')]));
  assert.equal(stale.ok,false);assert.equal(stale.code,'WACA_STALE_REVISION');
  await assert.rejects(()=>sqlMerge(randomUUID(),request(2,[link('INVALID-PARENT',{mainCode:''})])),
    /WACA_MASTER_LINK_DELTA_ROW_INVALID/u);
  const invalidIdentity=await sqlMerge(randomUUID(),request(2,[link('INVALID-IDENTITY',{productVariantId:randomUUID()})]));
  assert.equal(invalidIdentity.ok,false);assert.equal(invalidIdentity.code,'TRANSACTION_REJECTED');
  assert.equal((await db.sql.query("select count(*)::int n from public.waca_master_links where child_code in ('INVALID-PARENT','INVALID-IDENTITY')")).rows[0].n,0);

  const timings=[];let revision=2;
  for(const size of [1,100,1000]){
    const links=Array.from({length:size},(_,i)=>link(`S${size}-${i}`));
    const started=performance.now();const result=await sqlMerge(randomUUID(),request(revision,links));
    timings.push({size,ms:Number((performance.now()-started).toFixed(1))});
    assert.equal(result.changed,size);revision=Number(result.revision);
  }
  assert.ok(timings.at(-1).ms<1500,JSON.stringify(timings));

  await db.startPostgrest();
  const httpRequest=request(revision,[link('HTTP-1')]);const httpKey=randomUUID();
  const allowed=await db.http('/rpc/erp_merge_waca_master_links',{p_idempotency_key:httpKey,p_request:httpRequest},owner);
  assert.equal(allowed.status,200,JSON.stringify(allowed.data));assert.equal(allowed.data.ok,true);
  const replayHttp=await db.http('/rpc/erp_merge_waca_master_links',{p_idempotency_key:httpKey,p_request:httpRequest},owner);
  assert.equal(replayHttp.status,200);assert.equal(replayHttp.data.replayed,true);
  assert.equal((await db.http('/rpc/erp_merge_waca_master_links',{p_idempotency_key:randomUUID(),p_request:request(revision+1,[link('DENIED')])},viewer)).status,403);
  assert.equal((await db.http('/rpc/erp_merge_waca_master_links',{p_idempotency_key:randomUUID(),p_request:request(revision+1,[link('ANON')])},null)).status,401);
  const direct=await db.http('/waca_master_links',{child_code:'BYPASS',main_code:'GP',payload:{}},owner,{method:'POST'});
  assert.ok(direct.status>=400);
  const acl=(await db.sql.query(`select has_function_privilege('authenticated','public.erp_merge_waca_master_links(uuid,jsonb)','EXECUTE') authenticated,
    has_function_privilege('anon','public.erp_merge_waca_master_links(uuid,jsonb)','EXECUTE') anon,
    has_function_privilege('public','public.erp_merge_waca_master_links(uuid,jsonb)','EXECUTE') public`)).rows[0];
  assert.deepEqual(acl,{authenticated:true,anon:false,public:false});
  console.log(JSON.stringify({result:'PASS',nativePostgresql:'PASS',postgrest:'PASS',idempotency5x:'PASS',cas:'PASS',rollback:'PASS',acl:'PASS',timings}));
} finally { await vite.close(); await db.close(); }
