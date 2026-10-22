// Release-candidate evidence only. Does not adopt or change the live v32 baseline.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {buildMigrationEffectRegistry} from '../schema-reconciliation/migrationEffectRegistry.mjs';
export const baseFingerprint='a65bc8ee78b8c135d26c88f9a89b2ccfb522c8a47899caac811555c5f28f72e7';
export const sourceFile='078_core_source_capacity_and_receiving.sql';
export const sourceSha256='95607b46e7ebcf9b9b16cd23d9c73472070ca94ec32950547470de600e339f35';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const newFunctions=['erp_core_restore_in_progress','erp_core_write_lock','erp_core_source_guard','erp_core_package_progress','erp_core_shipment_guard'].map(n=>'public.'+n+'()');
export const changedFunctions=['public.erp_apply_japan_package_transaction(uuid,jsonb)','public.erp_apply_related_transaction(uuid,jsonb)'];
export const triggers=[
 ...['japan_packages','japan_package_items','outbound_shipments','outbound_shipment_items'].map(t=>[t,'erp_core_write_lock']),
 ['outbound_shipment_items','erp_core_capacity'],['japan_package_items','erp_core_capacity'],
 ['japan_package_items','erp_core_progress'],['japan_packages','erp_core_progress'],['outbound_shipments','erp_core_reactivate'],
];
export const source=()=>{const b=readFileSync(new URL('../../supabase/sql/'+sourceFile,import.meta.url));assert.equal(sha(b),sourceSha256,'078 immutable candidate source');return b.toString('utf8');};
export async function candidateEffectRegistry(){
 const registry=await buildMigrationEffectRegistry();
 assert.equal(registry['078'].sourceChecksum,sourceSha256);
 return registry;
}
export function exactFunctionDelta(before,after){
 const added=Object.keys(after.functions).filter(k=>!before.functions[k]).sort();
 const changed=Object.keys(before.functions).filter(k=>JSON.stringify(before.functions[k])!==JSON.stringify(after.functions[k])).sort();
 assert.deepEqual(added,[...newFunctions].sort());assert.deepEqual(changed,[...changedFunctions].sort());
 for(const key of changed){const {definition:a,...am}=before.functions[key],{definition:b,...bm}=after.functions[key];assert.deepEqual(am,bm,key+' metadata');}
 return {added,changed,definitions:Object.fromEntries([...added,...changed].map(k=>[k,{before:before.functions[k]??null,after:after.functions[k]}]))};
}
export function rollbackSql(before,after){
 exactFunctionDelta(before,after);
 const guard=[...newFunctions,...changedFunctions].map(sig=>`IF encode(sha256(convert_to(pg_get_functiondef('${sig}'::regprocedure),'UTF8')),'hex') <> '${sha(after.functions[sig].definition)}' THEN RAISE EXCEPTION 'R5_ROLLBACK_SOURCE_CHANGED'; END IF;`).join('\n');
 return `-- EMERGENCY CANDIDATE ONLY. Owner approval and write quiescence required.
-- Schema rollback does not restore business data or restore/adopt Ledger.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('erp-cloud-restore-maintenance-lock',0));
DO $guard$ BEGIN
${guard}
END $guard$;
${triggers.map(([t,n])=>'DROP TRIGGER '+n+' ON public.'+t+';').join('\n')}
${changedFunctions.map(k=>before.functions[k].definition+';').join('\n')}
${newFunctions.map(k=>'DROP FUNCTION '+k+';').join('\n')}
COMMIT;
`;
}
