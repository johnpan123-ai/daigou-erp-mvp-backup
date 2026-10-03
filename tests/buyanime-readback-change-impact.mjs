import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assertReviewedProviderContract, classifyDescendantFile } from '../scripts/post-adoption-descendant.mjs';
import { sourceHash, classifyReviewedFile } from '../scripts/reviewed-change-impact.mjs';
const base='535d9a67f044ac2bb237165313edc29ae477bb6e';
const files=['src/providers/cloud/cloudBulkRead.ts','src/providers/cloud/buyAnimeImportResume.ts',
  'src/providers/cloud/buyAnimeImportJournal.ts','src/providers/cloud/cloudSyncDomain.ts',
  'src/providers/cloud/cloudTargetedCache.ts','src/providers/cloud/supabaseProvider.ts','src/providers/dataProvider.ts'];
for(const file of files){
  const after=readFileSync(file,'utf8');let before=null;
  try { before=execFileSync('git',['show',base+':'+file],{encoding:'utf8',stdio:['ignore','pipe','ignore']}); } catch {}
  assertReviewedProviderContract(file,before,after);
  // Unit exact-hash fixtures, NOT deployment/release evidence.
  const reviews=[{id:'unit-exact-readback-resume',files:[{file,beforeHash:sourceHash(before),afterHash:sourceHash(after),
    classification:'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL'}]}];
  assert.ok(classifyReviewedFile({file,after,reviews}));
  for(const future of ['export const requiredDurableField="unsafe";',
    'export const rpcPayloadSignature="unsafe";', 'export const backupRegistry="unsafe";']){
    assert.throws(()=>classifyReviewedFile({file,after:after+'\n'+future,reviews}),/FAILED_CLOSED/u);
  }
  if(file.endsWith('buyAnimeImportJournal.ts'))assert.throws(()=>assertReviewedProviderContract(file,before,
    after.replace("supabase.from('import_batches')","supabase.from('new_durable_table')")),/FAILED_CLOSED/u);
  if(file.endsWith('cloudBulkRead.ts'))assert.throws(()=>assertReviewedProviderContract(file,before,
    after+'\nfetch("/unsafe");'),/FAILED_CLOSED/u);
  if(file.endsWith('cloudSyncDomain.ts'))assert.throws(()=>assertReviewedProviderContract(file,before,
    after+'\nexport const drift=1;'),/FAILED_CLOSED/u);
  if(file.endsWith('supabaseProvider.ts'))assert.throws(()=>assertReviewedProviderContract(file,before,
    after.replace('p_request: catalog.plan.request','p_unsafe_payload: catalog.plan.request')),/FAILED_CLOSED/u);
}
for(const file of ['supabase/sql/050_catalog_atomic_transaction.sql','src/lib/durableResourceRegistry.ts',
  'tools/schema-reconciliation/schemaContract.mjs','src/providers/cloud/futureUnreviewed.ts'])
  assert.equal(classifyDescendantFile(file,null,'unknown'),'SCHEMA_SENSITIVE_OR_UNREVIEWED');
console.log('PASS exact readback/resume source-only review; future durable/RPC/backup/SQL/canonical/provider/unknown hunks fail closed; no live evidence substitution');
