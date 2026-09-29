import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SCHEMA_FINGERPRINT_CONTRACT_VERSION,
  fingerprintLegacyStructuralSnapshotV1,
  fingerprintStructuralSnapshot,
  reconcileFingerprintEvidence,
} from './schemaContract.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const option = (name, required = true) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : null;
  if (required && !value) throw new Error(`OPTION_REQUIRED:${name}`);
  return value;
};
const readSnapshot = async path => {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (parsed?.erp_schema_snapshot) return parsed.erp_schema_snapshot;
  if (Array.isArray(parsed) && parsed.length === 1 && parsed[0]?.erp_schema_snapshot) return parsed[0].erp_schema_snapshot;
  return parsed;
};

if (command === 'fingerprint') {
  const snapshot = await readSnapshot(option('snapshot'));
  console.log(JSON.stringify({
    result: 'PASS', fingerprintContractVersion: SCHEMA_FINGERPRINT_CONTRACT_VERSION,
    fingerprint: fingerprintStructuralSnapshot(snapshot),
    legacyEvidenceFingerprintV1: fingerprintLegacyStructuralSnapshotV1(snapshot),
  }, null, 2));
  process.exit(0);
}
if (command === 'diff') {
  const currentSnapshot = await readSnapshot(option('current'));
  const oldPath = option('old', false);
  const result = reconcileFingerprintEvidence({
    expectedSnapshot: oldPath ? await readSnapshot(oldPath) : null,
    currentSnapshot,
    expectedFingerprint: option('expected-old-fingerprint', false),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.result === 'BLOCKED') process.exitCode = 2;
} else if (command !== 'fingerprint') {
  throw new Error('USAGE: node tools/schema-reconciliation/fingerprint-cli.mjs <fingerprint|diff> [options]');
}
