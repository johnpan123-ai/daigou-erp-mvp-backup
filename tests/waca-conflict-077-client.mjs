import assert from 'node:assert/strict';
import {recognitionDatabase} from './helpers/waca-recognition-isolated.mjs';
const db=await recognitionDatabase();
try{
 const flow=await db.vite.ssrLoadModule('/src/waca/confirmFlow.ts');
 const errors=await db.vite.ssrLoadModule('/src/waca/importErrors.ts');
 await db.importRows([db.row('FIRST',2)]);
 const current=await db.snapshot(),stale=await db.prepareImport([db.row('FIRST',3)]);
 const request=await db.makeRequest('FIRST',[['G-SYNTHETIC','HOLD']]),plan=await db.preview(request);
 await db.importRows([db.row('SECOND',1)]);
 let writes=0,reads=0;
 const send=async(rpc,args)=>{writes++;const r=await db.http(rpc,args);assert.equal(r.status,409);throw r.data;};
 const unexpectedRead=async()=>{reads++;throw new Error('Definite 409 must not be reconciled as success');};
 const provider={getNextWacaSnapshot:unexpectedRead,getAuthoritativeWacaVariants:unexpectedRead,readWacaRestoreEpoch:unexpectedRead,
  commitWacaCountedSnapshot:(s,r,p)=>send('erp_commit_waca_counted_snapshot',{p_snapshot:s,p_expected_revision:r,p_plan:p}),
  commitWacaRecognition:(r,p)=>send('erp_commit_waca_recognition',{p_request:r,p_expected_plan:p})};
 const before=await db.state();
 await assert.rejects(flow.commitAndVerifyWacaCounted({provider,current,candidate:current,plan:stale.p_plan,requestId:null}),e=>e.code==='PT409'&&e.message==='WACA_STALE_REVISION');
 await assert.rejects(db.management.commitAndVerifyWacaRecognition(provider,request,plan),e=>e.code==='PT409'&&e.message==='WACA_STALE_REVISION');
 assert.equal(writes,2);assert.equal(reads,0);assert.deepEqual(await db.state(),before);
 for(const reason of ['WACA_STALE_REVISION','WACA_RESTORE_EPOCH_CHANGED','WACA_COUNTED_PREVIEW_MISMATCH','WACA_RECOGNITION_PREVIEW_CHANGED','WACA_RECOGNITION_VARIANT_CHANGED']){
  const cause={code:'PT409',message:reason};assert.equal(errors.isWacaBusinessConflict(cause),true);
  for(const stage of ['commit','validation'])assert.equal(errors.classifyWacaError(cause,stage,'test','erp_commit_waca_counted_snapshot').category,'STALE_CONFLICT');
 }
 assert.equal(errors.isWacaBusinessConflict({code:'PT409',message:'UNREVIEWED_REASON'}),false);
 assert.equal(errors.isWacaBusinessConflict({code:'40001',message:'could not serialize access due to concurrent update'}),false);
 assert.equal(errors.classifyWacaError({code:'PT409',message:'UNREVIEWED_REASON'},'commit').category,'WACA_COMMIT_REJECTED');
 assert.equal(errors.classifyWacaError(new Error('network response lost'),'commit').category,'WACA_COMMIT_UNKNOWN');
 console.log(JSON.stringify({result:'PASS',engine:'Windows + native authenticated PostgREST14.5',conflictPosts:writes,replays:0,receiptSuccessAfter409:0,requiresFreshPlan:true,partialWrite:0}));
}finally{await db.close();}
