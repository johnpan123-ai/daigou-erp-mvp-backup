import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isolatedDatabase } from './helpers/saveability-isolated.mjs';
import { fingerprintStructuralSnapshot, fingerprintStructuralSnapshotV2 } from '../tools/schema-reconciliation/schemaContract.mjs';
const db = await isolatedDatabase();
try {
  const source = await readFile('tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql', 'utf8');
  const snapshot = (await db.sql.query(source)).rows[0].erp_schema_snapshot;
  const contract = JSON.parse(await readFile('config/erp-environment-identity.json', 'utf8'));
  assert.equal(fingerprintStructuralSnapshot(snapshot), contract.schemaBaseline.canonicalFingerprint);
  assert.equal(fingerprintStructuralSnapshotV2(snapshot), '64d84a4fe60bc9b73c1ba29e6392e7d2c254dcbb5faba8fb2aba9897cbd7e076');
  console.log('PASS native PostgreSQL fresh full schema equals PGlite/source canonical v3');
} finally { await db.close(); }
