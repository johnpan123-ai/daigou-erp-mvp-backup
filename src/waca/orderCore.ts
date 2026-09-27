/** Isolated WACA order domain. It never invokes ERP providers. */
export type WacaStatus = '處理中' | '完成付款' | '取消' | '失敗';

export interface WacaRow {
  orderStatus: string;
  orderNumber: string;
  purchasedAt: string;
  productCode: string;
  productTitle: string;
  spec1: string;
  spec2: string;
  specCode: string;
  quantity: number;
  subtotal: number;
}

export interface MasterVariant {
  mainCode: string;
  childCode: string;
  variantId: string;
  productGroupId: string;
  productTitle: string;
  variantTitle: string;
  active: boolean;
  sourceFile?: string;
}

export interface WacaMapping {
  feature: string;
  myacgMainId: string;
  myacgVariantId: string;
  productVariantId: string;
  method: 'AUTO' | 'MANUAL';
  confirmedAt: string;
  historicalProductTitle: string;
  historicalVariantTitle: string;
  masterStatus: 'ACTIVE' | 'MISSING_FROM_LATEST_MASTER';
}

export interface WacaOrder {
  key: string;
  orderNumber: string;
  status: WacaStatus;
  purchasedAt: string;
}

export interface WacaItem {
  key: string;
  orderKey: string;
  feature: string;
  productCode: string;
  productTitle: string;
  spec1: string;
  spec2: string;
  specCode: string;
  quantity: number;
  subtotal: number;
  productVariantId: string | null;
  match: 'AUTO_MATCH' | 'MANUAL_MATCH' | 'UNMATCHED' | 'MANUAL_REVIEW';
  diagnostic: 'MASTER_EVIDENCE_MISSING' | 'MASTER_GROUP_LINK_MISSING' | 'VARIANT_NOT_MATCHED'
    | 'MULTIPLE_VARIANT_CANDIDATES' | 'VARIANT_NOT_IN_ERP' | 'PRODUCT_NOT_IN_MASTER' | 'NAME_CONFLICT' | null;
}

export interface WacaRepository {
  orders: Map<string, WacaOrder>;
  items: Map<string, WacaItem>;
  mappings: Map<string, WacaMapping>;
  manualAdjustments: Map<string, number>;
  autoQuantities: Map<string, number>;
  importHistory: Array<{ id: string; rows: number; inserted: number; updated: number; unchanged: number }>;
}

export function cloneWacaRepository(repo: WacaRepository): WacaRepository {
  return {
    orders: new Map([...repo.orders].map(([key, row]) => [key, { ...row }])),
    items: new Map([...repo.items].map(([key, row]) => [key, { ...row }])),
    mappings: new Map([...repo.mappings].map(([key, row]) => [key, { ...row }])),
    manualAdjustments: new Map(repo.manualAdjustments),
    autoQuantities: new Map(repo.autoQuantities),
    importHistory: repo.importHistory.map(row => ({ ...row })),
  };
}

export const createWacaRepository = (): WacaRepository => ({
  orders: new Map(), items: new Map(), mappings: new Map(), manualAdjustments: new Map(),
  autoQuantities: new Map(), importHistory: [],
});

/** Only width, whitespace and English case are normalized; meaning-bearing text survives. */
export const normalizeWacaText = (value: string): string =>
  String(value ?? '')
    .replace(/[\uFF61-\uFF9F]+/gu, segment => segment.normalize('NFKC'))
    .replace(/[\uFF01-\uFF5E]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/gu, ' ').trim().replace(/[a-z]/gu, character => character.toUpperCase());

export const wacaFeature = (row: Pick<WacaRow, 'productCode' | 'productTitle' | 'spec1' | 'spec2'>): string =>
  JSON.stringify([row.productCode, row.productTitle, row.spec1, row.spec2].map(normalizeWacaText));

export const isWacaDiscount = (row: WacaRow): boolean =>
  normalizeWacaText(row.productCode) === 'COUPON'
  || normalizeWacaText(row.productTitle) === 'HIPPOSEP60'
  || normalizeWacaText(row.spec1) === normalizeWacaText('小河馬09月份60元折扣券');

const validStatuses = new Set<WacaStatus>(['處理中', '完成付款', '取消', '失敗']);
export const parseWacaStatus = (status: string): WacaStatus => {
  const value = normalizeWacaText(status) as WacaStatus;
  if (!validStatuses.has(value)) throw new Error(`WACA_STATUS_UNSUPPORTED:${value}`);
  return value;
};

export const isEffectiveWacaStatus = (status: WacaStatus): boolean =>
  status === '處理中' || status === '完成付款';

export interface WacaMatch {
  kind: 'AUTO_MATCH' | 'UNMATCHED' | 'MANUAL_REVIEW';
  candidate: MasterVariant | null;
  candidates: MasterVariant[];
  diagnostic: WacaItem['diagnostic'];
}

const specification = (value: string): string => normalizeWacaText(value)
  .replace(/[\s\u3000/／・·.．,，:：()（）【】_-]+/gu, '').replaceAll('[', '').replaceAll(']', '');

const matchingSpec = (row: WacaRow, candidates: readonly MasterVariant[]): MasterVariant[] => {
  const wanted = [row.spec1, row.spec2].map(specification).filter(Boolean).join('');
  if (!wanted) return [...candidates];
  return candidates.filter(candidate => specification(candidate.variantTitle) === wanted);
};

const verifiesTitle = (row: WacaRow, candidate: MasterVariant): boolean => {
  // Seller punctuation and spacing may differ across platforms; words, digits and signs do not.
  const title = (value: string) => normalizeWacaText(value).replace(/[\s\u3000、,，。・·]+/gu, '');
  const wanted = title(row.productTitle);
  const actual = title(candidate.productTitle);
  return !wanted || !actual || wanted === actual || wanted.includes(actual) || actual.includes(wanted);
};

export function matchWacaItem(row: WacaRow, master: readonly MasterVariant[], completeMaster = false): WacaMatch {
  const code = normalizeWacaText(row.productCode);
  const direct = master.filter(item => normalizeWacaText(item.childCode) === code && item.active);
  if (code.startsWith('G') && !code.startsWith('GP')) {
    if (!direct.length) return { kind: 'UNMATCHED', candidate: null, candidates: [], diagnostic: 'VARIANT_NOT_IN_ERP' };
    const resolved = direct.filter(item => item.variantId);
    if (!resolved.length) return { kind: 'UNMATCHED', candidate: null, candidates: direct, diagnostic: 'VARIANT_NOT_IN_ERP' };
    if (resolved.length !== 1) return { kind: 'MANUAL_REVIEW', candidate: null, candidates: resolved, diagnostic: 'MULTIPLE_VARIANT_CANDIDATES' };
    return { kind: 'AUTO_MATCH', candidate: resolved[0], candidates: resolved,
      diagnostic: resolved[0].mainCode && !resolved[0].productGroupId ? 'MASTER_GROUP_LINK_MISSING' : null };
  }
  const scoped = master.filter(item => normalizeWacaText(item.mainCode) === code && item.active);
  if (!scoped.length) return { kind: 'UNMATCHED', candidate: null, candidates: [],
    diagnostic: completeMaster ? 'PRODUCT_NOT_IN_MASTER' : 'MASTER_EVIDENCE_MISSING' };
  const specMatches = matchingSpec(row, scoped);
  if (!specMatches.length) return { kind: 'UNMATCHED', candidate: null, candidates: scoped, diagnostic: 'VARIANT_NOT_MATCHED' };
  const verified = specMatches.filter(item => verifiesTitle(row, item));
  if (!verified.length) return { kind: 'UNMATCHED', candidate: null, candidates: specMatches, diagnostic: 'NAME_CONFLICT' };
  if (verified.length !== 1) return { kind: 'MANUAL_REVIEW', candidate: null, candidates: verified, diagnostic: 'MULTIPLE_VARIANT_CANDIDATES' };
  if (!verified[0].variantId) return { kind: 'UNMATCHED', candidate: null, candidates: verified, diagnostic: 'VARIANT_NOT_IN_ERP' };
  return { kind: 'AUTO_MATCH', candidate: verified[0], candidates: verified,
    diagnostic: !verified[0].productGroupId ? 'MASTER_GROUP_LINK_MISSING' : null };
}

export const wacaOrderKey = (orderNumber: string): string => `WACA::${normalizeWacaText(orderNumber)}`;
const itemKey = (order: string, feature: string): string => `${order}::${feature}`;

export function recomputeWacaQuantities(repo: WacaRepository): Map<string, number> {
  const next = new Map<string, number>();
  for (const item of repo.items.values()) {
    const order = repo.orders.get(item.orderKey);
    if (!item.productVariantId || !order || !isEffectiveWacaStatus(order.status)) continue;
    next.set(item.productVariantId, (next.get(item.productVariantId) ?? 0) + item.quantity);
  }
  repo.autoQuantities = next;
  return next;
}

export const wacaDisplayQuantity = (repo: WacaRepository, variantId: string): number =>
  (repo.autoQuantities.get(variantId) ?? 0) + (repo.manualAdjustments.get(variantId) ?? 0);

export function setWacaMapping(repo: WacaRepository, mapping: WacaMapping): void {
  repo.mappings.set(mapping.feature, mapping);
  for (const item of repo.items.values()) {
    if (item.feature !== mapping.feature) continue;
    item.productVariantId = mapping.productVariantId;
    item.match = mapping.method === 'MANUAL' ? 'MANUAL_MATCH' : 'AUTO_MATCH';
    item.diagnostic = null;
  }
  recomputeWacaQuantities(repo);
}

export function refreshWacaMasterStatus(repo: WacaRepository, master: readonly MasterVariant[]): void {
  const active = new Set(master.filter(item => item.active).map(item => item.variantId));
  for (const mapping of repo.mappings.values()) {
    mapping.masterStatus = active.has(mapping.productVariantId) ? 'ACTIVE' : 'MISSING_FROM_LATEST_MASTER';
  }
}

export interface WacaImportResult {
  ordersTotal: number;
  effectiveOrders: number;
  cancelledOrders: number;
  failedOrders: number;
  productRows: number;
  effectiveQuantity: number;
  discountIgnored: number;
  inserted: number;
  updated: number;
  unchanged: number;
  matched: number;
  unmatched: number;
  multipleCandidates: number;
  mappingMissing: number;
  statusConflicts: string[];
  errors: string[];
  quantityChanges: Array<{ variantId: string; before: number; after: number }>;
  matchedEffectiveQuantity: number;
  unmatchedPendingQuantity: number;
}

/** A file is a keyed snapshot upsert, never an increment over prior imports. */
export function importWacaRows(
  rows: readonly WacaRow[], repo: WacaRepository, master: readonly MasterVariant[], importId: string,
): WacaImportResult {
  const grouped = new Map<string, WacaRow[]>();
  const errors: string[] = [];
  let discountIgnored = 0;
  for (const row of rows) {
    const discount = isWacaDiscount(row);
    if (discount) discountIgnored += 1;
    if (!row.orderNumber.trim() || (!discount && (!row.productCode.trim() || !Number.isSafeInteger(row.quantity) || row.quantity < 0))) {
      errors.push('WACA_ROW_INVALID'); continue;
    }
    try { parseWacaStatus(row.orderStatus); } catch { errors.push('WACA_STATUS_UNSUPPORTED'); continue; }
    const key = wacaOrderKey(row.orderNumber);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const before = new Map(repo.autoQuantities);
  let inserted = 0, updated = 0, unchanged = 0, matched = 0, unmatched = 0, multipleCandidates = 0, mappingMissing = 0;
  const statusConflicts: string[] = [];
  const importedItemKeys = new Set<string>();
  for (const [key, orderRows] of grouped) {
    const statuses = new Set(orderRows.map(row => parseWacaStatus(row.orderStatus)));
    if (statuses.size !== 1) { statusConflicts.push(key); continue; }
    const status = [...statuses][0];
    const order: WacaOrder = { key, orderNumber: orderRows[0].orderNumber, status, purchasedAt: orderRows[0].purchasedAt };
    const oldOrder = repo.orders.get(key);
    repo.orders.set(key, order);
    const itemsByFeature = new Map<string, WacaRow>();
    for (const row of orderRows) {
      if (isWacaDiscount(row)) continue;
      const feature = wacaFeature(row);
      const prior = itemsByFeature.get(feature);
      itemsByFeature.set(feature, prior
        ? { ...prior, quantity: prior.quantity + row.quantity, subtotal: prior.subtotal + row.subtotal }
        : { ...row });
    }
    for (const [feature, row] of itemsByFeature) {
      const keyForItem = itemKey(key, feature);
      importedItemKeys.add(keyForItem);
      const mapping = repo.mappings.get(feature);
      const match = mapping ? null : matchWacaItem(row, master);
      const productVariantId = mapping?.productVariantId ?? match?.candidate?.variantId ?? null;
      const matchKind = mapping ? (mapping.method === 'MANUAL' ? 'MANUAL_MATCH' : 'AUTO_MATCH') : match!.kind;
      const item: WacaItem = {
        key: keyForItem, orderKey: key, feature, productCode: row.productCode, productTitle: row.productTitle,
        spec1: row.spec1, spec2: row.spec2, specCode: row.specCode, quantity: row.quantity, subtotal: row.subtotal,
        productVariantId, match: matchKind, diagnostic: match?.diagnostic ?? null,
      };
      const prior = repo.items.get(keyForItem);
      if (!prior) inserted += 1;
      else if (JSON.stringify(prior) !== JSON.stringify(item) || oldOrder?.status !== status) updated += 1;
      else unchanged += 1;
      repo.items.set(keyForItem, item);
      if (matchKind === 'UNMATCHED') unmatched += 1;
      else if (matchKind === 'MANUAL_REVIEW') multipleCandidates += 1;
      else matched += 1;
      if (item.diagnostic === 'MASTER_EVIDENCE_MISSING') mappingMissing += 1;
      if (matchKind === 'AUTO_MATCH' && !mapping && match?.candidate) {
        repo.mappings.set(feature, {
          feature, myacgMainId: match.candidate.mainCode, myacgVariantId: match.candidate.childCode,
          productVariantId: match.candidate.variantId, method: 'AUTO', confirmedAt: importId,
          historicalProductTitle: row.productTitle, historicalVariantTitle: match.candidate.variantTitle,
          masterStatus: 'ACTIVE',
        });
      }
    }
  }
  recomputeWacaQuantities(repo);
  const quantityChanges = [...new Set([...before.keys(), ...repo.autoQuantities.keys()])].sort().map(variantId => ({
    variantId, before: before.get(variantId) ?? 0, after: repo.autoQuantities.get(variantId) ?? 0,
  })).filter(item => item.before !== item.after);
  repo.importHistory.push({ id: importId, rows: rows.length, inserted, updated, unchanged });
  const applicable = [...repo.items.values()].filter(item => {
    const order = repo.orders.get(item.orderKey);
    return importedItemKeys.has(item.key) && order && isEffectiveWacaStatus(order.status) && !statusConflicts.includes(item.orderKey);
  });
  const matchedEffectiveQuantity = applicable.filter(item => item.productVariantId).reduce((sum, item) => sum + item.quantity, 0);
  const unmatchedPendingQuantity = applicable.filter(item => !item.productVariantId).reduce((sum, item) => sum + item.quantity, 0);
  return {
    ordersTotal: grouped.size, effectiveOrders: [...grouped.keys()].filter(key => repo.orders.has(key) && isEffectiveWacaStatus(repo.orders.get(key)!.status) && !statusConflicts.includes(key)).length,
    cancelledOrders: [...grouped.keys()].filter(key => repo.orders.get(key)?.status === '取消' && !statusConflicts.includes(key)).length,
    failedOrders: [...grouped.keys()].filter(key => repo.orders.get(key)?.status === '失敗' && !statusConflicts.includes(key)).length,
    productRows: rows.length - discountIgnored, effectiveQuantity: matchedEffectiveQuantity + unmatchedPendingQuantity,
    discountIgnored, inserted, updated, unchanged, matched, unmatched, multipleCandidates, mappingMissing,
    statusConflicts, errors, quantityChanges, matchedEffectiveQuantity, unmatchedPendingQuantity,
  };
}
