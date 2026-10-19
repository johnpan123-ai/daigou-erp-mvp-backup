import type { WacaVariantCountedPreview } from './countedImport';

/** Presentation only. Never use filtered rows to build a counted plan or commit payload. */
export const hasWacaPreviewReview = (row: WacaVariantCountedPreview | undefined): boolean => Boolean(row
  && (row.pendingQuantity > 0 || row.uncertainItems > 0 || row.baselineChangedItems > 0));

export function isWacaCountedReviewRowVisible(options: {
  initial: WacaVariantCountedPreview | undefined;
  current: WacaVariantCountedPreview | undefined;
  onlyChanged: boolean;
  includeReview: boolean;
  modeChosen: boolean;
  riskyOverwrite: boolean;
}): boolean {
  const { initial, current, onlyChanged, includeReview, modeChosen, riskyOverwrite } = options;
  if (!onlyChanged) return true;
  // Keep original preview membership and explicitly edited specs. A KEEP decision must not
  // remove its own control, and confirming a pending order must not move/close the group.
  if (modeChosen || (initial?.difference ?? 0) !== 0 || (current?.difference ?? 0) !== 0) return true;
  return includeReview && (hasWacaPreviewReview(initial) || hasWacaPreviewReview(current) || riskyOverwrite);
}
