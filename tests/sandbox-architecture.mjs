import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(ROOT, 'src');
const normalized = value => value.split(path.sep).join('/');

const sourceFiles = [];
const visit = directory => {
  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name);
    if (statSync(fullPath).isDirectory()) visit(fullPath);
    else if (/\.(ts|tsx)$/.test(name)) sourceFiles.push(fullPath);
  }
};
visit(SRC);

const records = sourceFiles.map(file => ({
  file,
  relative: normalized(path.relative(ROOT, file)),
  source: readFileSync(file, 'utf8'),
}));

const createClientCallers = records.filter(({ source }) => /\bcreateClient\s*\(/.test(source));
assert.deepEqual(
  createClientCallers.map(({ relative }) => relative),
  ['src/providers/cloud/supabaseClient.ts'],
  'createClient() may only exist in supabaseClient.ts',
);

const runtimeSupabaseImports = records.filter(({ source }) => {
  const imports = source.match(/^import[^;]+from ['"]@supabase\/supabase-js['"];?/gm) ?? [];
  return imports.some(statement => !/^import\s+type\b/.test(statement));
});
assert.deepEqual(
  runtimeSupabaseImports.map(({ relative }) => relative),
  ['src/providers/cloud/supabaseClient.ts'],
  'Runtime @supabase/supabase-js imports may only exist in supabaseClient.ts',
);

const hardcodedProductionHosts = records.filter(({ source }) => /https?:\/\/[^'"\s]+\.supabase\.co/i.test(source));
assert.deepEqual(
  hardcodedProductionHosts.map(({ relative }) => relative),
  [],
  'Production Supabase hosts must come from the single environment-backed client',
);

const fetchBypassAllowlist = new Set([
  'src/lib/cloudWriteGuard.ts',
  'src/lib/testSandboxEnvironment.ts',
]);
const fetchBypassPatterns = /(?:globalThis|window)\.fetch\.bind|\b(?:native|original|raw)Fetch\b/i;
const fetchBypasses = records.filter(({ relative, source }) => (
  !fetchBypassAllowlist.has(relative) && fetchBypassPatterns.test(source)
));
assert.deepEqual(
  fetchBypasses.map(({ relative }) => relative),
  [],
  'Only approved guard modules may retain a pre-guard fetch reference',
);

const directSupabaseNetwork = records.filter(({ relative, source }) => (
  relative !== 'src/lib/testSandboxEnvironment.ts'
  && relative !== 'src/lib/cloudWriteGuard.ts'
  && relative !== 'src/providers/cloud/supabaseClient.ts'
  && /(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\s*\([^\n]*(?:supabase|VITE_SUPABASE_URL)/i.test(source)
));
assert.deepEqual(
  directSupabaseNetwork.map(({ relative }) => relative),
  [],
  'Direct Production Supabase network connections are forbidden outside the guard',
);

const sourceByPath = new Map(records.map(record => [record.relative, record.source]));
for (const switchOwner of ['src/components/layout/AppLayout.tsx', 'src/pages/Settings.tsx']) {
  assert.match(
    sourceByPath.get(switchOwner) ?? '',
    /setProviderMode\('cloud'\)\)\s*window\.location\.reload\(\)/,
    `${switchOwner} must reload after Test to Production so the in-memory guard cannot survive`,
  );
}

const storageClearCallers = records.filter(({ source }) => /\blocalStorage\.clear\s*\(/.test(source));
assert.deepEqual(storageClearCallers.map(({ relative }) => relative), [], 'App code must never clear all localStorage');

console.log('PASS createClient() has a single approved owner');
console.log('PASS runtime Supabase imports are centralized');
console.log('PASS no hardcoded Production Supabase host exists in src');
console.log('PASS no unapproved pre-guard fetch reference or direct connection exists');
console.log('PASS Production switches force reload and no global localStorage clear exists');
