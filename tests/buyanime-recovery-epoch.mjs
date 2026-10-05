import assert from 'node:assert/strict';
import {createServer} from 'vite';
const v=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
 const r=await v.ssrLoadModule('/src/providers/cloud/buyAnimeRecoveryEpoch.ts');
 const e=await v.ssrLoadModule('/src/utils/myacgImportErrors.ts');
 const p=await v.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
 const epoch={epoch:13,restoredAt:'2026-10-05T13:16:10.930276Z'};
 const historical={observedAt:'2026-10-04T15:24:52.375Z'};
 assert.equal(r.classifyBuyAnimeRecoveryGeneration(historical,epoch),'STALE_AFTER_RESTORE');
 assert.equal(r.classifyBuyAnimeRecoveryGeneration({...historical,restoreEpoch:12},epoch),'STALE_AFTER_RESTORE');
 assert.equal(r.classifyBuyAnimeRecoveryGeneration({...historical,restoreEpoch:13},epoch),'CURRENT','Server epoch beats client clock');
 assert.equal(r.classifyBuyAnimeRecoveryGeneration({observedAt:epoch.restoredAt},epoch),'CURRENT','Equal is not proof of staleness');
 assert.equal(r.classifyBuyAnimeRecoveryGeneration(historical,{epoch:0,restoredAt:null}),'CURRENT','No Restore must not invalidate existing recovery');
 for(const evidence of [{observedAt:'bad'}, {...historical,restoreEpoch:14},{...historical,restoreEpoch:-1}])
  assert.throws(()=>r.classifyBuyAnimeRecoveryGeneration(evidence,epoch),/核對/u);
 assert.throws(()=>r.classifyBuyAnimeRecoveryGeneration(historical,{epoch:13,restoredAt:null}),/核對/u);
 assert.throws(()=>r.assertBuyAnimeGenerationUnchanged(epoch,{epoch:14,restoredAt:epoch.restoredAt}),/核對/u);
 const old=new p.BuyAnimeResumeError('BUYANIME_JOURNAL_INVALID');
 const diagnostic=e.myAcgImportDiagnostic(e.classifyMyAcgImportError(old,'recovery'),'catalog_import_test');
 assert.equal(diagnostic.category,'RECOVERY_STATE_ERROR');assert.equal(diagnostic.rpc,undefined);
 assert.equal(diagnostic.reason,'BUYANIME_JOURNAL_INVALID');
 assert.equal(e.classifyMyAcgImportError(new TypeError('Failed to fetch'),'commit').code,'COMMIT_RESULT_UNKNOWN');
 // Stale intent must fail before load/verify/resume can dispatch anything.
 let calls=0;
 const pipeline=new p.BuyAnimeImportPipeline({readRestoreGeneration:async()=>epoch,
  load:async()=>{calls++;},readInventory:async()=>{calls++;},save:async()=>{calls++;},commitCatalog:async()=>{calls++;}});
 const stale={...historical,restoreEpoch:12};
 await assert.rejects(()=>pipeline.resume(stale),/核對/u);
 await assert.rejects(()=>pipeline.verify(stale),/核對/u);assert.equal(calls,0);
 console.log('PASS restore generation: old/missing/equal/future epoch, preserved legacy audit, stale response-loss no replay, accurate recovery diagnostics');
}finally{await v.close();}
