import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { isolatedDatabase,uuid,owner,viewer } from './helpers/saveability-isolated.mjs';
const db=await isolatedDatabase();
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});
try {
  const {buildPrivateOrderRequest}=await vite.ssrLoadModule('/src/providers/cloud/privateOrderTransaction.ts');
  const {sql}=db;
  const base={id:uuid(10),product_group_id:uuid(1),customer_name:'Synthetic',contact:'',note:'',created_at:'2026-10-01'};
  const line={id:uuid(11),private_order_id:uuid(10),product_variant_id:uuid(2),quantity:1,amount:0,note:''};
  const rpc=async(command)=>(await sql.query('select public.erp_apply_private_order_transaction($1,$2) result',
    [command.idempotencyKey,buildPrivateOrderRequest(command)])).rows[0].result;
  const active=async(table)=>(await sql.query('select * from public.'+table+' where deleted_at is null order by id')).rows;
  const command={idempotencyKey:uuid(12),order:base,items:[line],baseItems:[]};
  const bad={...command,idempotencyKey:uuid(13),items:[{...line,product_variant_id:uuid(999)}]};
  assert.equal((await rpc(bad)).ok,false); assert.equal((await active('private_orders')).length,0);
  assert.equal((await active('private_order_items')).length,0);
  const success=await rpc(command); assert.equal(success.ok,true,JSON.stringify(success));
  assert.equal(Number(success.items[0].amount),0); assert.equal(success.order.updated_by,owner);
  for(let n=0;n<5;n++)assert.equal((await rpc(command)).replayed,true);
  assert.equal((await active('private_orders')).length,1); assert.equal((await active('private_order_items')).length,1);
  const captured=async()=>({baseOrder:(await active('private_orders'))[0],baseItems:await active('private_order_items')});
  const initial=await captured();
  const failedReplacement={...command,...initial,idempotencyKey:uuid(14),order:{...initial.baseOrder,note:'do not commit'},
    items:[{...line,id:uuid(15),product_variant_id:uuid(999)}]};
  assert.equal((await rpc(failedReplacement)).ok,false); assert.deepEqual(await captured(),initial);
  const edit={...command,...initial,idempotencyKey:uuid(16),order:{...initial.baseOrder,note:'second save',contact:''},
    items:initial.baseItems.map(i=>({...i,quantity:2,amount:0,note:''}))};
  assert.equal((await rpc(edit)).ok,true);
  assert.equal((await rpc({...edit,idempotencyKey:uuid(17)})).code,'FIELD_CONFLICT');
  const fresh=await captured();
  assert.equal((await rpc({...command,...fresh,idempotencyKey:uuid(18),order:fresh.baseOrder,items:[]})).ok,true);
  assert.equal((await active('private_order_items')).length,0,'last-child/delete-only');
  const empty=await captured();
  assert.equal((await rpc({...command,...empty,idempotencyKey:uuid(19),order:empty.baseOrder,items:[],remove:true})).ok,true);
  assert.equal((await active('private_orders')).length,0);
  assert.throws(()=>buildPrivateOrderRequest({...command,items:[{...line,quantity:0}]}),/正整數/);
  assert.throws(()=>buildPrivateOrderRequest({...command,items:[{...line,quantity:1.5}]}),/正整數/);
  await sql.query(readFileSync('supabase/sql/049_private_order_atomic_transaction.sql','utf8')); // source replay
  await db.startPostgrest();
  const payload={p_idempotency_key:uuid(22),p_request:buildPrivateOrderRequest({...command,order:{...base,id:uuid(20)},items:[{...line,id:uuid(21),private_order_id:uuid(20)}]})};
  assert.equal((await db.http('/rpc/erp_apply_private_order_transaction',payload)).data.ok,true);
  assert.equal((await db.http('/rpc/erp_apply_private_order_transaction',payload)).data.replayed,true);
  const beforeReconcile=(await sql.query('select count(*)::int n from public.erp_idempotency_keys')).rows[0].n;
  assert.equal((await db.http('/rpc/erp_reconcile_private_order_transaction',payload)).data.committed,true);
  assert.equal((await db.http('/rpc/erp_reconcile_private_order_transaction',{...payload,p_idempotency_key:uuid(23)})).data.committed,false);
  assert.equal((await sql.query('select count(*)::int n from public.erp_idempotency_keys')).rows[0].n,beforeReconcile,'Read-only reconcile wrote replay state');
  for(const actor of [viewer,null]){
    const r=await db.http('/rpc/erp_apply_private_order_transaction',payload,actor);
    assert.ok([401,403,404].includes(r.status),String(r.status));
    assert.ok([401,403,404].includes((await db.http('/rpc/erp_reconcile_private_order_transaction',payload,actor)).status));
  }
  assert.ok((await db.http('/private_orders')).status===200);
  const acl=(await sql.query("select has_function_privilege('anon','public.erp_apply_private_order_transaction(uuid,jsonb)','EXECUTE') anon, has_function_privilege('authenticated','public.erp_apply_private_order_transaction(uuid,jsonb)','EXECUTE') authenticated")).rows[0];
  assert.deepEqual(acl,{anon:false,authenticated:true});
  console.log('PASS Private Order: native transaction/create/detail failure/replacement rollback/update/delete-only/last-child/CAS/5x replay/zero price');
  console.log('PASS PostgREST create/replay/owner read/viewer and anon denial; explicit ACL; fresh chain + source rerun; Live writes=0');
} finally{await vite.close();await db.close();}
