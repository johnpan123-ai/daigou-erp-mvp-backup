import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const failClosed = message => {
  throw new Error(`DEPLOYMENT_GUARD_FAILED_CLOSED: ${message}`);
};
const argumentNames = new Set([
  'role', 'profile', 'project', 'supabase-project', 'runtime-marker', 'fingerprint',
  'source-head', 'remote-branch', 'checkpoint-tag', 'candidate-worktree', 'guard-checkpoint-tag',
]);
export function parseArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith('--') || !argumentNames.has(key.slice(2))) failClosed(`unknown argument ${key}`);
    if (args.has(key.slice(2))) failClosed(`duplicate argument ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) failClosed(`missing value for ${key}`);
    args.set(key.slice(2), value);
  }
  return args;
}

// Dependencies are injected only by imported tests. The CLI always uses real Git/Cloudflare reads.
export function verifyDeploymentIdentity({ identity, args, candidateGit, guardGit, wrangler }) {
  const required = name => args.get(name) || failClosed(`missing --${name}`);
  const roleName = required('role');
  const environment = identity.environments[roleName];
  if (!environment?.deploymentAllowed) failClosed(`${roleName} is locked and has no deployment target`);
  const account = identity.accounts.erp;
  if (roleName !== 'erp2' || environment.role !== 'ERP_2_PRODUCTION'
    || environment.humanName !== '小河馬訂購紀錄表 2.0'
    || environment.cloudflareAccountId !== account.accountId) failClosed('ERP 2.0 role/account identity mismatch');
  const expected = {
    profile: account.profile,
    project: environment.cloudflareProject,
    'supabase-project': environment.supabaseProject,
    'runtime-marker': environment.runtimeMarker,
    fingerprint: environment.publicFingerprint,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (!value || required(name) !== value) failClosed(`${name} does not match approved ERP 2.0 identity`);
  }
  const gate = identity.githubPreDeployGate;
  const sourceHead = required('source-head');
  const remoteBranch = required('remote-branch');
  const checkpointTag = required('checkpoint-tag');
  if (!/^[a-f0-9]{40}$/u.test(sourceHead)) failClosed('candidate must be a full commit SHA');

  const verifyGit = (git, branch, checkpoint, expectedHead, label) => {
    if (!new RegExp(gate.allowedBranchPattern, 'u').test(branch)) failClosed(`${label} branch outside approved ERP2 pattern`);
    if (!checkpoint?.startsWith('checkpoint-')) failClosed(`${label} requires an explicit checkpoint-* tag`);
    git(['check-ref-format', `refs/heads/${branch}`]);
    git(['check-ref-format', `refs/tags/${checkpoint}`]);
    const localHead = git(['rev-parse', 'HEAD']).trim();
    if (localHead !== expectedHead) failClosed(`${label} local HEAD does not equal candidate HEAD`);
    if (git(['status', '--porcelain', '--untracked-files=all']).trim()) failClosed(`${label} worktree is not clean`);
    if (git(['branch', '--show-current']).trim() !== branch) failClosed(`${label} checked-out branch does not match remote branch`);
    const remoteUrl = git(['remote', 'get-url', gate.remote]).trim();
    const allowedUrls = [`https://github.com/${gate.repository}`, `https://github.com/${gate.repository}.git`,
      `git@github.com:${gate.repository}.git`, `ssh://git@github.com/${gate.repository}.git`];
    if (!allowedUrls.includes(remoteUrl)) failClosed(`${label} remote is not the approved GitHub repository`);
    const refs = new Map(git(['ls-remote', gate.remote, `refs/heads/${branch}`,
      `refs/tags/${checkpoint}`, `refs/tags/${checkpoint}^{}`,
      `refs/tags/${gate.acceptedTag}`, `refs/tags/${gate.acceptedTag}^{}`])
      .trim().split(/\r?\n/u).filter(Boolean).map(line => {
        const [sha, ref] = line.split(/\s+/u);
        return [ref, sha];
      }));
    if (refs.get(`refs/heads/${branch}`) !== localHead) failClosed(`${label} remote branch HEAD does not equal local HEAD`);
    if (refs.get(`refs/tags/${checkpoint}^{}`) !== localHead) failClosed(`${label} remote checkpoint peeled HEAD does not equal local HEAD`);
    if (refs.get(`refs/tags/${gate.acceptedTag}^{}`) !== gate.acceptedHead) failClosed('remote accepted tag peeled HEAD does not equal approved baseline');
    // Check the remote-proven SHA, not a possibly stale/moved local accepted tag.
    try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', gate.acceptedHead, localHead]); }
    catch { failClosed(`${label} candidate is not a proven descendant of the accepted baseline`); }
    return { localHead, remoteBranch: branch, checkpointTag: checkpoint,
      remoteBranchHead: refs.get(`refs/heads/${branch}`), remoteCheckpointPeeledHead: refs.get(`refs/tags/${checkpoint}^{}`) };
  };

  const candidate = verifyGit(candidateGit, remoteBranch, checkpointTag, sourceHead, 'runtime');
  const guardSourceHead = guardGit(['rev-parse', 'HEAD']).trim();
  const guardBranch = guardGit(['branch', '--show-current']).trim();
  const guardCheckpoint = args.get('guard-checkpoint-tag')
    || (guardSourceHead === sourceHead && guardBranch === remoteBranch ? checkpointTag : undefined);
  const guardSource = verifyGit(guardGit, guardBranch, guardCheckpoint, guardSourceHead, 'guard source');

  const whoami = wrangler(['whoami', '--json'], account.accountId);
  const accountIds = Array.isArray(whoami.accounts) ? whoami.accounts.map(item => item.id) : [];
  if (!whoami.loggedIn || !accountIds.includes(account.accountId)) failClosed(`active Wrangler account does not include ${account.accountId}`);
  const pages = wrangler(['pages', 'project', 'list', '--profile', account.profile, '--json'], account.accountId);
  if (!Array.isArray(pages) || !pages.some(item => item['Project Name'] === environment.cloudflareProject)) {
    failClosed('Pages project is not visible in the explicitly selected ERP account/profile');
  }
  // Detect local branch/worktree changes while remote/Cloudflare reads were in flight.
  for (const [git, proof] of [[candidateGit, candidate], [guardGit, guardSource]]) {
    if (git(['rev-parse', 'HEAD']).trim() !== proof.localHead
      || git(['branch', '--show-current']).trim() !== proof.remoteBranch
      || git(['status', '--porcelain', '--untracked-files=all']).trim()) failClosed('source changed during verification');
  }
  return {
    result: 'PASS', role: roleName, humanName: environment.humanName,
    accountId: account.accountId, profile: account.profile, project: environment.cloudflareProject,
    domain: environment.domain, runtimeMarker: environment.runtimeMarker,
    supabaseProject: environment.supabaseProject, fingerprint: environment.publicFingerprint,
    sourceHead, ...candidate, guardSourceHead, guardSource,
    acceptedTag: gate.acceptedTag, remoteAcceptedPeeledHead: gate.acceptedHead, acceptedAncestry: 'PASS',
    note: 'Read-only identity gate, not an upload. Artifact provenance and live baseline gates remain required. Guard source HEAD is not runtime source metadata.',
  };
}

const run = (command, args, options = {}) => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...options }); }
  catch { failClosed(`${command} read-only check failed (output suppressed to protect credentials)`); }
};
const parseJson = text => {
  const clean = stripVTControlCharacters(text).trim();
  const start = clean.search(/\{|\[/u);
  try { if (start >= 0) return JSON.parse(clean.slice(start)); } catch { /* Fail closed below. */ }
  failClosed('Wrangler did not return valid JSON');
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  const guardRoot = fileURLToPath(new URL('..', import.meta.url));
  const candidateRoot = resolve(args.get('candidate-worktree') || process.cwd());
  const identity = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
  const gitAt = cwd => argv => run('git', argv, { cwd, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = verifyDeploymentIdentity({ identity, args,
    candidateGit: gitAt(candidateRoot), guardGit: gitAt(guardRoot),
    wrangler: (argv, accountId) => {
      // Only fixed CLI verbs and the validated profile reach the Windows shell.
      if (argv.some(value => !/^[a-zA-Z0-9-]+$/u.test(value))) failClosed('unsafe Wrangler argument');
      return parseJson(run(npx, ['--yes', 'wrangler@4.141.0', ...argv], {
        cwd: candidateRoot, shell: process.platform === 'win32',
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      }));
    },
  });
  console.log(JSON.stringify({ ...result, candidateWorktree: candidateRoot, guardWorktree: guardRoot }, null, 2));
}
