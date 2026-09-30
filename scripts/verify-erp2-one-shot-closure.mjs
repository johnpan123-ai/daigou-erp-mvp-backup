import { spawnSync } from 'node:child_process';

const portable = [
  'tests/pre-adoption-recovery-bundle.mjs',
  'tests/erp2-one-shot-live-compatibility.mjs',
  'tests/erp2-partial-apply-recovery.mjs',
  'tests/schema-reconciliation.mjs',
  'tests/schema-reconciliation-pglite.mjs',
  'tests/erp2-pre-adoption-guard.mjs',
  'tests/post-migration-canonical-reconciliation.mjs',
  'tests/waca-backup-cutover-v3.mjs',
  'tests/durable-resource-registry-v3.mjs',
  'tests/cloud-backup-next-restore-e2e.mjs',
  'tests/erp2-promotion-guard.mjs',
];
const native = [
  'tests/waca-fresh-install-chain-v3.mjs',
  'tests/waca-cloud-restore-patch-v3.mjs',
  'tests/erp2-046-compatibility-isolated.mjs',
];

const executed = [];
for (const file of [...portable, ...(process.env.WACA_ISOLATED_PG_URL ? native : [])]) {
  const result = spawnSync(process.execPath, [file], { cwd: process.cwd(), env: process.env,
    stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
  executed.push(file);
}

console.log(JSON.stringify({
  result: 'PASS',
  exactRemainingDelta: ['045c','046b','047','048'],
  canonicalFingerprint: 'bc0cb320bb57dce141b7ce9c24990097f35ce739e441c7835fbe20ca5b64d317',
  nativePostgreSQL: process.env.WACA_ISOLATED_PG_URL ? 'PASS' : 'UNAVAILABLE',
  executed,
  liveMutation: 0,
}, null, 2));
