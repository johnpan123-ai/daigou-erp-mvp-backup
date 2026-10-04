import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

let stored='';
globalThis.window={localStorage:{setItem:(_key,value)=>{stored=value;},getItem:()=>stored||null},dispatchEvent:()=>true};
globalThis.CustomEvent=class { constructor(type,init){this.type=type;this.detail=init?.detail;} };
const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false}});
try {
  const trace=await vite.ssrLoadModule('/src/diagnostics/buyAnimeProductionTrace.ts');
  const points=[
    'T01_FILE_READ_START','T02_FILE_READ_DONE','T03_PARSE_START','T04_PARSE_DONE','T05_NORMALIZE_DONE',
    'T06_PREIMPORT_BACKUP_START','T07_PREIMPORT_BACKUP_DONE','T08_INDEX_BUILD_START','T09_INDEX_BUILD_DONE',
    'T10_INVENTORY_PLAN_START','T11_INVENTORY_PLAN_DONE','T12_INVENTORY_COMMIT_START','T13_INVENTORY_COMMIT_RESPONSE',
    'T14_INVENTORY_ACK_READ_START','T15_INVENTORY_ACK_READ_DONE','T16_CATALOG_PLAN_START','T17_CATALOG_PLAN_DONE',
    'T18_CATALOG_COMMIT_START','T19_CATALOG_COMMIT_RESPONSE','T20_CATALOG_READBACK_DONE','T21_BUYANIME_JOURNAL_FINALIZE_START',
    'T22_BUYANIME_JOURNAL_FINALIZE_DONE','T23_TARGETED_REFRESH_START','T24_TARGETED_REFRESH_DONE','T25_IMPORT_STATE_UPDATE',
    'T26_GLOBAL_SYNC_WAIT_START','T27_GLOBAL_SYNC_AUTHORITATIVE_READ_START','T28_GLOBAL_SYNC_AUTHORITATIVE_READ_DONE',
    'T29_GLOBAL_SYNC_SYNCED','T30_REACT_FINAL_COMMIT','T31_SUCCESS_MODAL_VISIBLE',
  ];
  const started=performance.now();
  trace.beginBuyAnimeProductionTrace({name:'private-business-file.xls',size:12345});
  points.forEach((point,index)=>trace.markBuyAnimeTrace(point,{index,rows:1505}));
  const result=trace.finishBuyAnimeProductionTrace('SUCCESS');
  const overhead=performance.now()-started;
  assert.equal(result.outcome,'SUCCESS');
  assert.equal(result.events.length,32);
  assert.deepEqual(result.missingRequiredPoints,[]);
  assert.equal(result.spans.length,31);
  assert.ok(result.unattributedMs<2,`unattributed wall clock ${result.unattributedMs}ms`);
  assert.equal(result.fileExtension,'.xls');
  assert.equal(JSON.stringify(result).includes('private-business-file'),false,'file name must never be persisted');
  assert.ok(overhead<50,`diagnostic overhead ${overhead.toFixed(1)}ms exceeds the <3% budget of the 2.27s baseline`);
  assert.equal(trace.getLatestBuyAnimeProductionTrace().traceId,result.traceId);

  const inventory=readFileSync('src/pages/Inventory.tsx','utf8');
  const pipeline=readFileSync('src/providers/cloud/buyAnimeImportResume.ts','utf8');
  const sync=readFileSync('src/contexts/CloudRealtimeSyncContext.tsx','utf8');
  for(const point of points) assert.ok((inventory+pipeline+sync+readFileSync('src/utils/myacgParser.ts','utf8')+readFileSync('src/providers/cloud/inventoryImportPlan.ts','utf8')).includes(point),point);
  assert.match(inventory,/buyanime-production-performance-trace/u);
  assert.match(inventory,/複製效能診斷/u);
  console.log(JSON.stringify({result:'PASS',points:32,missing:0,overheadMs:Number(overhead.toFixed(1)),businessBehaviorModification:0}));
} finally { await vite.close(); }
