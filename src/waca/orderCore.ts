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
    | 'MULTIPLE_VARIANT_CANDIDATES' | 'VARIANT_NOT_IN_ERP' | 'PRODUCT_NOT_IN_MASTER' | 'NAME_CONFLICT'
    | 'SPEC_CODE_MISSING' | 'SPEC_CODE_CONFLICT' | null;
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

const legacyWacaFeature = (row: Pick<WacaRow, 'productCode' | 'productTitle' | 'spec1' | 'spec2'>): string =>
  JSON.stringify([row.productCode, row.productTitle, row.spec1, row.spec2].map(normalizeWacaText));

// Keep both source codes: identical parent/name labels must not collapse two SKUs.
export const wacaFeature = (row: Pick<WacaRow, 'productCode' | 'productTitle' | 'spec1' | 'spec2' | 'specCode'>): string =>
  JSON.stringify([row.productCode, row.productTitle, row.spec1, row.spec2, row.specCode].map(normalizeWacaText));

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

const verifiesTitle = (row: Pick<WacaRow, 'productTitle'>, candidate: MasterVariant): boolean => {
  // Seller punctuation and spacing may differ across platforms; words, digits and signs do not.
  const title = (value: string) => normalizeWacaText(value).replace(/[\s\u3000、,，。・·]+/gu, '');
  const wanted = title(row.productTitle);
  const actual = title(candidate.productTitle);
  return !wanted || !actual || wanted === actual || wanted.includes(actual) || actual.includes(wanted);
};

export function matchWacaItem(
  row: Pick<WacaRow, 'specCode' | 'productTitle' | 'spec1' | 'spec2'>, master: readonly MasterVariant[],
): WacaMatch {
  // 商品編號 is parent evidence only. A missing 規格編號 is never guessed.
  const code = normalizeWacaText(row.specCode);
  if (!code) return { kind: 'UNMATCHED', candidate: null, candidates: [], diagnostic: 'SPEC_CODE_MISSING' };
  const direct = master.filter(item => normalizeWacaText(item.childCode) === code && item.active);
  const resolved = direct.filter(item => item.variantId);
  if (!resolved.length) return { kind: 'UNMATCHED', candidate: null, candidates: direct, diagnostic: 'VARIANT_NOT_IN_ERP' };
  if (resolved.length !== 1) return { kind: 'MANUAL_REVIEW', candidate: null, candidates: resolved, diagnostic: 'MULTIPLE_VARIANT_CANDIDATES' };
  const candidate = resolved[0];
  const wantedSpec = [row.spec1, row.spec2].map(specification).filter(Boolean).join('');
  const nameConflict = !verifiesTitle(row, candidate)
    || Boolean(wantedSpec && specification(candidate.variantTitle) && wantedSpec !== specification(candidate.variantTitle));
  return { kind: 'AUTO_MATCH', candidate, candidates: resolved,
    diagnostic: nameConflict ? 'NAME_CONFLICT'
      : candidate.mainCode && !candidate.productGroupId ? 'MASTER_GROUP_LINK_MISSING' : null };
}

function resolveWacaItem(item: WacaItem, repo: WacaRepository, master: readonly MasterVariant[], importId: string): void {
  const code = normalizeWacaText(item.specCode);
  const mapping = repo.mappings.get(item.feature);
  const match = matchWacaItem(item, master);
  if (mapping?.method === 'MANUAL') {
    const target = master.find(candidate => candidate.variantId === mapping.productVariantId
      && normalizeWacaText(candidate.childCode) === code);
    const conflict = code && (normalizeWacaText(mapping.myacgVariantId) !== code
      || master.some(candidate => candidate.variantId === mapping.productVariantId
        && normalizeWacaText(candidate.childCode) !== code));
    item.productVariantId = code && !conflict && target ? mapping.productVariantId : null;
    item.match = item.productVariantId ? 'MANUAL_MATCH' : conflict ? 'MANUAL_REVIEW' : 'UNMATCHED';
    item.diagnostic = !code ? 'SPEC_CODE_MISSING' : conflict ? 'SPEC_CODE_CONFLICT'
      : !target ? 'VARIANT_NOT_IN_ERP' : match.diagnostic === 'NAME_CONFLICT' ? 'NAME_CONFLICT' : null;
    return;
  }
  item.productVariantId = match.candidate?.variantId ?? null;
  item.match = match.kind;
  item.diagnostic = match.diagnostic;
  if (match.candidate && (mapping?.productVariantId !== match.candidate.variantId
    || normalizeWacaText(mapping.myacgVariantId) !== code)) {
    repo.mappings.set(item.feature, {
      feature: item.feature, myacgMainId: match.candidate.mainCode, myacgVariantId: match.candidate.childCode,
      productVariantId: match.candidate.variantId, method: 'AUTO', confirmedAt: importId,
      historicalProductTitle: item.productTitle, historicalVariantTitle: match.candidate.variantTitle,
      masterStatus: 'ACTIVE',
    });
  }
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
    if (!normalizeWacaText(item.specCode)
      || normalizeWacaText(item.specCode) !== normalizeWacaText(mapping.myacgVariantId)) {
      item.productVariantId = null;
      item.match = 'MANUAL_REVIEW';
      item.diagnostic = normalizeWacaText(item.specCode) ? 'SPEC_CODE_CONFLICT' : 'SPEC_CODE_MISSING';
      continue;
    }
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
    if (!row.orderNumber.trim() || (!discount && (!Number.isSafeInteger(row.quantity) || row.quantity < 0))) {
      errors.push('WACA_ROW_INVALID'); continue;
    }
    try { parseWacaStatus(row.orderStatus); } catch { errors.push('WACA_STATUS_UNSUPPORTED'); continue; }
    const key = wacaOrderKey(row.orderNumber);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const before = new Map(repo.autoQuantities);
  // Upgrade only the in-memory candidate, committed through the existing atomic
  // import boundary. Preserve manual mapping/audit records at their old feature.
  const keyedItems = new Map<string, WacaItem>();
  const keyByIdentity = new Map<string, string>();
  for (const prior of repo.items.values()) {
    const feature = wacaFeature(prior);
    const identity = itemKey(prior.orderKey, feature);
    if (keyByIdentity.has(identity)) throw new Error('WACA_ITEM_IDENTITY_CONFLICT');
    const mapping = repo.mappings.get(prior.feature);
    if (mapping?.method === 'MANUAL' && !repo.mappings.has(feature)) repo.mappings.set(feature, { ...mapping, feature });
    // Cloud RPC upserts by the durable key; never replace an existing key,
    // otherwise the old SQL row would survive and be counted a second time.
    keyedItems.set(prior.key, { ...prior, feature });
    keyByIdentity.set(identity, prior.key);
  }
  repo.items = keyedItems;
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
      const identity = itemKey(key, feature);
      const keyForItem = keyByIdentity.get(identity) ?? identity;
      keyByIdentity.set(identity, keyForItem);
      importedItemKeys.add(keyForItem);
      const item: WacaItem = {
        key: keyForItem, orderKey: key, feature, productCode: row.productCode, productTitle: row.productTitle,
        spec1: row.spec1, spec2: row.spec2, specCode: row.specCode, quantity: row.quantity, subtotal: row.subtotal,
        productVariantId: null, match: 'UNMATCHED', diagnostic: null,
      };
      // Legacy manual decisions are evidence, not permission to override SKU.
      const legacy = repo.mappings.get(legacyWacaFeature(row));
      if (legacy?.method === 'MANUAL' && !repo.mappings.has(feature)) repo.mappings.set(feature, { ...legacy, feature });
      resolveWacaItem(item, repo, master, importId);
      const matchKind = item.match;
      const prior = repo.items.get(keyForItem);
      if (!prior) inserted += 1;
      else if (JSON.stringify(prior) !== JSON.stringify(item) || oldOrder?.status !== status) updated += 1;
      else unchanged += 1;
      repo.items.set(keyForItem, item);
      if (matchKind === 'UNMATCHED') unmatched += 1;
      else if (matchKind === 'MANUAL_REVIEW') multipleCandidates += 1;
      else matched += 1;
      if (item.diagnostic === 'MASTER_EVIDENCE_MISSING') mappingMissing += 1;
    }
  }
  // Revalidate every saved line, including previously wrong AUTO matches and
  // orders omitted from this file. Quantities/statuses are never incremented.
  for (const item of repo.items.values()) {
    resolveWacaItem(item, repo, master, importId);
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
