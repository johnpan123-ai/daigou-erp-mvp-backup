import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {readFileSync} from 'node:fs';
const server=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:[]}});
try{
 const {commitAndVerifyWaca,wacaAtomicDelta}=await server.ssrLoadModule('/src/waca/confirmFlow.ts');
 const empty={revision:8,orders:[],items:[],mappings:[],batches:[],masterLinks:[],cutoverAudit:[]};
 const batch={id:'test-request',fileName:'synthetic',rows:0,inserted:0,updated:0,unchanged:0,result:{},conflictRows:[]};
 const candidate={...empty,batches:[batch]};
 const committed={...candidate,revision:9,batches:[{...batch,reconciliation:{status:'PASS'}}]};
 let writes=0,reads=0,stage='';
 const provider={getNextWacaSnapshot:async()=>{reads++;return structuredClone(committed);},getAuthoritativeWacaVariants:async()=>[],
  commitNextWacaSnapshot:async()=>{writes++;throw new Error('Failed to fetch');},exportData:async()=>{throw new Error('BACKUP_MUST_NEVER_BE_CALLED');}};
 const args={provider,current:empty,candidate,requestId:batch.id,cloud:true,onStage:s=>{stage=s;}};
 await commitAndVerifyWaca(args);assert.equal(writes,1);assert.equal(reads,1);assert.equal(stage,'readback');
 for(const corrupted of [{...empty},{...committed,revision:10},{...committed,batches:[{...batch,fileName:'not-this-request'}]}]){
  writes=0;stage='';await assert.rejects(()=>commitAndVerifyWaca({...args,provider:{...provider,getNextWacaSnapshot:async()=>corrupted}}));
  assert.equal(writes,1,'no mutation replay on unknown outcome');assert.equal(stage,'commit');
 }
 await assert.rejects(()=>commitAndVerifyWaca({...args,provider:{...provider,commitNextWacaSnapshot:async()=>9,
  getNextWacaSnapshot:async()=>({...committed,batches:[{...batch,reconciliation:{status:'FAIL'}}]})}}),/AUDIT_MISMATCH/);
 const linked={...empty,items:[{key:'i',productVariantId:''}]};
 assert.equal(wacaAtomicDelta(linked,{...linked,items:[{key:'i',productVariantId:null}]}).items.length,0);
 assert.throws(()=>wacaAtomicDelta(linked,{...empty}),/REMOVAL_UNSUPPORTED/);
 const source=readFileSync('src/pages/WacaIntegration.tsx','utf8');
 const confirm=source.slice(source.indexOf('  const confirmImport ='),source.indexOf('  const handleMasterFile'));
 assert.doesNotMatch(confirm,/exportData|backup|download/i);
 assert.match(confirm,/refreshAuthoritative\(\['products'\]\)/);
 assert.match(confirm,/syncRef\.current\.status !== 'fresh'/);
 assert.ok(confirm.indexOf('setCompletion({')>confirm.indexOf('WACA_GLOBAL_SYNC_NOT_CONVERGED'));
 console.log('PASS no-backup capability, exact receipt, unknown/no-replay, mismatched readback, stale receipt, NULL projection and synced success gate');
}finally{await server.close();}
