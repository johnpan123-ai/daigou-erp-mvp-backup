import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalSql } from '../tools/schema-reconciliation/sqlCanonical.mjs';
import { diffStructuralSnapshots, fingerprintStructuralSnapshot, fingerprintStructuralSnapshotV2,
  sqlOptionsForPath } from '../tools/schema-reconciliation/schemaContract.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';

let positive = 0; let negative = 0;
const same = (a, b, options) => { assert.equal(canonicalSql(a, options), canonicalSql(b, options)); positive += 1; };
const different = (a, b, options) => { assert.notEqual(canonicalSql(a, options), canonicalSql(b, options)); negative += 1; };
const fn = body => `CREATE FUNCTION public.generic_fixture(p_version bigint DEFAULT 0)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $outer$
 DECLARE command text; BEGIN ${body} END $outer$;`;
same(fn("-- caller's transaction\n RETURN '{\"Upper\":1}'::jsonb;"),
  fn("/* caller's /* nested */ transaction */\r\n RETURN '{\"Upper\":1}' :: jsonb ;").replaceAll('$outer$', '$other$'));
same('SELECT CAST(1 AS bigint)', 'select (1::bigint)');
same('SELECT ((1))', 'select 1');
same("SELECT 1+/* caller's comment */2", 'select 1 + 2');
same("SELECT 'a''b'", "select $value$a'b$value$");
same(fn('command := format(\'SELECT %s FROM %I WHERE id = $1\',p_version,\'items\'); EXECUTE command;'),
  fn('command := format(\'select  %s\n from %I where id=$1\',p_version,\'items\'); EXECUTE command;'));
const template = fn("command := format('SELECT %s FROM %I WHERE x = 1',p_version,'items'); EXECUTE command;");
different(template, template.replace('x = 1', 'x = 2'));
different(template, template.replace('%s', '%I'));
different(template, template.replace('EXECUTE command;', 'RAISE NOTICE \'%\',command; EXECUTE command;'));
different(fn("RETURN 'A  B';"), fn("RETURN 'A B';"));
different(fn("RETURN 'A';"), fn("RETURN 'a';"));
different('SELECT "Case" FROM items', 'SELECT "case" FROM items');
different('SELECT digest(x)', 'SELECT extensions.digest(x)');
same('SELECT digest(x)', 'SELECT extensions.digest(x)', {
  resolvedFunctionAliases: { digest: 'extension:pgcrypto:digest', 'extensions.digest': 'extension:pgcrypto:digest' },
});
const catalog = { functions: { fixture: { config: ['search_path=public,extensions'] } },
  sqlResolution: { resolvedFunctionAliases: { 'extensions.digest': 'extension:pgcrypto:digest' },
    digestCandidates: { 'public.digest': ['APPLICATION_FUNCTION'], 'extensions.digest': ['pgcrypto'] } } };
assert.equal(sqlOptionsForPath(catalog, ['functions','fixture','definition']).resolvedFunctionAliases.digest, undefined);
delete catalog.sqlResolution.digestCandidates['public.digest'];
assert.equal(sqlOptionsForPath(catalog, ['functions','fixture','definition']).resolvedFunctionAliases.digest, 'extension:pgcrypto:digest');
for (const [a, b] of [
  ['WHERE version = p_version','WHERE version <> p_version'],
  ['FROM items','FROM orders'], ['SELECT sku','SELECT name'],
  ['PERFORM validate(x)','PERFORM bypass(x)'], ['UPDATE items','UPDATE orders'],
  ['INSERT INTO items','INSERT INTO orders'], ['RETURN x','RETURN null'],
  ['FOR UPDATE','FOR SHARE'], ['SECURITY DEFINER','SECURITY INVOKER'],
  ['search_path=public','search_path=public,untrusted'], ['RETURNS jsonb','RETURNS text'],
]) different(fn(a), fn(b));
for (const malformed of ["SELECT 'bad", 'SELECT $$bad', 'SELECT /* bad']) {
  assert.throws(() => canonicalSql(malformed), /SQL_CANONICAL_UNTERMINATED/u); negative += 1;
}

// Real catalog golden pair: optional external raw evidence is never copied to
// Git. CI still covers the exact comment bug and semantic negative matrix.
const liveIndex = process.argv.indexOf('--live');
const sourceIndex = process.argv.indexOf('--source');
if (liveIndex >= 0 && sourceIndex >= 0) {
  const live = JSON.parse(await readFile(process.argv[liveIndex + 1], 'utf8'));
  const source = JSON.parse(await readFile(process.argv[sourceIndex + 1], 'utf8'));
  const comparison = diffStructuralSnapshots(source, live);
  assert.equal(comparison.semanticEqual, true, JSON.stringify(comparison.semanticDifferences));
  assert.equal(fingerprintStructuralSnapshot(source), fingerprintStructuralSnapshot(live));
  assert.equal(fingerprintStructuralSnapshotV2(source), '7c1af9ee6baf3be09c2640deece4ed4b397c5fbe5281f05c7e45958338e86521');
  assert.equal(fingerprintStructuralSnapshotV2(live), '5962a7a5c54668408802e8061b8f393bd6d6ca0295adeee81cf5a993e8769640');
  const registry = await buildMigrationEffectRegistry();
  const baseline = planSchemaDelta(source, registry, { expectedSnapshot: source });
  assert.equal(baseline.readyForApply, true);
  const signature = 'public.erp_commit_waca_snapshot(jsonb,bigint,boolean)';
  for (const mutate of [
    s => { s.functions[signature].definition += '\n SELECT malicious_function();'; },
    s => { s.functions[signature].authenticatedExecute = false; },
    s => { s.functions[signature].strict = !s.functions[signature].strict; },
    s => { s.functions[signature].config.push('search_path=untrusted'); },
    s => { s.functions[signature].arguments += ',extra text'; },
    s => { s.tables['public.product_variants'].rls = false; },
    s => { s.functions['public.unknown_durable_rpc()'] = { definition: 'select 1', authenticatedExecute: true }; },
  ]) {
    const drift = structuredClone(source); mutate(drift);
    assert.notEqual(fingerprintStructuralSnapshot(drift), fingerprintStructuralSnapshot(source));
    const plan = planSchemaDelta(drift, registry, { expectedSnapshot: source });
    assert.equal(plan.readyForApply, false);
    assert.ok(plan.blockers.length); negative += 1;
  }
  positive += 1;
  console.log('PASS full real Live/source golden pair, frozen v2 history, zero-delta drift blocking');
}
console.log(JSON.stringify({ result: 'PASS', algorithm: 3, positive, negative, liveMutation: 0 }));
