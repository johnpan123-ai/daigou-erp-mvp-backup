import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArguments, verifyDeploymentIdentity } from '../scripts/verify-erp-deployment-identity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const identity = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const accepted = 'e565d067f49c95cf71dd6c95c5fab5b4749558f8';
const candidate = '68269ad9e80762c07d64fde38194a56e3db69e1f';
const branch = 'codex/erp2-workflow-ux-quick-wins-v1';
const checkpoint = 'checkpoint-20260927-erp2-workflow-ux-quick-wins-v1';
const acceptedTag = 'accepted-20260927-erp2-deadline-v1-live';
const account = 'e0a58431cd5bcf0e01ec3438d531461a';
const catalogAccount = 'f543371d2e71d3f9d81dc5863b1f16c9';
const realGit = argv => execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

assert.equal(identity.renameDecision.mode, 'KEEP_PHYSICAL_SLUG_FIX_CANONICAL_LABELS');
assert.equal(identity.accounts.erp.profile, 'hippo-erp');
assert.equal(identity.accounts.erp.accountId, account);
assert.equal(identity.accounts.catalog.profile, 'hippo-catalog');
assert.equal(identity.accounts.catalog.accountId, catalogAccount);
assert.equal(identity.environments.erp1.humanName, '小河馬訂購紀錄表 1.0');
assert.equal(identity.environments.erp1.deploymentAllowed, false);
assert.equal(identity.environments.erp2.humanName, '小河馬訂購紀錄表 2.0');
assert.equal(identity.environments.erp2.cloudflareProject, 'hippo-erp-realtime-preview');
assert.equal(identity.environments.erp2.supabaseProject, 'rhfdjsklfrgpoqsaqpkn');
assert.equal(identity.environments.erp2.publicFingerprint, 'D9EA6B7BB6524517');
assert.equal(identity.environments.next.cloudflareProject, null);
assert.equal(identity.environments.experimental.cloudflareProject, null);
assert.equal(identity.githubPreDeployGate.acceptedHead, accepted);
assert.equal(identity.githubPreDeployGate.acceptedTag, acceptedTag);
assert.equal(identity.githubPreDeployGate.branch, undefined);
assert.equal(identity.githubPreDeployGate.checkpointTag, undefined);
assert.equal(pkg.scripts['verify:erp-deployment-identity'], 'node scripts/verify-erp-deployment-identity.mjs');

const baseArgs = {
  role: 'erp2', profile: 'hippo-erp', project: 'hippo-erp-realtime-preview',
  'supabase-project': 'rhfdjsklfrgpoqsaqpkn', 'runtime-marker': 'STAGING', fingerprint: 'D9EA6B7BB6524517',
  'source-head': candidate, 'remote-branch': branch, 'checkpoint-tag': checkpoint,
};
function gitEvidence(overrides = {}) {
  const state = {
    head: candidate, branch, checkpoint, dirty: '', remoteHead: candidate, checkpointHead: candidate,
    acceptedHead: accepted, remoteUrl: 'https://github.com/johnpan123-ai/daigou-erp-mvp-backup.git',
    ...overrides,
  };
  const calls = [];
  const git = argv => {
    calls.push(argv);
    if (argv[0] === 'rev-parse') return state.head;
    if (argv[0] === 'branch') return state.branch;
    if (argv[0] === 'status') return state.dirty;
    if (argv[0] === 'remote') return state.remoteUrl;
    if (argv[0] === 'ls-remote') {
      return [
        [state.remoteHead, `refs/heads/${state.branch}`],
        [state.checkpointHead, `refs/tags/${state.checkpoint}^{}`],
        [state.acceptedHead, `refs/tags/${acceptedTag}^{}`],
      ].filter(([sha]) => sha).map(([sha, ref]) => `${sha}\t${ref}`).join('\n');
    }
    // Actual repository objects/ref validation, including real e565 -> 682 ancestry.
    if (argv[0] === 'check-ref-format' || argv[0] === '--no-replace-objects') return realGit(argv);
    throw new Error(`Unexpected Git operation: ${argv.join(' ')}`);
  };
  return { state, calls, git };
}
function runCase({ args = {}, omitted = [], git = {}, guard, accounts = [account], loggedIn = true,
  projects = [{ 'Project Name': 'hippo-erp-realtime-preview' }], duringWhoami } = {}) {
  const candidateEvidence = gitEvidence(git);
  const guardEvidence = guard ? gitEvidence(guard) : candidateEvidence;
  const argMap = new Map(Object.entries({ ...baseArgs, ...args }));
  for (const key of omitted) argMap.delete(key);
  const calls = [];
  const result = verifyDeploymentIdentity({ identity, args: argMap,
    candidateGit: candidateEvidence.git, guardGit: guardEvidence.git,
    wrangler: (argv, accountId) => {
      assert.equal(accountId, account, 'Cloudflare reads must pin the ERP Account ID');
      calls.push(argv);
      if (argv[0] === 'whoami') {
        duringWhoami?.(candidateEvidence.state);
        return { loggedIn, accounts: accounts.map(id => ({ id })) };
      }
      assert.deepEqual(argv, ['pages', 'project', 'list', '--profile', 'hippo-erp', '--json']);
      return projects;
    },
  });
  return { result, calls, candidateEvidence, guardEvidence };
}

let passed = 0;
const positive = runCase();
assert.equal(positive.result.sourceHead, candidate);
assert.equal(positive.result.remoteAcceptedPeeledHead, accepted);
assert.equal(positive.result.acceptedAncestry, 'PASS');
assert.equal(positive.calls.length, 2);
assert(positive.candidateEvidence.calls.some(argv => argv[0] === '--no-replace-objects'));
console.log('PASS real Git ancestry: e565d067 -> 68269ad9 (GitHub/Cloudflare responses isolated here; CLI verifies live)');
passed += 1;

const negatives = [
  ['wrong account', { accounts: ['wrong'] }, /active Wrangler account/],
  ['wrong project', { args: { project: 'daigou-erp-mvp-backup' } }, /project does not match/],
  ['wrong Supabase', { args: { 'supabase-project': 'twzpqyesbtnfxdkorluf' } }, /supabase-project does not match/],
  ['wrong fingerprint', { args: { fingerprint: 'incorrect' } }, /fingerprint does not match/],
  ['dirty worktree', { git: { dirty: ' M src/App.tsx' } }, /worktree is not clean/],
  ['untracked file', { git: { dirty: '?? unexpected.txt' } }, /worktree is not clean/],
  ['remote branch mismatch', { git: { remoteHead: accepted } }, /remote branch HEAD/],
  ['missing remote branch', { git: { remoteHead: null } }, /remote branch HEAD/],
  ['missing checkpoint argument', { omitted: ['checkpoint-tag'] }, /missing --checkpoint-tag/],
  ['missing remote checkpoint', { git: { checkpointHead: null } }, /remote checkpoint peeled HEAD/],
  ['wrong checkpoint SHA', { git: { checkpointHead: accepted } }, /remote checkpoint peeled HEAD/],
  ['missing remote accepted tag', { git: { acceptedHead: null } }, /remote accepted tag/],
  ['wrong remote accepted SHA', { git: { acceptedHead: candidate } }, /remote accepted tag/],
  ['non descendant (real Git reverse ancestry)', {
    args: { 'source-head': '3089fbcec9e44323522c758059689bb7641d20eb' },
    git: { head: '3089fbcec9e44323522c758059689bb7641d20eb', remoteHead: '3089fbcec9e44323522c758059689bb7641d20eb', checkpointHead: '3089fbcec9e44323522c758059689bb7641d20eb' },
  }, /not a proven descendant/],
  ['NEXT runtime', { args: { 'runtime-marker': 'NEXT' } }, /runtime-marker/],
  ['Experimental runtime', { args: { 'runtime-marker': 'EXPERIMENTAL' } }, /runtime-marker/],
  ['NEXT role', { args: { role: 'next' } }, /locked/],
  ['Experimental role', { args: { role: 'experimental' } }, /locked/],
  ['ERP1 role', { args: { role: 'erp1' } }, /locked/],
  ['Catalog role', { args: { role: 'catalog' } }, /locked/],
  ['Catalog account', { accounts: [catalogAccount] }, /active Wrangler account/],
  ['wrong profile', { args: { profile: 'hippo-catalog' } }, /profile does not match/],
  ['branch pattern', { args: { 'remote-branch': 'codex/unrelated' } }, /branch outside/],
  ['local candidate mismatch', { args: { 'source-head': accepted } }, /local HEAD/],
  ['wrong checked-out branch', { git: { branch: 'codex/erp2-other' } }, /checked-out branch/],
  ['wrong repository', { git: { remoteUrl: 'https://github.com/other/repo.git' } }, /approved GitHub repository/],
  ['logged out', { loggedIn: false }, /active Wrangler account/],
  ['project not visible', { projects: [] }, /not visible/],
  ['local TOCTOU', { duringWhoami: state => { state.head = accepted; } }, /source changed/],
];
for (const [name, input, expected] of negatives) {
  assert.throws(() => runCase(input), error => {
    assert.match(error.message, /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
    assert.match(error.message, expected);
    return true;
  }, name);
  passed += 1;
  console.log(`PASS fail-closed: ${name}`);
}

const guardProof = {
  head: accepted, remoteHead: accepted, checkpointHead: accepted,
  branch: 'codex/erp2-guard-fixture', checkpoint: 'checkpoint-guard-fixture',
};
const split = runCase({ guard: guardProof, args: { 'guard-checkpoint-tag': guardProof.checkpoint } }).result;
assert.equal(split.sourceHead, candidate);
assert.equal(split.guardSourceHead, accepted);
assert.notEqual(split.sourceHead, split.guardSourceHead, 'Never substitute guard SHA for runtime SHA');
assert.throws(() => runCase({ guard: guardProof }), /guard source requires an explicit checkpoint/u);
assert.throws(() => runCase({ guard: { ...guardProof, checkpointHead: null }, args: { 'guard-checkpoint-tag': guardProof.checkpoint } }), /guard source remote checkpoint/u);
assert.throws(() => runCase({ guard: { ...guardProof, dirty: ' M scripts/guard.mjs' }, args: { 'guard-checkpoint-tag': guardProof.checkpoint } }), /guard source worktree/u);
passed += 4;
assert.throws(() => parseArguments(['--checkpoint-tag', checkpoint, '--checkpoint-tag', checkpoint]), /duplicate argument/u);
assert.throws(() => parseArguments(['--fixture', 'bypass']), /unknown argument/u);
assert.throws(() => parseArguments(['--checkpoint-tag']), /missing value/u);
assert.equal(parseArguments(['--candidate-worktree', 'C:/candidate with spaces']).get('candidate-worktree'), 'C:/candidate with spaces');
passed += 4;
console.log(JSON.stringify({ result: 'PASS', cases: passed, accepted, candidate, liveMutation: 0 }));
