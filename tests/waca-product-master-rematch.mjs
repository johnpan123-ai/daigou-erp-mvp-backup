import assert from 'node:assert/strict';
import { createServer } from 'vite';

globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
  const core=await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const catalog=await vite.ssrLoadModule('/src/lib/catalogAlgorithms.ts');
  const transaction=await vite.ssrLoadModule('/src/providers/cloud/catalogTransaction.ts');
  const masterModule=await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const projection=await vite.ssrLoadModule('/src/lib/productGroupDisplayName.ts');
  const inventory=[
    {id:'10000000-0000-4000-8000-000000000001',version:1,inventory_key:'fixture::Fuwawa',myacg_item_code:'G07609652',myacg_parent_code:'GP-FUWAWA',product_title:'Hololive IF Relax time Fuwawa 休息時光',raw_variant_name:'Fuwawa',import_sort_index:1},
    {id:'10000000-0000-4000-8000-000000000002',version:1,inventory_key:'fixture::Mococo',myacg_item_code:'G07609640',myacg_parent_code:'GP-MOCOCO',product_title:'Hololive IF Relax time Mococo 休息時光',raw_variant_name:'Mococo',import_sort_index:2},
    {id:'10000000-0000-4000-8000-000000000003',version:1,inventory_key:'fixture::Fubuki',myacg_item_code:'G07611656',myacg_parent_code:'GP-FUBUKI',product_title:'白上フブキ 誕生日記念2026',raw_variant_name:'複製簽套組',import_sort_index:3},
  ];
  let groups=[],categories=[],variants=[];
  const context={
    getInventory:async()=>inventory,getProductGroups:async()=>groups,getProductCategories:async()=>categories,
    getProductVariants:async()=>variants,saveProductGroups:async rows=>{groups=rows;},
    saveProductCategories:async rows=>{categories=rows;},saveProductVariants:async rows=>{variants=rows;},
    readVariantSyncGuardSnapshot:async()=>({variants,verifiedEmpty:variants.length===0}),
    computeVariantDedupe:rows=>({canonical:rows}),assertVariantSyncCandidateSafe:()=>{},
  };
  const rows=inventory.map((item,index)=>({orderNumber:`ORDER-${index}`,orderStatus:'處理中',purchasedAt:'2026-10-05',
    productCode:item.myacg_parent_code,productTitle:item.product_title,spec1:item.raw_variant_name,spec2:'',
    specCode:item.myacg_item_code,quantity:index===2?2:1,subtotal:100}));
  const repo=core.createWacaRepository();
  core.importWacaRows(rows,repo,[],'before-master');
  assert.equal([...repo.items.values()].filter(item=>!item.productVariantId).length,3);

  const wirePlan=await transaction.planCatalogTransaction({inventory,groups:[],categories:[],variants:[]},
    'master',inventory.map(row=>row.myacg_item_code));
  assert.equal(wirePlan.request.mode,'sync','Product Master planning must preserve the adopted Catalog RPC wire contract');

  const stale=masterModule.linksFromMyAcgInventory(inventory,[],'fixture.xls','2026-10-05T00:00:00Z').links;
  await catalog.ensureProductMasterFromInventory.call(context,inventory.map(row=>row.myacg_item_code));
  assert.equal(groups.length,3);assert.equal(variants.length,3);
  assert.ok(groups.every(row=>row.show_in_purchase_list===false));
  assert.ok(variants.every(row=>row.source==='inventory_import'));
  assert.equal(projection.purchaseRecordGroupIds(variants).size,0,'Product Master is not Purchase Records projection');
  const fresh=masterModule.linksFromMyAcgInventory(inventory,variants,'fixture.xls','2026-10-05T00:00:00Z').links;
  const delta=masterModule.planMyAcgMasterLinkDelta(stale,fresh);
  assert.equal(delta.updated,3,'stale links gain canonical ProductGroup/Variant identities');
  const master=masterModule.buildWacaMasterReference(variants,masterModule.mergeMyAcgMasterLinks(stale,fresh));
  const result=core.rematchHistoricalWaca(repo,master,'master-revision-1',new Set([
    ...inventory.map(row=>row.myacg_parent_code),...inventory.map(row=>row.myacg_item_code),
  ]));
  assert.equal(result.autoResolved,3);assert.equal(result.remainingPending,0);
  const bySku=new Map(variants.map(row=>[row.myacg_item_code,row.id]));
  assert.equal(repo.autoQuantities.get(bySku.get('G07609652')),1);
  assert.equal(repo.autoQuantities.get(bySku.get('G07609640')),1);
  assert.equal(repo.autoQuantities.get(bySku.get('G07611656')),2);

  const beforeQuantity=JSON.stringify([...repo.autoQuantities].sort());
  await catalog.createPurchaseRecordFromInventory.call(context,['G07609652']);
  assert.equal(projection.purchaseRecordGroupIds(variants).size,1,'explicit action creates Purchase Records projection');
  assert.equal(groups.find(row=>row.id===variants.find(row=>row.myacg_item_code==='G07609652').product_group_id).show_in_purchase_list,true);
  core.rematchHistoricalWaca(repo,masterModule.buildWacaMasterReference(variants,fresh),'projection-later',new Set(['GP-FUWAWA']));
  assert.equal(JSON.stringify([...repo.autoQuantities].sort()),beforeQuantity,'projection later cannot double-count WACA');

  // A master expansion revalidates an AUTO single-variant decision.
  const single=core.createWacaRepository();
  const blank={...rows[0],specCode:'',spec1:''};
  core.importWacaRows([blank],single,[master.find(row=>row.childCode==='G07609652')],'single');
  assert.equal(single.autoQuantities.size,1);
  const sibling={...master.find(row=>row.childCode==='G07609652'),variantId:'sibling',childCode:'G-SIBLING',variantTitle:'Sibling'};
  const revalidated=core.rematchHistoricalWaca(single,[...master,sibling],'expanded',new Set(['GP-FUWAWA']));
  assert.equal(revalidated.becamePending,1);assert.equal(single.autoQuantities.size,0);

  console.log(JSON.stringify({result:'PASS',productMasterCanonical:true,purchaseRecordRequired:false,
    fuwawa:'PASS',mococo:'PASS',fubukiHistoricalRematch:'PASS',staleLinksRebuilt:delta.updated,
    quantityWithoutPurchaseRecord:'PASS',purchaseRecordLaterNoDoubleCount:'PASS',autoRevalidation:'PASS'}));
} finally { await vite.close(); }
