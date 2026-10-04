import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {assertReviewedProviderContract,classifyDescendantFile} from '../scripts/post-adoption-descendant.mjs';
import {classifyReviewedFile,sourceHash} from '../scripts/reviewed-change-impact.mjs';
const base='3347ef8a82cd809e43e1059a71485dedb6685006';
for(const file of ['src/providers/cloud/buyAnimeImportCoordinator.ts','src/providers/cloud/catalogTransaction.ts',
  'src/providers/cloud/cloudTargetedCache.ts','src/providers/cloud/supabaseProvider.ts','src/providers/dataProvider.ts']){
  const after=readFileSync(file,'utf8');let before=null;
  try{before=execFileSync('git',['show',base+':'+file],{encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{}
  assertReviewedProviderContract(file,before,after);
  const reviews=[{id:'unit-exact-simple-flow',files:[{file,beforeHash:sourceHash(before),afterHash:sourceHash(after),classification:'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL'}]}];
  for(const hunk of ['export const durableField="unsafe";','export const rpcSignature="unsafe";','export const backupRegistry="unsafe";'])
    assert.throws(()=>classifyReviewedFile({file,after:after+'\n'+hunk,reviews}),/FAILED_CLOSED/u);
  if(file.endsWith('buyAnimeImportCoordinator.ts'))assert.throws(()=>assertReviewedProviderContract(file,before,after+'\nfetch("/unsafe");'),/FAILED_CLOSED/u);
  if(file.endsWith('catalogTransaction.ts'))assert.throws(()=>assertReviewedProviderContract(file,before,after.replace("family:'catalog'","family:'unsafe'")),/FAILED_CLOSED/u);
  if(file.endsWith('cloudTargetedCache.ts'))assert.throws(()=>assertReviewedProviderContract(file,before,after.replace('markCloudReadFailed(error','markCloudReadFresh(error')),/FAILED_CLOSED/u);
  if(file.endsWith('supabaseProvider.ts')){
    assert.throws(()=>assertReviewedProviderContract(file,before,after.replace('p_request: catalog.plan.request','p_unsafe: catalog.plan.request')),/FAILED_CLOSED/u);
    assert.throws(()=>assertReviewedProviderContract(file,before,after+"\\nsupabase.rpc('unexpected-waca-write', {});"),/FAILED_CLOSED/u);
  }
}
for(const file of ['supabase/sql/050_catalog_atomic_transaction.sql','src/lib/durableResourceRegistry.ts','tools/schema-reconciliation/schemaContract.mjs','src/providers/cloud/unreviewed.ts'])
  assert.equal(classifyDescendantFile(file,null,'unknown'),'SCHEMA_SENSITIVE_OR_UNREVIEWED');
console.log('PASS exact flow diff review; RPC/dependencies/CAS/serializer/backup/future unknown changes remain fail-closed');
