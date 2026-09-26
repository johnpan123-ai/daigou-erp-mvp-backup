import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const identity = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const argValues = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) throw new Error(`UNEXPECTED_ARGUMENT: ${key}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT_VALUE: ${key}`);
  argValues.set(key.slice(2), value);
  index += 1;
}

const failClosed = message => {
  throw new Error(`DEPLOYMENT_GUARD_FAILED_CLOSED: ${message}`);
};
const required = name => {
  const value = argValues.get(name);
  if (!value) failClosed(`missing --${name}`);
  return value;
};
const stripAnsi = text => text.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
const parseJson = (text, label) => {
  const clean = stripAnsi(text).trim();
  const start = Math.min(...['{', '['].map(token => {
    const position = clean.indexOf(token);
    return position < 0 ? Number.POSITIVE_INFINITY : position;
  }));
  if (!Number.isFinite(start)) failClosed(`${label} did not return JSON`);
  try {
    return JSON.parse(clean.slice(start));
  } catch {
    failClosed(`${label} returned invalid JSON`);
  }
};
const run = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().replaceAll(/\s+/gu, ' ').slice(-500);
    failClosed(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
};
const git = args => run('git', args);

const roleName = required('role');
const environment = identity.environments[roleName];
if (!environment) failClosed(`unknown role ${roleName}`);
if (!environment.deploymentAllowed) failClosed(`${roleName} is locked and has no deployment target`);

const profile = required('profile');
const expectedAccount = identity.accounts.erp;
if (profile !== expectedAccount.profile) failClosed(`profile ${profile} is not ${expectedAccount.profile}`);
const project = required('project');
if (project !== environment.cloudflareProject) failClosed(`project ${project} does not match ${environment.cloudflareProject}`);
const supabaseProject = required('supabase-project');
if (supabaseProject !== environment.supabaseProject) failClosed(`Supabase target ${supabaseProject} does not match ${environment.supabaseProject}`);
const runtimeMarker = required('runtime-marker');
if (runtimeMarker !== environment.runtimeMarker) failClosed(`runtime marker ${runtimeMarker} does not match ${environment.runtimeMarker}`);
const fingerprint = required('fingerprint');
if (!environment.publicFingerprint || fingerprint !== environment.publicFingerprint) {
  failClosed(`fingerprint ${fingerprint} does not match the approved environment fingerprint`);
}

const sourceHead = required('source-head');
const remoteBranch = required('remote-branch');
const checkpointTag = required('checkpoint-tag');
const gate = identity.githubPreDeployGate;
if (remoteBranch !== gate.branch) failClosed(`remote branch ${remoteBranch} does not match the approved gate branch`);
if (!checkpointTag.startsWith('checkpoint-')) failClosed('checkpoint tag must use the checkpoint-* naming contract');

const localHead = git(['rev-parse', 'HEAD']).trim();
if (localHead !== sourceHead) failClosed(`local HEAD ${localHead} does not equal candidate ${sourceHead}`);
if (git(['status', '--porcelain']).trim()) failClosed('worktree is not clean');
if (git(['branch', '--show-current']).trim() !== remoteBranch) failClosed('current branch does not match the approved remote branch');

const refs = new Map(git(['ls-remote', gate.remote]).trim().split(/\r?\n/gu).filter(Boolean).map(line => {
  const [sha, ref] = line.split(/\s+/u);
  return [ref, sha];
}));
if (refs.get(`refs/heads/${remoteBranch}`) !== localHead) failClosed('remote branch HEAD does not equal local HEAD');
if (refs.get(`refs/tags/${checkpointTag}^{}`) !== localHead) failClosed('remote checkpoint peeled HEAD does not equal local HEAD');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const whoami = parseJson(run(npx, ['wrangler', 'whoami', '--json'], { shell: process.platform === 'win32' }), 'wrangler whoami');
const accountIds = Array.isArray(whoami.accounts) ? whoami.accounts.map(account => account.id) : [];
if (!whoami.loggedIn || !accountIds.includes(expectedAccount.accountId)) {
  failClosed(`active Wrangler account does not include ${expectedAccount.accountId}`);
}
const pages = parseJson(run(npx, ['wrangler', 'pages', 'project', 'list', '--profile', profile, '--json'], { shell: process.platform === 'win32' }), 'Pages project list');
const visibleProjects = Array.isArray(pages) ? pages.map(item => item['Project Name']) : [];
if (!visibleProjects.includes(project)) failClosed(`project ${project} is not visible under profile ${profile}`);

console.log(JSON.stringify({
  result: 'PASS',
  role: roleName,
  humanName: environment.humanName,
  accountId: expectedAccount.accountId,
  profile,
  project,
  domain: environment.domain,
  runtimeMarker,
  supabaseProject,
  fingerprint,
  sourceHead,
  remoteBranch,
  checkpointTag,
  localHead,
  remoteBranchHead: refs.get(`refs/heads/${remoteBranch}`),
  remoteCheckpointPeeledHead: refs.get(`refs/tags/${checkpointTag}^{}`),
  note: 'whoami validates the active Wrangler session; Wrangler 4.141.0 does not accept --profile for whoami.'
}, null, 2));
