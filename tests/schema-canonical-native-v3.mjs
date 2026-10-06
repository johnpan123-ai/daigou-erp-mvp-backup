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
  assert.equal(fingerprintStructuralSnapshotV2(snapshot), '9e96c9941579e1e94366ebaf28ec995fb8b3c068ffdb5e8fedf7f94a4c09a8db');
  console.log('PASS native PostgreSQL fresh full schema equals PGlite/source canonical v3');
} finally { await db.close(); }
