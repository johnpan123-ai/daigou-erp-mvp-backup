import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../scripts/staging-release-build.mjs', import.meta.url), 'utf8');
const wrangler = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
assert.match(script, /EXPECTED_PROJECT_REF = 'rhfdjsklfrgpoqsaqpkn'/u);
assert.match(script, /EXPECTED_PUBLIC_KEY_FINGERPRINT = 'D9EA6B7BB6524517'/u);
assert.match(script, /VITE_DEPLOYMENT_ENV must be staging/u);
assert.match(script, /unapproved public-key fingerprint/u);
assert.match(script, /staging-release-artifacts/u);
assert.doesNotMatch(script, /local-sandbox-no-network|isolated-no-network|fixture-public-key/u);
assert.equal(wrangler.name, 'hippo-erp-realtime-preview');
assert.equal('account_id' in wrangler, false, 'Pages config must not include unsupported account_id');
assert.equal(wrangler.pages_build_output_dir, './staging-release-artifacts/dist');
assert.equal(wrangler.compatibility_date, '2026-08-24');
assert.deepEqual(wrangler.compatibility_flags, [
  'enable_request_signal',
  'request_signal_passthrough',
]);

const invoke = environment => spawnSync(
  process.execPath,
  ['scripts/staging-release-build.mjs', '--verify-only'],
  {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  },
);

const placeholder = invoke({
  VITE_DEPLOYMENT_ENV: 'staging',
  VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'local-sandbox-no-network',
});
assert.notEqual(placeholder.status, 0);
assert.match(`${placeholder.stdout}${placeholder.stderr}`, /unapproved public-key fingerprint/u);

const wrongProject = invoke({
  VITE_DEPLOYMENT_ENV: 'staging',
  VITE_SUPABASE_URL: 'https://twzpqyesbtnfxdkorluf.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'not-printed',
});
assert.notEqual(wrongProject.status, 0);
assert.match(`${wrongProject.stdout}${wrongProject.stderr}`, /unexpected Supabase project target/u);

const wrongMode = invoke({
  VITE_DEPLOYMENT_ENV: 'experimental',
  VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'not-printed',
});
assert.notEqual(wrongMode.status, 0);
assert.match(`${wrongMode.stdout}${wrongMode.stderr}`, /VITE_DEPLOYMENT_ENV must be staging/u);

console.log('Staging release build target, mode, fingerprint, and isolated-output guard: PASS');
