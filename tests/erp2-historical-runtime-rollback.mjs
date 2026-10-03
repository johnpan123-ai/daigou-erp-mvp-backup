import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { verifyHistoricalRelease, assertRollbackCompatibility } from '../scripts/historical-runtime-rollback.mjs';
import { buildManifestIdentity, listArtifactFiles, verifyArtifactIdentity, verifyRemoteCandidate,
  verifyCloudflareIdentity, CANONICAL_ERP2_TARGET as target } from '../scripts/promotion-safety.mjs';
import { parseArguments } from '../scripts/verify-erp2-promotion.mjs';
const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url)));
const registry = JSON.parse(await readFile(new URL('../config/erp2-historical-runtime-releases.json', import.meta.url)));
const release = registry.releases[0], gate = contract.githubPreDeployGate;
const tooling = { head:'1'.repeat(40) };
const manifest = { identity:release.artifactIdentity, files:Array.from({length:release.artifactFiles}),
  source:{head:release.head,branch:release.branch,checkpointTag:release.checkpoint}, target:{accountId:target.accountId,
    project:target.project,supabaseProject:target.supabaseProject,publicFingerprint:target.publicFingerprint,pagesBranch:target.pagesBranch} };
const deployment = { Id:release.deploymentId,Environment:'Production',Branch:target.pagesBranch,Source:release.head.slice(0,7),
  Deployment:release.deploymentUrl,Build:`https://dash.cloudflare.com/${target.accountId}/pages/view/${target.project}/${release.deploymentId}` };
function gitFixture(overrides={}) {
 return args=>{
  if(args[0]==='check-ref-format')return '';
  if(args[0]==='rev-parse') {
   if(args[1]==='HEAD')return tooling.head;
   if(args[1]===`${gate.acceptedTag}^{}`)return gate.acceptedHead;
   if(args[1]===`${gate.lineage.reconciliationTag}^{}`)return gate.lineage.reconciliationHead;
   return overrides.checkpointHead??release.head;
  }
  if(args[0]==='branch')return 'codex/erp2-runtime-rollback-guard-v1';
  if(args[0]==='status')return overrides.dirty??'';
  if(args[0]==='remote')return 'https://github.com/johnpan123-ai/daigou-erp-mvp-backup.git';
  if(args[0]==='ls-remote')return args.slice(2).filter(ref=>ref.endsWith('^{}')).map(ref=>`${overrides.remoteCheckpoint??release.head}\t${ref}`).join('\n');
  if(args[0]==='--no-replace-objects'&&args[1]==='rev-parse')return overrides.historicalHead??release.head;
  if(args[0]==='--no-replace-objects'&&args[1]==='merge-base') {
   if(overrides.notAncestor || args.at(-2)===gate.acceptedHead)throw Error('not ancestor');return '';
  }
  throw Error(`Unexpected Git call:${args}`);
 };
}
const check=options=>verifyHistoricalRelease({registry,releaseId:release.id,manifest,git:gitFixture(),tooling,contract,
 deployments:[deployment],...options});
assert.equal(check().candidate.head,release.head);
assert.notEqual(check().candidate.head,tooling.head);
console.log('PASS exact registered historical release; runtime HEAD differs from current tooling HEAD');
const negatives=[
 ['unknown release',()=>check({releaseId:'arbitrary-old-commit'})],
 ['wrong artifact',()=>check({manifest:{...manifest,identity:'F'.repeat(64)}})],
 ['wrong historical HEAD',()=>check({git:gitFixture({historicalHead:tooling.head})})],
 ['artifact HEAD mismatch',()=>check({manifest:{...manifest,source:{...manifest.source,head:tooling.head}}})],
 ['unknown historical checkpoint',()=>check({git:gitFixture({remoteCheckpoint:'0'.repeat(40)})})],
 ['non-ancestor historical source',()=>check({git:gitFixture({notAncestor:true})})],
 ['wrong Supabase',()=>check({manifest:{...manifest,target:{...manifest.target,supabaseProject:'wrong'}}})],
 ['wrong account',()=>check({manifest:{...manifest,target:{...manifest.target,accountId:'wrong'}}})],
 ['wrong project',()=>check({manifest:{...manifest,target:{...manifest.target,project:'wrong'}}})],
 ['wrong public fingerprint',()=>check({manifest:{...manifest,target:{...manifest.target,publicFingerprint:'wrong'}}})],
 ['missing historical deployment',()=>check({deployments:[]})],
 ['deployment in another account',()=>check({deployments:[{...deployment,Build:deployment.Build.replace(target.accountId,'wrong')}]})],
 ['preview deployment',()=>check({deployments:[{...deployment,Environment:'Preview'}]})],
 ['dirty tooling',()=>verifyRemoteCandidate({contract,git:gitFixture({dirty:' M scripts/tooling.mjs'}),checkpointTag:'checkpoint-test'})],
 ['wrong actual Cloudflare account',()=>verifyCloudflareIdentity({contract,wrangler:()=>({loggedIn:true,accounts:[{id:'wrong'}]})})],
 ['unknown mode',()=>parseArguments(['--mode','--force'])],
];
for(const [label,run]of negatives){assert.throws(run,/DEPLOYMENT_GUARD_FAILED_CLOSED/u,label);console.log(`PASS blocked: ${label}`);}
const artifact={result:'PASS',identity:release.artifactIdentity,source:{head:release.head},files:release.artifactFiles};
const schemaBaseline={result:'PASS',mode:'POST_ADOPTION',currentFingerprint:contract.schemaBaseline.canonicalFingerprint,
 applyDelta:[],deploymentLineage:{result:'PASS',mode:'SAFE_DESCENDANT',schemaBaselineMutated:false,schemaSensitiveFiles:0,unknownFiles:0,
 migrationChecksumParity:'PASS',canonicalContractParity:'PASS',providerContractParity:'PASS',backupContractParity:'PASS'}};
const compat=value=>assertRollbackCompatibility({schemaBaseline,artifact,release,contract,...value});
assert.equal(compat().result,'PASS');
for(const [label,patched]of [['DB incompatible',{...schemaBaseline,result:'FAIL'}],['schema drift',{...schemaBaseline,currentFingerprint:'0'.repeat(64)}],
 ['migration delta',{...schemaBaseline,applyDelta:['049']}],['provider incompatible',{...schemaBaseline,deploymentLineage:{...schemaBaseline.deploymentLineage,providerContractParity:'FAIL'}}],
 ['unknown diff',{...schemaBaseline,deploymentLineage:{...schemaBaseline.deploymentLineage,unknownFiles:1}}]]){
 assert.throws(()=>compat({schemaBaseline:patched}),/DEPLOYMENT_GUARD_FAILED_CLOSED/u,label);console.log(`PASS blocked: ${label}`);
}
const dir=await mkdtemp(resolve(tmpdir(),'erp2-rollback-guard-test-'));
await writeFile(resolve(dir,'index.html'),'immutable fixture');
const candidate={...check().candidate};
const payload={schemaVersion:2,schemaContract:{name:contract.schemaBaseline.canonicalContract,algorithm:contract.schemaBaseline.canonicalAlgorithm,
 version:contract.schemaBaseline.fingerprintContractVersion,fingerprint:contract.schemaBaseline.canonicalFingerprint},source:candidate,
 target:{role:target.role,accountId:target.accountId,project:target.project,supabaseProject:target.supabaseProject,
 publicFingerprint:target.publicFingerprint,runtimeMarker:target.runtimeMarker},build:{timestamp:new Date().toISOString()},files:await listArtifactFiles(dir)};
await writeFile(resolve(dir,'erp-build-identity.json'),JSON.stringify({...payload,identity:buildManifestIdentity(payload)}));
assert.equal((await verifyArtifactIdentity({artifactRoot:dir,proof:{candidate},contract})).result,'PASS');
await writeFile(resolve(dir,'index.html'),'tampered fixture');
await assert.rejects(verifyArtifactIdentity({artifactRoot:dir,proof:{candidate},contract}),/file hash inventory mismatch/u);
console.log('PASS actual file tamper blocked before deployment');
console.log('PASS HISTORICAL_RUNTIME_ROLLBACK regression matrix; mutation=0 deploy=0');
