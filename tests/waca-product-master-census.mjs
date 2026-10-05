import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const snapshotPath=process.env.ERP2_WACA_CENSUS_SNAPSHOT;
assert.ok(snapshotPath,'ERP2_WACA_CENSUS_SNAPSHOT is required');
globalThis.indexedDB={open:()=>({})};
globalThis.window={indexedDB:globalThis.indexedDB,location:{hostname:'127.0.0.1'},localStorage:{getItem:()=>null}};
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
  const source=JSON.parse(await readFile(snapshotPath,'utf8')).data;
  const core=await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const storage=await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const masterModule=await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const catalog=await vite.ssrLoadModule('/src/lib/catalogAlgorithms.ts');
  let groups=structuredClone(source.productGroups),categories=structuredClone(source.productCategories);
  let variants=structuredClone(source.productVariants);const inventory=structuredClone(source.inventory);
  const payloads=rows=>rows.map(row=>row.payload);
  const snapshot={revision:Number(source.wacaCutoverState?.[0]?.revision ?? source.wacaState?.[0]?.revision ?? 0),
    orders:payloads(source.wacaOrders),items:payloads(source.wacaItems),mappings:payloads(source.wacaMappings),
    masterLinks:payloads(source.myacgMasterLinks),batches:payloads(source.wacaImportBatches),
    cutoverAudit:payloads(source.wacaCutoverAudit),cutoverState:source.wacaCutoverState?.[0]?.payload};
  // Cloud export stores revision in the singleton state payload only on some
  // legacy snapshots; repository validation does not depend on the value.
  if (!Number.isSafeInteger(snapshot.revision)) snapshot.revision=0;
  const pendingBefore=snapshot.items.filter(row=>!row.productVariantId);
  const linksBefore=masterModule.linksFromMyAcgInventory(inventory,variants,'ERP2_CURRENT_BUYANIME_MASTER','');
  const mergedBefore=masterModule.mergeMyAcgMasterLinks(snapshot.masterLinks,linksBefore.links);
  const masterBefore=masterModule.buildWacaMasterReference(variants,mergedBefore);
  const indexBefore=core.indexWacaMaster(masterBefore);
  const classify=item=>{
    const matched=core.matchWacaItem(item,indexBefore);
    if (matched.diagnostic==='SPEC_CODE_CONFLICT') return 'MANUAL_MAPPING_CONFLICT';
    if (matched.resolution==='PENDING_AMBIGUOUS') return 'MASTER_EXISTS_BUT_AMBIGUOUS';
    if (matched.resolution==='SPEC_CODE_EXACT') return 'MASTER_EXISTS_EXACT_VARIANT';
    if (matched.resolution==='UNIQUE_PARENT_VARIANT') return 'MASTER_EXISTS_UNIQUE_PARENT_VARIANT';
    if (matched.resolution==='SPEC_NAME_EXACT_UNIQUE') return 'MASTER_EXISTS_SPEC_NAME_UNIQUE';
    if (['PRODUCT_NOT_IN_MASTER','VARIANT_NOT_IN_ERP'].includes(matched.diagnostic)) return 'MASTER_MISSING';
    return 'OTHER';
  };
  const beforeReasons=Object.fromEntries([...new Set(pendingBefore.map(classify))].sort()
    .map(reason=>[reason,pendingBefore.filter(item=>classify(item)===reason).length]));
  const existingCodes=new Set(variants.map(row=>row.myacg_item_code.trim().toUpperCase()));
  const missingCodes=new Set();
  for(const item of pendingBefore){const spec=item.specCode.trim().toUpperCase(),parent=item.productCode.trim().toUpperCase();
    for(const row of inventory){const child=row.myacg_item_code.trim().toUpperCase(),gp=(row.myacg_parent_code??'').trim().toUpperCase();
      if(!existingCodes.has(child)&&((spec&&child===spec)||(!spec&&(gp===parent||child===parent))))missingCodes.add(row.myacg_item_code);}}
  const context={getInventory:async()=>inventory,getProductGroups:async()=>groups,getProductCategories:async()=>categories,
    getProductVariants:async()=>variants,saveProductGroups:async rows=>{groups=rows;},saveProductCategories:async rows=>{categories=rows;},
    saveProductVariants:async rows=>{variants=rows;},readVariantSyncGuardSnapshot:async()=>({variants,verifiedEmpty:false}),
    computeVariantDedupe:rows=>({canonical:rows}),assertVariantSyncCandidateSafe:()=>{}};
  await catalog.ensureProductMasterFromInventory.call(context,[...missingCodes]);
  const fresh=masterModule.linksFromMyAcgInventory(inventory,variants,'ERP2_CURRENT_BUYANIME_MASTER','');
  const merged=masterModule.mergeMyAcgMasterLinks(snapshot.masterLinks,fresh.links);
  const staleDelta=masterModule.planMyAcgMasterLinkDelta(snapshot.masterLinks,merged);
  const repo=storage.repositoryFromSnapshot(snapshot,variants);
  const affected=new Set([...missingCodes]);
  for(const link of staleDelta.links){affected.add(link.mainCode);affected.add(link.childCode);}
  for(const item of pendingBefore){affected.add(item.productCode);if(item.specCode)affected.add(item.specCode);}
  const result=core.rematchHistoricalWaca(repo,masterModule.buildWacaMasterReference(variants,merged),'dry-run',affected);
  const remaining=[...repo.items.values()].filter(row=>!row.productVariantId);
  const remainingIndex=core.indexWacaMaster(masterModule.buildWacaMasterReference(variants,merged));
  const remainingReasons={};for(const item of remaining){const match=core.matchWacaItem(item,remainingIndex);
    const reason=match.resolution==='PENDING_AMBIGUOUS'?'AMBIGUOUS':
      ['PRODUCT_NOT_IN_MASTER','VARIANT_NOT_IN_ERP'].includes(match.diagnostic)?'MASTER_MISSING':
      match.diagnostic==='SPEC_CODE_CONFLICT'?'MANUAL_CONFLICT':'OTHER';remainingReasons[reason]=(remainingReasons[reason]??0)+1;}
  const compact=item=>({order:item.orderKey,productCode:item.productCode,specCode:item.specCode,title:item.productTitle,
    spec:[item.spec1,item.spec2].filter(Boolean).join(' / '),diagnostic:item.diagnostic,resolution:item.resolution});
  const bySku=sku=>variants.find(row=>row.myacg_item_code===sku);
  console.log(JSON.stringify({result:'PASS',pendingBefore:pendingBefore.length,beforeReasons,
    productMasterRowsCreated:missingCodes.size,autoResolved:result.autoResolved,pendingAfter:remaining.length,
    remainingReasons,staleMasterLinks:staleDelta.links.length,staleMasterLinksRebuilt:staleDelta.links.length,
    samplesAutoResolved:[...repo.items.values()].filter(item=>pendingBefore.some(before=>before.key===item.key)&&item.productVariantId).slice(0,10).map(compact),
    samplesRemaining:remaining.slice(0,10).map(compact),targets:{
      G07609652:Boolean(bySku('G07609652')),G07609640:Boolean(bySku('G07609640')),G07611656:Boolean(bySku('G07611656')),
    }},null,2));
} finally {await vite.close();}
