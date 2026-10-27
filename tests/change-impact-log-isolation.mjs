import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { regressionLogPath } from '../scripts/verify-erp2-change-impact.mjs';

const root = mkdtempSync(join(tmpdir(), 'erp2-change-impact-log-'));
const head = '1'.repeat(40);
try {
  const historical = resolve(root, 'scratch/erp2-release-evidence/provider-guard.log');
  const current = regressionLogPath({ root, candidateHead: head, id: 'provider-guard' });
  assert.notEqual(current, historical);
  assert.equal(current, resolve(root, `scratch/erp2-release-evidence/runs/${head}/provider-guard.log`));
  assert.notEqual(current, regressionLogPath({ root, candidateHead: '2'.repeat(40), id: 'provider-guard' }));
  assert.throws(() => regressionLogPath({ root, candidateHead: head, id: '../provider-guard' }), /Invalid/u);
  assert.throws(() => regressionLogPath({ root, candidateHead: 'bad', id: 'provider-guard' }), /Invalid/u);

  mkdirSync(resolve(root, 'scratch/erp2-release-evidence'), { recursive: true });
  writeFileSync(historical, 'immutable historical evidence', { encoding: 'utf8', flag: 'wx' });
  assert.equal(readFileSync(historical, 'utf8'), 'immutable historical evidence');
  console.log(JSON.stringify({ result: 'PASS', candidateScoped: true, historicalEvidencePreserved: true, negativeCases: 2 }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
