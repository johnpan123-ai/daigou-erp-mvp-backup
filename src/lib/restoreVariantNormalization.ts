// Restore-time duplicate Variant normalization (pure, deterministic, no I/O).
//
// ERP1 v1 backups carry rows that are the SAME product variant stored twice
// (same group + SKU + spec + product title). The ERP2 read model used to
// collapse them by updated_at, which let a computed-only recalculation hide
// the manual quantities the user maintains. This module turns such a snapshot
// into a normalized Restore candidate BEFORE anything is sent to the server:
//   * one canonical Variant per duplicate key (deterministic choice);
//   * manual quantities resolved by fixed rules; a value is never guessed,
//     summed, or taken from "the newest row" when the rows disagree;
//   * every reference re-pointed; merged-away rows are kept (soft-deleted);
//   * unresolved conflicts STOP the Restore with a full, ID-exact report;
//   * an Owner approval applies only to the exact row state it was given for.
// Already-normalized data (e.g. an ERP2 v2 backup) is returned unchanged.

export type RestoreRow = Record<string, unknown>;
export type RestoreTables = Record<string, RestoreRow[]>;

export const RESTORE_VARIANT_NORMALIZATION_POLICY = 'variant-duplicate-normalization-v1' as const;

export const MANUAL_FIELDS = [
  'myacg_manual_adjustment', 'waca_manual_adjustment', 'private_manual_adjustment', 'purchased_manual_adjustment',
] as const;
type ManualField = typeof MANUAL_FIELDS[number];

/** Plain business references that may be re-pointed to the canonical Variant. */
const REPOINTABLE_REFERENCES = [
  ['purchase_batch_items', 'product_variant_id'],
  ['private_order_items', 'product_variant_id'],
  ['japan_package_items', 'product_variant_id'],
  ['outbound_shipment_items', 'product_variant_id'],
  ['sales_order_items', 'product_variant_id'],
  ['bundle_components', 'bundle_variant_id'],
  ['bundle_components', 'component_variant_id'],
] as const;
/** WACA ledger rows carry hashed evidence; they are never rewritten here. */
const LEDGER_REFERENCES = [
  ['waca_order_items', 'product_variant_id'],
  ['waca_mappings', 'product_variant_id'],
  ['waca_master_links', 'product_variant_id'],
  ['waca_cutover_audit', 'product_variant_id'],
] as const;
const BUSINESS_TABLES = new Set(['purchase_batch_items', 'private_order_items', 'japan_package_items', 'outbound_shipment_items', 'sales_order_items']);

export interface VariantConflictApproval {
  /** sha256 of the exact duplicate-set state the Owner looked at (see setStateFingerprint). */
  setStateFingerprint: string;
  field: ManualField;
  approvedValue: number;
  keepVariantId: string;
  approvedBy: string;
  approvedAt: string;
}

export interface VariantConflict {
  key: { productGroupId: string; sku: string; spec: string; productTitle: string };
  setStateFingerprint: string;
  field: string;
  values: Record<string, unknown>;
  reason: string;
}

export interface VariantNormalizationReport {
  policy: typeof RESTORE_VARIANT_NORMALIZATION_POLICY;
  duplicateSets: number;
  extraRows: number;
  normalizedSets: number;
  approvedConflictsApplied: number;
  canonicalVariantIds: string[];
  softDeletedVariantIds: string[];
  canonicalFieldChanges: { id: string; field: string; from: unknown; to: unknown }[];
  repointedReferences: { table: string; id: string; field: string; from: string; to: string }[];
  softDeletedBundleIds: string[];
  conflicts: VariantConflict[];
}

export class RestoreVariantConflictError extends Error {
  readonly code = 'RESTORE_VARIANT_DUPLICATE_CONFLICT';
  readonly conflicts: VariantConflict[];
  constructor(conflicts: VariantConflict[]) {
    super(`備份內有 ${new Set(conflicts.map(c => c.setStateFingerprint)).size} 組重複規格的人工數量無法自動判定，已停止還原（未送出任何資料）。`);
    this.conflicts = conflicts;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const isActive = (row: RestoreRow): boolean => row.deleted_at === null || row.deleted_at === undefined || row.deleted_at === '';
const isZero = (value: unknown): boolean => value === null || value === undefined || value === '' || value === 0;
const millis = (value: unknown): number => { const t = Date.parse(str(value)); return Number.isFinite(t) ? t : 0; };

/** Same identity as IndexedDbAdapter.computeVariantDedupe: group + SKU + spec + product title; manual / blank rows never merge. */
export const variantDuplicateKey = (row: RestoreRow): string | null => {
  if (row.source === 'manual') return null;
  const sku = str(row.myacg_item_code).trim().toUpperCase();
  const group = str(row.product_group_id).trim();
  if (!sku || !group) return null;
  const spec = (str(row.raw_variant_name) || str(row.variant_name)).trim();
  return JSON.stringify([group, sku, spec, str(row.product_title).trim()]);
};

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map(k => [k, stable((value as RestoreRow)[k])]));
  return value;
};

/** Fingerprint of the exact rows of one duplicate set: IDs, identity, manual quantities, deletion state. */
export async function setStateFingerprint(rows: RestoreRow[], sha256: (text: string) => Promise<string>): Promise<string> {
  const state = [...rows].sort((a, b) => str(a.id).localeCompare(str(b.id))).map(row => ({
    id: str(row.id), product_group_id: str(row.product_group_id), myacg_item_code: str(row.myacg_item_code),
    raw_variant_name: row.raw_variant_name ?? null, variant_name: row.variant_name ?? null, product_title: row.product_title ?? null,
    deleted_at: row.deleted_at ?? null, ...Object.fromEntries(MANUAL_FIELDS.map(f => [f, row[f] ?? null])),
  }));
  return sha256(JSON.stringify(stable(state)));
}

export async function normalizeRestoreVariantDuplicates(
  source: RestoreTables,
  options: { approvals?: readonly VariantConflictApproval[]; sha256: (text: string) => Promise<string> },
): Promise<{ data: RestoreTables; report: VariantNormalizationReport }> {
  const data: RestoreTables = Object.fromEntries(Object.entries(source).map(([table, rows]) => [table, rows.map(row => ({ ...row }))]));
  const variants = data.product_variants ?? [];
  const sets = new Map<string, RestoreRow[]>();
  for (const row of variants) {
    if (!isActive(row)) continue;
    const key = variantDuplicateKey(row);
    if (!key) continue;
    (sets.get(key) ?? sets.set(key, []).get(key)!).push(row);
  }
  const duplicateSets = [...sets.entries()].filter(([, rows]) => rows.length > 1).sort(([a], [b]) => a.localeCompare(b));
  const report: VariantNormalizationReport = {
    policy: RESTORE_VARIANT_NORMALIZATION_POLICY, duplicateSets: duplicateSets.length,
    extraRows: duplicateSets.reduce((n, [, rows]) => n + rows.length - 1, 0), normalizedSets: 0, approvedConflictsApplied: 0,
    canonicalVariantIds: [], softDeletedVariantIds: [], canonicalFieldChanges: [], repointedReferences: [], softDeletedBundleIds: [], conflicts: [],
  };
  if (!duplicateSets.length) return { data, report };

  // Active reference counts per Variant (business first, then all).
  const businessRefs = new Map<string, number>(); const allRefs = new Map<string, number>();
  for (const [table, field] of REPOINTABLE_REFERENCES) for (const row of data[table] ?? []) {
    if (!isActive(row)) continue; const id = str(row[field]); if (!id) continue;
    allRefs.set(id, (allRefs.get(id) ?? 0) + 1);
    if (BUSINESS_TABLES.has(table)) businessRefs.set(id, (businessRefs.get(id) ?? 0) + 1);
  }
  const ledgerRefs = new Set<string>();
  for (const [table, field] of LEDGER_REFERENCES) for (const row of data[table] ?? []) { const id = str(row[field]); if (id) ledgerRefs.add(id); }

  const approvalsBySet = new Map<string, VariantConflictApproval[]>();
  for (const approval of options.approvals ?? []) (approvalsBySet.get(approval.setStateFingerprint) ?? approvalsBySet.set(approval.setStateFingerprint, []).get(approval.setStateFingerprint)!).push(approval);

  const aliasOf = new Map<string, string>();
  const patches = new Map<string, RestoreRow>();
  for (const [key, rows] of duplicateSets) {
    const [productGroupId, sku, spec, productTitle] = JSON.parse(key) as string[];
    const fingerprint = await setStateFingerprint(rows, options.sha256);
    const conflict = (field: string, reason: string, values?: Record<string, unknown>) => report.conflicts.push({
      key: { productGroupId, sku, spec, productTitle }, setStateFingerprint: fingerprint, field, reason,
      values: values ?? Object.fromEntries(rows.map(r => [str(r.id), r[field] ?? null])),
    });
    const before = report.conflicts.length;
    // What the ERP1 screen showed for this set (its read model: newest updated_at, then sort_order, then id).
    const shown = [...rows].sort((a, b) => millis(b.updated_at) - millis(a.updated_at)
      || (Number(a.sort_order ?? 999999) - Number(b.sort_order ?? 999999)) || str(a.id).localeCompare(str(b.id)))[0];
    // Canonical identity: most business references, then most references, then the row the user saw, then id.
    const canonical = [...rows].sort((a, b) => (businessRefs.get(str(b.id)) ?? 0) - (businessRefs.get(str(a.id)) ?? 0)
      || (allRefs.get(str(b.id)) ?? 0) - (allRefs.get(str(a.id)) ?? 0)
      || (a === shown ? -1 : b === shown ? 1 : 0) || str(a.id).localeCompare(str(b.id)))[0];
    const others = rows.filter(r => r !== canonical);
    if (others.some(r => ledgerRefs.has(str(r.id)))) conflict('waca_ledger_reference', 'WACA ledger rows reference a duplicate that would be merged away');
    const approvals = approvalsBySet.get(fingerprint) ?? [];
    const merged: RestoreRow = {};
    for (const field of MANUAL_FIELDS) {
      const nonZero = [...new Set(rows.map(r => r[field]).filter(v => !isZero(v)).map(v => JSON.stringify(v)))];
      const approval = approvals.find(a => a.field === field);
      let value: unknown;
      if (nonZero.length === 0) value = canonical[field];
      else if (nonZero.length === 1 && !isZero(shown[field])) value = JSON.parse(nonZero[0]);
      else if (approval && rows.some(r => r[field] === approval.approvedValue && str(r.id) === approval.keepVariantId)) {
        value = approval.approvedValue; report.approvedConflictsApplied += 1;
      } else {
        conflict(field, nonZero.length > 1 ? 'different non-zero values' : 'the row ERP1 displayed holds 0/NULL while another row holds a value');
        continue;
      }
      merged[field] = value;
    }
    for (const approval of approvals) if (!MANUAL_FIELDS.includes(approval.field)) conflict(approval.field, 'approval for an unknown field');
    // Non-quantity attributes: fill a missing value; two different values are a conflict, never a guess.
    for (const field of ['default_jpy_cost', 'default_twd_cost', 'note', 'product_category_id', 'waca_auto_quantity'] as const) {
      const present = [...new Set(rows.map(r => r[field]).filter(v => v !== null && v !== undefined && v !== '').map(v => JSON.stringify(v)))];
      if (present.length > 1) { conflict(field, 'different values'); continue; }
      if (present.length === 1) merged[field] = JSON.parse(present[0]);
    }
    if (report.conflicts.length > before) continue;
    const changes: RestoreRow = {};
    for (const [field, value] of Object.entries(merged)) {
      if (JSON.stringify(canonical[field] ?? null) !== JSON.stringify(value ?? null)) {
        changes[field] = value;
        report.canonicalFieldChanges.push({ id: str(canonical.id), field, from: canonical[field] ?? null, to: value ?? null });
      }
    }
    if (Object.keys(changes).length) patches.set(str(canonical.id), changes);
    for (const row of others) aliasOf.set(str(row.id), str(canonical.id));
    report.canonicalVariantIds.push(str(canonical.id));
    report.normalizedSets += 1;
  }
  if (report.conflicts.length) throw new RestoreVariantConflictError(report.conflicts);

  // Deterministic deletion instant: the latest change already present in the set (no wall clock).
  const deletedAtFor = new Map<string, string>();
  for (const [, rows] of duplicateSets) {
    const latest = rows.map(r => str(r.updated_at)).filter(Boolean).sort((a, b) => millis(a) - millis(b)).at(-1) ?? null;
    for (const row of rows) if (aliasOf.has(str(row.id)) && latest) deletedAtFor.set(str(row.id), latest);
  }
  for (const row of variants) {
    const id = str(row.id);
    const patch = patches.get(id); if (patch) Object.assign(row, patch);
    if (aliasOf.has(id)) { row.deleted_at = deletedAtFor.get(id) ?? row.updated_at ?? null; report.softDeletedVariantIds.push(id); }
  }
  // Re-point every ACTIVE reference. Soft-deleted history keeps its original ID (the merged-away
  // Variant row is kept, so the reference stays valid and the history is not rewritten).
  const repointedBundles = new Set<string>();
  for (const [table, field] of REPOINTABLE_REFERENCES) for (const row of data[table] ?? []) {
    if (!isActive(row)) continue;
    const from = str(row[field]); const to = aliasOf.get(from);
    if (to) {
      row[field] = to; report.repointedReferences.push({ table, id: str(row.id), field, from, to });
      if (table === 'bundle_components') repointedBundles.add(str(row.id));
    }
  }
  // A re-pointed bundle row that now duplicates another pair (or points at itself) is soft-deleted.
  // Untouched rows win; pre-existing rows the normalization did not touch are never changed.
  const seen = new Set<string>();
  const bundles = [...(data.bundle_components ?? [])].filter(isActive)
    .sort((a, b) => Number(repointedBundles.has(str(a.id))) - Number(repointedBundles.has(str(b.id)))
      || millis(a.created_at) - millis(b.created_at) || str(a.id).localeCompare(str(b.id)));
  for (const row of bundles) {
    const pair = `${str(row.bundle_variant_id)}|${str(row.component_variant_id)}`;
    const touched = repointedBundles.has(str(row.id));
    if (touched && (str(row.bundle_variant_id) === str(row.component_variant_id) || seen.has(pair))) {
      row.deleted_at = row.updated_at ?? row.created_at ?? null; report.softDeletedBundleIds.push(str(row.id));
    } else seen.add(pair);
  }
  report.softDeletedVariantIds.sort(); report.canonicalVariantIds.sort(); report.softDeletedBundleIds.sort();
  return { data, report };
}
