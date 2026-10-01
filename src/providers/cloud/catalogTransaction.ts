import type { InventoryItem,ProductGroup,ProductCategory,ProductVariant } from '../../lib/db';
import { calculateFinalMyacgDemand } from '../../lib/db';
import { createPurchaseRecordFromInventory,reparseProductVariants,syncProductGroupsWithInventory,
  type CatalogAlgorithmContext } from '../../lib/catalogAlgorithms';
import { buildCloudCollectionMutationPlan } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';

export type CatalogMode='create'|'sync'|'reparse';
export interface CatalogSnapshot {inventory:InventoryItem[];groups:ProductGroup[];categories:ProductCategory[];variants:ProductVariant[]}
export const CATALOG_RPC='erp_apply_catalog_transaction';

/** No IndexedDB, network, or persistence. Plan from a cloned authoritative snapshot. */
export async function planCatalogTransaction(base:CatalogSnapshot,mode:CatalogMode,itemCodes:string[]=[]) {
  const next=structuredClone(base);
  const ctx:CatalogAlgorithmContext={
    getInventory:async()=>next.inventory,getProductGroups:async()=>next.groups,getProductCategories:async()=>next.categories,
    getProductVariants:async(options)=>{
      if(options?.recalc) for(const v of next.variants){
        const demand=calculateFinalMyacgDemand(v,next.inventory);
        if(demand>=0){v.myacg_auto_quantity=demand;v.effective_myacg_quantity=demand;}
      }
      return next.variants;
    },
    saveProductGroups:async rows=>{next.groups=rows;},saveProductCategories:async rows=>{next.categories=rows;},
    saveProductVariants:async rows=>{next.variants=rows;},
    readVariantSyncGuardSnapshot:async()=>({variants:next.variants,verifiedEmpty:base.variants.length===0}),
    // Preserve every durable identity; read-model duplicate collapsing is not a write plan.
    computeVariantDedupe:rows=>({canonical:rows}),
    assertVariantSyncCandidateSafe:(before,after,verifiedEmpty)=>{
      const ids=new Map(after.map(v=>[v.id,v]));
      for(const v of before){
        const n=ids.get(v.id);
        if(!n || ['waca_manual_adjustment','myacg_manual_adjustment','private_manual_adjustment','purchased_manual_adjustment']
          .some(k=>n[k as keyof ProductVariant]!==v[k as keyof ProductVariant])) throw new Error('同步不得移除規格或改變人工調整。');
      }
      const beforeIds=new Set(before.map(v=>v.id));
      const newCount=after.filter(v=>!beforeIds.has(v.id)).length;
      if(!verifiedEmpty && before.length>0 && newCount>=Math.max(50,Math.ceil(before.length*0.25)))
        throw new Error('同步新增規格數量異常，本次未儲存；請先確認匯入資料。');
    },
  };
  let summary={filledVariantsCount:0,affectedGroupsCount:0,upgradedSkusCount:0};
  if(mode==='create') await createPurchaseRecordFromInventory.call(ctx,itemCodes);
  else if(mode==='reparse') await reparseProductVariants.call(ctx);
  else summary=await syncProductGroupsWithInventory.call(ctx);
  await ctx.getProductVariants({recalc:true});
  const sources={inventory_items:base.inventory,product_groups:base.groups,product_categories:base.categories,product_variants:base.variants};
  const dependencies=Object.fromEntries(Object.entries(sources).map(([table,rows])=>[table,rows.map(row=>{
    const r=toCloudFieldRow(table as keyof typeof sources,row);
    if(!Number.isInteger(r.version) || Number(r.version)<1) throw new Error('商品資料尚未完整同步，請重新整理後再試。');
    return {id:r.id,version:r.version};
  }).sort((a,b)=>String(a.id).localeCompare(String(b.id)))]));
  const operations={
    product_groups:buildCloudCollectionMutationPlan('product_groups',base.groups.map(r=>toCloudFieldRow('product_groups',r)),next.groups.map(r=>toCloudFieldRow('product_groups',r))),
    product_categories:buildCloudCollectionMutationPlan('product_categories',base.categories.map(r=>toCloudFieldRow('product_categories',r)),next.categories.map(r=>toCloudFieldRow('product_categories',r))),
    product_variants:buildCloudCollectionMutationPlan('product_variants',base.variants.map(r=>toCloudFieldRow('product_variants',r)),next.variants.map(r=>toCloudFieldRow('product_variants',r))),
  };
  return {request:{family:'catalog',mode,dependencies,operations},summary};
}
