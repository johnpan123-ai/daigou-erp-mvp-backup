import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { isolatedDatabase,uuid,viewer } from './helpers/saveability-isolated.mjs';
const db=await isolatedDatabase();
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});
try{
  const {buildRelatedRequest}=await vite.ssrLoadModule('/src/providers/cloud/relatedTransaction.ts');
  const {sql}=db;
  await sql.query("insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name) values($1,$2,'G-B','Synthetic group','B'),($3,$2,'G-C','Synthetic group','C')",[uuid(3),uuid(1),uuid(4)]);
  const active=async(table)=>(await sql.query('select * from public.'+table+' where deleted_at is null order by id')).rows;
  const call=async(c)=>(await sql.query('select public.erp_apply_related_transaction($1,$2) result',[c.idempotencyKey,buildRelatedRequest(c)])).rows[0].result;
  const extras=(await active('product_variants')).filter(v=>v.id===uuid(3)||v.id===uuid(4));
  const deleteVariants={idempotencyKey:uuid(36),family:'variant-delete',rootId:uuid(3),collections:[{entity:'product_variants',base:extras,next:[]}]};
  const invalidDelete=buildRelatedRequest(deleteVariants);invalidDelete.operations.product_variants[1].expectedVersion++;
  assert.equal((await sql.query('select public.erp_apply_related_transaction($1,$2) result',[uuid(37),invalidDelete])).rows[0].result.ok,false);
  assert.equal((await active('product_variants')).length,3,'bulk variant rollback');
  await sql.query('update public.product_variants set private_manual_adjustment=1 where id=$1',[uuid(4)]);
  const guarded={...deleteVariants,idempotencyKey:uuid(38),collections:[{entity:'product_variants',base:(await active('product_variants')).filter(v=>v.id!==uuid(2)),next:[]}]};
  assert.equal((await call(guarded)).code,'DEPENDENT_RECORDS_EXIST');assert.equal((await active('product_variants')).length,3);
  await sql.query('update public.product_variants set private_manual_adjustment=0 where id=$1',[uuid(4)]);
  deleteVariants.collections[0].base=(await active('product_variants')).filter(v=>v.id!==uuid(2));
  assert.equal((await call(deleteVariants)).ok,true);assert.equal((await call(deleteVariants)).replayed,true);
  await sql.query("insert into public.purchase_batches(id,product_group_id,name) values($1,$2,'Synthetic')",[uuid(40),uuid(1)]);
  await sql.query("insert into public.purchase_batch_items(id,purchase_batch_id,product_variant_id,quantity,cost) values($1,$2,$3,1,0)",[uuid(41),uuid(40),uuid(2)]);
  const before={b:await active('purchase_batches'),i:await active('purchase_batch_items')};
  const command={idempotencyKey:uuid(42),family:'purchase-delete',rootId:uuid(40),collections:[
    {entity:'purchase_batches',base:before.b,next:[]},{entity:'purchase_batch_items',base:before.i,next:[]}]};
  const broken=buildRelatedRequest(command); broken.operations.purchase_batches[0].expectedVersion++;
  const bad=(await sql.query('select public.erp_apply_related_transaction($1,$2) result',[uuid(43),broken])).rows[0].result;
  assert.equal(bad.ok,false);
  assert.deepEqual({b:await active('purchase_batches'),i:await active('purchase_batch_items')},before,'child deletion was not rolled back');
  assert.equal((await call(command)).ok,true);assert.equal((await call(command)).replayed,true);
  assert.equal((await active('purchase_batch_items')).length,0);assert.equal((await active('purchase_batches')).length,0);
  await sql.query("insert into public.japan_packages(id,title,status) values($1,'Synthetic package','arrived')",[uuid(50)]);
  await sql.query("insert into public.japan_package_items(id,japan_package_id,product_title,variant_name,sku,quantity,checked,note) values($1,$2,'Old','A','S-1',3,false,'')",[uuid(51),uuid(50)]);
  await sql.query("insert into public.outbound_shipments(id,title,status) values($1,'Synthetic outbound','draft')",[uuid(52)]);
  await sql.query("insert into public.outbound_shipment_items(id,outbound_shipment_id,japan_package_item_id,product_title,variant_name,sku,quantity,note) values($1,$2,$3,'Old','A','S-1',1,'')",[uuid(53),uuid(52),uuid(51)]);
  const scoped={j:await active('japan_package_items'),o:await active('outbound_shipment_items')};
  const change={sku:'S-2',product_title:'New',variant_name:'B',note:''};
  const edit={idempotencyKey:uuid(54),family:'manual-package-edit',rootId:uuid(51),collections:[
    {entity:'japan_package_items',base:scoped.j,next:scoped.j.map(r=>({...r,...change,quantity:2}))},
    {entity:'outbound_shipment_items',base:scoped.o,next:scoped.o.map(r=>({...r,...change}))}]};
  const invalid=buildRelatedRequest(edit); invalid.operations.outbound_shipment_items[0].expected.sku='not-old';
  const failed=(await sql.query('select public.erp_apply_related_transaction($1,$2) result',[uuid(55),invalid])).rows[0].result;
  assert.equal(failed.ok,false);assert.deepEqual({j:await active('japan_package_items'),o:await active('outbound_shipment_items')},scoped,'mirror failure partially committed');
  assert.equal((await call(edit)).ok,true);assert.equal((await call(edit)).replayed,true);
  assert.equal((await active('japan_package_items'))[0].product_title,'New');
  assert.equal((await active('outbound_shipment_items'))[0].product_title,'New');
  assert.equal((await call({...edit,idempotencyKey:uuid(56)})).code,'FIELD_CONFLICT');
  const pkg=await active('japan_packages');const items=await active('japan_package_items');
  const deletePkg={idempotencyKey:uuid(57),family:'package-delete',rootId:uuid(50),collections:[
    {entity:'japan_packages',base:pkg,next:[]},{entity:'japan_package_items',base:items,next:[]}]};
  assert.equal((await call(deletePkg)).code,'DEPENDENT_RECORDS_EXIST');
  assert.equal((await active('japan_packages')).length,1);
  await sql.query("update public.outbound_shipment_items set deleted_at=clock_timestamp() where id=$1",[uuid(53)]);
  const deleteItem={idempotencyKey:uuid(58),family:'package-item-delete',rootId:uuid(51),collections:[{entity:'japan_package_items',base:items,next:[]}]};
  assert.equal((await call(deleteItem)).ok,true);assert.equal((await active('japan_package_items')).length,0);
  deletePkg.collections[1].base=[];deletePkg.collections[0].base=await active('japan_packages');
  assert.equal((await call(deletePkg)).ok,true);
  await db.startPostgrest();
  const replay={p_idempotency_key:command.idempotencyKey,p_request:buildRelatedRequest(command)};
  assert.equal((await db.http('/rpc/erp_apply_related_transaction',replay)).data.replayed,true);
  for(const actor of [viewer,null])assert.ok([401,403,404].includes((await db.http('/rpc/erp_apply_related_transaction',replay,actor)).status));
  console.log('PASS related batch/package/item deletes; child-then-parent rollback; manual/outbound mirror atomic update; stale CAS; dependent deletion blocked; replay/PostgREST/ACL');
  console.log('Live writes=0; disposable database only');
}finally{await vite.close();await db.close();}
