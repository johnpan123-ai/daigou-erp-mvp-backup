import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_ERP2_TARGET, DeploymentGuardError } from './promotion-safety.mjs';
import { runPromotionGuard } from './verify-erp2-promotion.mjs';

const argv = process.argv.slice(2);
const executeIndex = argv.indexOf('--execute');
const execute = executeIndex >= 0;
if (execute) argv.splice(executeIndex, 1);

const proof = await runPromotionGuard(argv);
if (!execute) {
  console.log(JSON.stringify({ result: 'PASS', uploadPerformed: false, proof }, null, 2));
  process.exit(0);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const executable = process.platform === 'win32'
  ? resolve(root, 'node_modules/.bin/wrangler.cmd')
  : resolve(root, 'node_modules/.bin/wrangler');
const args = [
  'pages', 'deploy', proof.artifactRoot,
  '--profile', proof.cloudflare.profile,
  '--project-name', CANONICAL_ERP2_TARGET.project,
  '--branch', CANONICAL_ERP2_TARGET.pagesBranch,
  '--commit-hash', proof.candidate.head,
  '--commit-dirty=false',
  '--commit-message', `ERP2 guarded artifact ${proof.artifact.identity}`,
];
try {
  execFileSync(executable, args, {
    cwd: proof.candidateWorktree,
    stdio: 'inherit', timeout: 300_000,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: CANONICAL_ERP2_TARGET.accountId },
  });
} catch {
  throw new DeploymentGuardError('guard passed but Pages upload failed');
}
