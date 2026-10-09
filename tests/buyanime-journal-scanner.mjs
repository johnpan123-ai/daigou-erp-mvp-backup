import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server=await createServer({configFile:'tests/fixtures/inventory-cloud-import-vite.config.mjs',configLoader:'runner',mode:'staging',
 server:{host:'127.0.0.1',port:4293,strictPort:true,hmr:false}});
await server.listen();const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
 const page=await browser.newPage();let externalRequests=0;
 await page.route('https://**/*',route=>{externalRequests++;return route.abort();});
 await page.goto('http://127.0.0.1:4293/tests/fixtures/inventory-cloud-import.html');
 const cases=await page.evaluate(async()=>{
  const [{SupabaseProvider},{supabase},r,j]=await Promise.all([import('/src/providers/cloud/supabaseProvider.ts'),import('/src/providers/cloud/supabaseClient.ts'),
   import('/src/providers/cloud/buyAnimeImportResume.ts'),import('/src/providers/cloud/buyAnimeImportJournal.ts')]);
  const generation={epoch:24,restored_at:'2026-10-08T19:35:53.904Z'};
  const value=(n,stage='INVENTORY_COMMITTED',epoch=24)=>({format:'BUYANIME_IMPORT_RESUME_V1',batchId:'catalog_import_10000000-0000-4000-8000-'+String(n).padStart(12,'0'),
   fileName:'safe.xls',observedAt:'2026-10-09T00:00:00Z',restoreEpoch:epoch,stage,version:3,
   expected:[{id:'10000000-0000-4000-8000-000000000001',key:'safe',hash:'a'.repeat(64)}],stats:{total:1,newCount:1,updatedCount:0,unchangedCount:0,groupCount:1}});
  const row=record=>({id:r.importJournalId(record.batchId),platform:r.BUYANIME_JOURNAL_PLATFORM,version:record.version,file_name:record.fileName,
   total_rows:record.expected.length,deleted_at:null,details:{buyAnimeImport:record}});
  let rows=[],latest=[];let writes=0,pages=0;
  supabase.from=table=>{
   const chain={select:()=>chain,eq:()=>chain,is:()=>chain,not:()=>chain,order:()=>chain,
    single:async()=>({data:generation,error:null}),limit:async()=>({data:table==='import_batches'?rows:latest,error:null}),
    range:async(from,to)=>{pages++;return{data:rows.slice(from,to+1),error:null}},
    insert:()=>{writes++;throw Error('UNEXPECTED_WRITE')},update:()=>{writes++;throw Error('UNEXPECTED_WRITE')}};
   if(!['erp_cloud_restore_epoch','inventory_items','import_batches'].includes(table))throw Error('UNEXPECTED_TABLE');return chain;
  };
  const provider=new SupabaseProvider(),out=[];
  const check=async(name,input,expected,inventory=[])=>{rows=input;latest=inventory;const recovered=await provider.getBuyAnimeImportRecovery();
   if((recovered?.batchId??null)!==expected)throw Error(name);out.push({fixture:name,blockNewImport:recovered?'YES':'NO',recoveryAction:recovered?'RESUME_OR_RECONCILE':'NO_ACTIVE_RECOVERY',businessWrite:writes,error:null});};
  await check('missing journal',[],null);
  await check('old epoch CAS-reset journal',[{...row(value(1,'COMPLETE',23)),version:1}],null);
  await check('old incomplete CAS-reset journal',[{...row(value(2,'INVENTORY_COMMIT_UNKNOWN',23)),version:1}],null);
  await check('current incomplete',[row(value(3))],value(3).batchId);
  await check('current complete latest Inventory marker',[row(value(4,'COMPLETE'))],null,[{latest_catalog_import_id:value(4).batchId,catalog_last_seen_at:value(4).observedAt}]);
  await check('newest complete cannot hide unfinished current',[row(value(5,'COMPLETE')),row(value(6))],value(6).batchId);
  await check('multiple historical journals paginate',Array.from({length:55},(_,n)=>({...row(value(n+10,'COMPLETE',23)),version:1})),null);
  if(pages<2)throw Error('PAGINATION_NOT_TESTED');
  for(const [name,input]of [
   ['current identity corruption',[{...row(value(90)),version:1}]],
   ['wrong file identity',[{...row(value(91)),file_name:'wrong.xls'}]],
   ['multiple active current',[row(value(92)),row(value(93))]],
  ]){
   rows=input;let error;try{await provider.getBuyAnimeImportRecovery()}catch(cause){error=cause.code}
   if(error!=='RECOVERY_STATE_ERROR')throw Error(name);
   out.push({fixture:name,blockNewImport:'YES',recoveryAction:'FAIL_CLOSED',businessWrite:writes,error});
  }
  // Strict direct request loaders were NOT relaxed by the audit-only scanner.
  rows=[{...row(value(1,'COMPLETE',23)),version:1}];
  let strict=false;try{await j.readLatestBuyAnimeJournal()}catch{strict=true}if(!strict)throw Error('STRICT_LOADER_RELAXED');
  if(writes)throw Error('RECOVERY_SCANNER_WROTE');return out;
 });
 assert.equal(externalRequests,0);console.log(JSON.stringify({result:'PASS',cases,externalRequests,businessWrite:0}));
}finally{await browser.close();await server.close();}
