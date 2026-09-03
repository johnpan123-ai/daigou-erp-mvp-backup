import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourcePath = new URL('../src/lib/supabaseEnvironmentBoundary.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
const boundary = await import(moduleUrl);

const productionUrl = `https://${boundary.PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
const stagingUrl = `https://${boundary.STAGING_SUPABASE_PROJECT_REF}.supabase.co`;
const accepts = input => boundary.assertSupabaseEnvironmentBoundary(input);
const rejectsWith = (input, code) => assert.throws(
  () => accepts(input),
  error => error?.code === code,
);

assert.equal(accepts({ supabaseUrl: productionUrl, viteMode: 'production' }).role, 'production');
rejectsWith({ supabaseUrl: stagingUrl, viteMode: 'production' }, 'PRODUCTION_SUPABASE_PROJECT_REF_MISMATCH');
assert.equal(accepts({ supabaseUrl: stagingUrl, viteMode: 'staging' }).role, 'staging');
rejectsWith({ supabaseUrl: productionUrl, viteMode: 'staging' }, 'NON_PRODUCTION_SUPABASE_PROJECT_BLOCKED');
assert.equal(accepts({ supabaseUrl: stagingUrl, viteMode: 'next' }).role, 'next');
rejectsWith({ supabaseUrl: productionUrl, viteMode: 'next' }, 'NON_PRODUCTION_SUPABASE_PROJECT_BLOCKED');
assert.equal(accepts({ supabaseUrl: stagingUrl, viteMode: 'experimental' }).role, 'experimental');
rejectsWith({ supabaseUrl: productionUrl, viteMode: 'experimental' }, 'NON_PRODUCTION_SUPABASE_PROJECT_BLOCKED');
assert.equal(accepts({ supabaseUrl: stagingUrl, viteMode: 'production', cloudPreviewEnabled: true }).role, 'staging');
rejectsWith({ supabaseUrl: productionUrl, viteMode: 'production', cloudPreviewEnabled: true }, 'NON_PRODUCTION_SUPABASE_PROJECT_BLOCKED');
rejectsWith({ supabaseUrl: productionUrl, viteMode: 'unknown', providerMode: 'cloud' }, 'SUPABASE_RUNTIME_ROLE_UNDECLARED');
assert.equal(accepts({ supabaseUrl: productionUrl, viteMode: 'development', providerMode: 'cloud' }).role, 'production');

const clientSource = await readFile(new URL('../src/providers/cloud/supabaseClient.ts', import.meta.url), 'utf8');
assert.ok(clientSource.indexOf('assertSupabaseEnvironmentBoundary') < clientSource.indexOf('createClient(supabaseUrl'));

console.log('PASS Production runtime accepts only Production project ref');
console.log('PASS Staging/NEXT/Experimental reject Production project ref before createClient');
console.log('PASS undeclared Cloud runtime fails closed');
