import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {assertReviewedProviderContract} from '../scripts/post-adoption-descendant.mjs';
let checks=0;
for(const file of ['src/providers/cloud/supabaseProvider.ts','src/providers/dataProvider.ts']){
  const before=execFileSync('git',['show','ba04839b5f25bb962c4590c7ae205939935f6b63:'+file],{encoding:'utf8'}),after=readFileSync(file,'utf8');
  // Compare against the pre-existing guard baseline; recognition additions must
  // normalize away without exempting any earlier contract.
  const baseline=execFileSync('git',['show','5f73b2b02d9008dc863cf92978e6ea8e40a850ec:'+file],{encoding:'utf8'});
  assertReviewedProviderContract(file,baseline,after);checks++;
  for(const [a,b] of [['async previewWacaRecognition','async previewUnreviewedRecognition'],['async commitWacaRecognition','async commitUnreviewedRecognition'],
    ...(file.endsWith('supabaseProvider.ts')?[["supabase.rpc('erp_commit_waca_recognition'","supabase.rpc('erp_commit_waca_snapshot'"],
      ["supabase.rpc('erp_preview_waca_recognition'","supabase.rpc('erp_commit_waca_recognition'"],
      ['    await this.requireCloudWritePermission();\n    let data: unknown; let error: unknown;', '    let data: unknown; let error: unknown;']]
      :[['return this.guardedWrite(() => this.supabaseProvider.commitWacaRecognition(request, plan));','return this.supabaseProvider.commitWacaRecognition(request, plan);']])]){
    assert.ok(after.includes(a),a);assert.throws(()=>assertReviewedProviderContract(file,baseline,after.replace(a,b)),/FAILED_CLOSED/);checks++;
  }
  assert.ok(before.includes('commitWacaCountedSnapshot'));
}
console.log(JSON.stringify({result:'PASS',checks,exactProviderAdditions:true,oldRulesPreserved:true,cloudWrites:0}));
