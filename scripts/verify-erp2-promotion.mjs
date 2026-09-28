import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import {
  DeploymentGuardError,
  runGitAt,
  verifyArtifactIdentity,
  verifyPromotionIdentity,
} from './promotion-safety.mjs';

const fail = message => { throw new DeploymentGuardError(message); };
const allowedArguments = new Set(['checkpoint-tag', 'candidate-worktree', 'guard-checkpoint-tag', 'artifact-dir']);

export function parseArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || !allowedArguments.has(key.slice(2))) fail(`unknown argument ${String(key)}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${key}`);
    if (args.has(key.slice(2))) fail(`duplicate argument ${key}`);
    args.set(key.slice(2), value);
  }
  return args;
}

const parseJson = output => {
  const clean = stripVTControlCharacters(String(output)).trim();
  const start = clean.search(/[\[{]/u);
  try { if (start >= 0) return JSON.parse(clean.slice(start)); }
  catch { /* Fail closed below. */ }
  fail('Wrangler did not return valid JSON');
};

const runWrangler = (root, argv, accountId) => {
  if (argv.some(value => !/^[a-zA-Z0-9-]+$/u.test(value))) fail('unsafe Wrangler argument');
  const executable = process.platform === 'win32'
    ? resolve(root, 'node_modules/.bin/wrangler.cmd')
    : resolve(root, 'node_modules/.bin/wrangler');
  try {
    return parseJson(execFileSync(executable, argv, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    }));
  } catch (error) {
    if (error instanceof DeploymentGuardError) throw error;
    fail('Wrangler read-only identity check failed');
  }
};

export async function runPromotionGuard(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArguments(argv);
  const guardRoot = fileURLToPath(new URL('..', import.meta.url));
  const candidateRoot = resolve(args.get('candidate-worktree') || guardRoot);
  const artifactRoot = resolve(candidateRoot, args.get('artifact-dir') || 'staging-release-artifacts/dist');
  const checkpointTag = args.get('checkpoint-tag') || fail('missing --checkpoint-tag');
  const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
  const candidateGit = runGitAt(candidateRoot);
  const guardGit = candidateRoot === guardRoot ? candidateGit : runGitAt(guardRoot);
  const proof = verifyPromotionIdentity({
    contract,
    checkpointTag,
    candidateGit,
    guardGit,
    guardCheckpointTag: args.get('guard-checkpoint-tag'),
    environment,
    wrangler: (wranglerArgs, accountId) => runWrangler(candidateRoot, wranglerArgs, accountId),
  });
  const artifact = await verifyArtifactIdentity({ artifactRoot, proof, contract });
  return { ...proof, artifact, candidateWorktree: candidateRoot, artifactRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runPromotionGuard();
  console.log(JSON.stringify(result, null, 2));
}
