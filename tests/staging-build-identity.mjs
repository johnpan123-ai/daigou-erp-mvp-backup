import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [buildSource, guardSource, deploySource, systemSource, pkgSource, wranglerSource] = await Promise.all([
  readFile(new URL('../scripts/staging-release-build.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/verify-erp2-promotion.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/deploy-erp2-pages.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/layout/SystemInformation.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
]);
const pkg = JSON.parse(pkgSource);
const wrangler = JSON.parse(wranglerSource);

assert.equal(pkg.scripts['build:staging'], 'node scripts/staging-release-build.mjs');
assert.equal(pkg.scripts['verify:erp2-promotion'], 'node scripts/verify-erp2-promotion.mjs');
assert.equal(pkg.scripts['deploy:erp2'], 'node scripts/deploy-erp2-pages.mjs');
assert.equal(pkg.devDependencies.wrangler, '4.141.0');
assert.equal(wrangler.name, 'hippo-erp-realtime-preview');
assert.equal(wrangler.pages_build_output_dir, './staging-release-artifacts/dist');

for (const name of [
  'VITE_ERP_BUILD_SHA', 'VITE_ERP_BUILD_BRANCH', 'VITE_ERP_CHECKPOINT_TAG',
  'VITE_ERP_ACCEPTED_TAG', 'VITE_ERP_BUILD_TIME', 'VITE_ERP_ENVIRONMENT_ROLE',
]) {
  assert.match(buildSource, new RegExp(name, 'u'), `${name} missing from build injection`);
  assert.match(systemSource, new RegExp(name, 'u'), `${name} missing from System Information`);
}
assert.match(buildSource, /verifyLocalCandidate/u);
assert.match(buildSource, /verifyArtifactIdentity/u);
assert.doesNotMatch(buildSource, /--source-head|VITE_ERP_BUILD_SHA\?\?/u, 'build SHA must not be free-form input');
assert.match(guardSource, /verifyArtifactIdentity/u);
assert.match(guardSource, /resolve\(fileURLToPath\(new URL\('\.\.', import\.meta\.url\)\)\)/u,
  'guard and candidate roots must use the same normalized path on Windows');
assert.match(deploySource, /runPromotionGuard/u);
assert.match(deploySource, /--profile[\s\S]*proof\.cloudflare\.profile/u);
assert.match(deploySource, /--commit-hash/u);
assert.match(deploySource, /--execute/u);

const noCheckpoint = spawnSync(process.execPath, ['scripts/staging-release-build.mjs'], {
  cwd: new URL('../', import.meta.url), encoding: 'utf8',
});
assert.notEqual(noCheckpoint.status, 0);
assert.match(`${noCheckpoint.stdout}${noCheckpoint.stderr}`, /use exactly --checkpoint-tag/u);

console.log('PASS build identity is derived from Git and injected into the artifact/UI');
console.log('PASS canonical deploy wrapper is guard-bound and defaults to no upload');
