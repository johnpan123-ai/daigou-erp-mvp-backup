import assert from 'node:assert/strict';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
 const r=await vite.ssrLoadModule('/src/providers/cloud/buyAnimeImportResume.ts');
 const error=await vite.ssrLoadModule('/src/utils/myacgImportErrors.ts');
 const generation={epoch:24,restoredAt:'2026-10-08T19:35:53.904Z'};
 const record={format:'BUYANIME_IMPORT_RESUME_V1',batchId:'catalog_import_fa47f26b-e8a5-44a0-8ed7-22af8aaf45a1',
  fileName:'fixture.xls',observedAt:'2026-10-09T00:00:00Z',restoreEpoch:24,version:3,stage:'INVENTORY_COMMITTED',
  expected:[{id:'10000000-0000-4000-8000-000000000001',key:'fixture',hash:'a'.repeat(64)}],
  stats:{total:1,newCount:1,updatedCount:0,unchangedCount:0,groupCount:1}};
 const rowFor=value=>({id:r.importJournalId(value.batchId),platform:r.BUYANIME_JOURNAL_PLATFORM,version:value.version,
  file_name:value.fileName,total_rows:value.expected.length,deleted_at:null,details:{buyAnimeImport:value}});
 const cases=[];
 const check=(name,value,patch,classification,action,blocked)=>{
  const actual=r.classifyBuyAnimeJournalIdentity({...rowFor(value),...patch},value,generation);
  assert.equal(actual.classification,classification,name);assert.equal(actual.recoveryAction,action,name);assert.equal(actual.blockNewImport,blocked,name);
  cases.push({fixture:name,blockNewImport:blocked?'YES':'NO',recoveryAction:action,businessWrite:0,error:classification==='CORRUPT_IDENTITY'?'BUYANIME_JOURNAL_IDENTITY_MISMATCH':null});
  return actual;
 };
 check('same generation incomplete',record,{},'INCOMPLETE_CURRENT_IMPORT','RESUME',true);
 check('same generation committed',{...record,stage:'CATALOG_COMMITTED',catalog:{key:r.importCatalogKey(record.batchId),plan:null}}, {},'INCOMPLETE_CURRENT_IMPORT','RECONCILE',true);
 check('same generation complete',{...record,stage:'COMPLETE'},{},'COMPLETED_OLD_IMPORT','RETIRE_AS_COMPLETE',false);
 check('old epoch incomplete + restored CAS version',{...record,restoreEpoch:23},{version:1},'STALE_AFTER_RESTORE','RETIRE_AS_STALE',false);
 const stale=check('old epoch complete + restored CAS version',{...record,restoreEpoch:23,stage:'COMPLETE'},{version:1},'STALE_AFTER_RESTORE','RETIRE_AS_STALE',false);
 assert.deepEqual(stale.mismatchField,['row.version']);
 check('new generation old stable key',{...record,restoreEpoch:23,catalog:{key:r.importCatalogKey(record.batchId),plan:null}},{},'STALE_AFTER_RESTORE','RETIRE_AS_STALE',false);
 check('wrong file envelope',record,{file_name:'different.xls'},'CORRUPT_IDENTITY','FAIL_CLOSED_CORRUPT',true);
 assert.throws(()=>r.classifyBuyAnimeJournalIdentity(rowFor(record),{...record,catalog:{key:'wrong-key',plan:null}},generation),/BUYANIME_JOURNAL_INVALID/);
 cases.push({fixture:'wrong stable key',blockNewImport:'YES',recoveryAction:'FAIL_CLOSED_CORRUPT',businessWrite:0,error:'BUYANIME_JOURNAL_INVALID'});
 check('current CAS version mismatch remains blocked',record,{version:1},'CORRUPT_IDENTITY','FAIL_CLOSED_CORRUPT',true);
 for(const fixture of ['journal no receipt','receipt committed journal pending','response lost'])
  check(fixture,{...record,stage:'INVENTORY_COMMIT_UNKNOWN'},{},'INCOMPLETE_CURRENT_IMPORT','RECONCILE',true);
 check('ERP1 legacy restored batch timestamp',{...record,restoreEpoch:undefined,observedAt:'2026-10-08T10:00:00Z'},{version:1},'STALE_AFTER_RESTORE','RETIRE_AS_STALE',false);
 // No separate file fingerprint/business generation is invented or required.
 // Existing exact row proofs and Catalog stable request keys stay authoritative.
 const inventory={id:record.expected[0].id,inventory_key:record.expected[0].key,myacg_item_code:'SAFE',product_title:'Safe',raw_variant_name:'A'};
 const pipeline=new r.BuyAnimeImportPipeline({readRestoreGeneration:async()=>generation,readInventory:async()=>[inventory],load:async()=>null});
 await assert.rejects(()=>pipeline.verify(record),/BUYANIME_READBACK_IDENTITY_OR_FIELDS_MISMATCH/);
 cases.push({fixture:'wrong exact content fingerprint',blockNewImport:'YES',recoveryAction:'FAIL_CLOSED_CORRUPT',businessWrite:0,error:'BUYANIME_READBACK_IDENTITY_OR_FIELDS_MISMATCH'});
 const emptyPipeline=new r.BuyAnimeImportPipeline({readRestoreGeneration:async()=>generation,readInventory:async()=>[],load:async()=>null});
 await assert.rejects(()=>emptyPipeline.verify(record),/BUYANIME_READBACK_COUNT_MISMATCH/);
 await assert.rejects(()=>pipeline.resume({...record,restoreEpoch:23}),/核對/u);
 const diagnostic=error.myAcgImportDiagnostic(error.classifyMyAcgImportError(
  new r.BuyAnimeResumeError('BUYANIME_JOURNAL_IDENTITY_MISMATCH',undefined,undefined,{...stale,classification:'CORRUPT_IDENTITY'}),'recovery'),'new-request');
 assert.deepEqual(diagnostic.mismatchField,['row.version']);assert.equal(diagnostic.currentRequestId,'new-request');
 assert.equal(diagnostic.journalRequestId,record.batchId);
 console.log(JSON.stringify({result:'PASS',cases,unchangedIdentitySafety:'PASS',businessWrite:0}));
} finally {await vite.close();}
