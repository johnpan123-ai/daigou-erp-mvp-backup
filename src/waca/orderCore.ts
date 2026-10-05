/** Isolated WACA order domain. It never invokes ERP providers. */
import { wacaAliasKey, wacaProductKey, wacaProductTokens, wacaSourceSpecKeys, wacaSpecKey } from './nameEvidence';
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
  variantTitles?: readonly string[];
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
  /** Optional JSON provenance; older backups remain readable. */
  resolution?: WacaResolution;
}

export type WacaResolution = 'SPEC_CODE_EXACT' | 'SPEC_NAME_EXACT_UNIQUE' | 'UNIQUE_PARENT_VARIANT'
  | 'MANUAL_CONFIRMED_MAPPING' | 'PENDING_AMBIGUOUS' | 'PENDING_PRODUCT_MISSING'
  | 'PENDING_NAME_CONFLICT' | 'PENDING_SPEC_NAME' | 'CONFLICT_MANUAL_VS_SPEC'
  | 'PRODUCT_SPEC_EXACT' | 'PRODUCT_UNIQUE_SPEC' | 'PRODUCT_SINGLE_VARIANT'
  | 'GLOBAL_UNIQUE_COMBINATION' | 'ALIAS_UNIQUE' | 'LEARNED_PARENT_SPEC';

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
    | 'SPEC_CODE_MISSING' | 'SPEC_CODE_CONFLICT' | 'AMBIGUOUS_VARIANT' | 'PARENT_AMBIGUOUS'
    | 'PARENT_NAME_CONFLICT' | 'SPEC_NAME_NOT_MATCHED' | 'SOURCE_SPEC_IDENTITY_CONFLICT' | null;
  resolution?: WacaResolution;
  candidateCount?: number;
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

export const isWacaDiscount = (row: Pick<WacaRow, 'productCode' | 'productTitle' | 'spec1'>): boolean =>
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
  resolution: WacaResolution;
}

type ResolutionRow = Pick<WacaRow, 'productCode' | 'specCode' | 'productTitle' | 'spec1' | 'spec2'>;
export interface WacaMasterIndex {
  byChild: Map<string, MasterVariant[]>;
  byMain: Map<string, MasterVariant[]>;
  byGroup: Map<string, MasterVariant[]>;
  byVariant: Map<string, MasterVariant>;
  byName: Map<string, MasterVariant[]>;
  byAlias: Map<string, MasterVariant[]>;
  byTokens: Map<string, MasterVariant[]>;
  bySpec: Map<string, MasterVariant[]>;
  learnedParents: Map<string, Set<string>>;
}

/** Built once per catalogue/import, never once per tab or order row. */
export function indexWacaMaster(master: readonly MasterVariant[]): WacaMasterIndex {
  const result: WacaMasterIndex = { byChild: new Map(), byMain: new Map(), byGroup: new Map(), byVariant: new Map(),
    byName: new Map(), byAlias: new Map(), byTokens: new Map(), bySpec: new Map(), learnedParents: new Map() };
  const add = (map: Map<string, MasterVariant[]>, key: string, value: MasterVariant) => {
    if (key) { const rows = map.get(key) ?? []; rows.push(value); map.set(key, rows); }
  };
  for (const variant of master) {
    if (!variant.active) continue;
    add(result.byChild, normalizeWacaText(variant.childCode), variant);
    add(result.byMain, normalizeWacaText(variant.mainCode), variant);
    add(result.byGroup, variant.productGroupId, variant);
    if (variant.variantId && variant.productGroupId) {
      add(result.byName, wacaProductKey(variant.productTitle), variant);
      add(result.byAlias, wacaAliasKey(variant.productTitle), variant);
      add(result.byTokens, wacaProductTokens(variant.productTitle), variant);
      for (const name of new Set([variant.variantTitle, ...(variant.variantTitles ?? [])].map(wacaSpecKey))) {
        if (name) add(result.bySpec, `${variant.productGroupId}\u001f${name}`, variant);
      }
    }
    if (variant.variantId) result.byVariant.set(variant.variantId, variant);
  }
  return result;
}

const uniqueVariants = (rows: readonly MasterVariant[]): MasterVariant[] =>
  [...new Map(rows.filter(row => row.variantId).map(row => [row.variantId, row])).values()];

/** Lossless renderings of the two source fields, not fuzzy punctuation removal. */
export function wacaSpecNamesMatch(row: Pick<WacaRow, 'spec1' | 'spec2'>, candidate: MasterVariant): boolean {
  const names = new Set(wacaSourceSpecKeys(row.spec1, row.spec2));
  return [candidate.variantTitle, ...(candidate.variantTitles ?? [])]
    .some(title => names.has(wacaSpecKey(title)));
}

const parentIds = (rows: readonly MasterVariant[]) => new Set(rows.map(v => v.productGroupId).filter(Boolean));

function discoverWacaParent(row: ResolutionRow, index: WacaMasterIndex): WacaMatch | null {
  if (!normalizeWacaText(row.productCode) || !wacaProductKey(row.productTitle)) return null;
  const specKeys = wacaSourceSpecKeys(row.spec1, row.spec2);
  const select = (rows: MasterVariant[], resolution: WacaResolution, requireOneGroup = false): WacaMatch | null => {
    if (!rows.length) return null;
    const groups = parentIds(rows);
    const allowed = new Set(rows.map(v => v.variantId));
    const exact = uniqueVariants(specKeys.length ? [...groups].flatMap(id => specKeys
      .flatMap(spec => index.bySpec.get(`${id}\u001f${spec}`) ?? [])).filter(v => allowed.has(v.variantId)) : rows);
    if (groups.size === 1 && specKeys.length && !exact.length) return {
      kind: 'UNMATCHED', candidate: null, candidates: uniqueVariants(rows),
      diagnostic: 'SPEC_NAME_NOT_MATCHED', resolution: 'PENDING_SPEC_NAME',
    };
    if ((requireOneGroup && groups.size !== 1) || exact.length !== 1 || (!specKeys.length && groups.size !== 1)) {
      return { kind: 'MANUAL_REVIEW', candidate: null, candidates: uniqueVariants(rows), diagnostic: 'AMBIGUOUS_VARIANT', resolution: 'PENDING_AMBIGUOUS' };
    }
    if (!specKeys.length && uniqueVariants(index.byGroup.get(exact[0].productGroupId) ?? []).length !== 1) return null;
    return { kind: 'AUTO_MATCH', candidate: { ...exact[0], mainCode: normalizeWacaText(row.productCode) },
      candidates: exact, diagnostic: null, resolution: specKeys.length ? resolution : 'PRODUCT_SINGLE_VARIANT' };
  };
  const exactName = index.byName.get(wacaProductKey(row.productTitle)) ?? [];
  if (exactName.length) return select(exactName, parentIds(exactName).size === 1 ? 'PRODUCT_UNIQUE_SPEC' : 'PRODUCT_SPEC_EXACT');
  const alias = index.byAlias.get(wacaAliasKey(row.productTitle)) ?? [];
  if (alias.length) {
    const result = select(alias, 'ALIAS_UNIQUE', true);
    return result?.candidate ? { ...result, resolution: 'ALIAS_UNIQUE' } : result;
  }
  return select(index.byTokens.get(wacaProductTokens(row.productTitle)) ?? [], 'GLOBAL_UNIQUE_COMBINATION', true);
}

function learnWacaParent(row: ResolutionRow, match: WacaMatch, index: WacaMasterIndex): void {
  if (!match.candidate?.productGroupId || match.diagnostic || !normalizeWacaText(row.productCode)) return;
  const code = normalizeWacaText(row.productCode);
  const groups = index.learnedParents.get(code) ?? new Set<string>();
  groups.add(match.candidate.productGroupId);
  index.learnedParents.set(code, groups);
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
  row: ResolutionRow, master: readonly MasterVariant[] | WacaMasterIndex,
): WacaMatch {
  const index = Array.isArray(master) ? indexWacaMaster(master) : master as WacaMasterIndex;
  const pending = (diagnostic: WacaItem['diagnostic'], resolution: WacaResolution,
    candidates: MasterVariant[] = []): WacaMatch => ({
    kind: resolution === 'PENDING_AMBIGUOUS' ? 'MANUAL_REVIEW' : 'UNMATCHED',
    candidate: null, candidates, diagnostic, resolution,
  });
  // Presence is independent of equality: productCode === specCode is still an explicit SKU.
  const code = normalizeWacaText(row.specCode);
  if (!code) {
    const parentCode = normalizeWacaText(row.productCode);
    // A child code may identify a GROUP, never a selected child. Enumerate the whole group.
    const anchors = [...(index.byMain.get(parentCode) ?? []), ...(index.byChild.get(parentCode) ?? [])];
    const learned = index.learnedParents.get(parentCode) ?? new Set<string>();
    const groupIds = new Set([...anchors.map(v => v.productGroupId).filter(Boolean), ...learned]);
    if (!groupIds.size) return discoverWacaParent(row, index)
      ?? pending('PRODUCT_NOT_IN_MASTER', 'PENDING_PRODUCT_MISSING');
    if (groupIds.size !== 1) return pending('PARENT_AMBIGUOUS', 'PENDING_AMBIGUOUS');
    const groupId = [...groupIds][0];
    const all = index.byGroup.get(groupId) ?? [];
    const nameGroups = parentIds(index.byName.get(wacaProductKey(row.productTitle)) ?? []);
    const aliasGroups = parentIds(index.byAlias.get(wacaAliasKey(row.productTitle)) ?? []);
    if (learned.has(groupId) && nameGroups.size && !nameGroups.has(groupId)) {
      return pending('PARENT_NAME_CONFLICT', 'PENDING_NAME_CONFLICT');
    }
    // A revalidated, feature-proven GP link is a strong parent identity even
    // when another same-GP source line uses a placeholder title. A different
    // known Catalog product name above is still a conflict, never an override.
    const learnedTitle = learned.has(groupId) && !nameGroups.size && !aliasGroups.size
      && Boolean(wacaProductKey(row.productTitle));
    if (!learnedTitle && (!normalizeWacaText(row.productTitle)
      || !all.some(v => v.productTitle && verifiesTitle(row, v)))) {
      const discovered = discoverWacaParent(row, index);
      if (discovered?.candidate?.productGroupId === groupId) return discovered;
      if (discovered?.resolution === 'PENDING_AMBIGUOUS') return discovered;
      return pending('PARENT_NAME_CONFLICT', 'PENDING_NAME_CONFLICT');
    }
    const candidates = uniqueVariants(all);
    if (!candidates.length) return pending('VARIANT_NOT_IN_ERP', 'PENDING_PRODUCT_MISSING');
    const knownChildren = [...all, ...anchors.flatMap(v => v.mainCode
      ? index.byMain.get(normalizeWacaText(v.mainCode)) ?? [] : [])];
    const wantedSpec = [row.spec1, row.spec2].map(normalizeWacaText).filter(Boolean).join(' / ');
    if (wantedSpec) {
      // No punctuation, dates, colours, sizes or meaning-bearing tokens are removed.
      const exact = candidates.filter(v => wacaSpecNamesMatch(row, v));
      if (knownChildren.some(v => !v.variantId && wacaSpecNamesMatch(row, v))) {
        return pending('VARIANT_NOT_IN_ERP', 'PENDING_PRODUCT_MISSING', candidates);
      }
      if (exact.length === 1) {
        if (!learnedTitle && (!exact[0].productTitle || !verifiesTitle(row, exact[0]))) {
          return pending('PARENT_NAME_CONFLICT', 'PENDING_NAME_CONFLICT');
        }
        return { kind: 'AUTO_MATCH', candidate: learned.has(groupId) ? { ...exact[0], mainCode: parentCode } : exact[0], candidates,
          diagnostic: null, resolution: learned.has(groupId) ? 'LEARNED_PARENT_SPEC' : 'SPEC_NAME_EXACT_UNIQUE' };
      }
      return pending(exact.length > 1 ? 'AMBIGUOUS_VARIANT' : 'SPEC_NAME_NOT_MATCHED',
        exact.length > 1 ? 'PENDING_AMBIGUOUS' : 'PENDING_SPEC_NAME', candidates);
    }
    // Known children absent from ERP make a claim of a single variant unsafe.
    const incomplete = knownChildren.some(child => !child.variantId);
    if (incomplete) return pending('VARIANT_NOT_IN_ERP', 'PENDING_PRODUCT_MISSING', candidates);
    if (candidates.length !== 1) return pending('AMBIGUOUS_VARIANT', 'PENDING_AMBIGUOUS', candidates);
    if (!learnedTitle && (!candidates[0].productTitle || !verifiesTitle(row, candidates[0]))) {
      return pending('PARENT_NAME_CONFLICT', 'PENDING_NAME_CONFLICT');
    }
    return { kind: 'AUTO_MATCH', candidate: learned.has(groupId) ? { ...candidates[0], mainCode: parentCode } : candidates[0], candidates,
      diagnostic: null, resolution: 'UNIQUE_PARENT_VARIANT' };
  }
  const direct = index.byChild.get(code) ?? [];
  const resolved = uniqueVariants(direct);
  if (!resolved.length) return pending('VARIANT_NOT_IN_ERP', 'PENDING_PRODUCT_MISSING', direct);
  if (resolved.length !== 1) return pending('MULTIPLE_VARIANT_CANDIDATES', 'PENDING_AMBIGUOUS', resolved);
  const candidate = resolved[0];
  const wantedSpec = [row.spec1, row.spec2].map(specification).filter(Boolean).join('');
  const nameConflict = !verifiesTitle(row, candidate)
    || Boolean(wantedSpec && specification(candidate.variantTitle) && wantedSpec !== specification(candidate.variantTitle));
  return { kind: 'AUTO_MATCH', candidate, candidates: resolved,
    resolution: 'SPEC_CODE_EXACT',
    diagnostic: nameConflict ? 'NAME_CONFLICT'
      : candidate.mainCode && !candidate.productGroupId ? 'MASTER_GROUP_LINK_MISSING' : null };
}

/** Do not count an unresolved old blank line again alongside stronger source lines. */
function sourceSpecConflicts(repo: WacaRepository): Set<string> {
  const explicit = new Set<string>();
  for (const item of repo.items.values()) {
    if (normalizeWacaText(item.specCode)) explicit.add(itemKey(item.orderKey, legacyWacaFeature(item)));
  }
  return new Set([...repo.items.values()].filter(item => !normalizeWacaText(item.specCode)
    && explicit.has(itemKey(item.orderKey, legacyWacaFeature(item)))).map(item => item.key));
}

function resolveWacaItem(item: WacaItem, repo: WacaRepository, master: WacaMasterIndex, importId: string,
  sourceConflicts?: ReadonlySet<string>): void {
  const code = normalizeWacaText(item.specCode);
  if (!code && sourceConflicts?.has(item.key)) {
    // Keep the durable row and every decision/audit. A split cannot be guessed.
    item.productVariantId = null;
    item.match = 'MANUAL_REVIEW';
    item.diagnostic = 'SOURCE_SPEC_IDENTITY_CONFLICT';
    item.resolution = 'PENDING_AMBIGUOUS';
    item.candidateCount = 0;
    return;
  }
  const currentMapping = repo.mappings.get(item.feature);
  // An earlier blank-spec confirmation is weaker than a newly supplied explicit code.
  const blankMapping = code ? repo.mappings.get(wacaFeature({ ...item, specCode: '' })) : undefined;
  const mapping = currentMapping?.method === 'MANUAL' ? currentMapping
    : blankMapping?.method === 'MANUAL' ? blankMapping : currentMapping;
  const match = matchWacaItem(item, master);
  if (mapping?.method === 'MANUAL') {
    const targets = master.byChild.get(normalizeWacaText(mapping.myacgVariantId)) ?? [];
    const target = targets.find(candidate => candidate.variantId === mapping.productVariantId);
    const canonicalTarget = master.byVariant.get(mapping.productVariantId);
    const conflict = code && (normalizeWacaText(mapping.myacgVariantId) !== code
      || (canonicalTarget && normalizeWacaText(canonicalTarget.childCode) !== code));
    const parentCandidates = match.candidates;
    // A permanent, feature-bound manual decision is parent evidence too. Validate
    // its current canonical target and the originally confirmed source title.
    const verifiedParent = !code && target && target.productGroupId
      && normalizeWacaText(mapping.historicalProductTitle) === normalizeWacaText(item.productTitle)
      && (parentCandidates.some(v => v.variantId === target.variantId) || mapping.myacgMainId);
    item.productVariantId = !conflict && target && (code || verifiedParent) ? mapping.productVariantId : null;
    item.match = item.productVariantId ? 'MANUAL_MATCH' : conflict ? 'MANUAL_REVIEW' : 'UNMATCHED';
    item.diagnostic = conflict ? 'SPEC_CODE_CONFLICT' : !target ? 'VARIANT_NOT_IN_ERP'
      : item.productVariantId ? (match.diagnostic === 'NAME_CONFLICT' ? 'NAME_CONFLICT' : null) : match.diagnostic;
    item.resolution = conflict ? 'CONFLICT_MANUAL_VS_SPEC' : item.productVariantId
      ? code ? 'SPEC_CODE_EXACT' : 'MANUAL_CONFIRMED_MAPPING' : match.resolution;
    item.candidateCount = match.candidates.filter(v => v.variantId).length;
    return;
  }
  item.productVariantId = match.candidate?.variantId ?? null;
  item.match = match.kind;
  item.diagnostic = match.diagnostic;
  item.resolution = match.resolution;
  item.candidateCount = match.candidates.filter(v => v.variantId).length;
  if (match.candidate && (mapping?.productVariantId !== match.candidate.variantId
    || normalizeWacaText(mapping.myacgVariantId) !== normalizeWacaText(match.candidate.childCode)
    || mapping.resolution !== match.resolution)) {
    repo.mappings.set(item.feature, {
      feature: item.feature, myacgMainId: match.candidate.mainCode, myacgVariantId: match.candidate.childCode,
      productVariantId: match.candidate.variantId, method: 'AUTO', confirmedAt: importId,
      historicalProductTitle: item.productTitle, historicalVariantTitle: match.candidate.variantTitle,
      masterStatus: 'ACTIVE',
      resolution: match.resolution,
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

export function setWacaMapping(repo: WacaRepository, mapping: WacaMapping,
  master?: readonly MasterVariant[] | WacaMasterIndex, confirmedParentId?: string): void {
  const index = master ? Array.isArray(master) ? indexWacaMaster(master) : master as WacaMasterIndex : undefined;
  const conflicts = sourceSpecConflicts(repo);
  const affected = [...repo.items.values()].filter(item => item.feature === mapping.feature);
  if (affected.length && affected.every(item => conflicts.has(item.key))) {
    throw new Error('同一訂單已有明確規格列；請先核對來源空白規格列，避免重複計量。');
  }
  if ([...repo.items.values()].some(item => item.feature === mapping.feature && !normalizeWacaText(item.specCode))) {
    if (!index || mapping.method !== 'MANUAL' || affected.filter(item => !conflicts.has(item.key)).some(item => {
      const match = matchWacaItem(item, index);
      const candidates = match.candidates.length ? match.candidates
        : confirmedParentId ? index.byGroup.get(confirmedParentId) ?? [] : [];
      return !candidates.some(v => v.variantId === mapping.productVariantId
        && normalizeWacaText(v.childCode) === normalizeWacaText(mapping.myacgVariantId));
    })) {
      throw new Error('WACA_MANUAL_MAPPING_PARENT_MISMATCH');
    }
  }
  repo.mappings.set(mapping.feature, { ...mapping, resolution: 'MANUAL_CONFIRMED_MAPPING' });
  for (const item of repo.items.values()) {
    if (item.feature !== mapping.feature) continue;
    if (index) { resolveWacaItem(item, repo, index, mapping.confirmedAt, conflicts); continue; }
    if (!normalizeWacaText(item.specCode) || normalizeWacaText(item.specCode) !== normalizeWacaText(mapping.myacgVariantId)) {
      item.productVariantId = null;
      item.match = 'MANUAL_REVIEW';
      item.diagnostic = normalizeWacaText(item.specCode) ? 'SPEC_CODE_CONFLICT' : 'SPEC_CODE_MISSING';
      item.resolution = 'CONFLICT_MANUAL_VS_SPEC';
      continue;
    }
    item.productVariantId = mapping.productVariantId;
    item.match = mapping.method === 'MANUAL' ? 'MANUAL_MATCH' : 'AUTO_MATCH';
    item.diagnostic = null;
    item.resolution = 'SPEC_CODE_EXACT';
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
  const masterIndex = indexWacaMaster(master);
  // Rebuild parent evidence from the current Catalog, not a permanently locked
  // AUTO decision. Existing mapping JSON retains the GP, title/spec and target.
  for (const mapping of repo.mappings.values()) {
    if (mapping.method !== 'AUTO') continue;
    try {
      const fields: unknown = JSON.parse(mapping.feature);
      if (!Array.isArray(fields) || fields.length !== 5 || fields.some(v => typeof v !== 'string')) continue;
      const [productCode, productTitle, spec1, spec2, specCode] = fields;
      const row = { productCode, productTitle, spec1, spec2, specCode };
      const proof = specCode ? matchWacaItem(row, masterIndex) : discoverWacaParent(row, masterIndex);
      if (proof?.candidate?.variantId === mapping.productVariantId) learnWacaParent(row, proof, masterIndex);
    } catch { /* Legacy feature identities are revalidated through their order rows below. */ }
  }
  // Batch-wide prepass makes GP learning independent of row order. It never
  // writes persistence: mappings are saved only in the existing atomic snapshot.
  for (const row of [...repo.items.values(), ...rows]) {
    if (isWacaDiscount(row)) continue;
    const proof = normalizeWacaText(row.specCode) ? matchWacaItem(row, masterIndex) : discoverWacaParent(row, masterIndex);
    if (proof) learnWacaParent(row, proof, masterIndex);
  }
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
  const incomingCodes = new Map<string, { codes: Set<string>; blank: boolean }>();
  for (const [orderKey, orderRows] of grouped) {
    if (new Set(orderRows.map(row => parseWacaStatus(row.orderStatus))).size !== 1) continue;
    for (const row of orderRows) {
      if (isWacaDiscount(row)) continue;
      const identity = itemKey(orderKey, legacyWacaFeature(row));
      const evidence = incomingCodes.get(identity) ?? { codes: new Set<string>(), blank: false };
      const code = normalizeWacaText(row.specCode);
      if (code) evidence.codes.add(code); else evidence.blank = true;
      incomingCodes.set(identity, evidence);
    }
  }
  // Upgrade only the in-memory candidate, committed through the existing atomic
  // import boundary. Preserve manual mapping/audit records at their old feature.
  const keyedItems = new Map<string, WacaItem>();
  const keyByIdentity = new Map<string, string>();
  const existingExplicit = new Set([...repo.items.values()].filter(item => normalizeWacaText(item.specCode))
    .map(item => itemKey(item.orderKey, legacyWacaFeature(item))));
  for (const prior of repo.items.values()) {
    // A uniquely strengthened source field upgrades the SAME durable SQL key.
    // Do not keep an old blank line alongside its newly identified child.
    const evidence = incomingCodes.get(itemKey(prior.orderKey, legacyWacaFeature(prior)));
    const projected = !normalizeWacaText(prior.specCode) && evidence && !evidence.blank && evidence.codes.size === 1
      && !existingExplicit.has(itemKey(prior.orderKey, legacyWacaFeature(prior)))
      ? { ...prior, specCode: [...evidence.codes][0] } : prior;
    const feature = wacaFeature(projected);
    const identity = itemKey(prior.orderKey, feature);
    if (keyByIdentity.has(identity)) throw new Error('WACA_ITEM_IDENTITY_CONFLICT');
    const mapping = repo.mappings.get(prior.feature);
    if (mapping?.method === 'MANUAL' && !repo.mappings.has(feature)) repo.mappings.set(feature, { ...mapping, feature });
    // Cloud RPC upserts by the durable key; never replace an existing key,
    // otherwise the old SQL row would survive and be counted a second time.
    keyedItems.set(prior.key, { ...projected, feature });
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
      resolveWacaItem(item, repo, masterIndex, importId);
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
  const sourceConflicts = sourceSpecConflicts(repo);
  matched = 0; unmatched = 0; multipleCandidates = 0; mappingMissing = 0;
  for (const item of repo.items.values()) {
    resolveWacaItem(item, repo, masterIndex, importId, sourceConflicts);
    if (!importedItemKeys.has(item.key)) continue;
    if (item.match === 'UNMATCHED') unmatched += 1;
    else if (item.match === 'MANUAL_REVIEW') multipleCandidates += 1;
    else matched += 1;
    if (item.diagnostic === 'MASTER_EVIDENCE_MISSING') mappingMissing += 1;
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
