import assert from 'node:assert/strict';
import {createServer} from 'vite';
const v=await createServer({configFile:false,server:{middlewareMode:true,hmr:false}});
try {
 const {receivingCancellationMessage:message}=await v.ssrLoadModule('/src/lib/receivingCancellationMessage.ts');
 const {SaveabilityError,cloudMutationFailureMessage}=await v.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
 const raw={message:'CORE_SOURCE_CAPACITY',details:JSON.stringify({allocated:3,cancelable:2})};
 const cloud=new SaveabilityError(cloudMutationFailureMessage(raw));
 const local=new SaveabilityError('此來源已配置 3 件，未配置 2 件；不可整列取消點收。部分取消需另案設計。');
 for(const error of [cloud,local]){
  assert.equal(message(error,false),'此商品已有 3 件配置至出庫單，因此無法取消整筆點收。請先解除相關出庫配置。');
  assert.equal(message(error,true),'本次操作包含已配置出庫的商品，因此無法全部取消點收。所有商品均維持原狀。');
 }
 assert.equal(cloud.message,'來源配置數量超過可用數量（已配置 3 件），操作未完成。');
 assert.ok(!cloud.message.includes('取消'));
 for(const error of [new Error(cloud.message),new SaveabilityError('來源配置數量超過可用數量（已配置 0 件），操作未完成。'),new SaveabilityError('其他驗證失敗'),{message:'CORE_PACKAGE_PROGRESS_MISMATCH'},new Error('network')])
  assert.equal(message(error,true),cloudMutationFailureMessage(error),'Unknown/CAS/transport errors must not promise atomic rejection');
 assert.ok(!message(new SaveabilityError('來源配置數量超過可用數量（已配置 9007199254740992 件），操作未完成。'),true).includes('均維持原狀'));
 console.log('PASS single/batch cancellation wording for Cloud/Local, capacity-only outbound, fail-closed unknown and unsafe counts');
}finally{await v.close();}
