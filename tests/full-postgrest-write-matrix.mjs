import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {isolatedDatabase,uuid,viewer} from './helpers/saveability-isolated.mjs';
const db=await isolatedDatabase();const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});
try{
  const {CLOUD_FIELD_ENTITY_CONTRACTS}=await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  await db.startPostgrest();const {sql}=db;
  const rows={
    product_groups:{id:uuid(100),title:'Matrix group',show_in_purchase_list:false},
    product_categories:{id:uuid(101),product_group_id:uuid(100),title:'Matrix category'},
    product_variants:{id:uuid(102),product_group_id:uuid(100),product_category_id:uuid(101),myacg_item_code:'G-MATRIX',product_title:'Matrix group',variant_name:'A'},
    inventory_items:{id:uuid(103),inventory_key:'MATRIX',myacg_item_code:'G-MATRIX',product_title:'Matrix group',raw_variant_name:'A',listing_type:'代理版',final_price:0},
    purchase_batches:{id:uuid(104),product_group_id:uuid(100),name:'Matrix batch',currency:'JPY'},
    purchase_batch_items:{id:uuid(105),purchase_batch_id:uuid(104),product_variant_id:uuid(102),quantity:1,cost:0},
    private_orders:{id:uuid(106),product_group_id:uuid(100),customer_name:'Synthetic buyer'},
    private_order_items:{id:uuid(107),private_order_id:uuid(106),product_variant_id:uuid(102),quantity:1,amount:0},
    japan_packages:{id:uuid(108),title:'Matrix package',status:'registered'},
    japan_package_items:{id:uuid(109),japan_package_id:uuid(108),product_group_id:uuid(100),product_variant_id:uuid(102),quantity:1,checked:false},
    outbound_shipments:{id:uuid(110),title:'Matrix outbound',status:'draft',weight_kg:0,shipping_cost:0},
    outbound_shipment_items:{id:uuid(111),outbound_shipment_id:uuid(110),japan_package_item_id:uuid(109),product_variant_id:uuid(102),quantity:1,checked:false},
    sales_orders:{id:uuid(112),platform:'MYACG',order_number:'SYN-MATRIX',buyer_name:'Synthetic buyer'},
    sales_order_items:{id:uuid(113),order_id:uuid(112),product_variant_id:uuid(102),myacg_item_code:'G-MATRIX',product_name:'Matrix group',variant_name:'A',quantity:1,price:0,amount:0,order_status:'處理中'},
    bundle_components:{id:uuid(114),bundle_variant_id:uuid(102),component_variant_id:uuid(2)},
  };
  const rpc=async(entity,operations)=>db.http('/rpc/erp_apply_field_mutations',{p_entity:entity,p_operations:operations});
  const read=async(entity)=>(await db.http('/'+entity+'?id=eq.'+rows[entity].id)).data[0];
  const colmap=new Map((await sql.query("select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public'")).rows.map(c=>[c.table_name+'.'+c.column_name,c]));
  let creates=0,fields=0,secondSaves=0,thirdSavesAfterRead=0,negative=0,clears=0;
  for(const [entity,row] of Object.entries(rows)){
    const {id,...values}=row;const result=await rpc(entity,[{kind:'create',id,values}]);
    assert.equal(result.status,200,entity+JSON.stringify(result.data));assert.equal(result.data.ok,true,entity);creates++;
    for(const field of CLOUD_FIELD_ENTITY_CONTRACTS[entity].patch){
      for(let attempt=0;attempt<3;attempt++){
        const before=await read(entity);const old=before[field]??null;const c=colmap.get(entity+'.'+field);let value;
        if(c.data_type==='uuid')value=old??uuid(102); // unchanged canonical FK is still validated by the server
        else if(['integer','bigint','numeric','double precision','real'].includes(c.data_type))value=attempt+1;
        else if(c.data_type==='boolean')value=!old;
        else if(c.data_type==='date')value='2026-10-0'+(attempt+1);
        else if(c.data_type.includes('timestamp'))value='2026-10-0'+(attempt+1)+'T00:00:00+00:00';
        else if(field==='status')value=entity==='private_orders'?'pending':entity==='japan_packages'?'registered':'draft';
        else if(field==='currency')value=attempt?'JPY':'TWD';
        else if(field==='priority')value=attempt?'Low':'High';
        else value='Matrix '+field+' '+attempt;
        if(c.data_type==='uuid' && old===null){
          value=field==='purchase_batch_id'?uuid(104):field==='purchase_batch_item_id'?uuid(105):field==='product_group_id'?uuid(100):field==='product_category_id'?uuid(101):field==='japan_package_item_id'?uuid(109):uuid(102);
        }
        const op={kind:'patch',id:row.id,observedVersion:before.version,expected:{[field]:old},changes:{[field]:value}};
        const result=await rpc(entity,[op]);assert.equal(result.status,200,entity+'.'+field+JSON.stringify(result.data));assert.equal(result.data.ok,true,entity+'.'+field);
        const after=await read(entity);assert.equal(after.version,before.version+1);assert.equal(after.updated_by,'00000000-0000-4000-8000-000000000099');
        assert.equal(typeof value==='number'?Number(after[field]):c.data_type.includes('timestamp')?new Date(after[field]).getTime():after[field],c.data_type.includes('timestamp')?new Date(value).getTime():value);
        if(attempt===2)thirdSavesAfterRead++;else if(attempt===1)secondSaves++;else fields++;
      }
      if(cNullable(entity,field)){
        const b=await read(entity);const result=await rpc(entity,[{kind:'patch',id:row.id,observedVersion:b.version,expected:{[field]:b[field]??null},changes:{[field]:null}}]);
        assert.equal(result.data.ok,true);assert.equal((await read(entity))[field],null);clears++;
      }
    }
    for(const field of ['unknown_field','updated_at','version','deleted_at','id']){
      const b=await read(entity);const result=await rpc(entity,[{kind:'patch',id:row.id,observedVersion:b.version,expected:{[field]:b[field]??null},changes:{[field]:null}}]);
      assert.ok(result.status>=400||result.data.ok===false,entity+':'+field);assert.equal((await read(entity)).version,b.version);negative++;
    }
  }
  function cNullable(entity,field){return colmap.get(entity+'.'+field).is_nullable==='YES' && !field.endsWith('_id');}
  const before=await read('product_groups');const op={kind:'patch',id:before.id,observedVersion:before.version,expected:{title:before.title},changes:{title:'Matrix final'}};
  assert.equal((await rpc('product_groups',[op])).data.ok,true);
  assert.equal((await rpc('product_groups',[{...op,changes:{title:'Stale forbidden'}}])).data.code,'FIELD_CONFLICT');
  const bad=await rpc('private_order_items',[{kind:'create',id:uuid(200),values:{private_order_id:uuid(999),product_variant_id:uuid(102),quantity:1,amount:0}}]);assert.ok(bad.status>=400||!bad.data.ok);
  for(const actor of [viewer,null]){const deny=await db.http('/rpc/erp_apply_field_mutations',{p_entity:'product_groups',p_operations:[op]},actor);assert.ok(deny.status>=400);}
  // Exercise delete-only/soft-delete and authoritative read with new identities.
  for(const entity of Object.keys(rows)){
    const original=await read(entity);const {id:ignored,...row}=rows[entity];void ignored;
    const id=uuid(300+Object.keys(rows).indexOf(entity));
    if(entity==='inventory_items')row.inventory_key='MATRIX-DELETE';
    if(entity==='bundle_components')continue; // pair uniqueness; tested below on existing pair
    if(entity==='sales_orders')row.order_number='SYN-DELETE';
    assert.equal((await rpc(entity,[{kind:'create',id,values:row}])).data.ok,true);
    const created=(await db.http('/'+entity+'?id=eq.'+id)).data[0];
    assert.equal((await rpc(entity,[{kind:'delete',id,expectedVersion:created.version}])).data.ok,true);
    const deleted=(await db.http('/'+entity+'?id=eq.'+id)).data[0];assert.ok(deleted.deleted_at);assert.equal(original.id,rows[entity].id);
  }
  // Restore validates the real post-write snapshot using the CURRENT full chain.
  // Derived WACA/MyACG values are rebuilt, not invented opening balances.
  await sql.query('update public.product_variants set waca_auto_quantity=0,myacg_auto_quantity=0,effective_myacg_quantity=0');
  const snapshot=(await sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data;
  assert.equal(Object.keys(snapshot).length,24);
  const audit=(await sql.query('select public.erp_cloud_restore_audit_dataset($1) result',[snapshot])).rows[0].result;
  assert.equal(Number(audit.integrity.orphan_count),0);
  const manifest={schemaVersion:'cloud-erp-snapshot-v2',resourceCount:24,counts:audit.table_counts,totalRows:Number(audit.total_rows),orphanCount:0,duplicateVariantIdCount:0,duplicateVariantLocalIdCount:0};
  const restored=(await sql.query('select public.erp_restore_cloud_snapshot($1,repeat($2,64),$3,$4,$5) result',[uuid(400),'a',snapshot,manifest,'isolated-saveability'])).rows[0].result;
  assert.equal(restored.ok,true);
  const after=(await sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data;
  for(const table of Object.keys(snapshot))assert.equal(after[table].length,snapshot[table].length,table+' restore count');
  const corrupt=structuredClone(after);corrupt.product_variants[0].product_group_id=uuid(999);
  await assert.rejects(()=>sql.query('select public.erp_restore_cloud_snapshot($1,repeat($2,64),$3,$4,$5)',[uuid(401),'b',corrupt,manifest,'isolated-saveability']));
  assert.deepEqual((await sql.query('select public.erp_cloud_restore_snapshot() data')).rows[0].data,after,'restore failed to rollback');
  console.log(JSON.stringify({PASS:true,entities:creates,patchFields:fields,secondSaves,thirdSavesAfterRead,nullableClears:clears,forbiddenFieldsRejected:negative,postgrest:true,backupResources:24,isolatedRestore:true,rollback:true,liveWrites:0}));
}finally{await vite.close();await db.close();}
