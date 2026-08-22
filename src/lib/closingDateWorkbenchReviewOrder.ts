import type { RankedResolutionCandidate } from './closingDateResolutionDomain';

/**
 * Supplier priority is intentionally scoped to candidates that already share
 * an explicit resolution identity. It must never move an unrelated Wanrong
 * listing ahead of a different DreamLink product.
 */
export const orderClosingDateReviewCandidates = (
  candidates: readonly RankedResolutionCandidate[],
): readonly RankedResolutionCandidate[] => {
  const ordered = [...candidates];
  const positionsByIdentity = new Map<string, number[]>();
  ordered.forEach((candidate, index) => {
    if (!candidate.resolutionIdentityId) return;
    const positions = positionsByIdentity.get(candidate.resolutionIdentityId) ?? [];
    positions.push(index);
    positionsByIdentity.set(candidate.resolutionIdentityId, positions);
  });
  positionsByIdentity.forEach(positions => {
    if (positions.length < 2) return;
    const sameIdentity = positions.map(index => ordered[index]).sort((left, right) => {
      const supplierPriority = (candidate: RankedResolutionCandidate): number => (
        candidate.source.sourceSupplier.toLowerCase() === 'wanrong' ? 0 : 1
      );
      return supplierPriority(left) - supplierPriority(right) || left.rank - right.rank;
    });
    positions.forEach((position, index) => {
      ordered[position] = sameIdentity[index];
    });
  });
  return ordered;
};
