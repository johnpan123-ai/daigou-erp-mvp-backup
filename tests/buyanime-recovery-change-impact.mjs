import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {assertReviewedProviderContract} from '../scripts/post-adoption-descendant.mjs';
import {classifyReviewedFile,sourceHash} from '../scripts/reviewed-change-impact.mjs';
const base='4490100b63dc5811c050d1608846a73977df81a0';
for(const file of ['src/providers/cloud/supabaseProvider.ts','src/providers/cloud/buyAnimeImportJournal.ts']){
 const before=execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}),after=readFileSync(file,'utf8');
 assertReviewedProviderContract(file,before,after);
 const bad=file.endsWith('Journal.ts')
  ?after.replace("supabase.from('import_batches')","supabase.from('unknown_resource')")
  :after.replace("supabase.rpc('erp_apply_field_mutations'","supabase.rpc('unsafe_rpc'");
 assert.notEqual(after,bad);assert.throws(()=>assertReviewedProviderContract(file,before,bad),/FAILED_CLOSED/u);
}
const file='src/providers/cloud/buyAnimeRecoveryEpoch.ts',source=readFileSync(file,'utf8');
assertReviewedProviderContract(file,null,source);
for(const bad of [source.replace("'erp_cloud_restore_epoch'","'other_resource'"),
 source.replace(".select('epoch,restored_at')",".select('*')"),
 source.replace(".select('epoch,restored_at')",".update({epoch:1})"),
 source+"\nsupabase.rpc('unsafe');",source+"\nlocalStorage.clear();"])
 assert.throws(()=>assertReviewedProviderContract(file,null,bad),/FAILED_CLOSED/u);
assert.throws(()=>assertReviewedProviderContract('src/providers/cloud/unknownEpoch.ts',null,source),/FAILED_CLOSED/u);
const exactReview={id:'unit-immutable-epoch-review',files:[{file,afterHash:sourceHash(source)}]};
for(const change of ["export const newDurableField = 'required';", "export const newRpcPayload = { signature: 'changed' };", "export const changedBackupRegistry = ['unsafe'];"])
 assert.throws(()=>classifyReviewedFile({file,after:source+'\n'+change,reviews:[exactReview]}),/FAILED_CLOSED/u);
console.log('PASS exact journal optional epoch only; existing provider RPC unchanged; epoch resource/columns readonly; unknown/new writes FAIL CLOSED');
