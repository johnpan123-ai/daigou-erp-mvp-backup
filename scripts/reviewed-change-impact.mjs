import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const reviewedImpacts = JSON.parse(readFileSync(new URL('../config/erp2-reviewed-change-impacts.json', import.meta.url), 'utf8'));
const fail = message => { throw new Error(`DEPLOYMENT_GUARD_FAILED_CLOSED: ${message}`); };
export const sourceHash = source => source === null ? null
  : createHash('sha256').update(source.replace(/\r\n?/gu, '\n').trimEnd()).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const impactHash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export const regressionScripts = Object.freeze({
  guard: 'tests/erp2-reviewed-change-impact.mjs',
  promotion: 'tests/erp2-promotion-guard.mjs',
  domain: 'tests/next-waca-order-integration.mjs',
  pending: 'tests/waca-pending-reimport.mjs',
  'legacy-modern': 'tests/waca-backup-cutover-v3.mjs',
  'cloud-next': 'tests/cloud-backup-next-restore-e2e.mjs',
  registry: 'tests/durable-resource-registry-v3.mjs',
  provider: 'tests/waca-cloud-ui-parity.mjs',
  'cloud-restore': 'tests/waca-cloud-restore-patch-v3.mjs',
  postgrest: 'tests/waca-postgrest-isolated-v3.mjs',
  'execute-envelope': 'tests/cloud-restore-execute-dispatch-boundary.mjs',
  sync: 'tests/promotion-sync-state.mjs',
  'mutation-fields': 'tests/cloud-mutation-field-contract.mjs',
  'mutation-native': 'tests/cloud-mutation-field-contract-isolated.mjs',
  'mutation-ui': 'tests/cloud-mutation-inline-ui.mjs',
  'mutation-ordering': 'tests/cloud-mutation-ordering-dynamic.mjs',
  cas: 'tests/cloud-field-cas.mjs',
  realtime: 'tests/cloud-realtime-draft-catchup.mjs',
  draft: 'tests/cloud-field-cas-react.mjs',
});

// A review is an exact immutable patch, not a path exception. Both anchor
// trees are read from Git; any subsequent hunk in these files fails closed.
export function reviewForCandidate(git, candidateHead) {
  if (reviewedImpacts.schemaVersion !== 1) fail('unsupported change-impact registry');
  return reviewedImpacts.reviews.filter(review => {
    try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', review.reviewedHead, candidateHead]); }
    catch { return false; }
    git(['--no-replace-objects', 'merge-base', '--is-ancestor', review.beforeHead, review.reviewedHead]);
    const changed = git(['diff', '--name-only', '--no-renames', review.beforeHead, review.reviewedHead, '--'])
      .trim().split(/\r?\n/u).filter(Boolean).sort();
    if (impactHash(changed) !== impactHash(review.files.map(row => row.file).sort())) fail('review patch scope mismatch');
    for (const row of review.files) {
      const oldSource = row.beforeHash === null ? null : git(['show', `${review.beforeHead}:${row.file}`]);
      const afterSource = git(['show', `${review.reviewedHead}:${row.file}`]);
      if (sourceHash(oldSource) !== row.beforeHash || sourceHash(afterSource) !== row.afterHash
        || !['PRESENTATION_ONLY', 'APPLICATION_DOMAIN_ONLY', 'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL'].includes(row.classification)) {
        fail(`review anchor or classification mismatch: ${row.file}`);
      }
    }
    return true;
  });
}

export function classifyReviewedFile({ file, after, reviews }) {
  const matches = reviews.flatMap(review => review.files.filter(row => row.file === file).map(row => ({ review, row })));
  if (!matches.length) return null;
  if (matches.length !== 1) fail(`ambiguous reviewed source: ${file}`);
  const { review, row } = matches[0];
  if (sourceHash(after) !== row.afterHash) fail(`unreviewed change in reviewed source: ${file}`);
  return { review, row };
}

export function sealImpactEvidence(evidence) {
  return { ...evidence, identity: impactHash(evidence) };
}

export function verifyImpactEvidence({ evidence, inspection, git, now = Date.now() }) {
  if (!inspection.requiredRegressions.length) return null;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.kind !== 'ERP2_REVIEWED_CHANGE_IMPACT') fail('required change-impact evidence missing');
  const { identity, ...payload } = evidence;
  if (identity !== impactHash(payload) || impactHash(evidence.inspection) !== impactHash(inspection)) fail('change-impact evidence identity/diff mismatch');
  const age = now - Date.parse(evidence.completedAt ?? '');
  if (!Number.isFinite(age) || age < -60_000 || age > 24 * 60 * 60 * 1000) fail('change-impact regressions stale');
  if (!Array.isArray(evidence.regressions) || evidence.regressions.length !== inspection.requiredRegressions.length) fail('required regression scope mismatch');
  for (const [index, id] of inspection.requiredRegressions.entries()) {
    const row = evidence.regressions[index];
    const script = regressionScripts[id];
    if (!script || row?.id !== id || row.script !== script || row.result !== 'PASS' || row.exitCode !== 0
      || row.scriptChecksum !== sourceHash(git(['show', `${inspection.candidateHead}:${script}`]))
      || !/^[0-9a-f]{64}$/u.test(row.outputChecksum ?? '')
      || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) fail(`required regression invalid: ${id}`);
  }
  return { result: 'PASS', identity, requiredRegressions: inspection.requiredRegressions, candidateHead: inspection.candidateHead };
}
