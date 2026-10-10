import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {isolatedDatabase,owner,viewer} from './helpers/saveability-isolated.mjs';
const db=await isolatedDatabase();
const report={};
try {
 await db.sql.query("set timezone='UTC'");
 await db.startPostgrest();
 const epoch=Number((await db.sql.query('select epoch from public.erp_cloud_restore_epoch where singleton')).rows[0].epoch);
 const operations=Array.from({length:1624},(_,i)=>({kind:'create',id:randomUUID(),values:{inventory_key:'__ISOLATED_HTTP__'+i,product_title:'__ISOLATED_HTTP__',myacg_item_code:'HTTP-'+i,myacg_sold_quantity:1}}));
 const request={family:'inventory_import',batchId:'catalog_import_'+randomUUID(),restoreEpoch:epoch,operations};
 const key=randomUUID();const body={p_idempotency_key:key,p_request:request};
 const start=performance.now();
 const response=await db.http('/rpc/erp_apply_inventory_import',body);
 assert.equal(response.status,200);assert.equal(response.data.outcome,'COMMITTED');assert.equal(response.data.affected,1624);
 report.http={rows:1624,status:response.status,ms:performance.now()-start,server:response.data.serverPhases};
 const generation=async()=>String((await db.sql.query('select generation from public.erp_restore_business_generation where singleton')).rows[0].generation);
 const gen=await generation();
 // Discard commit response: receipt reconciliation, not replay, is sufficient.
 const readback=await db.http('/rpc/erp_reconcile_inventory_import',body);
 assert.equal(readback.status,200);assert.equal(readback.data.outcome,'COMMITTED');assert.equal(await generation(),gen);
 const replay=await db.http('/rpc/erp_apply_inventory_import',body);
 assert.equal(replay.data.replayed,true);assert.equal(await generation(),gen);
 assert.equal((await db.http('/rpc/erp_apply_inventory_import',body,null)).status,401);
 assert.equal((await db.http('/rpc/erp_apply_inventory_import',body,viewer)).status,403);
 const helper=await db.http('/rpc/erp_inventory_import_core',{p_key:key,p_request:request,p_commit:true});
 assert.ok([403,404].includes(helper.status));
 report.receiptAndAcl='PASS';
 // A concurrent maintenance holder must cause rejection before any business write.
 const other=new pg.Client({connectionString:db.url.toString()});await other.connect();
 try {
  await other.query('begin');await other.query("select pg_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0))");
  const blocked=await db.http('/rpc/erp_apply_inventory_import',{p_idempotency_key:randomUUID(),p_request:{...request,batchId:'catalog_import_'+randomUUID(),operations:[]}},owner);
  assert.equal(blocked.data.code,'55006');assert.equal(await generation(),gen);
  report.concurrentMaintenance='REJECTED_WITHOUT_MUTATION';
 }finally{await other.query('rollback');await other.end();}
 // Read-only EXPLAIN of the two actual writers, in rollback-only isolated transactions.
 const patches=operations.map(o=>({kind:'patch',id:o.id,observedVersion:1,expected:{myacg_sold_quantity:1},changes:{myacg_sold_quantity:2}}));
 for(const [label,sql,params]of [
  ['before','select public.erp_apply_field_mutations($1,$2)',['inventory_items',JSON.stringify(patches)]],
  ['after','select public.erp_apply_inventory_import($1,$2)',[randomUUID(),JSON.stringify({...request,operations:patches})]],
 ]){
  await db.sql.query('begin');
  try{report[label]=(await db.sql.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'];}
  finally{await db.sql.query('rollback');}
 }
 assert.equal(await generation(),gen);
 if(process.env.BUYANIME_HTTP_REPORT)writeFileSync(process.env.BUYANIME_HTTP_REPORT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
 console.log('PASS authenticated isolated PostgREST / exact receipt / response loss / ACL / maintenance fence / EXPLAIN');
}finally{await db.close();}
