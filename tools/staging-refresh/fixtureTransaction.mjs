import { buildSnapshotManifest, compareManifests, createSnapshotEnvelope } from './manifest.mjs';

/**
 * Isolated regression model for the all-or-nothing replacement contract.
 * Production execution uses PostgreSQL BEGIN/COMMIT; this model lets CI inject
 * failures without needing credentials or touching any real database.
 */
export async function replaceFixtureAtomically(target, snapshot, options = {}) {
  const before = structuredClone(target);
  try {
    let index = 0;
    for (const [table, rows] of Object.entries(snapshot.data)) {
      target[table] = structuredClone(rows);
      index += 1;
      if (options.failAfterTable === index) throw new Error('INJECTED_RESTORE_FAILURE');
    }
    const readback = createSnapshotEnvelope({
      sourceProjectRef: snapshot.sourceProjectRef,
      schema: snapshot.schema,
      data: target,
      piiMode: snapshot.piiMode,
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
    });
    const comparison = compareManifests(buildSnapshotManifest(snapshot), buildSnapshotManifest(readback));
    if (!comparison.accepted) throw new Error(`FIXTURE_INTEGRITY_FAILED:${comparison.differences.join(',')}`);
    return comparison;
  } catch (error) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, before);
    throw error;
  }
}
