import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {assertReviewedRestoreAdapterContract} from '../scripts/post-adoption-descendant.mjs';
const file='src/providers/cloud/cloudAtomicRestore.ts';
const before=execFileSync('git',['show',`c2bf972a1d00604f979fb7c653d24b85f9e130a0:${file}`],{encoding:'utf8'});
const after=readFileSync(file,'utf8');
assertReviewedRestoreAdapterContract(file,before,after);
for(const mutated of [
 after.replace('row.status_changed_at = null','row.status_changed_at = Date.now()'),
 after.replace('row.status_changed_at = null','row.status_changed_at = row.updated_at'),
 after.replace("'wacaOrders', 'waca_orders'","'wacaOrders', 'unsafe_orders'"),
 after.replace("'inventory-id-v2'","'inventory-id-unsafe'"),
 after.replace("'erp_restore_proven_cloud_snapshot_attempt'","'erp_unsafe_restore'"),
 after.replace("if (!('status_changed_at' in row))", "if (true)"),
 after+'\nexport const newDurableField = true;',
]) {
 assert.notEqual(mutated,after,'NEGATIVE_FIXTURE_MUST_CHANGE_SOURCE');
 assert.throws(()=>assertReviewedRestoreAdapterContract(file,before,mutated),/FAILED_CLOSED/u);
}
assert.throws(()=>assertReviewedRestoreAdapterContract('src/providers/cloud/unknown.ts',before,after),/FAILED_CLOSED/u);
console.log('PASS exact verified-v1 NULL adapter only; new durable fields, RPC, registry, identity and v2 downgrade remain FAIL CLOSED');
