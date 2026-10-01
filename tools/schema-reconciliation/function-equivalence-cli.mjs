import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { canonicalSqlTokens } from './sqlCanonical.mjs';
import { diffStructuralSnapshots, fingerprintStructuralSnapshotV2, sqlOptionsForPath,
  SCHEMA_CANONICAL_CONTRACT, SQL_CANONICAL_ALGORITHM } from './schemaContract.mjs';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, live: { type: 'string' }, output: { type: 'string' },
} });
if (!values.source || !values.live || !values.output) throw new Error('SOURCE_LIVE_OUTPUT_REQUIRED');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const source = await read(values.source); const live = await read(values.live);
const sha = value => createHash('sha256').update(value).digest('hex');
const comparison = diffStructuralSnapshots(source, live);
const functions = Object.keys(source.functions).sort().map(signature => {
  const a = source.functions[signature]; const b = live.functions[signature];
  const path = ['functions',signature,'definition'];
  const code = (s, row) => canonicalSqlTokens(row?.definition ?? '', sqlOptionsForPath(s, path));
  const fields = ['arguments', 'returnType', 'language', 'volatility', 'strict', 'parallel',
    'leakproof', 'securityDefiner', 'config', 'authenticatedExecute', 'anonExecute', 'publicExecute'];
  const metadata = Object.fromEntries(fields.map(field => [field, JSON.stringify(a[field]) === JSON.stringify(b?.[field])]));
  return { signature, rawSourceSha256: sha(a.definition ?? ''), rawLiveSha256: sha(b?.definition ?? ''),
    canonicalBodyEqual: JSON.stringify(code(source,a)) === JSON.stringify(code(live,b)),
    metadata, ownerClassification: 'ENVIRONMENT_LOCAL_FROZEN_FROM_V2',
    comparisonScope: 'Full token stream includes calls, tables, predicates, locks, return and transaction statements; no fragment/name exception' };
});
const report = { result: comparison.semanticEqual ? 'PASS' : 'FAIL',
  rootCause: comparison.semanticEqual ? 'RENDERING_ONLY' : 'SEMANTIC_DRIFT',
  canonicalContract: SCHEMA_CANONICAL_CONTRACT, algorithm: SQL_CANONICAL_ALGORITHM,
  rawArtifacts: { source: values.source, live: values.live },
  historicalV2: { source: fingerprintStructuralSnapshotV2(source), live: fingerprintStructuralSnapshotV2(live) },
  comparison, functions, sourceModificationRequiredForDatabase: !comparison.semanticEqual,
};
await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: report.result, rootCause: report.rootCause,
  sourceFingerprint: comparison.beforeFingerprint, liveFingerprint: comparison.afterFingerprint,
  semanticDifferences: comparison.semanticDifferences.length, functions: functions.length, report: values.output }));
if (!comparison.semanticEqual) process.exitCode = 2;
