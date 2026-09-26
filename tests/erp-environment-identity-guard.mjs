import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const identity = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
const guard = await readFile(new URL('../scripts/verify-erp-deployment-identity.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

assert.equal(identity.renameDecision.mode, 'KEEP_PHYSICAL_SLUG_FIX_CANONICAL_LABELS');
assert.equal(identity.accounts.erp.profile, 'hippo-erp');
assert.equal(identity.accounts.erp.accountId, 'e0a58431cd5bcf0e01ec3438d531461a');
assert.equal(identity.accounts.catalog.profile, 'hippo-catalog');
assert.equal(identity.accounts.catalog.accountId, 'f543371d2e71d3f9d81dc5863b1f16c9');
assert.equal(identity.environments.erp1.humanName, '小河馬訂購紀錄表 1.0');
assert.equal(identity.environments.erp1.deploymentAllowed, false);
assert.equal(identity.environments.erp2.humanName, '小河馬訂購紀錄表 2.0');
assert.equal(identity.environments.erp2.cloudflareProject, 'hippo-erp-realtime-preview');
assert.equal(identity.environments.erp2.supabaseProject, 'rhfdjsklfrgpoqsaqpkn');
assert.equal(identity.environments.erp2.publicFingerprint, 'D9EA6B7BB6524517');
assert.equal(identity.environments.next.cloudflareProject, null);
assert.equal(identity.environments.experimental.cloudflareProject, null);
assert.equal(identity.githubPreDeployGate.acceptedHead, '3089fbcec9e44323522c758059689bb7641d20eb');
assert.match(guard, /DEPLOYMENT_GUARD_FAILED_CLOSED/u);
assert.match(guard, /wrangler.*whoami/u);
assert.match(guard, /git.*ls-remote/u);
assert.match(guard, /remote checkpoint peeled HEAD/u);
assert.doesNotMatch(guard, /not the accepted GitHub gate HEAD/u);
assert.equal(packageJson.scripts['verify:erp-deployment-identity'], 'node scripts/verify-erp-deployment-identity.mjs');
console.log('ERP environment identity map and pre-deploy guard contract: PASS');
