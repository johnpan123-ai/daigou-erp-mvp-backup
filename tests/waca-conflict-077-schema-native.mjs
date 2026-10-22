import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {isolatedDatabase} from './helpers/saveability-isolated.mjs';
import {CANONICAL_FRESH_INSTALL_V3} from '../supabase/canonicalFreshInstallV3.mjs';
import {fingerprintStructuralSnapshot} from '../tools/schema-reconciliation/schemaContract.mjs';
import {buildMigrationEffectRegistry} from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import {planSchemaDelta,reconcileMigration} from '../tools/schema-reconciliation/reconcile.mjs';
import {WACA_TRANSPORT_REASONS,reviewedWacaConflictDefinition} from '../tools/schema-reconciliation/wacaConflictTransport.mjs';
const file='077_waca_custom_conflict_http409.sql',source=readFileSync('supabase/sql/'+file,'utf8');
const db=await isolatedDatabase({migrations:CANONICAL_FRESH_INSTALL_V3.slice(0,CANONICAL_FRESH_INSTALL_V3.indexOf(file))});
const canonical=JSON.parse(readFileSync('docs/schema-candidates/erp2-v32-waca-conflict-http409.snapshot.json'));
const capture=async()=>{const s=(await db.sql.query(readFileSync('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql','utf8'))).rows[0].erp_schema_snapshot;
 s.integrity.inventoryItems=(await db.sql.query(readFileSync('tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql','utf8'))).rows[0].inventory_items_integrity;
 s.completeness.inventoryIntegrity=true;return s;};
const state=async()=>(await db.sql.query(`select public.erp_export_cloud_restore_snapshot_json() business,
 (select epoch from public.erp_cloud_restore_epoch where singleton) epoch,
 (select generation from public.erp_restore_business_generation where singleton) generation`)).rows[0];
try{
 const before=await capture(),business=await state();
 assert.equal(fingerprintStructuralSnapshot(before),'76b44aa27ed32c540272da5e210df75d09cc55d5d0d3d993e41b060f403e0b16');
 await db.sql.query(source);assert.deepEqual(await state(),business);
 const after=await capture();assert.deepEqual(after.tables,before.tables);
 const changed=Object.keys(after.functions).filter(s=>JSON.stringify(after.functions[s])!==JSON.stringify(before.functions[s])).sort();
 assert.deepEqual(changed,Object.keys(WACA_TRANSPORT_REASONS).sort());
 for(const sig of changed){const {definition:d0,...meta0}=before.functions[sig],{definition:d1,...meta1}=after.functions[sig];
  assert.deepEqual(meta1,meta0,sig+' owner/ACL/config unchanged');
  assert.equal(d1,reviewedWacaConflictDefinition(sig,d0),sig+' only ten exact SQLSTATE literals');
 }
 assert.equal(fingerprintStructuralSnapshot(after),fingerprintStructuralSnapshot(canonical));
 // This test proves the historical v31 -> v32 (077) boundary. The full v33
 // source registry remains strict and is tested by r5-release-reconciliation.
 const fullRegistry=await buildMigrationEffectRegistry();
 const registry=Object.fromEntries(Object.entries(fullRegistry).filter(([,effect])=>effect.canonicalOrder<=fullRegistry['077'].canonicalOrder));
 const pre=planSchemaDelta(before,registry,{expectedSnapshot:after});
 assert.equal(pre.readyForApply,true,JSON.stringify(pre.blockers));assert.deepEqual(pre.applyPlan.map(p=>p.migrationId),['077']);
 const post=planSchemaDelta(after,registry,{expectedSnapshot:after});
 assert.equal(post.readyForApply,true,JSON.stringify(post.blockers));assert.equal(post.migrations.length,46);
 assert.ok(post.migrations.every(m=>m.state==='SATISFIED'&&m.applyMethod==='NO_APPLY'));
 // Every missing/modified function and each partial transport rollout fails exact whole-chain proof.
 let negative=0;
 const chain=registry['074'].postconditions[0].retainedImplementation.functions;
 for(const entry of chain){for(const operation of ['missing','body','acl']){
  const bad=structuredClone(after);
  if(operation==='missing')delete bad.functions[entry.object];
  else if(operation==='body'){
    const original=bad.functions[entry.object].definition;
    bad.functions[entry.object].definition=original.replace(/\b(select|begin)\b/i,'select 987654321; $1');
    assert.notEqual(bad.functions[entry.object].definition,original,'Negative fixture must actually change SQL');
  }
  else bad.functions[entry.object].anonExecute=true;
  for(const id of ['044','073','074','077'])assert.notEqual(reconcileMigration(bad,registry[id]).state,'SATISFIED',entry.object+' '+operation+' '+id);
  negative++;
 }}
 for(const sig of changed){const mixed=structuredClone(after);mixed.functions[sig]=before.functions[sig];
  assert.notEqual(reconcileMigration(mixed,registry['077']).state,'SATISFIED');
  for(const id of ['044','073','074'])assert.notEqual(reconcileMigration(mixed,registry[id]).state,'SATISFIED');negative++;
 }
 await assert.rejects(db.sql.query(source),/WACA_TRANSPORT_SOURCE_MISMATCH/);await db.sql.query('rollback');
 assert.equal(fingerprintStructuralSnapshot(await capture()),fingerprintStructuralSnapshot(after));assert.deepEqual(await state(),business);
 // Tampered source before apply is rejected, not silently patched.
 await db.sql.query('begin');
 for(const sig of changed)await db.sql.query(before.functions[sig].definition);
 await db.sql.query(before.functions[changed.at(-1)].definition.replace(/\bbegin\b/i,'begin perform 123456789;'));
 await assert.rejects(db.sql.query(source.replace(/^([\s\S]*?)BEGIN;/,'$1')),/WACA_TRANSPORT_SOURCE_MISMATCH/);
 await db.sql.query('rollback');assert.equal(fingerprintStructuralSnapshot(await capture()),fingerprintStructuralSnapshot(after));
 // A genuine engine serialization failure is NOT rewritten by this migration.
 const a=new pg.Client({connectionString:db.url.toString()}),b=new pg.Client({connectionString:db.url.toString()});
 await a.connect();await b.connect();
 try{
  await a.query('begin isolation level serializable');await b.query('begin isolation level serializable');
  const id=(await a.query('select id from public.product_variants order by id limit 1')).rows[0].id;
  await b.query('select version from public.product_variants where id=$1',[id]);
  await a.query('update public.product_variants set version=version+1 where id=$1',[id]);await a.query('commit');
  await assert.rejects(b.query('update public.product_variants set version=version+1 where id=$1',[id]),e=>e.code==='40001'&&/serialize access/.test(e.message));
  await b.query('rollback');
 }finally{await a.end();await b.end();}
 console.log(JSON.stringify({result:'PASS',migration:'077',changedFunctions:changed,sqlstateChanges:10,negative,
  schema:fingerprintStructuralSnapshot(after),post:'46/46 SATISFIED',businessMutation:0,rerun:'FAIL_CLOSED',cloudApply:0}));
}finally{await db.close();}
