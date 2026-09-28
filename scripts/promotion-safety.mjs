import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export const CANONICAL_ERP2_TARGET = Object.freeze({
  role: 'ERP_2_CLOUD_CANDIDATE',
  accountId: 'e0a58431cd5bcf0e01ec3438d531461a',
  project: 'hippo-erp-realtime-preview',
  domain: 'hippo-erp-realtime-preview.pages.dev',
  pagesBranch: 'isolated-preview',
  deploymentEnvironment: 'staging',
  runtimeMarker: 'STAGING',
  supabaseProject: 'rhfdjsklfrgpoqsaqpkn',
  publicFingerprint: 'D9EA6B7BB6524517',
});

export class DeploymentGuardError extends Error {
  constructor(message) {
    super(`DEPLOYMENT_GUARD_FAILED_CLOSED: ${message}`);
    this.name = 'DeploymentGuardError';
  }
}

const failClosed = message => { throw new DeploymentGuardError(message); };
export const sha256 = value => createHash('sha256').update(value).digest('hex').toUpperCase();

export function assertCanonicalContract(contract) {
  const account = contract?.accounts?.erp;
  const target = contract?.environments?.erp2;
  const expected = CANONICAL_ERP2_TARGET;
  if (contract?.schemaVersion !== 2 || !target?.deploymentAllowed) failClosed('invalid promotion contract');
  if (account?.accountId !== expected.accountId || target.cloudflareAccountId !== expected.accountId
    || target.role !== expected.role || target.cloudflareProject !== expected.project
    || target.pagesDomain !== expected.domain || target.pagesBranch !== expected.pagesBranch
    || target.deploymentEnvironment !== expected.deploymentEnvironment
    || target.runtimeMarker !== expected.runtimeMarker || target.supabaseProject !== expected.supabaseProject
    || target.publicFingerprint !== expected.publicFingerprint) failClosed('canonical ERP 2 target mismatch');
  const gate = contract.githubPreDeployGate;
  if (!gate?.repository || !gate?.remote || !gate?.acceptedTag || !/^[a-f0-9]{40}$/u.test(gate.acceptedHead ?? '')
    || gate.lineage?.mode !== 'DIRECT_OR_RECONCILED_CHECKPOINT_DESCENDANT'
    || !gate.lineage.reconciliationTag || !/^[a-f0-9]{40}$/u.test(gate.lineage.reconciliationHead ?? '')) {
    failClosed('invalid accepted-lineage contract');
  }
  return { account, target, gate };
}

export function validatePublicTarget(environment, target = CANONICAL_ERP2_TARGET) {
  if (environment.VITE_DEPLOYMENT_ENV?.trim() !== target.deploymentEnvironment) {
    failClosed('deployment environment role is not ERP 2 staging');
  }
  let url;
  try { url = new URL(environment.VITE_SUPABASE_URL ?? ''); }
  catch { failClosed('Supabase URL is invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== `${target.supabaseProject}.supabase.co` || url.pathname !== '/') {
    failClosed('Supabase project ref does not match ERP 2');
  }
  const publicKey = environment.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
  const publicFingerprint = publicKey ? sha256(publicKey).slice(0, 16) : '';
  if (!publicKey || publicFingerprint !== target.publicFingerprint) failClosed('public fingerprint does not match ERP 2');
  return { supabaseProject: target.supabaseProject, publicFingerprint, supabaseOrigin: url.origin };
}

const allowedRemoteUrls = (gate) => [
  `https://github.com/${gate.repository}`,
  `https://github.com/${gate.repository}.git`,
  `git@github.com:${gate.repository}.git`,
  `ssh://git@github.com/${gate.repository}.git`,
];

const parseRemoteRefs = output => new Map(String(output).trim().split(/\r?\n/u).filter(Boolean).map(line => {
  const [head, ref] = line.split(/\s+/u);
  return [ref, head];
}));

const assertRefName = (git, kind, name) => {
  try { git(['check-ref-format', `refs/${kind}/${name}`]); }
  catch { failClosed(`invalid ${kind === 'heads' ? 'branch' : 'tag'} name`); }
};

const isAncestor = (git, ancestor, descendant) => {
  try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', ancestor, descendant]); return true; }
  catch { return false; }
};

export function verifyLocalCandidate({ contract, git, checkpointTag, label = 'candidate' }) {
  const { gate, target } = assertCanonicalContract(contract);
  if (!checkpointTag?.startsWith('checkpoint-')) failClosed(`${label} requires an explicit checkpoint tag`);
  const head = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['branch', '--show-current']).trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) failClosed(`${label} HEAD is not a full SHA`);
  if (!new RegExp(gate.allowedBranchPattern, 'u').test(branch)) failClosed(`${label} branch is outside the approved pattern`);
  if (git(['status', '--porcelain', '--untracked-files=all']).trim()) failClosed(`${label} worktree is not clean`);
  assertRefName(git, 'heads', branch);
  assertRefName(git, 'tags', checkpointTag);
  if (git(['rev-parse', `${checkpointTag}^{}`]).trim() !== head) failClosed(`${label} local checkpoint does not peel to HEAD`);
  if (git(['rev-parse', `${gate.acceptedTag}^{}`]).trim() !== gate.acceptedHead) failClosed('local accepted baseline tag mismatch');
  if (git(['rev-parse', `${gate.lineage.reconciliationTag}^{}`]).trim() !== gate.lineage.reconciliationHead) {
    failClosed('local reconciliation checkpoint mismatch');
  }
  const lineageMode = isAncestor(git, gate.acceptedHead, head)
    ? 'DIRECT_ACCEPTED_BASELINE_DESCENDANT'
    : isAncestor(git, gate.lineage.reconciliationHead, head)
      ? 'RECONCILED_CHECKPOINT_DESCENDANT'
      : failClosed(`${label} is outside the approved promotion lineage`);
  return {
    head, branch, checkpointTag, lineageMode,
    acceptedBaselineTag: gate.acceptedTag,
    acceptedBaselineHead: gate.acceptedHead,
    reconciliationTag: gate.lineage.reconciliationTag,
    reconciliationHead: gate.lineage.reconciliationHead,
    target,
  };
}

export function verifyRemoteCandidate({ contract, git, checkpointTag, label = 'candidate' }) {
  const local = verifyLocalCandidate({ contract, git, checkpointTag, label });
  const { gate } = assertCanonicalContract(contract);
  const remoteUrl = git(['remote', 'get-url', gate.remote]).trim();
  if (!allowedRemoteUrls(gate).includes(remoteUrl)) failClosed(`${label} remote is not the approved repository`);
  const output = git(['ls-remote', gate.remote,
    `refs/heads/${local.branch}`,
    `refs/tags/${checkpointTag}`, `refs/tags/${checkpointTag}^{}`,
    `refs/tags/${gate.acceptedTag}`, `refs/tags/${gate.acceptedTag}^{}`,
    `refs/tags/${gate.lineage.reconciliationTag}`, `refs/tags/${gate.lineage.reconciliationTag}^{}`,
  ]);
  const refs = parseRemoteRefs(output);
  if (refs.get(`refs/heads/${local.branch}`) !== local.head) failClosed(`${label} remote branch HEAD mismatch`);
  if (refs.get(`refs/tags/${checkpointTag}^{}`) !== local.head) failClosed(`${label} remote checkpoint mismatch or missing`);
  if (refs.get(`refs/tags/${gate.acceptedTag}^{}`) !== gate.acceptedHead) failClosed('remote accepted baseline mismatch or missing');
  if (refs.get(`refs/tags/${gate.lineage.reconciliationTag}^{}`) !== gate.lineage.reconciliationHead) {
    failClosed('remote reconciliation checkpoint mismatch or missing');
  }
  return { ...local, remoteBranchHead: local.head, remoteCheckpointPeeledHead: local.head };
}

const projectName = row => row?.name ?? row?.['Project Name'] ?? row?.project_name;
const projectDomains = row => {
  const value = row?.domains ?? row?.Domains ?? row?.['Project Domains'];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(domain => domain.trim()).filter(Boolean);
  return [];
};

export function verifyCloudflareIdentity({ contract, wrangler }) {
  const { account, target } = assertCanonicalContract(contract);
  const whoami = wrangler(['whoami', '--json'], account.accountId);
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts.map(row => row.id) : [];
  if (!whoami?.loggedIn || !accounts.includes(account.accountId)) failClosed('active Wrangler account does not include ERP 2 account');
  const projects = wrangler(['pages', 'project', 'list', '--profile', account.profile, '--json'], account.accountId);
  const project = Array.isArray(projects) ? projects.find(row => projectName(row) === target.cloudflareProject) : null;
  if (!project) failClosed('ERP 2 Pages project is not visible in the selected account/profile');
  const domains = projectDomains(project);
  if (!domains.includes(target.pagesDomain)) {
    failClosed('ERP 2 Pages domain does not match project metadata');
  }
  return { accountId: account.accountId, profile: account.profile, project: target.cloudflareProject, domain: target.pagesDomain };
}

export function verifyPromotionIdentity({ contract, checkpointTag, candidateGit, guardGit, guardCheckpointTag,
  wrangler, environment, targetValidator = validatePublicTarget }) {
  const publicTarget = targetValidator(environment);
  const candidate = verifyRemoteCandidate({ contract, git: candidateGit, checkpointTag, label: 'candidate' });
  const sameSource = guardGit === candidateGit;
  const guardSource = verifyRemoteCandidate({
    contract,
    git: guardGit,
    checkpointTag: guardCheckpointTag || (sameSource ? checkpointTag : ''),
    label: 'guard source',
  });
  const cloudflare = verifyCloudflareIdentity({ contract, wrangler });
  const candidateAfter = candidateGit(['rev-parse', 'HEAD']).trim();
  const guardAfter = guardGit(['rev-parse', 'HEAD']).trim();
  if (candidateAfter !== candidate.head || guardAfter !== guardSource.head
    || candidateGit(['status', '--porcelain', '--untracked-files=all']).trim()
    || guardGit(['status', '--porcelain', '--untracked-files=all']).trim()) failClosed('source changed during verification');
  return { result: 'PASS', candidate, guardSource, cloudflare, publicTarget };
}

export const runGitAt = cwd => args => {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
  } catch { failClosed(`read-only Git check failed: ${args[0]}`); }
};

export async function listArtifactFiles(root) {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== 'erp-build-identity.json') files.push(path);
    }
  };
  await visit(root);
  return Promise.all(files.sort().map(async path => ({
    file: relative(root, path).replaceAll('\\', '/'),
    bytes: (await stat(path)).size,
    sha256: sha256(await readFile(path)),
  })));
}

export function buildManifestIdentity(manifestWithoutIdentity) {
  return sha256(JSON.stringify(manifestWithoutIdentity));
}

export async function verifyArtifactIdentity({ artifactRoot, proof, contract }) {
  const { target } = assertCanonicalContract(contract);
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(artifactRoot, 'erp-build-identity.json'), 'utf8')); }
  catch { failClosed('build identity manifest missing or invalid'); }
  const { identity, ...evidence } = manifest;
  if (manifest.schemaVersion !== 2 || identity !== buildManifestIdentity(evidence)) failClosed('artifact manifest identity mismatch');
  const source = manifest.source ?? {};
  if (source.head !== proof.candidate.head || source.branch !== proof.candidate.branch
    || source.checkpointTag !== proof.candidate.checkpointTag
    || source.acceptedBaselineTag !== proof.candidate.acceptedBaselineTag
    || source.acceptedBaselineHead !== proof.candidate.acceptedBaselineHead
    || source.lineageMode !== proof.candidate.lineageMode) failClosed('artifact source identity does not match verified candidate');
  if (manifest.target?.role !== target.role || manifest.target?.accountId !== target.cloudflareAccountId
    || manifest.target?.project !== target.cloudflareProject || manifest.target?.supabaseProject !== target.supabaseProject
    || manifest.target?.publicFingerprint !== target.publicFingerprint
    || manifest.target?.runtimeMarker !== target.runtimeMarker) failClosed('artifact target identity mismatch');
  if (!manifest.build?.timestamp || Number.isNaN(Date.parse(manifest.build.timestamp))) failClosed('artifact build timestamp missing');
  const files = await listArtifactFiles(artifactRoot);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) failClosed('artifact file hash inventory mismatch');
  return { result: 'PASS', identity, files: files.length, source, target: manifest.target, build: manifest.build };
}
