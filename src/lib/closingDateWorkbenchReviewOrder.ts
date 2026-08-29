import type { RankedResolutionCandidate } from './closingDateResolutionDomain';

/**
 * Candidates have already passed retrieval and qualification before reaching
 * this display-only ordering step. Keep native order stable within each group,
 * while presenting the exact Wanrong supplier identity first for review.
 */
export const orderClosingDateReviewCandidates = (
  candidates: readonly RankedResolutionCandidate[],
): readonly RankedResolutionCandidate[] => {
  const wanrong: RankedResolutionCandidate[] = [];
  const otherSuppliers: RankedResolutionCandidate[] = [];
  candidates.forEach(candidate => {
    if (candidate.source.sourceSupplier === 'wanrong') wanrong.push(candidate);
    else otherSuppliers.push(candidate);
  });
  return [...wanrong, ...otherSuppliers];
};
