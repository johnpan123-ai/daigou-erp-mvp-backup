import { buildCloudCollectionMutationPlan, type CloudMutableEntity } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';
import { CloudMutationBoundaryError } from './cloudFieldCas';
import { stableFormIntent,readFormIntent,clearFormIntent } from './privateOrderTransaction';
export type RelatedFamily='purchase-delete'|'package-delete'|'package-item-delete'|'manual-package-edit'|'variant-delete';
export interface RelatedCollection {entity:CloudMutableEntity;base:unknown[];next:unknown[]}
export interface RelatedTransactionCommand {idempotencyKey:string;family:RelatedFamily;rootId:string;collections:RelatedCollection[]}
export const RELATED_RPC='erp_apply_related_transaction';
const submissions=new Map<string,Promise<void>>();
export async function submitRelatedIntent(draft:Omit<RelatedTransactionCommand,'idempotencyKey'>,submit:(command:RelatedTransactionCommand)=>Promise<void>):Promise<void> {
  const scope=`related:${draft.family}:${draft.rootId}`;
  const running=submissions.get(scope);if(running)return running;
  const command=readFormIntent<RelatedTransactionCommand>(scope)??stableFormIntent(scope,draft,key=>({...draft,idempotencyKey:key}));
  const promise=(async()=>{
    try{await submit(command);clearFormIntent(scope);}
    catch(error){if(!(error instanceof CloudMutationBoundaryError))clearFormIntent(scope);throw error;}
    finally{submissions.delete(scope);}
  })();
  submissions.set(scope,promise);return promise;
}
export const RELATED_STORAGE:Readonly<Record<string,string>>={
  purchase_batches:'erp_purchase_batches',purchase_batch_items:'erp_purchase_batch_items',
  japan_packages:'erp_japan_packages',japan_package_items:'erp_japan_package_items',outbound_shipment_items:'erp_outbound_shipment_items',
  product_variants:'erp_product_variants',private_order_items:'erp_private_order_items',sales_order_items:'erp_sales_order_items',
  bundle_components:'erp_bundle_components',waca_mappings:'erp_waca_mappings_v1',waca_order_items:'erp_waca_items_v1',waca_master_links:'erp_myacg_master_links_v1',
};
export const relatedWriteEntities=(command:RelatedTransactionCommand)=>new Set([
  ...command.collections.map(c=>c.entity),...(['manual-package-edit','package-item-delete'].includes(command.family)?['japan_packages']:[]),
]);
export function buildRelatedRequest(command:RelatedTransactionCommand) {
  return {family:command.family,rootId:command.rootId,
    expectedRecords:Object.fromEntries(command.collections.map(c=>[c.entity,c.base.map(r=>toCloudFieldRow(c.entity,r))
      .map(r=>({id:r.id,version:r.version})).sort((a,b)=>String(a.id).localeCompare(String(b.id)))])),
    operations:Object.fromEntries(command.collections.map(c=>[c.entity,buildCloudCollectionMutationPlan(c.entity,
      c.base.map(r=>toCloudFieldRow(c.entity,r)),c.next.map(r=>toCloudFieldRow(c.entity,r)))]))};
}

/** Runs against rows read INSIDE the local atomic transaction, not a stale pre-read. */
export function mergeRelatedCollections(current:Record<string,Record<string,unknown>[]>,command:RelatedTransactionCommand) {
  const next=structuredClone(current);
  const root=command.rootId;
  const linked=(table:string,field:string,ids:Set<unknown>)=>(current[table]??[]).some(r=>ids.has(r[field]));
  if(command.family==='variant-delete'){
    const ids=new Set(command.collections.flatMap(c=>c.base.map(r=>(r as {id:string}).id)));
    const references=[['purchase_batch_items','product_variant_id'],['private_order_items','product_variant_id'],['sales_order_items','product_variant_id'],
      ['japan_package_items','product_variant_id'],['outbound_shipment_items','product_variant_id'],['bundle_components','bundle_variant_id'],
      ['bundle_components','component_variant_id'],['waca_mappings','productVariantId'],['waca_order_items','productVariantId'],['waca_master_links','productVariantId']];
    if(references.some(([table,field])=>linked(table,field,ids)))throw new Error('規格仍有訂單、包裹或配對關聯；本次完全未刪除。');
    const quantities=['myacg_manual_adjustment','waca_manual_adjustment','private_manual_adjustment','purchased_manual_adjustment','myacg_auto_quantity','effective_myacg_quantity','waca_auto_quantity'];
    if((current.product_variants??[]).some(r=>ids.has(String(r.id))&&quantities.some(field=>Number(r[field]??0)!==0)))
      throw new Error('規格仍有需求數量或人工調整；本次完全未刪除。');
  }
  if(command.family==='purchase-delete'){
    const children=(current.purchase_batch_items??[]).filter(r=>r.purchase_batch_id===root);
    if(linked('japan_package_items','purchase_batch_id',new Set([root])) || linked('japan_package_items','purchase_batch_item_id',new Set(children.map(r=>r.id))))
      throw new Error('採購批次已有包裹關聯，請先處理關聯；本次未刪除。');
  }
  if(command.family==='package-delete'||command.family==='package-item-delete'){
    const ids=new Set((current.japan_package_items??[]).filter(r=>command.family==='package-delete'?r.japan_package_id===root:r.id===root).map(r=>r.id));
    if(linked('outbound_shipment_items','japan_package_item_id',ids)) throw new Error('商品已有出庫關聯，請先處理關聯；本次未刪除。');
  }
  for(const c of command.collections){
    const ids=new Set(c.base.map(r=>(r as {id:string}).id));
    const actual=(current[c.entity]??[]).filter(r=>ids.has(String(r.id)));
    const normalize=(rows:unknown[])=>JSON.stringify(rows.map(r=>toCloudFieldRow(c.entity,r)).sort((a,b)=>String(a.id).localeCompare(String(b.id))));
    if(normalize(actual)!==normalize(c.base)) throw new Error('資料已更新，請重新開啟確認；本次未儲存。');
    // Scope completeness: newly attached children/mirrors cannot be silently skipped.
    const field=c.entity==='purchase_batch_items'?'purchase_batch_id':c.entity==='japan_package_items'&&command.family==='package-delete'?'japan_package_id':c.entity==='outbound_shipment_items'?'japan_package_item_id':null;
    if(field && (current[c.entity]??[]).filter(r=>r[field]===root).length!==c.base.length) throw new Error('關聯資料已更新，請重新整理後再試。');
    next[c.entity]=[...(current[c.entity]??[]).filter(r=>!ids.has(String(r.id))), ...structuredClone(c.next as Record<string,unknown>[])];
  }
  if(command.family==='manual-package-edit'||command.family==='package-item-delete'){
    const original=(current.japan_package_items??[]).find(r=>r.id===root);
    const row=(next.japan_package_items??[]).find(r=>r.id===root);
    if(row){
      const allocation=(next.outbound_shipment_items??[]).filter(r=>r.japan_package_item_id===root).reduce((s,r)=>s+Number(r.quantity),0);
      if(!Number.isSafeInteger(row.quantity)||Number(row.quantity)<=0||Number(row.quantity)<allocation) throw new Error('包裹數量必須為正整數，且不可低於已分配出庫數量。');
    }
    const items=(next.japan_package_items??[]).filter(r=>r.japan_package_id===original?.japan_package_id);
    const complete=items.length>0&&items.every(r=>r.checked);
    next.japan_packages=(next.japan_packages??[]).map(p=>{
      if(p.id!==original?.japan_package_id||p.status==='problem')return p;
      const status=complete?'confirmed':p.status==='confirmed'?'arrived':p.status;
      return status===p.status?p:{...p,status,arrived_at:p.arrived_at??new Date().toISOString().slice(0,10)};
    });
  }
  return next;
}
