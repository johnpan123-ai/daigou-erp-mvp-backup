import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildOneTimeBaselineException,
  consumeOneTimeBaselineException,
  verifyOneTimeBaselineException,
} from '../scripts/one-time-baseline-exception.mjs';

const repo = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(resolve(repo, 'config/erp2-one-time-baseline-exception.json'), 'utf8'));
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'erp2-baseline-exception-'));
const copy = record => {
  const destination = resolve(root, record.path); mkdirSync(dirname(destination), { recursive: true });
  cpSync(resolve(repo, record.path), destination);
};

try {
  copy(config.failure.baselineEvidence); copy(config.failure.candidateEvidence);
  Object.values(config.carriedPasses).forEach(copy);
  const now = Date.parse('2026-10-27T01:00:00+08:00');
  const evidence = buildOneTimeBaselineException({ config, root, git,
    candidateHead: config.originalCandidateHead, now });
  assert.equal(evidence.originalPatchSha256, config.originalPatchSha256);
  assert.equal(evidence.regressionId, 'post-restore-business-release');
  assert.equal(evidence.baselineEvidence.sha256, config.failure.baselineEvidence.sha256);
  assert.equal(evidence.candidateEvidence.sha256, config.failure.candidateEvidence.sha256);
  assert.equal(verifyOneTimeBaselineException({ config, evidence, root, git,
    candidateHead: config.originalCandidateHead, now }).identity, evidence.identity);

  assert.throws(() => verifyOneTimeBaselineException({ config, evidence: { ...evidence, finalPatchSha256: '0'.repeat(64) },
    root, git, candidateHead: config.originalCandidateHead, now }), /FAILED_CLOSED/u, 'tampered evidence');
  assert.throws(() => buildOneTimeBaselineException({ config: { ...config, originalPatchSha256: '0'.repeat(64) },
    root, git, candidateHead: config.originalCandidateHead, now }), /original patch SHA256 mismatch/u);
  assert.throws(() => buildOneTimeBaselineException({ config: { ...config, target: { ...config.target, url: 'https://example.invalid' } },
    root, git, candidateHead: config.originalCandidateHead, now }), /configuration mismatch/u);

  const candidatePath = resolve(root, config.failure.candidateEvidence.path);
  const original = readFileSync(candidatePath);
  writeFileSync(candidatePath, Buffer.from(original.toString('utf8').replaceAll(
    'BUYANIME_INVENTORY_READBACK_IDENTITY_ERROR', 'DIFFERENT_FAILURE')));
  const changedFailure = structuredClone(config);
  changedFailure.failure.candidateEvidence.sha256 = sha256(readFileSync(candidatePath));
  assert.throws(() => buildOneTimeBaselineException({ config: changedFailure, root, git,
    candidateHead: config.originalCandidateHead, now }), /evidence signature mismatch|sealed evidence mismatch/u);
  writeFileSync(candidatePath, original);

  const unauthorizedGit = args => args[0] === 'diff' && args.includes('--name-only')
    ? 'src/providers/cloud/supabaseProvider.ts\n' : git(args);
  assert.throws(() => buildOneTimeBaselineException({ config, root, git: unauthorizedGit,
    candidateHead: config.originalCandidateHead, now }), /unapproved descendant file/u);

  assert.throws(() => consumeOneTimeBaselineException({ evidence, root,
    candidateHead: config.originalCandidateHead, artifactIdentity: 'G'.repeat(64), now }), /consumption identity mismatch/u);
  const consumed = consumeOneTimeBaselineException({ evidence, root,
    candidateHead: config.originalCandidateHead, artifactIdentity: 'A'.repeat(64), now });
  assert.equal(consumed.useCount, 1);
  assert.throws(() => consumeOneTimeBaselineException({ evidence, root,
    candidateHead: config.originalCandidateHead, artifactIdentity: 'a'.repeat(64), now }), /already consumed/u);
  assert.throws(() => buildOneTimeBaselineException({ config, root, git,
    candidateHead: config.originalCandidateHead, now }), /already consumed/u);
  console.log(JSON.stringify({ result: 'PASS', positive: 1, negative: 8,
    baselineFailurePreserved: true, candidateFailurePreserved: true, useLimit: 1 }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
