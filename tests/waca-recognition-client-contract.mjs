import assert from 'node:assert/strict';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,cacheDir:'.vite-cache/recognition-client-contract',server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  const {commitAndVerifyWacaRecognition:commit}=await vite.ssrLoadModule('/src/waca/recognitionManagement.ts');
  const {classifyWacaError}=await vite.ssrLoadModule('/src/waca/importErrors.ts');
  const request={requestId:crypto.randomUUID(),revision:2,restoreEpoch:4,orderKey:'WACA::CLIENT',reason:'isolated',choices:[{itemKey:'i',mode:'HOLD'}]};
  const plan={contract:'waca-recognition-v1',requestId:request.requestId,requestHash:'proof',revision:2,restoreEpoch:4,
    orderKey:request.orderKey,reason:request.reason,lines:[{itemKey:'i',mode:'HOLD',countedAfter:0}],quantities:[{variantId:'v',after:10}]};
  const result={status:'COMMITTED',requestId:request.requestId,revision:3};
  const saved={revision:3,items:[{key:'i',countedQuantity:0,recognition:{requestId:request.requestId,mode:'HOLD'}}],
    batches:[{id:request.requestId,recognition:{actor:'isolated-owner',request,plan,result}}]};
  const provider={commitWacaRecognition:async()=>result,getNextWacaSnapshot:async()=>saved,
    getAuthoritativeWacaVariants:async()=>[{id:'v',waca_auto_quantity:2,waca_manual_adjustment:8}],readWacaRestoreEpoch:async()=>({epoch:4,restoredAt:null})};
  let stage;let writes=0;
  await assert.rejects(commit({...provider,commitWacaRecognition:async()=>{writes++;return result;},
    getNextWacaSnapshot:async()=>{throw {code:'42501',message:'permission denied'};}},request,plan,s=>{stage=s;}));
  assert.equal(stage,'readback');assert.equal(writes,1);assert.equal(classifyWacaError({code:'42501',message:'permission denied'},stage,request.requestId,'erp_commit_waca_recognition').category,'READBACK_FAILED');
  assert.equal((await commit({...provider,commitWacaRecognition:async()=>{throw new Error('READ_ONLY_RECONCILE_NO_RPC');}},request,plan)).result.status,'COMMITTED');
  await assert.rejects(commit({...provider,readWacaRestoreEpoch:async()=>({epoch:5})},request,plan),/WACA_RESTORE_EPOCH_CHANGED/);
  await assert.rejects(commit({...provider,getAuthoritativeWacaVariants:async()=>[{id:'v',waca_auto_quantity:2,waca_manual_adjustment:99}]},request,plan),/WACA_READBACK_PREVIEW_MISMATCH/);
  assert.equal(classifyWacaError({code:'23000',message:'WACA_REVERSAL_PROOF_REQUIRED'},'commit',request.requestId,'erp_commit_waca_recognition').diagnostic.rpc,'erp_commit_waca_recognition');
  console.log(JSON.stringify({result:'PASS',postCommitReadFailureNotMisclassifiedAsRollback:true,readOnlyReconcile:true,epoch:true,mismatchFailClosed:true,correctRpc:true,productionWrites:0}));
} finally {await vite.close();}
