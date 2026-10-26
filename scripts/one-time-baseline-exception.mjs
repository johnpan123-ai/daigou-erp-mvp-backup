import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const fail = message => { throw new Error(`DEPLOYMENT_GUARD_FAILED_CLOSED: baseline exception ${message}`); };
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const exceptionHash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fileSha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const inside = (root, path) => {
  const scope = relative(root, path);
  return Boolean(scope) && !scope.startsWith('..') && !isAbsolute(scope);
};
const gitPatchSha256 = (git, before, after) => createHash('sha256').update(git([
  'diff', '--no-ext-diff', '--binary', '--full-index', '--no-renames', before, after, '--',
])).digest('hex');

const assertConfig = config => {
  if (config?.schemaVersion !== 1 || config.kind !== 'ERP2_ONE_TIME_BASELINE_FAILURE_EXCEPTION'
    || config.id !== 'erp2-v33-japan-package-create-buyanime-baseline-20261027'
    || !SHA1.test(config.baselineHead ?? '') || !SHA1.test(config.originalCandidateHead ?? '')
    || !SHA256.test(config.originalPatchSha256 ?? '') || config.consumption?.limit !== 1
    || config.failure?.regressionId !== 'post-restore-business-release'
    || config.failure?.script !== 'tests/buyanime-post-restore-isolated.mjs'
    || config.failure?.backendCode !== 'BUYANIME_INVENTORY_READBACK_IDENTITY_ERROR'
    || config.failure?.uiSymptom !== 'ISOLATED_IMPORT_SUCCESS_SYNC_TIMEOUT'
    || config.failure?.stage !== 'ERP1 Restore -> immediate BuyAnime'
    || config.target?.url !== 'https://hippo-erp-realtime-preview.pages.dev') fail('configuration mismatch');
};

const readBoundEvidence = (root, record, requiredStrings = []) => {
  if (!record || !SHA256.test(record.sha256 ?? '')) fail('evidence identity missing');
  const path = resolve(root, record.path ?? '');
  if (!inside(root, path) || !existsSync(path) || fileSha256(path) !== record.sha256) fail('evidence file mismatch');
  const text = readFileSync(path, 'utf8');
  for (const value of requiredStrings) if (!text.includes(value)) fail(`evidence signature mismatch: ${value}`);
  return { path: record.path, sha256: record.sha256 };
};

const assertGitIdentity = ({ config, git, candidateHead }) => {
  try {
    git(['--no-replace-objects', 'merge-base', '--is-ancestor', config.baselineHead, config.originalCandidateHead]);
    git(['--no-replace-objects', 'merge-base', '--is-ancestor', config.originalCandidateHead, candidateHead]);
  } catch { fail('Git ancestry mismatch'); }
  if (gitPatchSha256(git, config.baselineHead, config.originalCandidateHead) !== config.originalPatchSha256) {
    fail('original patch SHA256 mismatch');
  }
  if (git(['rev-parse', `${config.baselineHead}:${config.failure.script}`]).trim() !== config.failure.scriptBlob
    || git(['rev-parse', `${config.originalCandidateHead}:${config.failure.script}`]).trim() !== config.failure.scriptBlob
    || git(['rev-parse', `${candidateHead}:${config.failure.script}`]).trim() !== config.failure.scriptBlob) {
    fail('failure test Blob mismatch');
  }
  for (const [file, blob] of Object.entries(config.unchangedBuyAnimeBlobs ?? {})) {
    if (git(['rev-parse', `${config.baselineHead}:${file}`]).trim() !== blob
      || git(['rev-parse', `${config.originalCandidateHead}:${file}`]).trim() !== blob
      || git(['rev-parse', `${candidateHead}:${file}`]).trim() !== blob) fail(`BuyAnime Blob mismatch: ${file}`);
  }
  const descendantFiles = git(['diff', '--name-only', '--no-renames', config.originalCandidateHead, candidateHead, '--'])
    .trim().split(/\r?\n/u).filter(Boolean).sort();
  const allowed = [...config.allowedDescendantFiles].sort();
  if (descendantFiles.some(file => !allowed.includes(file))) fail('unapproved descendant file');
  return { descendantFiles, finalPatchSha256: gitPatchSha256(git, config.baselineHead, candidateHead) };
};

export function buildOneTimeBaselineException({ config, root, git, candidateHead, now = Date.now() }) {
  assertConfig(config);
  const expires = Date.parse(config.expiresAt ?? '');
  if (!Number.isFinite(expires) || now > expires) fail('expired');
  const marker = resolve(root, config.consumption.marker ?? '');
  if (!inside(resolve(root, 'scratch/erp2-release-evidence'), marker)) fail('consumption marker path');
  if (existsSync(marker)) fail('already consumed');
  const gitIdentity = assertGitIdentity({ config, git, candidateHead });
  const signatures = [config.failure.stage, config.failure.backendCode, config.failure.uiSymptom];
  const baselineEvidence = readBoundEvidence(root, config.failure.baselineEvidence, signatures);
  const candidateEvidence = readBoundEvidence(root, config.failure.candidateEvidence, signatures);
  const carriedPasses = Object.fromEntries(Object.entries(config.carriedPasses ?? {}).map(([id, record]) => [id,
    readBoundEvidence(root, record, ['PASS'])]));
  const payload = {
    schemaVersion: 1, kind: config.kind, exceptionId: config.id,
    configIdentity: exceptionHash(config), baselineHead: config.baselineHead,
    originalCandidateHead: config.originalCandidateHead, candidateHead,
    originalPatchSha256: config.originalPatchSha256, finalPatchSha256: gitIdentity.finalPatchSha256,
    regressionId: config.failure.regressionId, failureScriptBlob: config.failure.scriptBlob,
    failureSignature: { stage: config.failure.stage, backendCode: config.failure.backendCode, uiSymptom: config.failure.uiSymptom },
    baselineEvidence, candidateEvidence, carriedPasses,
    target: config.target, descendantFiles: gitIdentity.descendantFiles,
    consumptionMarker: config.consumption.marker, useLimit: 1,
  };
  return { ...payload, identity: exceptionHash(payload) };
}

export function verifyOneTimeBaselineException({ config, evidence, root, git, candidateHead, now = Date.now() }) {
  const expected = buildOneTimeBaselineException({ config, root, git, candidateHead, now });
  if (!evidence || evidence.identity !== expected.identity || exceptionHash(evidence) !== exceptionHash(expected)) {
    fail('sealed evidence mismatch');
  }
  return expected;
}

export function consumeOneTimeBaselineException({ evidence, root, candidateHead, artifactIdentity, now = Date.now() }) {
  if (!evidence || evidence.candidateHead !== candidateHead || !SHA256.test(evidence.identity ?? '')
    || !SHA256.test(artifactIdentity ?? '') || evidence.useLimit !== 1) fail('consumption identity mismatch');
  const marker = resolve(root, evidence.consumptionMarker ?? '');
  if (!inside(resolve(root, 'scratch/erp2-release-evidence'), marker)) fail('consumption marker path');
  mkdirSync(dirname(marker), { recursive: true });
  const record = {
    schemaVersion: 1, kind: 'ERP2_ONE_TIME_BASELINE_FAILURE_EXCEPTION_CONSUMED',
    exceptionId: evidence.exceptionId, exceptionIdentity: evidence.identity,
    candidateHead, artifactIdentity, target: evidence.target, consumedAt: new Date(now).toISOString(), useCount: 1,
  };
  try { writeFileSync(marker, `${JSON.stringify({ ...record, identity: exceptionHash(record) }, null, 2)}\n`, { flag: 'wx' }); }
  catch { fail('already consumed'); }
  return { ...record, identity: exceptionHash(record), marker: evidence.consumptionMarker };
}
