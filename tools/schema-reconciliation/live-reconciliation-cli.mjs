import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { diffObservedStructuralSnapshotsV2, diffStructuralSnapshots } from './schemaContract.mjs';
import { classifyLiveSchemaDifferences } from './liveSchemaReconciliationRegistry.mjs';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`ARGUMENT_REQUIRED:${name}`);
  return args[index + 1];
};
const unwrap = parsed => Array.isArray(parsed) && parsed.length === 1 && parsed[0]?.erp_schema_snapshot
  ? parsed[0].erp_schema_snapshot : parsed;
const sourcePath = resolve(value('--source'));
const livePath = resolve(value('--live'));
const outputPath = resolve(value('--output'));
const source = unwrap(JSON.parse(await readFile(sourcePath, 'utf8')));
const live = unwrap(JSON.parse(await readFile(livePath, 'utf8')));
const observedDifferences = diffObservedStructuralSnapshotsV2(source, live);
const canonical = diffStructuralSnapshots(source, live);
const classification = classifyLiveSchemaDifferences(observedDifferences, {
  canonicalDifferencePaths: canonical.semanticDifferences.map(item => item.path),
  normalizationProofPaths: canonical.normalizationDifferences.map(item => item.path),
});
const report = {
  contract: 'ERP2_LIVE_SCHEMA_RECONCILIATION_V1',
  sourcePath,
  livePath,
  classification,
  canonicalComparison: canonical,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  result: classification.result,
  observedDifferenceCount: observedDifferences.length,
  counts: classification.counts,
  canonicalDifferenceCount: canonical.semanticDifferences.length,
  output: outputPath,
}));
