// Candidate impact inventory, not a production release waiver or schema adoption.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const base='23a02377044c7cf56a41aabe1ddce79fc0535df5',core='7aee41d89153d7fff7aa42adf71502b546c9101d';
const head=git('rev-parse','HEAD');
git('merge-base','--is-ancestor',base,head);git('merge-base','--is-ancestor',core,head);
assert.equal(git('status','--porcelain'),'','Candidate evidence requires a clean committed tree');
const allowed=[
 'src/hooks/useProductGroupBasicInfoDrafts.ts','src/lib/closingDateInput.ts','src/lib/db.ts','src/lib/japanPackageReceivingUpdates.ts',
 'src/lib/receivingCancellationMessage.ts','src/providers/cloud/cloudFieldCas.ts','tests/r5-receiving-message.mjs',
 'src/pages/JapanPackageDetail.tsx','src/pages/PurchaseManagement.tsx','src/pages/PurchaseRecords.tsx',
 'src/providers/cloud/japanPackageTransaction.ts','src/providers/localProvider.ts',
 'tests/closing-date-input-validation.mjs','tests/japan-package-bulk-receiving-postgrest.mjs','tests/r5-closing-date-react.mjs',
 'tests/r5-owner-preview-ui.mjs','tests/fixtures/r5-mode-draft.tsx','tests/fixtures/r5-owner-preview.html','tests/fixtures/r5-owner-preview.mjs',
 'tests/waca-counted-restore-e2e.mjs','scripts/r5-seven-integration-gates.mjs','scripts/r5-seven-owner-preview.mjs','scripts/r5-seven-change-impact.mjs',
 'tests/r5-schema-rollback-isolated.mjs','tests/r5-authoritative-backup-restore-isolated.mjs','tools/r5-release/contract.mjs',
 'tests/r5-release-reconciliation.mjs','tests/helpers/saveability-isolated.mjs','tests/waca-counted-transition.mjs',
 'tests/schema-canonical-native-v3.mjs','tests/schema-canonical-v3.mjs','tests/schema-reconciliation.mjs',
 'tests/migration-source-checksum-windows.mjs','tests/waca-conflict-077-schema-native.mjs',
 'tools/schema-reconciliation/migrationEffectRegistry.mjs','supabase/canonicalFreshInstallV3.mjs','config/erp-environment-identity.json',
 'docs/schema-candidates/erp2-v33-r5-source-capacity-receiving.snapshot.json',
];
const changed=git('diff','--name-only',core,head).split(/\r?\n/).filter(Boolean).sort();
assert.deepEqual(changed.filter(file=>!allowed.includes(file)),[],'Unreviewed integration file');
const protectedFiles=[
 'supabase/sql/078_core_source_capacity_and_receiving.sql','docs/schema-candidates/erp2-v32-waca-conflict-http409.snapshot.json',
 'scripts/post-adoption-descendant.mjs','scripts/r5-core-provider-review.mjs',
 'src/providers/providerMode.ts','src/providers/dataProvider.ts','src/providers/cloud/supabaseProvider.ts',
 'src/providers/cloud/cloudCacheWriteFence.ts',
 'src/contexts/CloudRealtimeSyncContext.tsx','src/providers/cloud/cloudAtomicRestore.ts',
 'src/auth/AuthProvider.tsx',
];
for(const file of protectedFiles)assert.equal(git('rev-parse',core+':'+file),git('rev-parse',head+':'+file),file+' must retain core protection');
const textAt=(ref,file)=>execFileSync('git',['show',ref+':'+file],{encoding:'utf8'}).replace(/\r\n?/g,'\n');
const fresh='supabase/canonicalFreshInstallV3.mjs';
assert.equal(textAt(head,fresh),textAt(core,fresh).replaceAll("  '077_waca_custom_conflict_http409.sql',","  '077_waca_custom_conflict_http409.sql',\n  '078_core_source_capacity_and_receiving.sql',"));
const cfg='config/erp-environment-identity.json',expectedCfg=JSON.parse(textAt(core,cfg));
expectedCfg.schemaBaseline.requiredBaselineId='erp2-canonical-schema-v33-r5-source-capacity-receiving';
expectedCfg.schemaBaseline.canonicalFingerprint='a5387d8513f2f1aab7eba16ab2f0b10a43a21fdbfeb85d8ac0686a6fc7878ac5';
assert.deepEqual(JSON.parse(textAt(head,cfg)),expectedCfg,'Only the candidate schema target identity changes; guards stay exact');
// Exactly two user-facing string replacements; every other CAS/error statement stays pinned.
const cas='src/providers/cloud/cloudFieldCas.ts';
const originalCas=execFileSync('git',['show',core+':'+cas],{encoding:'utf8'}).replace(/\r\n?/g,'\n');
const currentCas=execFileSync('git',['show',head+':'+cas],{encoding:'utf8'}).replace(/\r\n?/g,'\n');
assert.equal(currentCas,originalCas
 .replace('此來源已配置 ${detail.allocated} 件，未配置 ${detail.cancelable} 件；不可超額配置或整列取消點收。部分取消需另案設計。','來源配置數量超過可用數量（已配置 ${detail.allocated} 件），操作未完成。')
 .replace('來源數量不足或已有出庫配置，操作未完成；請同步後確認。','來源可用數量不足，操作未完成；請同步後確認。'));
assert.equal(git('diff','--name-only',base,head,'--','supabase/sql/073*','supabase/sql/074*','supabase/sql/075*','supabase/sql/076*','supabase/sql/077*'),'','Applied migrations must be immutable');
const hash=source=>createHash('sha256').update(source.replace(/\r\n?/g,'\n')).digest('hex');
const files=git('diff','--name-only',base,head).split(/\r?\n/).filter(Boolean).sort().map(file=>{
 let before=null;try{before=hash(execFileSync('git',['show',base+':'+file],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));}catch{}
 return {file,beforeSha256:before,afterSha256:hash(execFileSync('git',['show',head+':'+file],{encoding:'utf8'})),classification:file.startsWith('supabase/sql/')?'APPEND_ONLY_MIGRATION_CANDIDATE':file.startsWith('src/')?'APPLICATION_OR_PERSISTENCE_BEHAVIOR':'TEST_OR_LOCAL_TOOLING'};
});
console.log(JSON.stringify({result:'PASS',kind:'R5_CANDIDATE_CHANGE_IMPACT',base,core,head,files,integrationFiles:changed,protectedCoreFiles:protectedFiles,
 paths:{receiving:'JapanPackageDetail -> changedReceivingUpdates -> DynamicDataProvider -> SupabaseProvider -> existing RPC -> 078 source/progress triggers',dates:'L1/L2 -> shared draft hook -> closingDateInput -> existing CAS save',mode:'Existing immutable mode binding and Restore Epoch barriers retained; no Provider dispatch exception'},
 externalContracts:{newRpc:0,appliedMigrationsModified:0,backupFormatChanged:false,newDurableFields:0,formalWrites:0},
 releaseGate:'NOT_RUN: no Push or formal migration authorized; candidate impact PASS is not schema adoption or deployment approval'},null,2));
