import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const base = '346e41ea19f92d1374452c8bec53dd706762dda0';
const restore = '3089fbcec9e44323522c758059689bb7641d20eb';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
git('merge-base', '--is-ancestor', restore, 'HEAD');
git('merge-base', '--is-ancestor', base, 'HEAD');
const unchanged = [
  'src/components/CloudAtomicRestorePanel.tsx',
  'src/providers/cloud/cloudAtomicRestore.ts',
  'src/providers/cloud/cloudRestoreCandidateProof.ts',
  'src/providers/cloud/cloudRestoreRpcTransport.ts',
  'src/providers/cloud/supabaseProvider.ts',
  'src/providers/dataProvider.ts',
  'src/lib/cloudWriteGuard.ts',
  'src/lib/cloudClosingDateWorkbenchApply.ts',
  'src/lib/closingDateWorkbenchAtomicApply.ts',
  'src/lib/closingDateCandidateRetrievalV2.ts',
  'scripts/verify-erp-deployment-identity.mjs',
  'wrangler.jsonc',
  ...readdirSync('supabase/sql').filter(name => /^(041|042|043)_/u.test(name))
    .map(name => 'supabase/sql/' + name),
];
for (const file of unchanged) {
  assert.equal(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'),
    git('show', base + ':' + file).replaceAll('\r\n', '\n'), file + ' must preserve canonical contract');
}
const prior = JSON.parse(git('show', base + ':config/erp-environment-identity.json'));
const current = JSON.parse(readFileSync('config/erp-environment-identity.json', 'utf8'));
assert.deepEqual(current.environments, prior.environments, 'No environment retargeting');
assert.deepEqual(current.accounts, prior.accounts, 'No account retargeting');
assert.equal(current.githubPreDeployGate.acceptedHead, restore);
assert.equal(current.githubPreDeployGate.branch, 'codex/erp2-deadline-v1-canonical-integration');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const oldPkg = JSON.parse(git('show', base + ':package.json'));
for (const [name, command] of Object.entries(oldPkg.scripts)) {
  assert.equal(pkg.scripts[name], command, 'Existing script preserved: ' + name);
}
assert.deepEqual(pkg.dependencies, oldPkg.dependencies);
assert.deepEqual(pkg.devDependencies, oldPkg.devDependencies);
console.log(JSON.stringify({ status: 'PASS', base, restore, unchangedContracts: unchanged.length,
  environmentRetargeting: 0, restoreSourceChanges: 0, migrationChanges: 0 }));
