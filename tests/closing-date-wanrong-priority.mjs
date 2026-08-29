import assert from 'node:assert/strict';
import { orderClosingDateReviewCandidates } from '../src/lib/closingDateWorkbenchReviewOrder.ts';

const candidate = (id, supplier, rank, resolutionIdentityId = undefined) => ({
  id,
  rank,
  resolutionIdentityId,
  source: { sourceSupplier: supplier, sourceProductId: id },
  score: 0.9 - rank / 100,
  safetyClassification: rank % 2 === 0 ? 'YELLOW' : 'GREEN',
});

const qualifiedCandidates = [
  candidate('dreamlink-first', 'dreamlink', 1, 'identity:a'),
  candidate('wanrong-first', 'wanrong', 2, 'identity:b'),
  candidate('other-middle', 'other', 3, 'identity:c'),
  candidate('wanrong-second', 'wanrong', 4, 'identity:a'),
  candidate('dreamlink-last', 'dreamlink', 5, 'identity:b'),
];
const before = structuredClone(qualifiedCandidates);
const ordered = orderClosingDateReviewCandidates(qualifiedCandidates);

assert.deepEqual(
  ordered.map(item => item.id),
  ['wanrong-first', 'wanrong-second', 'dreamlink-first', 'other-middle', 'dreamlink-last'],
  'All already-qualified Wanrong candidates must be first, preserving stable order within both partitions',
);
assert.deepEqual(qualifiedCandidates, before, 'Display ordering must not mutate candidates or their score/classification');
assert.equal(ordered.length, qualifiedCandidates.length, 'Display ordering must not add or remove candidates');
assert.deepEqual(
  new Set(ordered),
  new Set(qualifiedCandidates),
  'Display ordering must retain the exact candidate objects',
);
assert.equal(
  orderClosingDateReviewCandidates([
    candidate('not-an-alias', '萬榮', 1),
    candidate('exact-wanrong', 'wanrong', 2),
  ])[0].id,
  'exact-wanrong',
  'Priority must use the exact existing supplier identity rather than display text or aliases',
);

console.log('PASS Wanrong candidates are first with stable partition ordering');
console.log('PASS score, classification, candidate set, and source objects remain unchanged');
console.log('PASS only exact supplier identity wanrong receives priority');
