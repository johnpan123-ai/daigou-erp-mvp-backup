import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyOneTimeBaselineException } from './one-time-baseline-exception.mjs';

export const reviewedImpacts = JSON.parse(readFileSync(new URL('../config/erp2-reviewed-change-impacts.json', import.meta.url), 'utf8'));
const fail = message => { throw new Error(`DEPLOYMENT_GUARD_FAILED_CLOSED: ${message}`); };
export const sourceHash = source => source === null ? null
  : createHash('sha256').update(source.replace(/\r\n?/gu, '\n').trimEnd()).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const impactHash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export const regressionScripts = Object.freeze({
  'waca-normal-import-native': 'tests/waca-normal-import-isolated.mjs',
  // Historical review ID: bind to the finite React assertions, NEVER the persistent Owner preview launcher.
  'waca-normal-import-preview': 'tests/waca-preview-filter-ui.mjs',
  'waca-counted-transition': 'tests/waca-counted-transition.mjs',
  'waca-counted-restore': 'tests/waca-counted-restore-e2e.mjs',
  'waca-preview-visibility': 'tests/waca-preview-visibility.mjs',
  'waca-preview-filter-ui': 'tests/waca-preview-filter-ui.mjs',
  'waca-accumulate-ui': 'tests/waca-accumulate-default.mjs',
  'waca-counted-ui': 'tests/waca-counted-ui.mjs',
  'waca-review-ui': 'tests/waca-ui-review.mjs',
  'egress-full-read-budget': 'tests/realtime-full-read-budget.mjs',
  'provider-guard': 'tests/p02-1a-provider-guard.mjs',
  'r5-core-provider-guard': 'tests/r5-core-provider-guard.mjs',
  'context-guard': 'tests/p02-1a-context-guard.mjs',
  'buyanime-journal-identity': 'tests/buyanime-journal-identity.mjs',
  'buyanime-journal-scanner': 'tests/buyanime-journal-scanner.mjs',
  'buyanime-recovery-epoch': 'tests/buyanime-recovery-epoch.mjs',
  'buyanime-recovery-review': 'tests/buyanime-recovery-change-impact.mjs',
  'post-restore-business-release': 'tests/buyanime-post-restore-isolated.mjs',
  'baseline-exception-control': 'tests/erp2-one-time-baseline-exception.mjs',
  'erp1-v1-exact-restore': 'tests/erp1-v1-restore-compatibility.mjs',
  'erp1-v1-restore-review': 'tests/erp1-v1-restore-change-impact.mjs',
  'waca-v3-native-replay': 'tests/waca-resolver-v3-replay.mjs',
  'waca-atomic-confirm': 'tests/waca-atomic-confirm-native.mjs',
  'waca-confirm-contract': 'tests/waca-atomic-confirm-contract.mjs',
  'waca-confirm-errors': 'tests/waca-import-errors.mjs',
  'waca-confirm-next-ui': 'tests/next-waca-ui.mjs',
  'product-master-rematch-review': 'tests/waca-product-master-change-impact.mjs',
  'product-master-rematch': 'tests/waca-product-master-rematch.mjs',
  'buyanime-simple-flow': 'tests/buyanime-simple-flow.mjs',
  'buyanime-flow-performance': 'tests/buyanime-flow-performance-isolated.mjs',
  'buyanime-flow-review': 'tests/buyanime-flow-change-impact.mjs',
  'buyanime-production-trace': 'tests/buyanime-production-trace.mjs',
  'buyanime-cache-authority': 'tests/cloud-cache-authority.mjs',
  'buyanime-data-size': 'tests/data-size-advisory.mjs',
  'buyanime-lint-delta': 'tests/p0-eslint-baseline-delta.mjs',
  'buyanime-bulk': 'tests/cloud-bulk-readback.mjs',
  'buyanime-resume': 'tests/buyanime-import-resume.mjs',
  'buyanime-resume-real': 'tests/buyanime-readback-resume-isolated.mjs',
  'buyanime-resume-ui': 'tests/inventory-cloud-import-flow.mjs',
  'buyanime-resume-review': 'tests/buyanime-readback-change-impact.mjs',
  'buyanime-domain': 'tests/buyanime-canonical-identity.mjs',
  'buyanime-real': 'tests/buyanime-canonical-identity-isolated.mjs',
  'buyanime-ui': 'tests/buyanime-import-error-ui.mjs',
  'buyanime-provider': 'tests/buyanime-cloud-provider.mjs',
  catalog: 'tests/catalog-atomic-isolated.mjs',
  guard: 'tests/erp2-reviewed-change-impact.mjs',
  promotion: 'tests/erp2-promotion-guard.mjs',
  domain: 'tests/next-waca-order-integration.mjs',
  'spec-code': 'tests/waca-spec-code-matching.mjs',
  'evidence-resolver': 'tests/waca-evidence-resolver-v2.mjs',
  'evidence-real': 'tests/waca-evidence-real-fixture-v2.mjs',
  'evidence-manual': 'tests/waca-matching-closure-v2-manual-ui.mjs',
  'evidence-review': 'tests/waca-evidence-v2-change-impact.mjs',
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
  'private-delete': 'tests/cloud-private-order-delete.mjs',
});

// A review is an exact immutable patch, not a path exception. Both anchor
// trees are read from Git; any subsequent hunk in these files fails closed.
export function reviewForCandidate(git, candidateHead, adoptedBaselineHead = null) {
  if (reviewedImpacts.schemaVersion !== 1) fail('unsupported change-impact registry');
  const previousReviews = new Map();
  return reviewedImpacts.reviews.filter(review => {
    try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', review.reviewedHead, candidateHead]); }
    catch { return false; }
    git(['--no-replace-objects', 'merge-base', '--is-ancestor', review.beforeHead, review.reviewedHead]);
    const changed = git(['diff', '--name-only', '--no-renames', review.beforeHead, review.reviewedHead, '--'])
      .trim().split(/\r?\n/u).filter(Boolean).sort();
    if (impactHash(changed) !== impactHash(review.files.map(row => row.file).sort())) fail('review patch scope mismatch');
    for (const row of review.files) {
      const previous = previousReviews.get(row.file);
      if (previous) {
        if (row.beforeHash !== previous.row.afterHash) {
          // An adopted schema baseline may legitimately contain changes from
          // a schema release between two frontend reviews. Only that verified
          // Git boundary can reset the chain; gaps after adoption stay blocked.
          if (!adoptedBaselineHead) fail(`unreviewed gap between exact patches: ${row.file}`);
          try {
            // The current reviewed patch may itself already be part of the
            // adopted tree. In that case the baseline has verified the whole
            // earlier gap and it must not be reclassified as post-baseline.
            git(['--no-replace-objects', 'merge-base', '--is-ancestor', review.reviewedHead, adoptedBaselineHead]);
          } catch {
            try {
              git(['--no-replace-objects', 'merge-base', '--is-ancestor', previous.review.reviewedHead, adoptedBaselineHead]);
              git(['--no-replace-objects', 'merge-base', '--is-ancestor', adoptedBaselineHead, review.beforeHead]);
            } catch { fail(`unreviewed post-baseline gap: ${row.file}`); }
          }
        }
        try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', previous.review.reviewedHead, review.beforeHead]); }
        catch { fail(`review chain is not chronological: ${row.file}`); }
      }
      const oldSource = row.beforeHash === null ? null : git(['show', `${review.beforeHead}:${row.file}`]);
      const afterSource = git(['show', `${review.reviewedHead}:${row.file}`]);
      if (sourceHash(oldSource) !== row.beforeHash || sourceHash(afterSource) !== row.afterHash
        || !['PRESENTATION_ONLY', 'APPLICATION_DOMAIN_ONLY', 'PERSISTENCE_BEHAVIOR_SCHEMA_NEUTRAL'].includes(row.classification)) {
        fail(`review anchor or classification mismatch: ${row.file}`);
      }
      previousReviews.set(row.file, { row, review });
    }
    return true;
  });
}

export function classifyReviewedFile({ file, after, reviews }) {
  const matches = reviews.flatMap(review => review.files.filter(row => row.file === file).map(row => ({ review, row })));
  if (!matches.length) return null;
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].row.beforeHash !== matches[i - 1].row.afterHash) fail(`ambiguous/discontinuous reviewed source: ${file}`);
  }
  const { review, row } = matches.at(-1);
  if (sourceHash(after) !== row.afterHash) fail(`unreviewed change in reviewed source: ${file}`);
  return { review, row, chain: matches };
}

export function sealImpactEvidence(evidence) {
  return { ...evidence, identity: impactHash(evidence) };
}

export function verifyImpactEvidence({ evidence, inspection, git, now = Date.now(), baselineExceptionConfig = null, evidenceRoot = null }) {
  if (!inspection.requiredRegressions.length) return null;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.kind !== 'ERP2_REVIEWED_CHANGE_IMPACT') fail('required change-impact evidence missing');
  const { identity, ...payload } = evidence;
  if (identity !== impactHash(payload) || impactHash(evidence.inspection) !== impactHash(inspection)) fail('change-impact evidence identity/diff mismatch');
  const age = now - Date.parse(evidence.completedAt ?? '');
  if (!Number.isFinite(age) || age < -60_000 || age > 24 * 60 * 60 * 1000) fail('change-impact regressions stale');
  if (!Array.isArray(evidence.regressions) || evidence.regressions.length !== inspection.requiredRegressions.length) fail('required regression scope mismatch');
  let baselineException = null;
  if (evidence.result === 'PASS_WITH_BASELINE_EXCEPTION') {
    if (!baselineExceptionConfig || !evidenceRoot) fail('baseline exception verifier unavailable');
    baselineException = verifyOneTimeBaselineException({
      config: baselineExceptionConfig, evidence: evidence.baselineException,
      root: evidenceRoot, git, candidateHead: inspection.candidateHead, now,
    });
  } else if (evidence.result !== undefined || evidence.baselineException !== undefined) {
    fail('unexpected baseline exception evidence');
  }
  for (const [index, id] of inspection.requiredRegressions.entries()) {
    const row = evidence.regressions[index];
    const script = regressionScripts[id];
    const scriptChecksum = script ? sourceHash(git(['show', `${inspection.candidateHead}:${script}`])) : null;
    if (!script || row?.id !== id || row.script !== script || row.scriptChecksum !== scriptChecksum
      || !/^[0-9a-f]{64}$/u.test(row.outputChecksum ?? '')) fail(`required regression invalid: ${id}`);
    const carried = baselineExceptionConfig?.carriedPasses?.[id];
    if (baselineException && carried) {
      if (row.result !== 'PASS' || row.exitCode !== 0 || row.provenance !== 'CARRIED_FORWARD_EXACT_BLOB'
        || row.sourceHead !== baselineException.originalCandidateHead || row.outputChecksum !== carried.sha256
        || sourceHash(git(['show', `${baselineException.originalCandidateHead}:${script}`])) !== scriptChecksum) {
        fail(`carried regression invalid: ${id}`);
      }
      continue;
    }
    if (baselineException && id === baselineException.regressionId) {
      if (row.result !== 'FAIL' || row.exitCode === 0 || row.provenance !== 'BASELINE_FAILURE_MATCH'
        || row.outputChecksum !== baselineException.candidateEvidence.sha256) fail(`accepted baseline failure invalid: ${id}`);
      continue;
    }
    if (row.result !== 'PASS' || row.exitCode !== 0 || (row.provenance && row.provenance !== 'EXECUTED_CURRENT_CANDIDATE')
      || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) fail(`required regression invalid: ${id}`);
  }
  return { result: baselineException ? 'PASS_WITH_BASELINE_EXCEPTION' : 'PASS', identity,
    requiredRegressions: inspection.requiredRegressions, candidateHead: inspection.candidateHead,
    baselineException: baselineException ? {
      exceptionId: baselineException.exceptionId, identity: baselineException.identity,
      regressionId: baselineException.regressionId, candidateEvidence: baselineException.candidateEvidence,
      baselineEvidence: baselineException.baselineEvidence, consumptionMarker: baselineException.consumptionMarker,
      useLimit: baselineException.useLimit, target: baselineException.target, candidateHead: baselineException.candidateHead,
    } : null };
}
