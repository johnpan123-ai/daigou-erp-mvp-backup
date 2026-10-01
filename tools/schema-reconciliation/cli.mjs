import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildMigrationEffectRegistry } from './migrationEffectRegistry.mjs';
import { formatReconciliationReport, planSchemaDelta } from './reconcile.mjs';
import { assertSnapshotShape } from './schemaContract.mjs';

const parse = argv => {
  const allowed = new Set(['snapshot', 'inventory-integrity', 'ledger-history', 'expected', 'project-ref', 'source-head', 'checkpoint', 'baseline-id', 'mode', 'json']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/u, ''); const value = argv[index + 1];
    if (!allowed.has(key) || !value) throw new Error(`SCHEMA_RECONCILIATION_ARGUMENT_INVALID:${argv[index]}`);
    values.set(key, value);
  }
  if (!values.has('snapshot')) throw new Error('SCHEMA_RECONCILIATION_SNAPSHOT_REQUIRED');
  return values;
};

const readJson = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const unwrapCell = (value, key) => {
  const row = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return row?.[key] ?? row;
};
const args = parse(process.argv.slice(2));
const snapshot = unwrapCell(await readJson(args.get('snapshot')), 'erp_schema_snapshot');
assertSnapshotShape(snapshot);
if (args.has('inventory-integrity')) {
  const integrity = unwrapCell(await readJson(args.get('inventory-integrity')), 'inventory_items_integrity');
  snapshot.integrity = { ...(snapshot.integrity ?? {}), inventoryItems: integrity };
  snapshot.completeness = { ...snapshot.completeness, inventoryIntegrity: true };
}
if (args.has('ledger-history')) {
  const history = unwrapCell(await readJson(args.get('ledger-history')), 'erp_schema_migration_history') ?? [];
  if (!Array.isArray(history)) throw new Error('SCHEMA_RECONCILIATION_LEDGER_HISTORY_INVALID');
  snapshot.migrationHistory = {
    ...(snapshot.migrationHistory ?? {}), available: true, records: history,
    entries: Object.fromEntries(history.filter(record => record.eventType === 'MIGRATION_APPLIED' && record.result === 'PASS')
      .map(record => [record.eventKey, record])),
  };
}
if (args.has('project-ref')) snapshot.identity = { ...snapshot.identity, projectRef: args.get('project-ref') };
const expectedSnapshot = args.has('expected')
  ? unwrapCell(await readJson(args.get('expected')), 'erp_schema_snapshot') : null;
if (expectedSnapshot) assertSnapshotShape(expectedSnapshot);
const mode = args.get('mode') ?? 'PRE_ADOPTION';
if (!['PRE_ADOPTION', 'POST_ADOPTION'].includes(mode)) throw new Error('SCHEMA_RECONCILIATION_MODE_INVALID');
const registry = await buildMigrationEffectRegistry();
const snapshotToolSource = await readFile(new URL('./sql/live-schema-snapshot-readonly.sql', import.meta.url));
const snapshotToolChecksum = createHash('sha256').update(snapshotToolSource.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
const plan = planSchemaDelta(snapshot, registry, {
  expectedSnapshot, sourceHead: args.get('source-head') ?? null, checkpoint: args.get('checkpoint') ?? null,
  requiredBaselineId: args.get('baseline-id') ?? null, mode, snapshotToolChecksum,
});
console.log(formatReconciliationReport(plan));
if (args.has('json')) await writeFile(resolve(args.get('json')), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
else console.log(JSON.stringify(plan, null, 2));
process.exitCode = plan.readyForApply ? 0 : 2;
