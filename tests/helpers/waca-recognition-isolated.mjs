import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { isolatedDatabase, owner, uuid } from './saveability-isolated.mjs';
import { CANONICAL_FRESH_INSTALL_V3 } from '../../supabase/canonicalFreshInstallV3.mjs';
export async function recognitionDatabase() {
  assert.ok(process.env.WACA_TEST_SAFEUPDATE_LIBRARY,'Real safeupdate is mandatory');
  assert.ok(process.env.WACA_TEST_POSTGREST_BINARY,'Use the verified local PostgREST');
  const vite=await createServer({configFile:false,cacheDir:'.vite-cache/waca-recognition-ssr',server:{middlewareMode:true,hmr:false},appType:'custom'});
  const migration='075_waca_order_recognition_management.sql';
  const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.slice(0,CANONICAL_FRESH_INSTALL_V3.indexOf(migration)),
    safeupdateLibrary:process.env.WACA_TEST_SAFEUPDATE_LIBRARY,postgrestBinary:process.env.WACA_TEST_POSTGREST_BINARY});
  const q=(s,a)=>db.sql.query(s,a);
  const snapshot=async()=>(await q('select public.erp_read_waca_snapshot() s')).rows[0].s;
  const variants=async()=>(await q('select * from public.product_variants order by id')).rows;
  const epoch=async()=>{const e=(await q('select epoch,restored_at from public.erp_cloud_restore_epoch where singleton')).rows[0];
    return {epoch:Number(e.epoch),restoredAt:e.restored_at?.toISOString()??null};};
  const state=async()=>(await q(`select public.erp_export_cloud_restore_snapshot_json() business,
    (select to_jsonb(e) from public.erp_cloud_restore_epoch e where singleton) epoch,
    (select generation from public.erp_restore_business_generation where singleton) generation`)).rows[0];
  try {
    const before=await state(); await q(readFileSync('supabase/sql/'+migration,'utf8')); assert.deepEqual(await state(),before,'075 migration has zero business mutation');
    for(const file of CANONICAL_FRESH_INSTALL_V3.slice(CANONICAL_FRESH_INSTALL_V3.indexOf(migration)+1)) {
      const baseline=await state(); await q(readFileSync('supabase/sql/'+file,'utf8').replace(/\r\n?/g,'\n'));
      assert.deepEqual(await state(),baseline,file+' has zero business mutation');
    }
    await q("update public.product_variants set waca_manual_adjustment=10 where id=$1",[uuid(2)]);
    await q("insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name,waca_manual_adjustment) values($1,$2,'G-SECOND','Synthetic group','B',20)",[uuid(3),uuid(1)]);
    await q("update public.erp_cloud_restore_epoch set epoch=34,restored_at=now() where singleton");
    const core=await vite.ssrLoadModule('/src/waca/orderCore.ts');
    const counted=await vite.ssrLoadModule('/src/waca/countedImport.ts');
    const storage=await vite.ssrLoadModule('/src/waca/nextStorage.ts');
    const flow=await vite.ssrLoadModule('/src/waca/confirmFlow.ts');
    const management=await vite.ssrLoadModule('/src/waca/recognitionManagement.ts');
    const row=(order,qty,status='完成付款',sku='G-SYNTHETIC')=>({orderNumber:order,orderStatus:status,purchasedAt:'2026/10/17 12:00',
      productCode:'GP-LOCAL',productTitle:'Synthetic group',specCode:sku,spec1:sku==='G-SECOND'?'B':'A',spec2:'',quantity:qty,subtotal:qty*100});
    const prepareImport=async(rows,opts={})=>{
      const current=await snapshot(),vs=await variants(),repo=storage.repositoryFromSnapshot(current,vs),candidate=core.cloneWacaRepository(repo),requestId=crypto.randomUUID();
      const result=core.importWacaRows(rows,candidate,vs.map(v=>({mainCode:'GP-LOCAL',childCode:v.myacg_item_code,variantId:v.id,
        productGroupId:uuid(1),productTitle:'Synthetic group',variantTitle:v.variant_name,active:true})),requestId);
      assert.deepEqual(result.errors,[]);
      const identities=new Set(rows.map(r=>`${core.wacaOrderKey(r.orderNumber)}::${core.wacaFeature(r)}`));
      const importedKeys=new Set([...candidate.items.values()].filter(i=>identities.has(`${i.orderKey}::${i.feature}`)).map(i=>i.key));
      const plan=counted.planWacaCountedImport({variants:vs,current:repo,candidate,importedKeys,
        context:counted.wacaTransitionContext(current.cutoverState,await epoch(),new Date().toISOString()),defaultMode:opts.mode??'ACCUMULATE',actor:owner,
        overlapChoices:opts.choice?new Map([...importedKeys].map(k=>[k,opts.choice])):undefined});
      counted.applyCountedItems(candidate,plan);
      const batch={id:requestId,fileName:'synthetic-order-management.xlsx',importedAt:new Date().toISOString(),rows:rows.length,
        inserted:result.inserted,updated:result.updated,unchanged:result.unchanged,result,conflictRows:[],
        transition:{contract:plan.plan.contract,restoreEpoch:plan.plan.restoreEpoch,variants:[...plan.variants.values()].filter(v=>v.touched).map(v=>({
          variantId:v.variantId,mode:v.mode,before:v.displayBefore,ledger:v.ledgerAfter,countedDelta:v.countedDelta,after:v.displayAfter,pending:v.pendingQuantity}))}};
      return {p_snapshot:flow.wacaAtomicDelta(current,storage.snapshotFromRepository(current,candidate,[...current.batches,batch])),
        p_expected_revision:current.revision,p_plan:plan.plan};
    };
    const http=(rpc,args,actor=owner)=>db.http('/rpc/'+rpc,args,actor,{signal:AbortSignal.timeout(15000)});
    await db.startPostgrest();
    const importRows=async(rows,opts)=>{const r=await http('erp_commit_waca_counted_snapshot',await prepareImport(rows,opts)); assert.equal(r.status,200,JSON.stringify(r));return r;};
    const request=async(order,choices,reason='Owner synthetic recognition review')=>({requestId:crypto.randomUUID(),orderKey:core.wacaOrderKey(order),
      reason,revision:(await snapshot()).revision,restoreEpoch:(await epoch()).epoch,
      choices:[]});
    const makeRequest=async(order,choices)=>{const r=await request(order,choices); const s=await snapshot(),vs=await variants();
      r.choices=choices.map(([sku,mode])=>({itemKey:s.items.find(i=>i.orderKey===r.orderKey&&i.productVariantId===vs.find(v=>v.myacg_item_code===sku).id).key,mode}));return r;};
    const preview=async request=>{const r=await http('erp_preview_waca_recognition',{p_request:request});assert.equal(r.status,200,JSON.stringify(r));return r.data;};
    const commit=async(request,plan)=>{const r=await http('erp_commit_waca_recognition',{p_request:request,p_expected_plan:plan});assert.equal(r.status,200,JSON.stringify(r));return r.data;};
    const manage=async(order,choices)=>{const request=await makeRequest(order,choices),plan=await preview(request);return {request,plan,result:await commit(request,plan)};};
    const display=async(sku='G-SYNTHETIC')=>{const v=(await variants()).find(v=>v.myacg_item_code===sku);return v.waca_auto_quantity+v.waca_manual_adjustment;};
    return {...db,vite,rawHttp:db.http,q,snapshot,variants,epoch,state,row,prepareImport,importRows,makeRequest,preview,commit,manage,http,display,management,
      async close(){await db.close();await vite.close();}};
  } catch(error) {await db.close();await vite.close();throw error;}
}
