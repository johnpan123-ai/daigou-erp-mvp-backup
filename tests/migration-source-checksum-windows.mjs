import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMigrationSourceReader, verifyMigrationSourceBytes } from '../tools/schema-reconciliation/migrationSource.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { verifySchemaBaselineEvidence } from '../scripts/promotion-safety.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const file='045_waca_erp2_restore_contract_patch.sql';
const name=execFileSync('git',['ls-tree','-r','--name-only','HEAD','--','supabase/sql'],{cwd:root,encoding:'utf8'}).split(/\r?\n/u).find(f=>f.startsWith('supabase/sql/045_'));
assert.ok(name);const approved=execFileSync('git',['show','HEAD:'+name],{cwd:root,maxBuffer:8*1024*1024});
assert.equal(approved.includes(13),false);const sql=approved.toString('utf8'),hash=b=>createHash('sha256').update(b).digest('hex');
const pin='26fdfdba34906355b0792474d2ca78646f4226f9f0f882935cc5e732bc21f9f8';assert.equal(hash(approved),pin);
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
check('exact LF keeps reviewed checksum',()=>assert.equal(verifyMigrationSourceBytes(approved,approved,file).sourceChecksum,pin));
const crlf=Buffer.from(sql.replace(/\n/gu,'\r\n'));
check('CRLF accepted only with exact immutable blob proof',()=>{const r=verifyMigrationSourceBytes(crlf,approved,file);assert.equal(r.sourceChecksum,pin);assert.equal(r.sql,sql);assert.equal(r.encoding,'GIT_VERIFIED_CRLF_CHECKOUT');assert.notEqual(r.checkoutChecksum,pin);});
check('mixed checkout line endings preserve only exact source',()=>assert.equal(verifyMigrationSourceBytes(Buffer.from(sql.replace('\n','\r\n')),approved,file).sourceChecksum,pin));
check('untracked append-only source retains exact bytes, no implicit normalization',()=>{assert.equal(verifyMigrationSourceBytes(crlf,null,file).sourceChecksum,hash(crlf));assert.notEqual(hash(crlf),pin);});
const mutations=[['SQL token',s=>s.replace('begin;','begin; select 42;')],['comment',s=>s+'\n-- changed\n'],['trailing space',s=>s+' '],
 ['trailing newline',s=>s+'\n'],['BOM',s=>'\uFEFF'+s],['lone CR',s=>s.replace('\n','\r')],['literal content',s=>s.replace('WACA','CHANGED_WACA')]];
for(const [label,mutate] of mutations)for(const windows of [false,true])check('reject '+label+(windows?' with CRLF':''),()=>{
 const changed=mutate(sql),bytes=Buffer.from(windows?changed.replace(/\n/gu,'\r\n'):changed);assert.notEqual(hash(bytes),pin);
 assert.throws(()=>verifyMigrationSourceBytes(bytes,approved,file),/MIGRATION_SOURCE_CONTENT_DRIFT/u);
});
check('invalid UTF8 rejected, not replacement-decoded',()=>assert.throws(()=>verifyMigrationSourceBytes(Buffer.from([0xff]),null,file),/UTF8_INVALID/u));
const read=createMigrationSourceReader(root),actual=await read(name.split('/').at(-1));assert.equal(actual.sourceChecksum,pin);checks++;
const registry=await buildMigrationEffectRegistry();assert.equal(registry['045'].sourceChecksum,pin);assert.equal(registry['045b'].sourceChecksum,'56fc74eadd5ef8ea7ccc707ed03979a18116ec1b466c7a7131de07ad34451e29');checks++;
assert.equal(registry['074'].sourceChecksum,'4d3833ff1fe98b8276eeb22c7f6052e40c747f1cf614b6f3c78eb2a184f8b268');checks++;
for(const path of ['../045.sql','/tmp/045.sql','045.sql'])await assert.rejects(()=>read(path),/PATH_INVALID/u);checks+=3;
const current=JSON.parse(readFileSync(new URL('../docs/schema-candidates/erp2-v30-waca-order-recognition.snapshot.json',import.meta.url)));
const expected=JSON.parse(readFileSync(new URL('../docs/schema-candidates/erp2-v33-r5-source-capacity-receiving.snapshot.json',import.meta.url)));
const contract=JSON.parse(readFileSync(new URL('../config/erp-environment-identity.json',import.meta.url)));
current.identity={...current.identity,projectRef:'rhfdjsklfrgpoqsaqpkn',environmentRole:'PRODUCTION'};
const candidate={head:'03fd94b0ddd380e2746e6dd26f9524488ebbc908',checkpointTag:'checkpoint-unit-checksum-only'};
const evidence=planSchemaDelta(current,registry,{expectedSnapshot:expected,sourceHead:candidate.head,checkpoint:candidate.checkpointTag,
 requiredBaselineId:contract.schemaBaseline.requiredBaselineId,snapshotToolChecksum:contract.schemaBaseline.snapshotToolChecksum});
assert.equal(evidence.readyForApply,true,JSON.stringify(evidence.blockers));
const liveObservation={projectRef:current.identity.projectRef,fingerprint:evidence.currentFingerprint,observedAt:current.capturedAt};
const verify=migrationRegistry=>verifySchemaBaselineEvidence({evidence,contract,candidate,liveObservation,migrationRegistry,now:Date.parse(current.capturedAt)});
check('unchanged strict PRE_ADOPTION verifier accepts approved source identities',()=>assert.equal(verify(registry).result,'PASS'));
for(const [label,mutate] of mutations)check('sealed evidence rejects genuine '+label+' checksum drift',()=>{
 const changed={...registry,'045':{...registry['045'],sourceChecksum:hash(Buffer.from(mutate(sql)))}};
 assert.throws(()=>verify(changed),/migration 045 does not match the candidate source registry/u);
});
console.log(JSON.stringify({result:'PASS',checks,contract:'EXACT_GIT_BYTES_OR_GIT_PROVEN_CRLF_CHECKOUT',reviewed045PinUnchanged:true,strictVerifierUnchanged:true,sqlFilesChanged:0,liveWrites:0}));
