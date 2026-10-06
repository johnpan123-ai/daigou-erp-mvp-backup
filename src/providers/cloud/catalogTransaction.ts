import type { InventoryItem,ProductGroup,ProductCategory,ProductVariant } from '../../lib/db';
import { calculateFinalMyacgDemand } from '../../lib/db';
import { createPurchaseRecordFromInventory,ensureProductMasterFromInventory,reparseProductVariants,syncProductGroupsWithInventory,
  type CatalogAlgorithmContext } from '../../lib/catalogAlgorithms';
import { buildCloudCollectionMutationPlan, SaveabilityError } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';

export type CatalogMode='create'|'master'|'sync'|'reparse';
export interface CatalogSnapshot {inventory:InventoryItem[];groups:ProductGroup[];categories:ProductCategory[];variants:ProductVariant[]}
export const CATALOG_RPC='erp_apply_catalog_transaction';

export type CatalogOperationErrorCategory =
  | 'CATALOG_VALIDATION_ERROR'
  | 'CATALOG_PROTECTED_METADATA_ERROR'
  | 'STALE_CONFLICT'
  | 'COMMIT_REJECTED'
  | 'COMMIT_UNKNOWN'
  | 'READBACK_FAILED'
  | 'AUTH_PERMISSION_ERROR'
  | 'NETWORK_ERROR';

type CatalogErrorDiagnostic = {
  code?: string;
  sqlstate?: string;
  serverMessage?: string;
  requestId: string;
  stage: 'commit'|'readback';
};

const catalogErrorText = (value: unknown): string|undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const catalogTechnicalDetail = (category:CatalogOperationErrorCategory, diagnostic:CatalogErrorDiagnostic):string =>
  [
    `category=${category}`,
    `code=${diagnostic.code ?? 'none'}`,
    `SQLSTATE=${diagnostic.sqlstate ?? 'none'}`,
    `message=${diagnostic.serverMessage ?? 'none'}`,
    `requestId=${diagnostic.requestId}`,
    `stage=${diagnostic.stage}`,
  ].join('; ');

export class CatalogOperationError extends SaveabilityError {
  readonly category: CatalogOperationErrorCategory;
  readonly diagnostic: Readonly<CatalogErrorDiagnostic>;
  constructor(category:CatalogOperationErrorCategory,userMessage:string,diagnostic:CatalogErrorDiagnostic) {
    super(`${userMessage}\n技術資訊：${catalogTechnicalDetail(category,diagnostic)}`);
    this.name='CatalogOperationError';
    this.category=category;
    this.diagnostic=Object.freeze({...diagnostic});
  }
}

export const classifyCatalogRpcError = (
  value:unknown,requestId:string,stage:'commit'|'readback'='commit',
):CatalogOperationError => {
  const row=value && typeof value === 'object' ? value as Record<string,unknown> : {};
  const code=catalogErrorText(row.code);
  const serverMessage=catalogErrorText(row.message) ?? catalogErrorText(value);
  const sqlstate=code && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
  const diagnostic={code,sqlstate,serverMessage,requestId,stage} as const;
  if(stage==='readback') return new CatalogOperationError('READBACK_FAILED',
    '商品操作已儲存，但雲端資料讀回尚未完成。請先同步確認，勿重複提交。',diagnostic);
  if(code==='42501' || code==='401' || code==='403' || serverMessage==='CATALOG_FORBIDDEN') return new CatalogOperationError('AUTH_PERMISSION_ERROR',
    '目前帳號沒有執行商品操作的權限，本次沒有寫入資料。',diagnostic);
  if(serverMessage==='CATALOG_MANUAL_METADATA_FORBIDDEN'
    || serverMessage==='CATALOG_PROVENANCE_TRANSITION_FORBIDDEN') return new CatalogOperationError(
      'CATALOG_PROTECTED_METADATA_ERROR','商品資料狀態不符合建立訂購紀錄的條件，本次沒有寫入資料。',diagnostic);
  if(code?.startsWith('22') || serverMessage?.startsWith('CATALOG_')) return new CatalogOperationError(
    'CATALOG_VALIDATION_ERROR','商品資料未通過建立訂購紀錄的驗證，本次沒有寫入資料。',diagnostic);
  if(code==='NETWORK_ERROR') return new CatalogOperationError('NETWORK_ERROR',
    '網路連線在送出商品操作前失敗，本次沒有寫入資料。',diagnostic);
  if(!code || /^5/u.test(code) || /fetch|network|timeout|abort/iu.test(serverMessage ?? ''))
    return new CatalogOperationError('COMMIT_UNKNOWN',
      '商品操作結果尚未確認。請先同步核對雲端資料，勿重複提交。',
      {...diagnostic,code:code ?? 'NETWORK_ERROR'});
  return new CatalogOperationError('COMMIT_REJECTED','商品操作已被雲端拒絕，本次沒有寫入資料。',diagnostic);
};

export const catalogCanonicalResultError = (
  code:string|undefined,requestId:string,
):CatalogOperationError => code==='FIELD_CONFLICT'
  ? new CatalogOperationError('STALE_CONFLICT','商品資料已更新，本次沒有寫入資料；請重新整理後再試。',
    {code,serverMessage:code,requestId,stage:'commit'})
  : new CatalogOperationError('COMMIT_REJECTED','商品操作已被雲端拒絕，本次沒有寫入資料。',
    {code:code ?? 'UNKNOWN_RESULT',serverMessage:code,requestId,stage:'commit'});

/** No IndexedDB, network, or persistence. Plan from a cloned authoritative snapshot. */
export async function planCatalogTransaction(base:CatalogSnapshot,mode:CatalogMode,itemCodes:string[]=[], options: { baselineVariantCount?: number } = {}) {
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
    readVariantSyncGuardSnapshot:async()=>({variants:next.variants,verifiedEmpty:(options.baselineVariantCount ?? base.variants.length)===0}),
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
      const baselineCount=options.baselineVariantCount ?? before.length;
      if(!verifiedEmpty && baselineCount>0 && newCount>=Math.max(50,Math.ceil(baselineCount*0.25)))
        throw new Error('同步新增規格數量異常，本次未儲存；請先確認匯入資料。');
    },
  };
  let summary={filledVariantsCount:0,affectedGroupsCount:0,upgradedSkusCount:0};
  if(mode==='create') await createPurchaseRecordFromInventory.call(ctx,itemCodes);
  else if(mode==='master') await ensureProductMasterFromInventory.call(ctx,itemCodes);
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
  // `master` is an application planning strategy, not a new persistence
  // protocol. The adopted atomic RPC executes these ordinary Catalog UPSERTs
  // through its existing `sync` wire contract.
  return {request:{family:'catalog',mode:mode==='master'?'sync':mode,dependencies,operations},summary};
}
