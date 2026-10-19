/**
 * WACA transition import (counted contract, server RPC erp_commit_waca_counted_snapshot / 073).
 *
 * Every WACA order item carries `countedQuantity`: the part already reflected in the Purchase
 * Records WACA quantity. The server keeps waca_auto_quantity = ledger total and moves the
 * difference into waca_manual_adjustment so that, per variant,
 *   OVERWRITE : display = ledger total (all items fully counted, manual = 0)
 *   ACCUMULATE: display = before + net newly recognized quantity (valid imports, no conflict)
 *   KEEP      : display = before (new orders stay pending, nothing is lost)
 * The same order can never be counted twice because countedQuantity survives re-imports.
 * Pure module: no provider, no persistence.
 */
import {
  isEffectiveWacaStatus, type WacaCountedReason, type WacaItem, type WacaRepository,
} from './orderCore';
import type { ProductVariant } from '../lib/db';

export type WacaUpdateMode = 'OVERWRITE' | 'ACCUMULATE' | 'KEEP';
export type WacaOverlapChoice = 'COUNT_AS_NEW' | 'BASELINE_INCLUDED' | 'PENDING';
export const WACA_COUNTED_CONTRACT = 'waca-counted-import-v1' as const;

export interface WacaTransitionContext {
  /** Current Restore epoch (erp_cloud_restore_epoch.epoch); the plan is bound to it. */
  restoreEpoch: number;
  /** Historical audit timestamp only. NEVER a boundary for normal import recognition. */
  baselineAt: string;
  /** Ledger already ORDER_DRIVEN_ACTIVE (legacy items without countedQuantity count fully). */
  driven: boolean;
}

export type WacaCountedItemState = 'COUNTED' | 'PENDING' | 'BASELINE' | 'UNMATCHED';

export interface WacaCountedItemPreview {
  key: string;
  orderNumber: string;
  purchasedAt: string;
  variantId: string | null;
  effectiveQuantity: number;
  countedBefore: number;
  countedAfter: number;
  reason: WacaCountedReason;
  state: WacaCountedItemState;
  /** Concrete unresolved evidence / explicit hold; not an order-date heuristic. */
  overlapUncertain: boolean;
  /** An order already contained in the ERP1 baseline changed quantity/status. */
  baselineChanged: boolean;
  isNew: boolean;
  afterBaseline: boolean;
  inFile: boolean;
}

export interface WacaVariantCountedPreview {
  variantId: string;
  mode: WacaUpdateMode;
  displayBefore: number;
  autoBefore: number;
  manualBefore: number;
  ledgerAfter: number;
  countedBefore: number;
  countedAfter: number;
  /** Quantity newly reflected by this import (countedAfter - countedBefore). */
  countedDelta: number;
  displayAfter: number;
  manualAfter: number;
  difference: number;
  pendingQuantity: number;
  uncertainItems: number;
  baselineChangedItems: number;
  /** In-file normal orders newly recognized by ACCUMULATE (independent of Restore date). */
  newCountableQuantity: number;
  touched: boolean;
  items: WacaCountedItemPreview[];
}

export interface WacaCountedPlan {
  contract: typeof WACA_COUNTED_CONTRACT;
  restoreEpoch: number;
  overwriteVariantIds: string[];
  expectedDisplay: Record<string, { before: number; after: number }>;
}

export interface WacaCountedImportResult {
  items: Map<string, WacaItem>;
  variants: Map<string, WacaVariantCountedPreview>;
  plan: WacaCountedPlan;
  /** OVERWRITE rows whose quantity goes down, or any OVERWRITE before the transition baseline exists. */
  riskyOverwrites: string[];
}

const COUNTED_REASONS = new Set<WacaCountedReason>(['LEGACY_COUNTED', 'NEW_AFTER_BASELINE', 'NORMAL_IMPORT', 'OWNER_CONFIRMED_NEW',
  'SOURCE_CHANGE_APPLIED', 'OVERWRITE']);

const effective = (item: WacaItem | undefined, repo: WacaRepository): number => {
  if (!item) return 0;
  const order = repo.orders.get(item.orderKey);
  return order && isEffectiveWacaStatus(order.status) ? item.quantity : 0;
};

/** Counted quantity of a stored item, with the same legacy default as the server (073). */
export const storedCountedQuantity = (item: WacaItem, repo: WacaRepository, driven: boolean): number =>
  item.countedQuantity ?? (driven ? effective(item, repo) : 0);

/** WACA exports Taiwan local time (YYYY/MM/DD HH:mm[:ss]); ISO strings keep their own offset. */
export const parseWacaOrderTime = (value: string): number => {
  const raw = String(value ?? '').trim();
  const local = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u);
  if (local) {
    const [, y, mo, d, h = '0', mi = '0', se = '0'] = local;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(se));
  }
  return /[zZ]|[+-]\d{2}:?\d{2}$/u.test(raw) ? Date.parse(raw) : Number.NaN;
};

// Audit display only: dates are not proof that an order was (or was not) counted.
const placedAfter = (purchasedAt: string, baselineAt: string): boolean => {
  const placed = parseWacaOrderTime(purchasedAt);
  const baseline = Date.parse(baselineAt);
  return Number.isFinite(placed) && Number.isFinite(baseline) && placed > baseline;
};

export function planWacaCountedImport(options: {
  variants: readonly ProductVariant[];
  current: WacaRepository;
  candidate: WacaRepository;
  context: WacaTransitionContext;
  /** Item keys present in this import file (OVERWRITE never touches variants absent from it). */
  importedKeys: ReadonlySet<string>;
  modes?: ReadonlyMap<string, WacaUpdateMode>;
  defaultMode?: WacaUpdateMode;
  overlapChoices?: ReadonlyMap<string, WacaOverlapChoice>;
  actor: string;
}): WacaCountedImportResult {
  const { variants, current, candidate, context, importedKeys, actor } = options;
  const defaultMode = options.defaultMode ?? 'ACCUMULATE';
  const variantById = new Map(variants.map(row => [row.id, row]));
  const touchedVariants = new Set<string>();
  for (const key of importedKeys) {
    const id = candidate.items.get(key)?.productVariantId;
    if (id) touchedVariants.add(id);
  }
  const modeFor = (variantId: string): WacaUpdateMode => touchedVariants.has(variantId)
    ? options.modes?.get(variantId) ?? defaultMode : options.modes?.get(variantId) ?? 'ACCUMULATE';

  const items = new Map<string, WacaItem>();
  const previews: WacaCountedItemPreview[] = [];
  for (const item of candidate.items.values()) {
    const prior = current.items.get(item.key);
    const q = effective(item, candidate);
    const priorQ = effective(prior, current);
    const cBefore = prior ? storedCountedQuantity(prior, current, context.driven) : 0;
    const priorReason: WacaCountedReason | undefined = prior?.countedReason
      ?? (prior && context.driven ? 'LEGACY_COUNTED' : undefined);
    const order = candidate.orders.get(item.orderKey);
    const afterBaseline = placedAfter(order?.purchasedAt ?? '', context.baselineAt);
    let c = cBefore;
    let reason: WacaCountedReason = priorReason ?? 'PENDING_REVIEW';
    let overlapUncertain = false;
    let baselineChanged = false;
    let review = prior?.countedReview;
    if (priorReason === 'BASELINE_INCLUDED' && q !== priorQ) review = 'BASELINE_SOURCE_CHANGED';
    const recognized = Boolean(prior) && priorReason !== undefined && COUNTED_REASONS.has(priorReason);
    // Positive counted evidence with no recognized provenance is contradictory, not a new order.
    // Likewise losing an already counted SKU must not silently turn into a cancellation.
    if ((cBefore > 0 && !recognized) || (cBefore > 0 && !item.productVariantId)) {
      throw new Error(`WACA_COUNTED_HISTORY_CONFLICT:${item.key}`);
    }
    if (item.productVariantId) {
      const mode = modeFor(item.productVariantId);
      if (prior?.recognition) {
        // A durable line decision is stronger than this file's quantity update mode.
        // Changing it requires the dedicated, server-reviewed management transaction.
        if (item.productVariantId !== prior.productVariantId) throw new Error('WACA_MANAGED_IDENTITY_CHANGED');
        if (prior.recognition.mode !== 'COUNT') {
          if (mode === 'OVERWRITE' && q > 0) throw new Error('WACA_MANAGED_OVERWRITE_CONFLICT');
          c = 0; reason = prior.recognition.mode === 'INCLUDED' ? 'BASELINE_INCLUDED' : 'PENDING_REVIEW';
          if (item.quantity !== prior.recognition.sourceQuantity || order?.status !== prior.recognition.sourceStatus) review = 'OWNER_SOURCE_CHANGED';
          overlapUncertain = review === 'OWNER_SOURCE_CHANGED';
        } else if (mode !== 'KEEP') {
          if (q !== cBefore && prior.recognition.restoreEpoch !== context.restoreEpoch) throw new Error('WACA_MANAGED_RESTORE_REVIEW_REQUIRED');
          c = q; reason = q === cBefore ? priorReason! : 'SOURCE_CHANGE_APPLIED';
        }
      } else if (!touchedVariants.has(item.productVariantId)) {
        // Variants absent from this file are never re-decided: counted orders follow their source,
        // pending / kept / baseline orders keep their recorded state until a later import or decision.
        const choice = options.overlapChoices?.get(item.key);
        if (choice === 'COUNT_AS_NEW') { c = q; reason = 'OWNER_CONFIRMED_NEW'; review = undefined; }
        else if (choice === 'BASELINE_INCLUDED') { c = 0; reason = 'BASELINE_INCLUDED'; review = undefined; }
        else if (recognized) { c = q; reason = q === cBefore ? priorReason! : 'SOURCE_CHANGE_APPLIED'; }
        else { c = cBefore; reason = priorReason ?? 'PENDING_REVIEW'; overlapUncertain = q > c && reason !== 'BASELINE_INCLUDED' && reason !== 'KEPT'; }
      } else if (mode === 'OVERWRITE') {
        c = q; reason = 'OVERWRITE'; review = undefined;
      } else if (mode === 'KEEP') {
        // KEEP defers a source change, but must not erase the origin of a previously counted item.
        c = cBefore; reason = recognized || review ? priorReason ?? 'PENDING_REVIEW'
          : priorReason === 'BASELINE_INCLUDED' ? 'BASELINE_INCLUDED' : 'KEPT';
      } else if (recognized) {
        // Already counted orders follow their source (quantity change / cancellation), exactly once.
        c = q; reason = q === cBefore ? priorReason! : 'SOURCE_CHANGE_APPLIED';
      } else {
        const choice = options.overlapChoices?.get(item.key);
        const inFile = importedKeys.has(item.key);
        if (choice === 'COUNT_AS_NEW') { c = q; reason = 'OWNER_CONFIRMED_NEW'; review = undefined; }
        else if (choice === 'BASELINE_INCLUDED') { c = 0; reason = 'BASELINE_INCLUDED'; review = undefined; }
        else if (priorReason === 'BASELINE_INCLUDED') {
          c = 0; reason = 'BASELINE_INCLUDED';
          if (q !== priorQ) review = 'BASELINE_SOURCE_CHANGED';
        } else if (!inFile || choice === 'PENDING' || review) {
          // Pending / kept orders absent from this file keep their recorded state.
          c = cBefore; reason = priorReason ?? 'PENDING_REVIEW'; overlapUncertain = q > c && reason !== 'KEPT';
          if (choice === 'PENDING') review = 'OWNER_HOLD';
        } else if (q === 0 && ((prior && priorQ > 0)
          || Number(variantById.get(item.productVariantId)?.waca_manual_adjustment ?? 0) > 0)) {
          // A cancellation with historical quantity but no receipt is not evidence for a deduction.
          c = cBefore; reason = 'PENDING_REVIEW'; review = 'UNPROVEN_CANCELLATION';
        } else {
          // Owner policy 2026-10-19: valid, uniquely mapped in-file orders count normally.
          // Empty ledger and Restore/order timestamps prove neither inclusion nor exclusion.
          c = q; reason = 'NORMAL_IMPORT';
        }
      }
      baselineChanged = review === 'BASELINE_SOURCE_CHANGED' || review === 'UNPROVEN_CANCELLATION' || review === 'OWNER_SOURCE_CHANGED';
    }
    const next: WacaItem = { ...item, countedQuantity: c, countedReason: reason,
      countedReview: review,
      countedBy: c !== cBefore || reason !== priorReason ? actor : item.countedBy ?? prior?.countedBy ?? actor };
    items.set(item.key, next);
    previews.push({
      key: item.key, orderNumber: order?.orderNumber ?? item.orderKey.replace(/^WACA::/u, ''),
      purchasedAt: order?.purchasedAt ?? '', variantId: item.productVariantId, effectiveQuantity: q,
      countedBefore: cBefore, countedAfter: c, reason,
      state: !item.productVariantId ? 'UNMATCHED' : reason === 'BASELINE_INCLUDED' ? 'BASELINE' : review || c !== q ? 'PENDING' : 'COUNTED',
      overlapUncertain, baselineChanged, isNew: !prior, afterBaseline, inFile: importedKeys.has(item.key),
    });
  }

  // Per-variant aggregates (before uses the stored mapping, after the candidate mapping).
  const countedBefore = new Map<string, number>();
  for (const item of current.items.values()) {
    if (!item.productVariantId) continue;
    countedBefore.set(item.productVariantId, (countedBefore.get(item.productVariantId) ?? 0)
      + storedCountedQuantity(item, current, context.driven));
  }
  const after = new Map<string, { q: number; c: number; items: WacaCountedItemPreview[] }>();
  for (const preview of previews) {
    if (!preview.variantId) continue;
    const row = after.get(preview.variantId) ?? { q: 0, c: 0, items: [] };
    row.q += preview.effectiveQuantity; row.c += preview.countedAfter; row.items.push(preview);
    after.set(preview.variantId, row);
  }
  const variantsOut = new Map<string, WacaVariantCountedPreview>();
  const expectedDisplay: WacaCountedPlan['expectedDisplay'] = {};
  const overwriteVariantIds: string[] = [];
  const riskyOverwrites: string[] = [];
  for (const id of new Set([...countedBefore.keys(), ...after.keys()])) {
    const variant = variantById.get(id);
    if (!variant) throw new Error(`WACA_COUNTED_VARIANT_MISSING:${id}`);
    const mode = modeFor(id);
    const autoBefore = Number(variant.waca_auto_quantity ?? 0);
    const manualBefore = Number(variant.waca_manual_adjustment ?? 0);
    const displayBefore = autoBefore + manualBefore;
    const a = after.get(id) ?? { q: 0, c: 0, items: [] };
    const cBefore = countedBefore.get(id) ?? 0;
    const overwrite = mode === 'OVERWRITE' && touchedVariants.has(id);
    const displayAfter = overwrite ? a.q : displayBefore + a.c - cBefore;
    const manualAfter = displayAfter - a.q;
    // Same rule as the server (073): a counted import never produces a negative WACA demand.
    if (displayAfter < 0) throw new Error(`WACA_COUNTED_NEGATIVE_DISPLAY:${id}`);
    const preview: WacaVariantCountedPreview = {
      variantId: id, mode, displayBefore, autoBefore, manualBefore, ledgerAfter: a.q,
      countedBefore: cBefore, countedAfter: a.c, countedDelta: a.c - cBefore, displayAfter, manualAfter,
      difference: displayAfter - displayBefore,
      pendingQuantity: a.items.reduce((sum, row) => sum + Math.max(0, row.effectiveQuantity - row.countedAfter), 0)
        - a.items.filter(row => row.state === 'BASELINE').reduce((sum, row) => sum + row.effectiveQuantity, 0),
      uncertainItems: a.items.filter(row => row.overlapUncertain && row.state === 'PENDING').length,
      baselineChangedItems: a.items.filter(row => row.baselineChanged).length,
      newCountableQuantity: a.items.filter(row => row.inFile && row.reason === 'NORMAL_IMPORT' && row.state === 'COUNTED')
        .reduce((sum, row) => sum + Math.max(0, row.effectiveQuantity - row.countedBefore), 0),
      touched: touchedVariants.has(id), items: a.items,
    };
    variantsOut.set(id, preview);
    if (overwrite) {
      overwriteVariantIds.push(id);
      if (displayAfter < displayBefore || !context.driven) riskyOverwrites.push(id);
    }
    if (overwrite || a.q !== autoBefore || manualAfter !== manualBefore) {
      expectedDisplay[id] = { before: displayBefore, after: displayAfter };
    }
  }
  return {
    items, variants: variantsOut, riskyOverwrites,
    plan: { contract: WACA_COUNTED_CONTRACT, restoreEpoch: context.restoreEpoch,
      overwriteVariantIds: overwriteVariantIds.sort(), expectedDisplay },
  };
}

/** Re-applies counted planning to a repository in place (items replaced by their counted version). */
export function applyCountedItems(candidate: WacaRepository, result: WacaCountedImportResult): WacaRepository {
  candidate.items = new Map([...candidate.items.keys()].map(key => [key, result.items.get(key)!]));
  return candidate;
}

/** Transition context from the stored cutover state plus the current Restore epoch. */
export function wacaTransitionContext(
  cutoverState: { mode?: string; transition?: { baselineAt?: string; restoreEpoch?: number } } | undefined,
  epoch: { epoch: number; restoredAt: string | null },
  now: string,
): WacaTransitionContext {
  const driven = cutoverState?.mode === 'ORDER_DRIVEN_ACTIVE';
  const established = cutoverState?.transition;
  return {
    restoreEpoch: epoch.epoch,
    // Preserve historical audit metadata. Recognition never infers inclusion from this timestamp.
    baselineAt: established?.baselineAt ?? epoch.restoredAt ?? now,
    driven,
  };
}
