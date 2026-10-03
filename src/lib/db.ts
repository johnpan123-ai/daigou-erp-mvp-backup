import { reportStorageWriteFailure } from './storageGuard';
import { RELATED_STORAGE,relatedWriteEntities,mergeRelatedCollections,type RelatedTransactionCommand } from '../providers/cloud/relatedTransaction';
import { createPurchaseRecordFromInventory as createCatalogRecords, reparseProductVariants as reparseCatalogVariants,
  syncProductGroupsWithInventory as syncCatalogGroups, type CatalogAlgorithmContext } from './catalogAlgorithms';
import { mergePrivateOrderState, type PrivateOrderTransactionCommand } from '../providers/cloud/privateOrderTransaction';

export interface InventoryItem {
  id?: string;
  database_id?: string; // Canonical Cloud UUID; never used as Local Mode identity.
  version?: number;
  updated_at?: string;
  import_sort_index?: number;
  myacg_item_code: string; // PK
  myacg_parent_code?: string;
  product_id?: string;
  product_title: string;
  normalized_product_title?: string;
  raw_variant_name: string;
  listing_type: string;
  final_price: number;
  myacg_available_quantity: number;
  myacg_sold_quantity: number;
  myacg_demand_quantity?: number;
  myacg_listed_at: string;
  inventory_key?: string; // New composite field
  latest_catalog_import_id?: string;
  catalog_last_seen_at?: string;
}

export interface SalesOrder {
  database_id?: string; // Canonical Cloud UUID when id is a source-local order id.
  version?: number;
  updated_at?: string;
  id: string; // PK
  platform: string;
  order_number: string;
  buyer_name: string;
  created_at: string;
}

export interface SalesOrderItem {
  database_id?: string;
  order_database_id?: string;
  version?: number;
  updated_at?: string;
  id: string; // PK
  order_id: string; // FK
  product_variant_id?: string; // FK
  myacg_item_code: string; // FK
  product_name?: string;
  variant_name?: string;
  quantity: number; // Demand
  price?: number;
  amount?: number;
  order_status?: string;
}

// === New 3-Tier Architecture ===

// === Single Document (Header) - Multiple Items (Lines) ===

export interface PurchaseBatch {
  database_id?: string;
  id: string; // PK
  product_group_id: string; // FK
  name: string;
  date: string;
  note: string;
  created_at: string;
  updated_at?: string;
  version?: number;
}

export interface PurchaseBatchItem {
  database_id?: string;
  id: string; // PK
  purchase_batch_id: string; // FK
  product_variant_id: string; // FK
  quantity: number;
  cost: number;
  note: string;
  updated_at?: string;
  version?: number;
}

export interface JapanPackage {
  database_id?: string;
  id: string;
  title: string;
  vendor_name?: string;
  carrier?: string;
  tracking_number?: string;
  shipped_at?: string;
  expected_arrival_at?: string;
  arrived_at?: string;
  status: string;
  note?: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface JapanPackageItem {
  database_id?: string;
  id: string;
  japan_package_id: string;
  product_group_id?: string;
  product_variant_id?: string;
  purchase_batch_id?: string;
  purchase_batch_item_id?: string;
  product_title?: string;
  category_name?: string;
  variant_name?: string;
  sku?: string;
  quantity: number;
  note?: string;
  checked: boolean;
  checked_at?: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface OutboundShipment {
  database_id?: string;
  id: string;
  title: string;
  status: string;
  carrier?: string;
  tracking_number?: string;
  weight_kg?: number;
  shipping_cost?: number;
  shipped_at?: string;
  received_at?: string;
  status_changed_at?: string;
  note?: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface OutboundShipmentItem {
  database_id?: string;
  id: string;
  outbound_shipment_id: string;
  japan_package_item_id?: string;
  product_group_id?: string;
  product_variant_id?: string;
  product_title?: string;
  variant_name?: string;
  sku?: string;
  quantity: number;
  checked: boolean;
  checked_at?: string;
  note?: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface PrivateOrder {
  database_id?: string;
  id: string; // PK
  product_group_id: string; // FK
  customer_name: string;
  contact: string;
  note: string;
  created_at: string;
  updated_at?: string;
  version?: number;
}

export interface PrivateOrderItem {
  database_id?: string;
  id: string; // PK
  private_order_id: string; // FK
  product_variant_id: string; // FK
  quantity: number;
  amount: number;
  note: string;
  updated_at?: string;
  version?: number;
}

export interface BundleComponent {
  database_id?: string;
  id: string; // PK
  bundle_variant_id: string; // FK to product_variants.id
  component_variant_id: string; // FK to product_variants.id
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface ProductGroup {
  database_id?: string;
  id: string; // PK (We will use product_title as ID for simplicity, or UUID)
  purchase_date: string;
  priority: 'High' | 'Medium' | 'Low';
  title: string;
  normalized_title?: string;
  listing_type?: string;
  source_type?: string;
  closing_date: string;
  release_month: string;
  has_official_site: boolean;
  product_url: string;
  proxy_agent?: string;
  show_in_purchase_list?: boolean;
  created_at: string;
  updated_at: string;
  version?: number;
}

export interface ProductCategory {
  database_id?: string;
  id: string; // PK
  product_group_id: string; // FK
  title: string;
  sort_order: number;
  updated_at?: string;
  version?: number;
}

export interface ProductVariant {
  database_id?: string;
  id: string; // PK
  product_group_id?: string; // FK
  product_category_id?: string; // FK (Deprecated)
  myacg_item_code: string;
  product_title: string;
  variant_name: string;
  raw_variant_name?: string;
  
  // Platform demands
  myacg_auto_quantity?: number;
  effective_myacg_quantity?: number;
  myacg_manual_adjustment?: number;
  waca_auto_quantity?: number;
  waca_manual_adjustment?: number;
  private_manual_adjustment?: number | null;
  purchased_manual_adjustment?: number | null;

  note: string;
  sort_order: number;

  // Order Import specific flags
  catalog_missing?: boolean;
  source?: "inventory_import" | "myacg_order_import" | "manual";

  // Cost Sync fields
  default_jpy_cost?: number | null;
  default_twd_cost?: number | null;

  updated_at?: string;
  version?: number;

  // Compatibility fields for manual variants
  waca_sku?: string;
  custom_sku?: string;
  unit_price?: number;
  source_type?: string;
  group_id?: string;
}

export interface ImportBatch {
  id: string; // PK
  platform: string; // 'myacg'
  file_name: string;
  imported_at: string;
  total_rows: number;
  valid_rows: number;
  skipped_cancelled_rows: number;
  new_order_items: number;
  skipped_duplicate_items: number;
  created_groups_count: number;
  completed_group_skus_count: number;
  catalog_missing_count: number;
  note: string;
  details: {
    newOrderItems: any[];
    skippedDuplicateItems: any[];
    createdGroups: string[];
    completedGroupSkus: any[];
    catalogMissingSkus: any[];
  };
}

export function normalizeProductTitle(title: string): string {
  if (!title) return '';
  let cleanTitle = title;

  // Protect 代理版
  cleanTitle = cleanTitle.replace(/代理版/g, '___DAILIBAN___');

  // Patterns to remove
  const patterns = [
    /【小河馬日本代購】/g,
    /【小河馬代購】/g,
    /預購/g,
    /現貨/g,
    /日本代購/g,
    /現地代購/g,
    /再版/g,
    /預約/g,
    /日版/g,
    /代理/g, 
    /\d{2,4}年\d{1,2}月/g,
  ];

  for (const p of patterns) {
    cleanTitle = cleanTitle.replace(p, '');
  }

  // Restore 代理版
  cleanTitle = cleanTitle.replace(/___DAILIBAN___/g, '代理版');
  
  return cleanTitle.trim().replace(/\s+/g, ' '); // Clean up extra spaces
}

export function determineListingType(title: string): string {
  if (!title) return '一般預購';
  if (title.includes('代理版') || title.includes('代理')) return '代理版';
  if (title.includes('現貨')) return '現貨';
  if (title.includes('現地代購')) return '現地代購';
  if (title.includes('日本代購')) return '日本代購';
  return '一般預購';
}

export function resolveMyacgSpecs(rawNames: string[]): Record<string, { category_label: string | null, variant_label: string }> {
  const result: Record<string, { category_label: string | null, variant_label: string }> = {};
  
  // 1. Filter, clean, and deduplicate names
  const uniqueNames = Array.from(new Set(rawNames.map(n => (n || '').trim()).filter(Boolean)));
  
  // 2. Count prefix frequencies (by word combinations)
  const prefixCounts: Record<string, number> = {};
  uniqueNames.forEach(name => {
    const parts = name.split(/\s+/);
    // Generate prefixes from 1 word up to N-1 words
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(' ');
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }
  });

  // 3. Find the longest prefix with count > 1 for each name
  uniqueNames.forEach(name => {
    const parts = name.split(/\s+/);
    let bestPrefix: string | null = null;
    let maxWords = 0;

    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(' ');
      if (prefixCounts[prefix] > 1) {
        if (i > maxWords) {
          maxWords = i;
          bestPrefix = prefix;
        }
      }
    }

    if (bestPrefix) {
      result[name] = {
        category_label: bestPrefix,
        variant_label: parts.slice(maxWords).join(' ')
      };
    } else {
      result[name] = {
        category_label: null,
        variant_label: name
      };
    }
  });

  // Fallback for empty or unmatched names
  rawNames.forEach(name => {
    if (!name) {
      result[''] = { category_label: null, variant_label: '' };
    } else if (!result[name]) {
      result[name] = { category_label: null, variant_label: name.trim() };
    }
  });

  return result;
}

export function mergeVariantNames(name1: string, name2: string): string {
  if (!name1) return name2 || '';
  if (!name2) return name1 || '';
  if (name1.trim() === name2.trim()) return name1;

  const expand = (name: string): string[] => {
    const parts = name.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) return parts;
    
    const firstPart = parts[0];
    const firstWords = firstPart.split(/\s+/);
    if (firstWords.length <= 1) return parts;
    
    const prefixWords = firstWords.slice(0, -1);
    const prefix = prefixWords.join(' ');
    
    return parts.map((part, idx) => {
      if (idx === 0) return part;
      const partWords = part.split(/\s+/);
      if (prefixWords.length > 0 && partWords[0] === prefixWords[0]) {
        return part;
      }
      return `${prefix} ${part}`.trim();
    });
  };

  const expanded1 = expand(name1);
  const expanded2 = expand(name2);
  
  const uniqueParts: string[] = [];
  for (const part of [...expanded1, ...expanded2]) {
    let shouldAdd = true;
    for (let i = 0; i < uniqueParts.length; i++) {
      const existing = uniqueParts[i];
      if (existing === part) {
        shouldAdd = false;
        break;
      }
      if (existing.includes(part)) {
        shouldAdd = false;
        break;
      }
      if (part.includes(existing)) {
        uniqueParts[i] = part;
        shouldAdd = false;
        break;
      }
    }
    if (shouldAdd) {
      uniqueParts.push(part);
    }
  }
  // Remove any exact duplicates that might have sneaked in
  const finalUniqueParts = Array.from(new Set(uniqueParts));
  if (finalUniqueParts.length === 1) return finalUniqueParts[0];

  const findCommonPrefix = (arr: string[]): string => {
    if (arr.length === 0) return '';
    const wordLists = arr.map(s => s.split(/\s+/));
    let commonWords: string[] = [];
    const minLen = Math.min(...wordLists.map(list => list.length));
    
    for (let i = 0; i < minLen; i++) {
      const word = wordLists[0][i];
      const allMatch = wordLists.every(list => list[i] === word);
      if (allMatch) {
        commonWords.push(word);
      } else {
        break;
      }
    }
    return commonWords.join(' ');
  };

  const prefix = findCommonPrefix(finalUniqueParts);
  if (prefix) {
    const suffixes = finalUniqueParts.map(part => {
      return part.slice(prefix.length).trim();
    }).filter(Boolean);
    
    if (suffixes.length > 0) {
      return `${prefix} ${suffixes.join(' / ')}`;
    }
    return prefix;
  }

  return finalUniqueParts.join(' / ');
}

export interface ImportStats {
  total: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  groupCount: number;
}

export const VARIANT_DESTRUCTIVE_SYNC_GUARD_MESSAGE =
  '商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。';

export class VariantDestructiveSyncGuardError extends Error {
  readonly code = 'VARIANT_DESTRUCTIVE_SYNC_GUARD';

  constructor(reason: string, options?: { cause?: unknown }) {
    super(VARIANT_DESTRUCTIVE_SYNC_GUARD_MESSAGE, options);
    this.name = 'VariantDestructiveSyncGuardError';
    console.error(`[Variant Destructive Sync Guard] ${reason}`, options?.cause);
  }
}

export const isVariantDestructiveSyncGuardError = (error: unknown): boolean => (
  error instanceof VariantDestructiveSyncGuardError
  || (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'VARIANT_DESTRUCTIVE_SYNC_GUARD'
  )
);

/**
 * Test-only failure injection for the P0-G manual acceptance SOP.
 * Production builds cannot enable this path, even if the query parameter is present.
 */
export const isVariantSyncReadFailureInjectionEnabled = (): boolean => (
  import.meta.env.DEV
  && (import.meta.env.MODE === 'next' || import.meta.env.MODE === 'experimental')
  && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('simulateVariantReadFailure') === '1'
);

export const isVariantSyncGuardAcceptanceUiEnabled = (): boolean => (
  import.meta.env.DEV
  && (import.meta.env.MODE === 'next' || import.meta.env.MODE === 'experimental')
  && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('p0GGuardAcceptance') === '1'
);

export interface DatabaseAdapter {
  getInventory(): Promise<InventoryItem[]>;
  saveInventory(items: InventoryItem[]): Promise<void>;
  upsertInventory(items: InventoryItem[]): Promise<ImportStats>;
  
  getSalesOrders(): Promise<SalesOrder[]>;
  saveSalesOrders(items: SalesOrder[]): Promise<void>;
  getSalesOrderItems(): Promise<SalesOrderItem[]>;
  saveSalesOrderItems(items: SalesOrderItem[]): Promise<void>;

  getProductGroups(): Promise<ProductGroup[]>;
  saveProductGroups(groups: ProductGroup[]): Promise<void>;
  getProductCategories(): Promise<ProductCategory[]>;
  saveProductCategories(categories: ProductCategory[]): Promise<void>;
  getProductVariants(options?: { recalc?: boolean; raw?: boolean }): Promise<ProductVariant[]>;
  saveProductVariants(variants: ProductVariant[]): Promise<void>;
  updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void>;
  updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void>;

  getPurchaseBatches(): Promise<PurchaseBatch[]>;
  savePurchaseBatches(batches: PurchaseBatch[]): Promise<void>;
  getPurchaseBatchItems(): Promise<PurchaseBatchItem[]>;
  savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void>;
  savePurchaseBatchTransaction(batches: PurchaseBatch[], items: PurchaseBatchItem[]): Promise<void>;
  savePrivateOrderTransaction(command: PrivateOrderTransactionCommand): Promise<void>;
  applyRelatedTransaction(command: RelatedTransactionCommand): Promise<void>;

  getPrivateOrders(): Promise<PrivateOrder[]>;
  savePrivateOrders(orders: PrivateOrder[]): Promise<void>;
  getPrivateOrderItems(): Promise<PrivateOrderItem[]>;
  savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void>;
  deletePrivateOrderItems(ids: string[]): Promise<void>;

  getJapanPackages(): Promise<JapanPackage[]>;
  saveJapanPackages(packages: JapanPackage[]): Promise<void>;
  getJapanPackageItems(): Promise<JapanPackageItem[]>;
  saveJapanPackageItems(items: JapanPackageItem[]): Promise<void>;
  saveJapanPackageTransaction(packages: JapanPackage[], items: JapanPackageItem[]): Promise<void>;

  getOutboundShipments(): Promise<OutboundShipment[]>;
  saveOutboundShipments(shipments: OutboundShipment[]): Promise<void>;
  getOutboundShipmentItems(): Promise<OutboundShipmentItem[]>;
  saveOutboundShipmentItems(items: OutboundShipmentItem[]): Promise<void>;
  saveOutboundShipmentTransaction(shipments: OutboundShipment[], items: OutboundShipmentItem[]): Promise<void>;

  getBundleComponents(): Promise<BundleComponent[]>;
  saveBundleComponents(components: BundleComponent[]): Promise<void>;

  getImportBatches(): Promise<ImportBatch[]>;
  saveImportBatches(batches: ImportBatch[]): Promise<void>;

  exportData(): Promise<void>;
  importData(jsonString: string): Promise<boolean>;
  clearData(): Promise<void>;
  clearPurchaseRecords(): Promise<void>;
  createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void>;
  reparseProductVariants(): Promise<void>;
  reparseProductTitles(): Promise<void>;
  syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount?: number }>;
  deleteProductVariant(id: string): Promise<void>;
  getLastImportBackup(): Promise<{ data: string; timestamp: string } | null>;
  saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void>;
}

// Helper for local storage
const loadData = <T>(key: string, defaultValue: T): T => {
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      return JSON.parse(stored) as T;
    } catch (e) {
      console.error(`Failed to parse ${key} from localStorage`, e);
    }
  }
  return defaultValue;
};

const saveData = <T>(key: string, data: T) => {
  localStorage.setItem(key, JSON.stringify(data));
};

export const getBaseSku = (code: string): string => {
  if (!code) return '';
  const clean = code.trim().toUpperCase();
  const parts = clean.split('_');
  // If the last part is a number or variant index, strip it
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('_');
  }
  return clean;
};

export const findMatchingInventoryItem = (
  variantOrCode: string | ProductVariant,
  inventory: InventoryItem[]
): InventoryItem | undefined => {
  if (!variantOrCode) return undefined;

  let cleanCode: string;
  let rawVariantName: string | undefined = undefined;
  let variantName: string | undefined = undefined;

  if (typeof variantOrCode === 'string') {
    cleanCode = variantOrCode.trim().toUpperCase();
  } else {
    cleanCode = (variantOrCode.myacg_item_code || '').trim().toUpperCase();
    rawVariantName = variantOrCode.raw_variant_name;
    variantName = variantOrCode.variant_name;
  }

  if (!cleanCode) return undefined;

  const matches = inventory.filter(i => i.myacg_item_code.trim().toUpperCase() === cleanCode);
  if (matches.length === 0) return undefined;

  // Priority 1: Match by SKU + raw_variant_name
  if (rawVariantName) {
    const cleanRaw = rawVariantName.trim();
    const matchRaw = matches.find(i => i.raw_variant_name?.trim() === cleanRaw);
    if (matchRaw) return matchRaw;
  }

  // Priority 2: Match by SKU + variant_name (for compatibility)
  if (variantName) {
    const cleanVar = variantName.trim();
    const matchVar = matches.find(i => i.raw_variant_name?.trim() === cleanVar);
    if (matchVar) return matchVar;
  }

  // Priority 3: Fallback to SKU only.
  // ONLY fallback to SKU-only matching if:
  // 1. Input has no spec name (neither rawVariantName nor variantName).
  // 2. OR if the inventory item has no raw_variant_name.
  if (!rawVariantName && !variantName) {
    return matches[0];
  } else {
    // Input has a spec name. We can match an inventory item only if it has NO raw_variant_name.
    return matches.find(i => !i.raw_variant_name || i.raw_variant_name.trim() === '');
  }
};

export const findInventoryItemForVariant = findMatchingInventoryItem;

export const findMatchingVariant = (
  itemOrCode: string | InventoryItem,
  variants: ProductVariant[],
  productGroupId?: string
): ProductVariant | undefined => {
  if (!itemOrCode) return undefined;

  let cleanCode: string;
  let rawVariantName: string | undefined = undefined;

  if (typeof itemOrCode === 'string') {
    cleanCode = itemOrCode.trim().toUpperCase();
  } else {
    cleanCode = (itemOrCode.myacg_item_code || '').trim().toUpperCase();
    rawVariantName = itemOrCode.raw_variant_name;
  }

  if (!cleanCode) return undefined;

  // Filter variants by productGroupId if provided
  const targetVariants = productGroupId 
    ? variants.filter(v => v.product_group_id === productGroupId)
    : variants;

  // Priority 1: Match by SKU + raw_variant_name
  if (rawVariantName) {
    const cleanRaw = rawVariantName.trim();
    const matchRaw = targetVariants.find(
      v => v.myacg_item_code.trim().toUpperCase() === cleanCode && v.raw_variant_name?.trim() === cleanRaw
    );
    if (matchRaw) return matchRaw;

    // Priority 2: Match by SKU + variant_name (compatibility)
    const matchVarName = targetVariants.find(
      v => v.myacg_item_code.trim().toUpperCase() === cleanCode && v.variant_name?.trim() === cleanRaw
    );
    if (matchVarName) return matchVarName;
  }

  // Priority 3: Fallback to SKU only.
  // ONLY fallback to SKU-only matching if:
  // 1. The incoming item/variant has no spec name (raw_variant_name is empty/falsy).
  // 2. OR if the matched variant in the database has no spec name (v.raw_variant_name is empty/falsy).
  const skuMatches = targetVariants.filter(v => v.myacg_item_code.trim().toUpperCase() === cleanCode);
  
  if (!rawVariantName) {
    // If incoming has no spec name, we can match any SKU match, preferably one with no raw_variant_name.
    if (skuMatches.length === 1) {
      return skuMatches[0];
    }
    if (skuMatches.length > 1) {
      return skuMatches.find(v => !v.raw_variant_name) || skuMatches[0];
    }
  } else {
    // Incoming has a spec name, but we didn't find an exact match in Priority 1/2.
    // We can only match a database variant if it has NO raw_variant_name (meaning it's a legacy variant with no spec).
    const legacyMatches = skuMatches.filter(v => !v.raw_variant_name || v.raw_variant_name.trim() === '');
    if (legacyMatches.length > 0) {
      // Return the first legacy variant that has no spec name
      return legacyMatches[0];
    }
  }

  return undefined;
};

export const calculateFinalMyacgDemand = (
  variantOrCode: string | ProductVariant, 
  inventory: InventoryItem[], 
  salesOrderItems?: SalesOrderItem[]
): number => {
  void salesOrderItems;
  if (!variantOrCode) return -1;
  const invItem = findMatchingInventoryItem(variantOrCode, inventory);
  if (invItem) {
    return invItem.myacg_sold_quantity ?? 0;
  }
  // SKU is missing from inventory catalog
  if (typeof variantOrCode === 'object' && variantOrCode !== null) {
    // Attempt to return the variant's existing quantities
    const existingVal = variantOrCode.effective_myacg_quantity ?? variantOrCode.myacg_auto_quantity;
    if (existingVal !== undefined && existingVal !== null && existingVal >= 0) {
      return existingVal;
    }
  }
  return -1;
};

export interface VariantDemandResult {
  myacg: number;
  waca: number;
  privateOrder: number;
  purchased: number;
  gap: number;
}

export interface GroupDemandResult {
  demand: number;
  myacg: number;
  waca: number;
  privateOrder: number;
  purchased: number;
  gap: number;
  hasCatalogMissing: boolean;
}

export const calculateVariantDemandAndPurchased = (
  v: ProductVariant,
  privateOrderItems: PrivateOrderItem[],
  batchItems: PurchaseBatchItem[],
  inventory: InventoryItem[],
  salesOrderItems?: SalesOrderItem[]
): VariantDemandResult => {
  // 買動漫數量
  const rawMyacgQty = calculateFinalMyacgDemand(v.myacg_item_code || '', inventory, salesOrderItems);
  const localMyacg = (rawMyacgQty >= 0 ? rawMyacgQty : 0) + (v.myacg_manual_adjustment ?? 0);
  const autoMyacg = (v.myacg_auto_quantity !== null && v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity >= 0)
    ? v.myacg_auto_quantity + (v.myacg_manual_adjustment ?? 0)
    : null;
  const rawMyacg = (v.effective_myacg_quantity !== null && v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity >= 0)
    ? v.effective_myacg_quantity + (v.myacg_manual_adjustment ?? 0)
    : (autoMyacg ?? (v as any).myacg_quantity ?? localMyacg);
  const vMyacg = rawMyacg >= 0 ? rawMyacg : 0;

  // WACA 數量
  const localWaca = (v.waca_auto_quantity ?? 0) + (v.waca_manual_adjustment ?? 0);
  const autoWaca = (v.waca_auto_quantity !== null && v.waca_auto_quantity !== undefined && v.waca_auto_quantity >= 0)
    ? v.waca_auto_quantity + (v.waca_manual_adjustment ?? 0)
    : null;
  const rawWaca = autoWaca ?? (v as any).waca_quantity ?? localWaca;
  const vWaca = rawWaca >= 0 ? rawWaca : 0;

  // 私下數量
  const localPrivate = privateOrderItems.filter(poi => poi && poi.product_variant_id === v.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
  // Accepted worksheet contract (624c9a8): private-order items are authoritative.
  const vPrivate = localPrivate >= 0 ? localPrivate : 0;

  // 已採購 / 已下單數量
  const localPurchased = batchItems.filter(pbi => pbi && pbi.product_variant_id === v.id).reduce((sum, item) => sum + (item.quantity || 0), 0);

  const manualPurchased = v.purchased_manual_adjustment;
  const legacyPurchased = (v as any).ordered_quantity ?? (v as any).ordered_qty;

  // Fallback checking order:
  // manual > 0 -> manual
  // else localPurchased > 0 -> localPurchased
  // else legacyPurchased > 0 -> legacyPurchased
  // else 0
  let rawPurchased = 0;
  if (typeof manualPurchased === 'number' && manualPurchased > 0) {
    rawPurchased = manualPurchased;
  } else if (localPurchased > 0) {
    rawPurchased = localPurchased;
  } else if (typeof legacyPurchased === 'number' && legacyPurchased > 0) {
    rawPurchased = legacyPurchased;
  }

  const vPurchased = rawPurchased;

  const demand = vMyacg + vWaca + vPrivate;
  const gap = Math.max(demand - vPurchased, 0);

  return {
    myacg: vMyacg,
    waca: vWaca,
    privateOrder: vPrivate,
    purchased: vPurchased,
    gap
  };
};

export const calculateGroupDemandAndPurchased = (
  groupId: string,
  categories: ProductCategory[],
  variants: ProductVariant[],
  privateOrderItems: PrivateOrderItem[],
  batchItems: PurchaseBatchItem[],
  inventory: InventoryItem[],
  salesOrderItems?: SalesOrderItem[]
): GroupDemandResult => {
  const catIds = new Set(categories.filter(c => c && c.product_group_id === groupId).map(c => c.id));
  const groupVars = variants.filter(v => v && (v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id))));
  
  let totalDemand = 0;
  let totalMyacg = 0;
  let totalWaca = 0;
  let totalPrivateOrder = 0;
  let totalPurchased = 0;
  let gap = 0;
  
  groupVars.forEach(v => {
    if (!v) return;
    const res = calculateVariantDemandAndPurchased(v, privateOrderItems, batchItems, inventory, salesOrderItems);
    totalMyacg += res.myacg;
    totalWaca += res.waca;
    totalPrivateOrder += res.privateOrder;
    totalDemand += (res.myacg + res.waca + res.privateOrder);
    totalPurchased += res.purchased;
    gap += res.gap;
  });
  
  const hasCatalogMissing = groupVars.some(v => v && v.catalog_missing === true);
  return {
    demand: totalDemand,
    myacg: totalMyacg,
    waca: totalWaca,
    privateOrder: totalPrivateOrder,
    purchased: totalPurchased,
    gap,
    hasCatalogMissing
  };
};

export const normalizeDateInput = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const clean = value.trim();
  if (clean === '') return null;

  // Format: YYYYMMDD (e.g. 20261005)
  const yyyymmddMatch = clean.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmddMatch) {
    const y = parseInt(yyyymmddMatch[1], 10);
    const m = parseInt(yyyymmddMatch[2], 10);
    const d = parseInt(yyyymmddMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // Format: MMDD (e.g. 1005, 0704)
  const mmddMatch = clean.match(/^(\d{2})(\d{2})$/);
  if (mmddMatch) {
    const y = 2026; // Default to 2026 (this year)
    const m = parseInt(mmddMatch[1], 10);
    const d = parseInt(mmddMatch[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // Format: YYYY/MM/DD or YYYY-MM-DD (e.g. 2026/10/5, 2026-10-5)
  const fullSplitMatch = clean.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (fullSplitMatch) {
    const y = parseInt(fullSplitMatch[1], 10);
    const m = parseInt(fullSplitMatch[2], 10);
    const d = parseInt(fullSplitMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // Format: MM/DD or MM-DD (e.g. 10/5, 10-5, 7/4)
  const partialSplitMatch = clean.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (partialSplitMatch) {
    const y = 2026; // Default to 2026 (this year)
    const m = parseInt(partialSplitMatch[1], 10);
    const d = parseInt(partialSplitMatch[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  return null;
};

export class LocalStorageAdapter implements DatabaseAdapter {
  async getInventory(): Promise<InventoryItem[]> {
    return loadData<InventoryItem[]>('erp_inventory', []);
  }

  async saveInventory(items: InventoryItem[]): Promise<void> {
    saveData('erp_inventory', items);
  }

  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    const current = await this.getInventory();
    
    // Collect parentCodes and normalizedTitles from incoming items to delete old residues
    const parentCodes = new Set<string>();
    const normalizedTitles = new Set<string>();
    for (const item of items) {
      const pCode = item.myacg_parent_code || getBaseSku(item.myacg_item_code);
      if (pCode) {
        parentCodes.add(pCode.trim().toUpperCase());
      } else {
        const normTitle = item.normalized_product_title || normalizeProductTitle(item.product_title);
        if (normTitle) {
          normalizedTitles.add(normTitle);
        }
      }
    }

    const parentCodesArr = Array.from(parentCodes);
    const normalizedTitlesArr = Array.from(normalizedTitles);

    const filteredCurrent = current.filter(x => {
      if (parentCodesArr.length > 0) {
        const codeUpper = (x.myacg_item_code || '').trim().toUpperCase();
        const parentUpper = (x.myacg_parent_code || '').trim().toUpperCase();
        for (const pc of parentCodesArr) {
          if (parentUpper === pc || codeUpper === pc || codeUpper.startsWith(pc + '_')) {
            return false;
          }
        }
      } else {
        const normTitle = x.normalized_product_title || normalizeProductTitle(x.product_title);
        if (normTitle && normalizedTitlesArr.includes(normTitle)) {
          return false;
        }
      }
      return true;
    });

    const currentMap = new Map(filteredCurrent.map(i => [i.myacg_item_code, i]));
    
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    const groupSet = new Set<string>();

    // Pre-aggregate the incoming items by myacg_item_code to handle duplicates inside the same file
    const aggregatedItemsMap = new Map<string, InventoryItem>();
    for (const item of items) {
      const code = item.myacg_item_code;
      const existingAgg = aggregatedItemsMap.get(code);
      if (!existingAgg) {
        aggregatedItemsMap.set(code, { ...item });
      } else {
        // Merge raw variant names and product titles
        // existingAgg.raw_variant_name = mergeVariantNames(existingAgg.raw_variant_name, item.raw_variant_name);
        // existingAgg.product_title = mergeVariantNames(existingAgg.product_title, item.product_title);
        existingAgg.raw_variant_name = item.raw_variant_name || existingAgg.raw_variant_name;
        existingAgg.product_title = item.product_title || existingAgg.product_title;

        // Sum quantities
        existingAgg.myacg_sold_quantity = (existingAgg.myacg_sold_quantity ?? 0) + (item.myacg_sold_quantity ?? 0);
        existingAgg.myacg_available_quantity = (existingAgg.myacg_available_quantity ?? 0) + (item.myacg_available_quantity ?? 0);
        if (item.myacg_demand_quantity !== undefined) {
          existingAgg.myacg_demand_quantity = (existingAgg.myacg_demand_quantity ?? 0) + (item.myacg_demand_quantity ?? 0);
        }
      }
    }
    const incomingItems = Array.from(aggregatedItemsMap.values());

    for (const item of incomingItems) {
      item.normalized_product_title = normalizeProductTitle(item.product_title);
      item.listing_type = determineListingType(item.product_title);
      groupSet.add(item.normalized_product_title);

      const existing = currentMap.get(item.myacg_item_code);
      if (!existing) {
        newCount++;
        currentMap.set(item.myacg_item_code, item);
      } else {
        // Merge raw variant names and product titles from existing database item to prevent loss
        // item.raw_variant_name = mergeVariantNames(existing.raw_variant_name, item.raw_variant_name);
        // item.product_title = mergeVariantNames(existing.product_title, item.product_title);
        item.raw_variant_name = item.raw_variant_name || existing.raw_variant_name;
        item.product_title = item.product_title || existing.product_title;
        item.normalized_product_title = normalizeProductTitle(item.product_title);
        item.listing_type = determineListingType(item.product_title);

        const isChanged = 
          existing.product_title !== item.product_title ||
          existing.raw_variant_name !== item.raw_variant_name ||
          existing.final_price !== item.final_price ||
          existing.myacg_available_quantity !== item.myacg_available_quantity ||
          existing.myacg_sold_quantity !== item.myacg_sold_quantity ||
          existing.myacg_demand_quantity !== item.myacg_demand_quantity ||
          existing.myacg_listed_at !== item.myacg_listed_at;
        
        if (isChanged) {
          updatedCount++;
        } else {
          unchangedCount++;
        }
        currentMap.set(item.myacg_item_code, { ...existing, ...item });
      }
    }
    await this.saveInventory(Array.from(currentMap.values()));
    return {
      total: items.length,
      newCount,
      updatedCount,
      unchangedCount,
      groupCount: groupSet.size
    };
  }

  async createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void> {
    const allInventory = await this.getInventory();
    const targetItems = allInventory.filter(i => itemCodes.includes(i.myacg_item_code));
    if (targetItems.length === 0) return;

    const groups = await this.getProductGroups();
    const categories = await this.getProductCategories();
    const variants = await this.getProductVariants();

    let groupsUpdated = false;
    let categoriesUpdated = false;
    let variantsUpdated = false;

    // Group targets by product_title to parse their names together
    const itemsByTitle: Record<string, typeof targetItems> = {};
    for (const item of targetItems) {
      if (!itemsByTitle[item.product_title]) itemsByTitle[item.product_title] = [];
      itemsByTitle[item.product_title].push(item);
    }

    for (const title of Object.keys(itemsByTitle)) {
      const itemsInGroup = itemsByTitle[title];
      
      // 1. Group
      let group = groups.find(g => g.title === title);
      if (!group) {
        group = {
          id: crypto.randomUUID(),
          title: title,
          normalized_title: normalizeProductTitle(title),
          listing_type: determineListingType(title),
          priority: 'Low',
          purchase_date: '',
          closing_date: '',
          release_month: '',
          has_official_site: false,
          product_url: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        groups.push(group);
        groupsUpdated = true;
      } else {
        // Just in case it's an old group without normalized_title
        if (!group.normalized_title) {
          group.normalized_title = normalizeProductTitle(title);
          group.listing_type = determineListingType(title);
          groupsUpdated = true;
        }
      }

      // We should resolve specs using ALL variants in this group + new items
      const existingVars = variants.filter(v => v.product_group_id === group!.id);
      const allRawNames = [
        ...existingVars.map(v => v.raw_variant_name || ''),
        ...itemsInGroup.map(i => i.raw_variant_name)
      ].filter(Boolean);
      
      const resolvedSpecs = resolveMyacgSpecs(allRawNames);

      for (const item of itemsInGroup) {
        const spec = resolvedSpecs[item.raw_variant_name] || { category_label: null, variant_label: item.raw_variant_name };

        // 2. Category
        let categoryId: string | undefined = undefined;
        if (spec.category_label) {
          let category = categories.find(c => c.product_group_id === group!.id && c.title === spec.category_label);
          if (!category) {
            category = {
              id: crypto.randomUUID(),
              product_group_id: group.id,
              title: spec.category_label,
              sort_order: categories.filter(c => c.product_group_id === group!.id).length
            };
            categories.push(category);
            categoriesUpdated = true;
          }
          categoryId = category.id;
        }

        // 3. Variant
        let variant = findMatchingVariant(item, variants, group!.id);
        if (!variant) {
          variant = {
            id: crypto.randomUUID(),
            product_group_id: group.id,
            product_category_id: categoryId,
            myacg_item_code: item.myacg_item_code,
            product_title: item.product_title,
            variant_name: spec.variant_label,
            raw_variant_name: item.raw_variant_name,
            myacg_auto_quantity: 0,
            effective_myacg_quantity: 0,
            waca_auto_quantity: 0,
            note: '',
            sort_order: variants.filter(v => v.product_group_id === group!.id).length
          };
          variants.push(variant);
          variantsUpdated = true;
        } else {
          if (
            variant.variant_name !== spec.variant_label ||
            variant.product_category_id !== categoryId ||
            variant.product_title !== item.product_title ||
            variant.raw_variant_name !== item.raw_variant_name
          ) {
            variant.variant_name = spec.variant_label;
            variant.raw_variant_name = item.raw_variant_name;
            variant.product_title = item.product_title;
            variant.product_category_id = categoryId;
            variantsUpdated = true;
          }
        }
      }
      
      // Update existing variants that were already in the group
      for (const existingVar of existingVars) {
        const invItem = findMatchingInventoryItem(existingVar, targetItems);
        const rawName = invItem ? invItem.raw_variant_name : existingVar.raw_variant_name;
        if (rawName) {
          const spec = resolvedSpecs[rawName];
          if (spec) {
            let categoryId: string | undefined = undefined;
            if (spec.category_label) {
              let category = categories.find(c => c.product_group_id === group!.id && c.title === spec.category_label);
              if (!category) {
                category = {
                  id: crypto.randomUUID(),
                  product_group_id: group!.id,
                  title: spec.category_label,
                  sort_order: categories.filter(c => c.product_group_id === group!.id).length
                };
                categories.push(category);
                categoriesUpdated = true;
              }
              categoryId = category.id;
            }

            let updated = false;
            if (existingVar.variant_name !== spec.variant_label) {
              existingVar.variant_name = spec.variant_label;
              updated = true;
            }
            if (existingVar.product_category_id !== categoryId) {
              existingVar.product_category_id = categoryId;
              updated = true;
            }
            if (invItem && existingVar.product_title !== invItem.product_title) {
              existingVar.product_title = invItem.product_title;
              updated = true;
            }
            if (invItem && existingVar.raw_variant_name !== invItem.raw_variant_name) {
              existingVar.raw_variant_name = invItem.raw_variant_name;
              updated = true;
            }
            if (updated) {
              variantsUpdated = true;
            }
          }
        }
      }

      // Update Category sort_order for this group
      for (const cat of categories.filter(c => c.product_group_id === group.id)) {
        const variantsInCat = variants.filter(v => v.product_group_id === group.id && v.product_category_id === cat.id);
        let minSort = 9999;
        for (const v of variantsInCat) {
            const invItem = findMatchingInventoryItem(v, targetItems);
            const vSort = (invItem?.import_sort_index ?? v.sort_order ?? 9999);
            if (vSort < minSort) minSort = vSort;
        }
        cat.sort_order = minSort;
      }
    }

    if (groupsUpdated) await this.saveProductGroups(groups);
    if (categoriesUpdated) await this.saveProductCategories(categories);
    if (variantsUpdated) await this.saveProductVariants(variants);
  }

  async reparseProductVariants(): Promise<void> {
    const allInventory = await this.getInventory();
    const inventoryMap = new Map(allInventory.map(i => [i.myacg_item_code, i]));

    const groups = await this.getProductGroups();
    const categories = await this.getProductCategories();
    const variants = await this.getProductVariants({ recalc: true });

    let categoriesUpdated = false;
    let variantsUpdated = false;

    for (const group of groups) {
      const groupVariants = variants.filter(v => v.product_group_id === group.id);
      
      // We will ensure raw_variant_name and product_title are in sync with inventory
      groupVariants.forEach(v => {
        const invItem = inventoryMap.get(v.myacg_item_code);
        if (invItem) {
          if (v.raw_variant_name !== invItem.raw_variant_name || v.product_title !== invItem.product_title) {
            v.raw_variant_name = invItem.raw_variant_name;
            v.product_title = invItem.product_title;
            variantsUpdated = true;
          }
        }
      });

      const allRawNames = groupVariants.map(v => v.raw_variant_name || '').filter(Boolean);
      const resolvedSpecs = resolveMyacgSpecs(allRawNames);

      for (const v of groupVariants) {
        if (!v.raw_variant_name) continue;
        const spec = resolvedSpecs[v.raw_variant_name];
        if (!spec) continue;

        let categoryId: string | undefined = undefined;
        if (spec.category_label) {
          let category = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
          if (!category) {
            category = {
              id: crypto.randomUUID(),
              product_group_id: group.id,
              title: spec.category_label,
              sort_order: categories.filter(c => c.product_group_id === group.id).length
            };
            categories.push(category);
            categoriesUpdated = true;
          }
          categoryId = category.id;
        } else {
          categoryId = undefined; // Nullify category for single items
        }

        if (v.variant_name !== spec.variant_label || v.product_category_id !== categoryId) {
          v.variant_name = spec.variant_label;
          v.product_category_id = categoryId;
          variantsUpdated = true;
        }
      }
    }

    // Clean up empty categories (optional, but good practice)
    const activeCategoryIds = new Set(variants.map(v => v.product_category_id).filter(Boolean));
    const activeCategories = categories.filter(c => activeCategoryIds.has(c.id));
    if (activeCategories.length !== categories.length) {
      categories.splice(0, categories.length, ...activeCategories);
      categoriesUpdated = true;
    }

    if (categoriesUpdated) await this.saveProductCategories(categories);
    if (variantsUpdated) await this.saveProductVariants(variants);
  }

  
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount: number }> {
    const allInventory = await this.getInventory();
    const groups = await this.getProductGroups();
    const variants = await this.getProductVariants();
    let categories = await this.getProductCategories();

    let filledVariantsCount = 0;
    let affectedGroupsCount = 0;
    let anyGroupChanged = false;
    let upgradedSkusCount = 0;

    for (const group of groups) {
      const groupNormTitle = group.normalized_title || normalizeProductTitle(group.title);
      const groupTitle = group.title;

      const matchingItems = allInventory.filter(item => {
        const itemNorm = item.normalized_product_title || normalizeProductTitle(item.product_title);
        if (groupNormTitle && itemNorm) {
            return groupNormTitle === itemNorm;
        }
        return item.product_title === groupTitle;
      });

      const existingVariants = variants.filter(v => v.product_group_id === group.id || 
         (v.product_category_id && categories.some(c => c.id === v.product_category_id && c.product_group_id === group.id)));

      let groupChanged = false;
      const ambiguousItemCodes = new Set<string>();

      // SKU Auto-Upgrade Phase for new catalog format
      for (const item of matchingItems) {
        const hasExactMatch = existingVariants.some(v => v.myacg_item_code === item.myacg_item_code);
        if (hasExactMatch) continue;

        const parentCode = item.myacg_parent_code || getBaseSku(item.myacg_item_code);
        if (!parentCode) continue;

        const cleanParent = parentCode.trim().toUpperCase();
        const cleanRaw = item.raw_variant_name?.trim();

        // 1. Find candidates matching strict raw_variant_name and parent code prefix, excluding manual source
        const candidates = existingVariants.filter(v => {
          if (v.source === 'manual') return false;
          
          const vCode = v.myacg_item_code.trim().toUpperCase();
          const prefixMatch = vCode === cleanParent || vCode.startsWith(cleanParent + '_');
          const nameMatch = v.raw_variant_name?.trim() === cleanRaw;
          return prefixMatch && nameMatch;
        });

        if (candidates.length === 1) {
          const matchVar = candidates[0];
          const oldCode = matchVar.myacg_item_code;
          matchVar.myacg_item_code = item.myacg_item_code;
          groupChanged = true;
          anyGroupChanged = true;
          upgradedSkusCount++;
          console.log(`[SKU Auto Upgrade] Variant ${matchVar.id} SKU upgraded: ${oldCode} -> ${item.myacg_item_code}`);
        } else if (candidates.length > 1) {
          ambiguousItemCodes.add(item.myacg_item_code);
          console.warn(`[SKU Auto Upgrade WARNING] Ambiguous match: multiple candidates found for item ${item.myacg_item_code} and spec "${item.raw_variant_name}"`);
        } else {
          // candidates.length === 0: check if variant_name matches (but raw_variant_name does not)
          const nameMatchCandidates = existingVariants.filter(v => {
            if (v.source === 'manual') return false;
            
            const vCode = v.myacg_item_code.trim().toUpperCase();
            const prefixMatch = vCode === cleanParent || vCode.startsWith(cleanParent + '_');
            const nameMatch = v.variant_name?.trim() === cleanRaw;
            return prefixMatch && nameMatch;
          });

          if (nameMatchCandidates.length > 0) {
            ambiguousItemCodes.add(item.myacg_item_code);
            console.warn(`[SKU Auto Upgrade WARNING] Ambiguous match: variant_name matched but raw_variant_name did not for item ${item.myacg_item_code} and spec "${item.raw_variant_name}"`);
          }
        }
      }

      const missingItems = matchingItems.filter(item => {
        if (ambiguousItemCodes.has(item.myacg_item_code)) return false;
        const matchingVar = findMatchingVariant(item, existingVariants, group.id);
        return !matchingVar;
      });
      
      // 1. Process existing variants: check if they are missing from catalog and update sort_order
      for (const v of existingVariants) {
        if (v.source === 'manual') {
          continue;
        }
        const invItem = findMatchingInventoryItem(v, matchingItems);
        if (invItem) {
          let updated = false;
          if (v.catalog_missing !== false) {
            v.catalog_missing = false;
            updated = true;
          }
          if (v.sort_order !== (invItem.import_sort_index ?? 9999)) {
            v.sort_order = invItem.import_sort_index ?? 9999;
            updated = true;
          }
          if (v.product_title !== invItem.product_title) {
            v.product_title = invItem.product_title;
            updated = true;
          }
          if (v.raw_variant_name !== invItem.raw_variant_name) {
            v.raw_variant_name = invItem.raw_variant_name;
            updated = true;
          }
          if (updated) {
            groupChanged = true;
          }
        } else {
          if (v.catalog_missing !== true || v.sort_order !== 999999) {
            v.catalog_missing = true;
            v.sort_order = 999999;
            groupChanged = true;
          }
        }
      }

      // 2. Add missing items from catalog
      if (missingItems.length > 0) {
        affectedGroupsCount++;
        groupChanged = true;
        
        const rawNames = matchingItems.map(i => i.raw_variant_name || '');
        const resolved = resolveMyacgSpecs(rawNames);

        for (const item of missingItems) {
            const spec = resolved[item.raw_variant_name || ''];
            let catId = undefined;
            
            if (spec && spec.category_label) {
                let cat = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
                if (!cat) {
                    cat = {
                        id: crypto.randomUUID(),
                        product_group_id: group.id,
                        title: spec.category_label,
                        sort_order: categories.filter(c => c.product_group_id === group.id).length
                    };
                    categories.push(cat);
                }
                catId = cat.id;
            }

            const newVariant = {
                id: crypto.randomUUID(),
                product_group_id: group.id,
                product_category_id: catId,
                myacg_item_code: item.myacg_item_code,
                product_title: item.product_title,
                variant_name: spec ? spec.variant_label : (item.raw_variant_name || ''),
                myacg_auto_quantity: 0,
                effective_myacg_quantity: 0,
                note: '',
                sort_order: item.import_sort_index ?? 9999,
                catalog_missing: false
            };
            variants.push(newVariant);
            existingVariants.push(newVariant); // add to existing for category calculation later
            filledVariantsCount++;
        }

        for (const item of matchingItems) {
            if (missingItems.includes(item)) continue; 
            
            const existingVar = findMatchingVariant(item, variants, group.id);
            if (existingVar) {
                let updated = false;
                if (existingVar.product_title !== item.product_title) {
                    existingVar.product_title = item.product_title;
                    updated = true;
                }
                if (existingVar.raw_variant_name !== item.raw_variant_name) {
                    existingVar.raw_variant_name = item.raw_variant_name;
                    updated = true;
                }
                
                const spec = resolved[item.raw_variant_name || ''];
                if (spec && spec.category_label) {
                    let cat = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
                    if (!cat) {
                        cat = {
                            id: crypto.randomUUID(),
                            product_group_id: group.id,
                            title: spec.category_label,
                            sort_order: categories.filter(c => c.product_group_id === group.id).length
                        };
                        categories.push(cat);
                    }
                    if (existingVar.product_category_id !== cat.id) {
                        existingVar.product_category_id = cat.id;
                        updated = true;
                    }
                    if (existingVar.variant_name !== spec.variant_label) {
                        existingVar.variant_name = spec.variant_label;
                        updated = true;
                    }
                } else if (spec) {
                    if (existingVar.product_category_id !== undefined) {
                        existingVar.product_category_id = undefined;
                        updated = true;
                    }
                    if (existingVar.variant_name !== spec.variant_label) {
                        existingVar.variant_name = spec.variant_label;
                        updated = true;
                    }
                }
                if (updated) {
                    groupChanged = true;
                }
            }
        }
      }

      // 3. Update category sort_order
      for (const cat of categories.filter(c => c.product_group_id === group.id)) {
        const variantsInCat = existingVariants.filter(v => v.product_category_id === cat.id);
        let minSort = 999999;
        for (const v of variantsInCat) {
          if (v.sort_order < minSort) minSort = v.sort_order;
        }
        if (variantsInCat.length > 0 && variantsInCat.every(v => v.catalog_missing)) {
          minSort = 999999; // If all are missing, put category at the end
        }
        if (cat.sort_order !== minSort) {
          cat.sort_order = minSort;
          groupChanged = true;
        }
      }

      if (groupChanged) {
        anyGroupChanged = true;
      }
    }

    if (anyGroupChanged) {
        await this.saveProductCategories(categories);
        await this.saveProductVariants(variants);
    }

    // Recalculate auto quantities based on new inventory sold numbers
    await this.getProductVariants({ recalc: true });

    return { filledVariantsCount, affectedGroupsCount, upgradedSkusCount };
  }

  async reparseProductTitles(): Promise<void> {
    const inventory = await this.getInventory();
    const groups = await this.getProductGroups();

    let invUpdated = false;
    for (const item of inventory) {
      const normalized = normalizeProductTitle(item.product_title);
      const lType = determineListingType(item.product_title);
      if (item.normalized_product_title !== normalized || item.listing_type !== lType) {
        item.normalized_product_title = normalized;
        item.listing_type = lType;
        invUpdated = true;
      }
    }

    let groupsUpdated = false;
    for (const group of groups) {
      const normalized = normalizeProductTitle(group.title);
      const lType = determineListingType(group.title);
      if (group.normalized_title !== normalized || group.listing_type !== lType) {
        group.normalized_title = normalized;
        group.listing_type = lType;
        groupsUpdated = true;
      }
    }

    if (invUpdated) await this.saveInventory(inventory);
    if (groupsUpdated) await this.saveProductGroups(groups);
  }

  async getSalesOrders(): Promise<SalesOrder[]> {
    return loadData<SalesOrder[]>('erp_sales_orders', []);
  }
  
  async saveSalesOrders(items: SalesOrder[]): Promise<void> {
    saveData('erp_sales_orders', items);
  }

  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return loadData<SalesOrderItem[]>('erp_sales_order_items', []);
  }

  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    saveData('erp_sales_order_items', items);
  }

  async getProductGroups(): Promise<ProductGroup[]> {
    return loadData<ProductGroup[]>('erp_product_groups', []);
  }

  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    saveData('erp_product_groups', groups);
  }

  async getProductCategories(): Promise<ProductCategory[]> {
    return loadData<ProductCategory[]>('erp_product_categories', []);
  }

  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    saveData('erp_product_categories', categories);
  }



  async getProductVariants(options?: { recalc?: boolean; raw?: boolean }): Promise<ProductVariant[]> {
    const variants = loadData<ProductVariant[]>('erp_product_variants', []);
    console.log(`[IndexedDB Read Variants] count: ${variants.length}`);
    console.log('[IndexedDB Read Variants] sample:', variants.length > 0 ? JSON.stringify(variants[0]) : 'empty');

    // Settings database statistics describe the stored collection, not the
    // business-facing deduped/canonical view used by catalog pages.
    if (options?.raw) return variants;
    
    const recalc = options?.recalc ?? false;
    const inventory = await this.getInventory();
    
    if (!recalc || inventory.length === 0) {
      console.log(`[getProductVariants Local] Skipping recalculation. recalc=${recalc}, inventory=${inventory.length}`);
      return variants;
    }
    
    const salesOrderItems = await this.getSalesOrderItems();
    const orders = await this.getSalesOrders();
    const orderMap = new Map(orders.map(o => [o.id, o]));
    
    // 1. Calculate orders demand for myacg
    const myacgOrderDemandMap = new Map<string, number>();

    for (const item of salesOrderItems) {
      if (item.order_status && item.order_status.includes('已取消')) continue;
      const order = orderMap.get(item.order_id);
      if (!order) continue;
      const platform = order.platform || 'myacg';
      const cleanItemCode = item.myacg_item_code.trim().toUpperCase();
      if (platform === 'myacg') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      } else if (platform === 'ruten') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      }
    }

    let changed = false;
    for (const v of variants) {
      // Find matching inventory item using fuzzy matching helpers
      const invItem = findMatchingInventoryItem(v, inventory);

      
      const rawMyacg = calculateFinalMyacgDemand(v, inventory, salesOrderItems);
      const effectiveMyacg = rawMyacg >= 0 ? rawMyacg : (v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity !== null && v.effective_myacg_quantity >= 0 ? v.effective_myacg_quantity : 0);
      const autoMyacg = rawMyacg >= 0 ? rawMyacg : (v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity !== null && v.myacg_auto_quantity >= 0 ? v.myacg_auto_quantity : 0);

      if (invItem) {
        const inventoryDemand = invItem.myacg_sold_quantity ?? invItem.myacg_demand_quantity;
        if (inventoryDemand == null || inventoryDemand === 0) {
          console.warn(`找到 SKU 但 myacg_sold_quantity 為空: ${v.myacg_item_code}`);
        }
      } else {
        console.warn(`找不到 InventoryItem 對應 SKU: ${v.myacg_item_code}`);
      }

      if (
        v.effective_myacg_quantity !== effectiveMyacg || 
        v.myacg_auto_quantity !== autoMyacg
      ) {
        v.effective_myacg_quantity = effectiveMyacg;
        v.myacg_auto_quantity = autoMyacg;
        changed = true;
      }
    }

    if (changed) {
      await this.saveProductVariants(variants);
    }
    return variants;
  }

  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    if (variants.length === 0) {
      console.warn("[IndexedDB Save Variants] SKIP empty variants save");
      return;
    }
    console.log(`[IndexedDB Save Variants] count: ${variants.length}`);
    saveData('erp_product_variants', variants);
  }

  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    const whitelist = new Set([
      'myacg_manual_adjustment',
      'waca_manual_adjustment',
      'private_manual_adjustment',
      'purchased_manual_adjustment',
      'default_jpy_cost',
      'default_twd_cost',
      'note',
      'updated_at',
      'version',
      'variant_name',
      'myacg_item_code'
    ]);
    for (const key of Object.keys(patch)) {
      if (!whitelist.has(key)) {
        throw new Error(`Field '${key}' is not allowed to be patched in updateProductVariantPatch`);
      }
    }

    const variants = await this.getProductVariants();
    const targetIdx = variants.findIndex(v => v.id === id);
    if (targetIdx !== -1) {
      variants[targetIdx] = { ...variants[targetIdx], ...patch };
      await this.saveProductVariants(variants);
    }
  }

  async deleteProductVariant(id: string): Promise<void> {
    const variants = await this.getProductVariants();
    const updated = variants.filter(v => v.id !== id);
    await this.saveProductVariants(updated);
  }

  async updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void> {
    const whitelist = new Set([
      'myacg_manual_adjustment',
      'waca_manual_adjustment',
      'private_manual_adjustment',
      'purchased_manual_adjustment',
      'default_jpy_cost',
      'default_twd_cost',
      'note',
      'updated_at',
      'version',
      'variant_name',
      'myacg_item_code'
    ]);
    for (const item of patches) {
      for (const key of Object.keys(item.patch)) {
        if (!whitelist.has(key)) {
          throw new Error(`Field '${key}' is not allowed to be patched in updateProductVariantPatchBulk`);
        }
      }
    }

    const variants = await this.getProductVariants();
    let changed = false;
    for (const item of patches) {
      const targetIdx = variants.findIndex(v => v.id === item.id);
      if (targetIdx !== -1) {
        variants[targetIdx] = { ...variants[targetIdx], ...item.patch };
        changed = true;
      }
    }
    if (changed) {
      await this.saveProductVariants(variants);
    }
  }

  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return loadData<PurchaseBatch[]>('erp_purchase_batches', []);
  }

  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    saveData('erp_purchase_batches', batches);
  }

  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return loadData<PurchaseBatchItem[]>('erp_purchase_batch_items', []);
  }

  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    saveData('erp_purchase_batch_items', items);
  }

  async savePurchaseBatchTransaction(batches: PurchaseBatch[], items: PurchaseBatchItem[]): Promise<void> {
    const beforeBatches = localStorage.getItem('erp_purchase_batches');
    const beforeItems = localStorage.getItem('erp_purchase_batch_items');
    try {
      saveData('erp_purchase_batches', batches);
      saveData('erp_purchase_batch_items', items);
    } catch (error) {
      if (beforeBatches === null) localStorage.removeItem('erp_purchase_batches');
      else localStorage.setItem('erp_purchase_batches', beforeBatches);
      if (beforeItems === null) localStorage.removeItem('erp_purchase_batch_items');
      else localStorage.setItem('erp_purchase_batch_items', beforeItems);
      throw error;
    }
  }

  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return loadData<PrivateOrder[]>('erp_private_orders', []);
  }

  async applyRelatedTransaction(command:RelatedTransactionCommand):Promise<void> {
    const entries=Object.entries(RELATED_STORAGE);
    const before=entries.map(([,key])=>localStorage.getItem(key));
    const current=Object.fromEntries(entries.map(([entity,key])=>[entity,loadData<Record<string,unknown>[]>(key,[])]));
    const next=mergeRelatedCollections(current,command);
    const writes=relatedWriteEntities(command);
    try{entries.filter(([entity])=>writes.has(entity)).forEach(([entity,key])=>saveData(key,next[entity]));}
    catch(error){entries.forEach(([,key],i)=>before[i]===null?localStorage.removeItem(key):localStorage.setItem(key,before[i]!));throw error;}
  }

  async savePrivateOrderTransaction(command: PrivateOrderTransactionCommand): Promise<void> {
    const keys=['erp_private_orders','erp_private_order_items'];
    const before=keys.map(k=>localStorage.getItem(k));
    const next=mergePrivateOrderState(loadData<PrivateOrder[]>(keys[0],[]), loadData<PrivateOrderItem[]>(keys[1],[]), command);
    try { saveData(keys[0],next.orders); saveData(keys[1],next.items); }
    catch(error){ keys.forEach((k,i)=>before[i]===null ? localStorage.removeItem(k) : localStorage.setItem(k,before[i]!)); throw error; }
  }

  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    saveData('erp_private_orders', orders);
  }

  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return loadData<PrivateOrderItem[]>('erp_private_order_items', []);
  }

  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    saveData('erp_private_order_items', items);
  }

  async deletePrivateOrderItems(ids: string[]): Promise<void> {
    const allItems = await this.getPrivateOrderItems();
    const updated = allItems.filter(i => !ids.includes(i.id));
    await this.savePrivateOrderItems(updated);
  }

  async getImportBatches(): Promise<ImportBatch[]> {
    return loadData<ImportBatch[]>('erp_import_batches', []);
  }

  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    saveData('erp_import_batches', batches);
  }

  async getJapanPackages(): Promise<JapanPackage[]> {
    return loadData<JapanPackage[]>('erp_japan_packages', []);
  }

  async saveJapanPackages(packages: JapanPackage[]): Promise<void> {
    saveData('erp_japan_packages', packages);
  }

  async getJapanPackageItems(): Promise<JapanPackageItem[]> {
    return loadData<JapanPackageItem[]>('erp_japan_package_items', []);
  }

  async saveJapanPackageItems(items: JapanPackageItem[]): Promise<void> {
    saveData('erp_japan_package_items', items);
  }

  async saveJapanPackageTransaction(packages: JapanPackage[], items: JapanPackageItem[]): Promise<void> {
    const beforePackages = localStorage.getItem('erp_japan_packages');
    const beforeItems = localStorage.getItem('erp_japan_package_items');
    try {
      saveData('erp_japan_packages', packages);
      saveData('erp_japan_package_items', items);
    } catch (error) {
      if (beforePackages === null) localStorage.removeItem('erp_japan_packages');
      else localStorage.setItem('erp_japan_packages', beforePackages);
      if (beforeItems === null) localStorage.removeItem('erp_japan_package_items');
      else localStorage.setItem('erp_japan_package_items', beforeItems);
      throw error;
    }
  }

  async getOutboundShipments(): Promise<OutboundShipment[]> {
    return loadData<OutboundShipment[]>('erp_outbound_shipments', []);
  }

  async saveOutboundShipments(shipments: OutboundShipment[]): Promise<void> {
    saveData('erp_outbound_shipments', shipments);
  }

  async getOutboundShipmentItems(): Promise<OutboundShipmentItem[]> {
    return loadData<OutboundShipmentItem[]>('erp_outbound_shipment_items', []);
  }

  async saveOutboundShipmentItems(items: OutboundShipmentItem[]): Promise<void> {
    saveData('erp_outbound_shipment_items', items);
  }

  async saveOutboundShipmentTransaction(shipments: OutboundShipment[], items: OutboundShipmentItem[]): Promise<void> {
    const beforeShipments = localStorage.getItem('erp_outbound_shipments');
    const beforeItems = localStorage.getItem('erp_outbound_shipment_items');
    try {
      saveData('erp_outbound_shipments', shipments);
      saveData('erp_outbound_shipment_items', items);
    } catch (error) {
      if (beforeShipments === null) localStorage.removeItem('erp_outbound_shipments');
      else localStorage.setItem('erp_outbound_shipments', beforeShipments);
      if (beforeItems === null) localStorage.removeItem('erp_outbound_shipment_items');
      else localStorage.setItem('erp_outbound_shipment_items', beforeItems);
      throw error;
    }
  }

  async getBundleComponents(): Promise<BundleComponent[]> {
    return loadData<BundleComponent[]>('erp_bundle_components', []);
  }

  async saveBundleComponents(components: BundleComponent[]): Promise<void> {
    saveData('erp_bundle_components', components);
  }

  async exportData(): Promise<void> {
    const data = {
      inventory: await this.getInventory(),
      salesOrders: await this.getSalesOrders(),
      salesOrderItems: await this.getSalesOrderItems(),
      productGroups: await this.getProductGroups(),
      productCategories: await this.getProductCategories(),
      productVariants: await this.getProductVariants(),
      purchaseBatches: await this.getPurchaseBatches(),
      purchaseBatchItems: await this.getPurchaseBatchItems(),
      privateOrders: await this.getPrivateOrders(),
      privateOrderItems: await this.getPrivateOrderItems(),
      bundleComponents: await this.getBundleComponents(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workbench-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  async importData(jsonString: string): Promise<boolean> {
    try {
      const data = JSON.parse(jsonString);
      if (data.inventory) await this.saveInventory(data.inventory);
      if (data.salesOrders) await this.saveSalesOrders(data.salesOrders);
      if (data.salesOrderItems) await this.saveSalesOrderItems(data.salesOrderItems);
      if (data.productGroups) await this.saveProductGroups(data.productGroups);
      if (data.productCategories) await this.saveProductCategories(data.productCategories);
      if (data.productVariants) await this.saveProductVariants(data.productVariants);
      if (data.purchaseBatches) await this.savePurchaseBatches(data.purchaseBatches);
      if (data.purchaseBatchItems) await this.savePurchaseBatchItems(data.purchaseBatchItems);
      if (data.privateOrders) await this.savePrivateOrders(data.privateOrders);
      if (data.privateOrderItems) await this.savePrivateOrderItems(data.privateOrderItems);
      if (data.bundleComponents) await this.saveBundleComponents(data.bundleComponents);
      if (data.importBatches) await this.saveImportBatches(data.importBatches);
      return true;
    } catch (e) {
      console.error('Import failed', e);
      return false;
    }
  }

  async clearData(): Promise<void> {
    localStorage.removeItem('erp_inventory');
    localStorage.removeItem('erp_sales_orders');
    localStorage.removeItem('erp_sales_order_items');
    localStorage.removeItem('erp_product_groups');
    localStorage.removeItem('erp_product_categories');
    localStorage.removeItem('erp_product_variants');
    localStorage.removeItem('erp_purchase_batches');
    localStorage.removeItem('erp_purchase_batch_items');
    localStorage.removeItem('erp_private_orders');
    localStorage.removeItem('erp_private_order_items');
    localStorage.removeItem('erp_bundle_components');
  }

  async clearPurchaseRecords(): Promise<void> {
    localStorage.removeItem('erp_product_groups');
    localStorage.removeItem('erp_product_categories');
    localStorage.removeItem('erp_product_variants');
    localStorage.removeItem('erp_purchase_batches');
    localStorage.removeItem('erp_purchase_batch_items');
    localStorage.removeItem('erp_private_orders');
    localStorage.removeItem('erp_private_order_items');
  }

  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return loadData<{ data: string; timestamp: string } | null>('erp_last_import_backup', null);
  }

  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    saveData('erp_last_import_backup', backup);
  }
}

// Singleton export
const INDEXED_DB_BACKED_STORAGE_KEYS = [
  'erp_inventory',
  'erp_sales_orders',
  'erp_sales_order_items',
  'erp_product_groups',
  'erp_product_categories',
  'erp_product_variants',
  'erp_purchase_batches',
  'erp_purchase_batch_items',
  'erp_private_orders',
  'erp_private_order_items',
  'erp_import_batches',
  'erp_bundle_components',
  'erp_japan_packages',
  'erp_japan_package_items',
  'erp_outbound_shipments',
  'erp_outbound_shipment_items',
  'erp_last_import_backup',
] as const;

const ATOMIC_IMPORT_COLLECTIONS = [
  ['inventory', 'erp_inventory'],
  ['salesOrders', 'erp_sales_orders'],
  ['salesOrderItems', 'erp_sales_order_items'],
  ['productGroups', 'erp_product_groups'],
  ['productCategories', 'erp_product_categories'],
  ['productVariants', 'erp_product_variants'],
  ['purchaseBatches', 'erp_purchase_batches'],
  ['purchaseBatchItems', 'erp_purchase_batch_items'],
  ['privateOrders', 'erp_private_orders'],
  ['privateOrderItems', 'erp_private_order_items'],
  ['japanPackages', 'erp_japan_packages'],
  ['japanPackageItems', 'erp_japan_package_items'],
  ['outboundShipments', 'erp_outbound_shipments'],
  ['outboundShipmentItems', 'erp_outbound_shipment_items'],
  ['bundleComponents', 'erp_bundle_components'],
] as const;

const OPTIONAL_ATOMIC_IMPORT_COLLECTIONS = [
  ['importBatches', 'erp_import_batches'],
  ['wacaOrders', 'erp_waca_orders_v1'],
  ['wacaItems', 'erp_waca_items_v1'],
  ['wacaMappings', 'erp_waca_mappings_v1'],
  ['wacaImportBatches', 'erp_waca_import_batches_v1'],
  ['myacgMasterLinks', 'erp_myacg_master_links_v1'],
  ['wacaCutoverAudit', 'erp_waca_cutover_audit_v2'],
] as const;

import { classifyWorkbenchBackup, legacyCutoverState, validateDashboardImageBackup, WORKBENCH_BACKUP_FORMAT_VERSION,
  type WacaCutoverState } from '../waca/backupFormat';
import { readDeadlineDurableBackup } from './closingDateSidecarBackup';
import { DASHBOARD_IMAGE_CATEGORY_KEYS, getAllDashboardCategoryImages } from './dashboardImageStore';

/**
 * Local Mode owns this database.  It is authoritative for Local Mode only and
 * must never be used as the Cloud provider's cache.
 */
export const LOCAL_AUTHORITATIVE_INDEXED_DB_NAME = 'daigou-erp-local-authoritative-v1';

/** Cloud Mode cache only.  Supabase remains authoritative. */
export const CLOUD_CACHE_INDEXED_DB_NAME = 'daigou-erp-cloud-cache-v1';

/** Pre-isolation database name retained solely for one-time Local data migration. */
export const LEGACY_SHARED_INDEXED_DB_NAME = 'daigou-erp-db';

type AtomicImportEntry = {
  storageKey: string;
  value: unknown;
};

const validateAtomicImportPayload = (jsonString: string, source: 'backup' | 'cloud-sync' = 'backup'): AtomicImportEntry[] => {
  const parsed: unknown = JSON.parse(jsonString);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON 備份最上層必須是物件。');
  }

  const data = parsed as Record<string, unknown>;
  // Cloud pull is an authoritative server cache projection, never a legacy
  // backup. It must preserve the server's WACA auto/manual fields verbatim and
  // must not alter any local WACA ledger/cutover keys.
  const backupKind = source === 'backup' ? classifyWorkbenchBackup(data) : null;
  const cutoverState: WacaCutoverState | null = backupKind === 'waca-v2'
    ? (data.wacaCutoverState as WacaCutoverState[])[0]
    : backupKind ? legacyCutoverState(backupKind, data) : null;
  const entries: AtomicImportEntry[] = [];

  for (const [collectionName, storageKey] of ATOMIC_IMPORT_COLLECTIONS) {
    const collection = data[collectionName];
    if (!Array.isArray(collection)) {
      throw new Error(`JSON 備份集合 ${collectionName} 缺少或不是陣列。`);
    }
    if (collection.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`JSON 備份集合 ${collectionName} 含有無效資料列。`);
    }
    if (collectionName === 'productVariants' && cutoverState && cutoverState.mode !== 'ORDER_DRIVEN_ACTIVE') {
      const legacyVariants = (collection as Record<string, unknown>[]).map(row => {
        const storedAuto = Number(row.waca_auto_quantity ?? 0);
        const storedManual = Number(row.waca_manual_adjustment ?? 0);
        const legacyQuantity = Number(row.waca_quantity ?? storedAuto + storedManual);
        if (!Number.isSafeInteger(legacyQuantity) || legacyQuantity < 0) {
          throw new Error('舊備份的 WACA 數量無效，已取消還原。');
        }
        return { ...row, waca_auto_quantity: legacyQuantity, waca_manual_adjustment: 0 };
      });
      entries.push({ storageKey, value: legacyVariants });
    } else {
      entries.push({ storageKey, value: collection });
    }
  }

  for (const [collectionName, storageKey] of OPTIONAL_ATOMIC_IMPORT_COLLECTIONS) {
    const collection = data[collectionName];
    if (collection !== undefined && !Array.isArray(collection)) {
      throw new Error(`JSON 備份集合 ${collectionName} 不是陣列。`);
    }
    if (Array.isArray(collection) && collection.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`JSON 備份集合 ${collectionName} 含有無效資料列。`);
    }
    entries.push({ storageKey, value: Array.isArray(collection) ? collection : [] });
  }

  if (source === 'cloud-sync') return entries;
  if (!cutoverState || !backupKind) throw new Error('JSON 備份格式無法確認。');

  if (backupKind === 'waca-v2') {
    for (const row of validateDashboardImageBackup(data.dashboardCategoryImages)) {
      entries.push({ storageKey: `dashboard_category_img_${row.categoryKey}`, value: row.dataUrl });
    }
  }

  if (backupKind !== 'legacy-pre-waca') {
    const records = (name: string) => (data[name] as Record<string, unknown>[] | undefined) ?? [];
    const orders = records('wacaOrders');
    const items = records('wacaItems');
    const mappings = records('wacaMappings');
    const links = records('myacgMasterLinks');
    const cutoverAudit = records('wacaCutoverAudit');
    const variants = records('productVariants');
    const unique = (values: unknown[], name: string) => {
      if (values.some(value => typeof value !== 'string' || !value) || new Set(values).size !== values.length) {
        throw new Error(`JSON 備份 WACA ${name} 識別碼無效或重複。`);
      }
    };
    unique(orders.map(row => row.key), '訂單');
    unique(items.map(row => row.key), '品項');
    unique(mappings.map(row => row.feature), '對照');
    unique(links.map(row => row.childCode), '主子關係');
    unique(cutoverAudit.map(row => row.productVariantId), '切換稽核');
    const orderIds = new Set(orders.map(row => row.key));
    const variantIds = new Set(variants.map(row => row.id));
    if (items.some(row => !orderIds.has(row.orderKey) || (row.productVariantId && !variantIds.has(row.productVariantId)))) {
      throw new Error('JSON 備份 WACA 品項關聯不完整。');
    }
    if (mappings.some(row => !variantIds.has(row.productVariantId)) ||
        links.some(row => typeof row.mainCode !== 'string' || !row.mainCode
          || (row.productVariantId && !variantIds.has(row.productVariantId)))) {
      throw new Error('JSON 備份 WACA 商品對照關聯不完整。');
    }
    if (cutoverAudit.some(row => typeof row.productVariantId !== 'string' || !row.productVariantId.trim()
      || !Number.isFinite(Number(row.legacyWacaQuantity))
      || !Number.isFinite(Number(row.newOrderDerivedQuantity)))) {
      throw new Error('JSON 備份 WACA 切換稽核無效。');
    }
    const statusByOrder = new Map(orders.map(row => [row.key, row.status]));
    const auto = new Map<string, number>();
    for (const item of items) {
      if (!item.productVariantId || !['處理中', '完成付款'].includes(String(statusByOrder.get(item.orderKey)))) continue;
      const id = String(item.productVariantId);
      const quantity = Number(item.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('JSON 備份 WACA 數量無效。');
      auto.set(id, (auto.get(id) ?? 0) + quantity);
    }
    if (cutoverState.mode === 'ORDER_DRIVEN_ACTIVE'
      && variants.some(row => Number(row.waca_auto_quantity ?? 0) !== (auto.get(String(row.id)) ?? 0))) {
      throw new Error('JSON 備份 WACA 自動數量與訂單不一致。');
    }
    if (cutoverState.mode === 'ORDER_DRIVEN_ACTIVE') {
      const variantEntry = entries.find(entry => entry.storageKey === 'erp_product_variants');
      if (variantEntry) variantEntry.value = variants.map(row => ({
        ...row, waca_auto_quantity: auto.get(String(row.id)) ?? 0,
      }));
    }
  }

  // Revisions are concurrency markers, not user data. A restored snapshot begins
  // a new local revision after all durable collections have committed together.
  entries.push({ storageKey: 'erp_waca_revision_v1', value: 0 });
  entries.push({ storageKey: 'erp_waca_cutover_state_v1', value: cutoverState });

  return entries;
};

const readAllKeyValues = (database: IDBDatabase): Promise<Array<{ key: IDBValidKey; value: unknown }>> => (
  new Promise((resolve, reject) => {
    const transaction = database.transaction('kv', 'readonly');
    const request = transaction.objectStore('kv').openCursor();
    const entries: Array<{ key: IDBValidKey; value: unknown }> = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      entries.push({ key: cursor.key, value: cursor.value });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(entries);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB read transaction aborted'));
  })
);

const putAllKeyValues = (
  database: IDBDatabase,
  entries: Array<{ key: IDBValidKey; value: unknown }>,
): Promise<void> => new Promise((resolve, reject) => {
  if (entries.length === 0) {
    resolve();
    return;
  }
  const transaction = database.transaction('kv', 'readwrite');
  const store = transaction.objectStore('kv');
  entries.forEach(entry => store.put(entry.value, entry.key));
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB migration transaction aborted'));
});

const openExistingDatabase = async (name: string): Promise<IDBDatabase | null> => {
  const databaseFactory = window.indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (databaseFactory.databases) {
    const databases = await databaseFactory.databases();
    if (!databases.some(database => database.name === name)) return null;
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Legacy IndexedDB open blocked: ${name}`));
  });
};

/** Copy legacy shared data once into the Local authoritative namespace only. */
const migrateLegacyLocalDatabase = async (target: IDBDatabase, targetName: string): Promise<void> => {
  if (targetName === LEGACY_SHARED_INDEXED_DB_NAME) return;
  if (['test', 'next', 'experimental'].includes(import.meta.env.MODE)) return;
  if ((await readAllKeyValues(target)).length > 0) return;

  const legacy = await openExistingDatabase(LEGACY_SHARED_INDEXED_DB_NAME);
  if (!legacy) return;
  try {
    if (!legacy.objectStoreNames.contains('kv')) return;
    const entries = await readAllKeyValues(legacy);
    await putAllKeyValues(target, entries);
    if (entries.length > 0) {
      console.info(`[IndexedDB Migration] Copied ${entries.length} Local records into ${targetName}`);
    }
  } finally {
    legacy.close();
  }
};

/** Pure inventory projection used by Cloud Mode before its server mutation commits. */
export const prepareInventoryUpsert = (
  currentRows: InventoryItem[],
  incomingRows: InventoryItem[],
): { inventory: InventoryItem[]; stats: ImportStats } => {
  const current = currentRows.map(item => ({ ...item }));
  const items = incomingRows.map(item => ({ ...item }));
  const parentCodes = new Set<string>();
  const normalizedTitles = new Set<string>();
  for (const item of items) {
    const parentCode = item.myacg_parent_code || getBaseSku(item.myacg_item_code);
    if (parentCode) parentCodes.add(parentCode.trim().toUpperCase());
    else {
      const normalizedTitle = item.normalized_product_title || normalizeProductTitle(item.product_title);
      if (normalizedTitle) normalizedTitles.add(normalizedTitle);
    }
  }

  const filteredCurrent = current.filter(item => {
    if (parentCodes.size > 0) {
      const code = (item.myacg_item_code || '').trim().toUpperCase();
      const parent = (item.myacg_parent_code || '').trim().toUpperCase();
      if (parentCodes.has(parent) || parentCodes.has(code)) return false;
      for (let boundary = code.indexOf('_'); boundary >= 0; boundary = code.indexOf('_', boundary + 1)) {
        if (parentCodes.has(code.slice(0, boundary))) return false;
      }
    } else {
      const normalizedTitle = item.normalized_product_title || normalizeProductTitle(item.product_title);
      if (normalizedTitle && normalizedTitles.has(normalizedTitle)) return false;
    }
    return true;
  });

  const currentMap = new Map<string, InventoryItem>();
  for (const item of filteredCurrent) {
    const key = item.inventory_key || `${normalizeProductTitle(item.product_title)}::${item.myacg_item_code}::${item.raw_variant_name || ''}`;
    item.inventory_key = key;
    currentMap.set(key, item);
  }

  const aggregated = new Map<string, InventoryItem>();
  for (const item of items) {
    const key = item.inventory_key || `${normalizeProductTitle(item.product_title)}::${item.myacg_item_code}::${item.raw_variant_name || ''}`;
    item.inventory_key = key;
    const existing = aggregated.get(key);
    if (!existing) aggregated.set(key, { ...item });
    else {
      existing.raw_variant_name = item.raw_variant_name || existing.raw_variant_name;
      existing.product_title = item.product_title || existing.product_title;
      existing.myacg_sold_quantity = (existing.myacg_sold_quantity ?? 0) + (item.myacg_sold_quantity ?? 0);
      existing.myacg_available_quantity = (existing.myacg_available_quantity ?? 0) + (item.myacg_available_quantity ?? 0);
      if (item.myacg_demand_quantity !== undefined) {
        existing.myacg_demand_quantity = (existing.myacg_demand_quantity ?? 0) + (item.myacg_demand_quantity ?? 0);
      }
    }
  }

  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const groupSet = new Set<string>();
  for (const item of aggregated.values()) {
    item.normalized_product_title = normalizeProductTitle(item.product_title);
    item.listing_type = determineListingType(item.product_title);
    groupSet.add(item.normalized_product_title);
    const existing = currentMap.get(item.inventory_key!);
    if (!existing) {
      newCount += 1;
      currentMap.set(item.inventory_key!, item);
      continue;
    }
    item.raw_variant_name = item.raw_variant_name || existing.raw_variant_name;
    item.product_title = item.product_title || existing.product_title;
    item.normalized_product_title = normalizeProductTitle(item.product_title);
    item.listing_type = determineListingType(item.product_title);
    const changed = existing.product_title !== item.product_title
      || existing.raw_variant_name !== item.raw_variant_name
      || existing.final_price !== item.final_price
      || existing.myacg_available_quantity !== item.myacg_available_quantity
      || existing.myacg_sold_quantity !== item.myacg_sold_quantity
      || existing.myacg_demand_quantity !== item.myacg_demand_quantity
      || existing.myacg_listed_at !== item.myacg_listed_at;
    if (changed) updatedCount += 1;
    else unchangedCount += 1;
    currentMap.set(item.inventory_key!, { ...existing, ...item });
  }

  return {
    inventory: [...currentMap.values()],
    stats: { total: items.length, newCount, updatedCount, unchangedCount, groupCount: groupSet.size },
  };
};

export class IndexedDbAdapter implements DatabaseAdapter {
  private dbPromise: Promise<IDBDatabase>;
  private readonly allowLegacyLocalStorageFallback: boolean;

  readonly databaseName: string;

  constructor(
    databaseName = LOCAL_AUTHORITATIVE_INDEXED_DB_NAME,
    options: { allowLegacyLocalStorageFallback?: boolean; migrateLegacyLocalData?: boolean } = {},
  ) {
    this.databaseName = databaseName;
    this.allowLegacyLocalStorageFallback = options.allowLegacyLocalStorageFallback ?? true;
    console.log(`[IndexedDB Init] ${databaseName}`);
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        console.warn('[IndexedDB] Not supported in this environment');
        reject(new Error('IndexedDB not supported'));
        return;
      }
      const request = window.indexedDB.open(databaseName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
      };

      request.onsuccess = async () => {
        console.log(`[IndexedDB Open Success] ${databaseName}`);
        try {
          if (options.migrateLegacyLocalData) {
            await migrateLegacyLocalDatabase(request.result, databaseName);
          }
          if (this.allowLegacyLocalStorageFallback) {
            this.removeRedundantLocalStorageBackups(request.result);
          }
          resolve(request.result);
        } catch (error) {
          request.result.close();
          reject(error);
        }
      };

      request.onerror = () => {
        console.error('[IndexedDB Open Error]', request.error);
        reject(request.error);
      };
    });
  }

  private removeRedundantLocalStorageBackups(db: IDBDatabase): void {
    try {
      const transaction = db.transaction('kv', 'readonly');
      const store = transaction.objectStore('kv');

      INDEXED_DB_BACKED_STORAGE_KEYS.forEach((key) => {
        const request = store.get(key);
        request.onsuccess = () => {
          // Only remove the duplicate after confirming IndexedDB has a copy.
          if (request.result !== undefined) {
            localStorage.removeItem(key);
          }
        };
      });
    } catch {
      // Keep existing localStorage fallbacks when IndexedDB cannot be read.
    }
  }

  private async readVariantSyncGuardSnapshot(): Promise<{
    variants: ProductVariant[];
    verifiedEmpty: boolean;
  }> {
    const keys = [
      'erp_product_variants',
      'erp_product_groups',
      'erp_purchase_batch_items',
      'erp_private_order_items',
      'erp_bundle_components',
      'erp_japan_package_items',
      'erp_outbound_shipment_items',
      'erp_sales_order_items',
    ] as const;

    try {
      if (isVariantSyncReadFailureInjectionEnabled()) {
        throw new Error('TEST_ONLY_VARIANT_READ_FAILURE');
      }

      const database = await this.dbPromise;
      const values = await new Promise<Map<string, unknown>>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction('kv', 'readonly');
        } catch (error) {
          reject(error);
          return;
        }

        const store = transaction.objectStore('kv');
        const result = new Map<string, unknown>();
        let requestFailure: unknown = null;

        for (const key of keys) {
          const request = store.get(key);
          request.onsuccess = () => result.set(key, request.result);
          request.onerror = () => {
            requestFailure = request.error ?? new Error(`IndexedDB read failed: ${key}`);
            try {
              transaction.abort();
            } catch {
              // The transaction may already be inactive; onerror/onabort still rejects.
            }
          };
        }

        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(
          requestFailure ?? transaction.error ?? new Error('Variant sync readonly transaction failed.'),
        );
        transaction.onabort = () => reject(
          requestFailure ?? transaction.error ?? new Error('Variant sync readonly transaction aborted.'),
        );
      });

      const readArray = <T>(key: typeof keys[number]): T[] => {
        const value = values.get(key);
        if (value === undefined) return [];
        if (!Array.isArray(value)) {
          throw new Error(`Expected ${key} to contain an array.`);
        }
        return value as T[];
      };

      const rawVariantValue = values.get('erp_product_variants');
      const variants = readArray<ProductVariant>('erp_product_variants');
      const groups = readArray<ProductGroup>('erp_product_groups');
      const purchaseItems = readArray<PurchaseBatchItem>('erp_purchase_batch_items');
      const privateItems = readArray<PrivateOrderItem>('erp_private_order_items');
      const bundleComponents = readArray<BundleComponent>('erp_bundle_components');
      const japanPackageItems = readArray<JapanPackageItem>('erp_japan_package_items');
      const outboundItems = readArray<OutboundShipmentItem>('erp_outbound_shipment_items');
      const salesItems = readArray<SalesOrderItem>('erp_sales_order_items');
      const variantReferenceCount = (
        purchaseItems.filter(item => Boolean(item.product_variant_id)).length
        + privateItems.filter(item => Boolean(item.product_variant_id)).length
        + bundleComponents.filter(item => Boolean(item.bundle_variant_id)).length
        + bundleComponents.filter(item => Boolean(item.component_variant_id)).length
        + japanPackageItems.filter(item => Boolean(item.product_variant_id)).length
        + outboundItems.filter(item => Boolean(item.product_variant_id)).length
        + salesItems.filter(item => Boolean(item.product_variant_id)).length
      );

      const variantsKeyExists = rawVariantValue !== undefined;
      const isCompletelyBlankDatabase = groups.length === 0 && variantReferenceCount === 0;
      const isSmallExplicitInitialization = variantsKeyExists
        && groups.length <= 10
        && variantReferenceCount === 0;
      const verifiedEmpty = variants.length === 0
        && (isCompletelyBlankDatabase || isSmallExplicitInitialization);

      if (variants.length === 0 && !verifiedEmpty) {
        throw new Error('Variant collection is missing while existing ERP data is present.');
      }
      if (variants.length === 0 && variantReferenceCount > 0) {
        throw new Error(`Variant collection is empty but ${variantReferenceCount} existing records reference Variants.`);
      }

      return { variants, verifiedEmpty };
    } catch (error) {
      if (isVariantDestructiveSyncGuardError(error)) throw error;
      throw new VariantDestructiveSyncGuardError('Variant source could not be verified.', { cause: error });
    }
  }

  private assertVariantSyncCandidateSafe(
    baseline: ProductVariant[],
    candidate: ProductVariant[],
    verifiedEmpty: boolean,
  ): void {
    const baselineById = new Map(baseline.map(variant => [variant.id, variant]));
    const candidateById = new Map(candidate.map(variant => [variant.id, variant]));
    const missingIds = [...baselineById.keys()].filter(id => !candidateById.has(id));

    if (missingIds.length > 0) {
      throw new VariantDestructiveSyncGuardError(
        `Sync would remove or replace ${missingIds.length} existing Variant identities.`,
      );
    }

    for (const [id, before] of baselineById.entries()) {
      const after = candidateById.get(id);
      if (!after) continue;
      if (
        after.waca_manual_adjustment !== before.waca_manual_adjustment
        || after.purchased_manual_adjustment !== before.purchased_manual_adjustment
        || after.myacg_manual_adjustment !== before.myacg_manual_adjustment
        || after.private_manual_adjustment !== before.private_manual_adjustment
      ) {
        throw new VariantDestructiveSyncGuardError(
          `Sync would change manual demand/purchase metadata for Variant ${id}.`,
        );
      }
    }

    if (!verifiedEmpty && baseline.length > 0) {
      const plannedNewCount = candidate.filter(variant => !baselineById.has(variant.id)).length;
      const maximumExpectedNewVariants = Math.max(50, Math.ceil(baseline.length * 0.25));
      if (plannedNewCount >= maximumExpectedNewVariants) {
        throw new VariantDestructiveSyncGuardError(
          `Sync would create ${plannedNewCount} new Variants from a baseline of ${baseline.length}.`,
        );
      }
    }
  }

  private async get<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const db = await this.dbPromise;
      return new Promise((resolve) => {
        const transaction = db.transaction('kv', 'readonly');
        const store = transaction.objectStore('kv');
        const request = store.get(key);

        request.onsuccess = () => {
          if (request.result !== undefined) {
            resolve(request.result as T);
          } else {
            // Fallback & Migration: Check if exists in localStorage
            const localStored = this.allowLegacyLocalStorageFallback ? localStorage.getItem(key) : null;
            if (localStored) {
              try {
                const parsed = JSON.parse(localStored) as T;
                // Migrate to IndexedDB
                this.set(key, parsed).catch(err => console.error(`Migration failed for ${key}`, err));
                resolve(parsed);
                return;
              } catch (e) {
                console.error(`Failed to parse ${key} from localStorage during migration`, e);
              }
            }
            resolve(defaultValue);
          }
        };

        request.onerror = () => {
          // Fallback to localStorage on request error
          const localStored = this.allowLegacyLocalStorageFallback ? localStorage.getItem(key) : null;
          if (localStored) {
            try {
              resolve(JSON.parse(localStored) as T);
              return;
            } catch (e) {}
          }
          resolve(defaultValue);
        };
      });
    } catch (e) {
      // Fallback if DB open failed
      const localStored = this.allowLegacyLocalStorageFallback ? localStorage.getItem(key) : null;
      if (localStored) {
        try {
          return JSON.parse(localStored) as T;
        } catch (err) {}
      }
      return defaultValue;
    }
  }

  async getCloudInventoryCatalogSnapshot(): Promise<{
    inventory: InventoryItem[];
    productGroups: ProductGroup[];
  }> {
    if (this.databaseName !== CLOUD_CACHE_INDEXED_DB_NAME) {
      throw new Error('CLOUD_INVENTORY_CATALOG_SNAPSHOT_WRONG_NAMESPACE');
    }
    const database = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readonly');
      const store = transaction.objectStore('kv');
      const inventoryRequest = store.get('erp_inventory');
      const groupsRequest = store.get('erp_product_groups');
      transaction.oncomplete = () => resolve({
        inventory: (inventoryRequest.result as InventoryItem[] | undefined) ?? [],
        productGroups: (groupsRequest.result as ProductGroup[] | undefined) ?? [],
      });
      transaction.onerror = () => reject(transaction.error ?? new Error('Cloud inventory catalog snapshot failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Cloud inventory catalog snapshot aborted'));
    });
  }

  async replaceAuthoritativeCloudCollections(entries: ReadonlyArray<{ storageKey: string; value: unknown[] }>): Promise<void> {
    if (this.databaseName !== CLOUD_CACHE_INDEXED_DB_NAME) {
      throw new Error('CLOUD_CACHE_ATOMIC_REPLACE_WRONG_NAMESPACE');
    }
    const allowed = new Set<string>(INDEXED_DB_BACKED_STORAGE_KEYS);
    if (entries.length === 0 || entries.some(entry => !allowed.has(entry.storageKey) || !Array.isArray(entry.value))) {
      throw new Error('CLOUD_CACHE_ATOMIC_REPLACE_INVALID_COLLECTION');
    }
    const database = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      let failure: unknown = null;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Cloud cache atomic replace failed'));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Cloud cache atomic replace aborted'));
      try {
        entries.forEach(entry => store.put(entry.value, entry.storageKey));
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    });
    if (entries.some(entry => entry.storageKey === 'erp_product_variants')) {
      this.variantVersion++;
      this.variantDedupeCache = null;
      this.variantDedupeCacheVersion = -1;
    }
  }

  private async set<T>(key: string, value: T): Promise<void> {
    try {
      const db = await this.dbPromise;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('kv', 'readwrite');
        const store = transaction.objectStore('kv');
        const request = store.put(value, key);

        request.onsuccess = () => {
          // IndexedDB is the primary store. Remove any old duplicate instead
          // of filling localStorage and blocking Supabase Auth persistence.
          if (this.allowLegacyLocalStorageFallback) {
            try {
              localStorage.removeItem(key);
            } catch {
              // Storage cleanup is best-effort after the IndexedDB write succeeds.
            }
          }
          resolve();
        };

        request.onerror = () => {
          reject(request.error);
        };
      });
    } catch (e) {
      if (!this.allowLegacyLocalStorageFallback) throw e;
      console.warn(`[IndexedDB Write Fallback] Writing to localStorage for ${key}`, e);
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        reportStorageWriteFailure(key, err);
        throw err;
      }
    }
  }

  async getInventory(): Promise<InventoryItem[]> {
    return this.get<InventoryItem[]>('erp_inventory', []);
  }

  async saveInventory(items: InventoryItem[]): Promise<void> {
    await this.set('erp_inventory', items);
  }

  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    const current = await this.getInventory();
    
    // Collect parentCodes and normalizedTitles from incoming items to delete old residues
    const parentCodes = new Set<string>();
    const normalizedTitles = new Set<string>();
    for (const item of items) {
      const pCode = item.myacg_parent_code || getBaseSku(item.myacg_item_code);
      if (pCode) {
        parentCodes.add(pCode.trim().toUpperCase());
      } else {
        const normTitle = item.normalized_product_title || normalizeProductTitle(item.product_title);
        if (normTitle) {
          normalizedTitles.add(normTitle);
        }
      }
    }

    const parentCodesArr = Array.from(parentCodes);
    const normalizedTitlesArr = Array.from(normalizedTitles);

    const filteredCurrent = current.filter(x => {
      if (parentCodesArr.length > 0) {
        const codeUpper = (x.myacg_item_code || '').trim().toUpperCase();
        const parentUpper = (x.myacg_parent_code || '').trim().toUpperCase();
        for (const pc of parentCodesArr) {
          if (parentUpper === pc || codeUpper === pc || codeUpper.startsWith(pc + '_')) {
            return false;
          }
        }
      } else {
        const normTitle = x.normalized_product_title || normalizeProductTitle(x.product_title);
        if (normTitle && normalizedTitlesArr.includes(normTitle)) {
          return false;
        }
      }
      return true;
    });

    // Map of existing inventory items, keyed by their inventory_key
    const currentMap = new Map<string, InventoryItem>();
    for (const i of filteredCurrent) {
      const key = i.inventory_key || `${normalizeProductTitle(i.product_title)}::${i.myacg_item_code}::${i.raw_variant_name || ''}`;
      i.inventory_key = key;
      currentMap.set(key, i);
    }
    
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    const groupSet = new Set<string>();

    // Pre-aggregate the incoming items by inventory_key to avoid merging different specs
    const aggregatedItemsMap = new Map<string, InventoryItem>();
    for (const item of items) {
      const key = `${normalizeProductTitle(item.product_title)}::${item.myacg_item_code}::${item.raw_variant_name || ''}`;
      item.inventory_key = key;
      const existingAgg = aggregatedItemsMap.get(key);
      if (!existingAgg) {
        aggregatedItemsMap.set(key, { ...item });
      } else {
        existingAgg.raw_variant_name = item.raw_variant_name || existingAgg.raw_variant_name;
        existingAgg.product_title = item.product_title || existingAgg.product_title;

        // Sum quantities for items with the exact same spec/name key
        existingAgg.myacg_sold_quantity = (existingAgg.myacg_sold_quantity ?? 0) + (item.myacg_sold_quantity ?? 0);
        existingAgg.myacg_available_quantity = (existingAgg.myacg_available_quantity ?? 0) + (item.myacg_available_quantity ?? 0);
        if (item.myacg_demand_quantity !== undefined) {
          existingAgg.myacg_demand_quantity = (existingAgg.myacg_demand_quantity ?? 0) + (item.myacg_demand_quantity ?? 0);
        }
      }
    }
    const incomingItems = Array.from(aggregatedItemsMap.values());

    for (const item of incomingItems) {
      item.normalized_product_title = normalizeProductTitle(item.product_title);
      item.listing_type = determineListingType(item.product_title);
      groupSet.add(item.normalized_product_title);

      const existing = currentMap.get(item.inventory_key!);
      if (!existing) {
        newCount++;
        currentMap.set(item.inventory_key!, item);
      } else {
        item.raw_variant_name = item.raw_variant_name || existing.raw_variant_name;
        item.product_title = item.product_title || existing.product_title;
        item.normalized_product_title = normalizeProductTitle(item.product_title);
        item.listing_type = determineListingType(item.product_title);

        const isChanged = 
          existing.product_title !== item.product_title ||
          existing.raw_variant_name !== item.raw_variant_name ||
          existing.final_price !== item.final_price ||
          existing.myacg_available_quantity !== item.myacg_available_quantity ||
          existing.myacg_sold_quantity !== item.myacg_sold_quantity ||
          existing.myacg_demand_quantity !== item.myacg_demand_quantity ||
          existing.myacg_listed_at !== item.myacg_listed_at;
        
        if (isChanged) {
          updatedCount++;
        } else {
          unchangedCount++;
        }
        currentMap.set(item.inventory_key!, { ...existing, ...item });
      }
    }
    await this.saveInventory(Array.from(currentMap.values()));
    return {
      total: items.length,
      newCount,
      updatedCount,
      unchangedCount,
      groupCount: groupSet.size
    };
  }

  private catalogContext(): CatalogAlgorithmContext {
    return {
      getInventory:()=>this.getInventory(),getProductGroups:()=>this.getProductGroups(),getProductCategories:()=>this.getProductCategories(),
      getProductVariants:options=>this.getProductVariants(options),saveProductGroups:rows=>this.saveProductGroups(rows),
      saveProductCategories:rows=>this.saveProductCategories(rows),saveProductVariants:rows=>this.saveProductVariants(rows),
      readVariantSyncGuardSnapshot:()=>this.readVariantSyncGuardSnapshot(),computeVariantDedupe:rows=>this.computeVariantDedupe(rows),
      assertVariantSyncCandidateSafe:(before,after,empty)=>this.assertVariantSyncCandidateSafe(before,after,empty),
    };
  }
  async createPurchaseRecordFromInventory(itemCodes:string[]):Promise<void> { return createCatalogRecords.call(this.catalogContext(),itemCodes); }
  async reparseProductVariants():Promise<void> { return reparseCatalogVariants.call(this.catalogContext()); }
  async syncProductGroupsWithInventory():Promise<{filledVariantsCount:number;affectedGroupsCount:number;upgradedSkusCount:number}> { return syncCatalogGroups.call(this.catalogContext()); }

  async reparseProductTitles(): Promise<void> {
    const inventory = await this.getInventory();
    const groups = await this.getProductGroups();

    let invUpdated = false;
    for (const item of inventory) {
      const normalized = normalizeProductTitle(item.product_title);
      const lType = determineListingType(item.product_title);
      if (item.normalized_product_title !== normalized || item.listing_type !== lType) {
        item.normalized_product_title = normalized;
        item.listing_type = lType;
        invUpdated = true;
      }
    }

    let groupsUpdated = false;
    for (const group of groups) {
      const normalized = normalizeProductTitle(group.title);
      const lType = determineListingType(group.title);
      if (group.normalized_title !== normalized || group.listing_type !== lType) {
        group.normalized_title = normalized;
        group.listing_type = lType;
        groupsUpdated = true;
      }
    }

    if (invUpdated) await this.saveInventory(inventory);
    if (groupsUpdated) await this.saveProductGroups(groups);
  }

  async getSalesOrders(): Promise<SalesOrder[]> {
    return this.get<SalesOrder[]>('erp_sales_orders', []);
  }

  async saveSalesOrders(items: SalesOrder[]): Promise<void> {
    await this.set('erp_sales_orders', items);
  }

  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return this.get<SalesOrderItem[]>('erp_sales_order_items', []);
  }

  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    await this.set('erp_sales_order_items', items);
  }

  async getProductGroups(): Promise<ProductGroup[]> {
    return this.get<ProductGroup[]>('erp_product_groups', []);
  }

  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    console.log(`[IndexedDB Save Groups] count: ${groups.length}`);
    await this.set('erp_product_groups', groups);
  }

  async getProductCategories(): Promise<ProductCategory[]> {
    return this.get<ProductCategory[]>('erp_product_categories', []);
  }

  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    console.log(`[IndexedDB Save Categories] count: ${categories.length}`);
    await this.set('erp_product_categories', categories);
  }

  // Cache for computeVariantDedupe(): the dedupe/alias computation is O(n) work that was
  // previously re-run on every getProductVariants/getPurchaseBatchItems/getPrivateOrderItems
  // call (several times per page load), which showed up as noticeable lag. variantVersion is
  // bumped only by saveProductVariants (the sole writer of 'erp_product_variants'), so the
  // cached result stays valid across calls until the underlying data actually changes.
  private variantVersion = 0;
  private variantDedupeCache: { canonical: ProductVariant[]; aliasMap: Map<string, string> } | null = null;
  private variantDedupeCacheVersion = -1;

  /** Called after another NEXT owner commits the Variant collection in the same DB. */
  invalidateVariantDedupeCache(): void {
    this.variantVersion++;
    this.variantDedupeCache = null;
    this.variantDedupeCacheVersion = -1;
  }

  private getCachedVariantDedupe(rawVariants: ProductVariant[]): { canonical: ProductVariant[]; aliasMap: Map<string, string> } {
    if (this.variantDedupeCache && this.variantDedupeCacheVersion === this.variantVersion) {
      return this.variantDedupeCache;
    }
    const result = this.computeVariantDedupe(rawVariants);
    this.variantDedupeCache = result;
    this.variantDedupeCacheVersion = this.variantVersion;
    return result;
  }

  private computeVariantDedupe(variants: ProductVariant[]): { canonical: ProductVariant[]; aliasMap: Map<string, string> } {
    // Duplicate detection key: same product group + same SKU + same spec name + same
    // product title. Manual (user-created) variants are never merged, since they aren't
    // tied to the myacg catalog. A variant with a blank SKU or blank product_group_id is
    // also treated as always-unique (keyed by its own id) rather than grouped under a
    // shared empty-string bucket — prize/景品-style listings frequently have no real SKU,
    // and two different products both having a blank SKU must never be merged just because
    // they share that blank value. product_title is included so that two variants with the
    // same SKU/spec text but a different product title (a different actual product) are
    // never collapsed into one row either.
    const keyOf = (v: ProductVariant) => {
      if (v.source === 'manual') return `unique::${v.id}`;

      const sku = (v.myacg_item_code || '').trim().toUpperCase();
      const groupId = (v.product_group_id || '').trim();
      if (!sku || !groupId) return `unique::${v.id}`;

      const spec = (v.raw_variant_name || v.variant_name || '').trim();
      const title = (v.product_title || '').trim();
      return `${groupId}::${sku}::${spec}::${title}`;
    };

    const groups = new Map<string, ProductVariant[]>();
    for (const v of variants) {
      if (!v) continue;
      const key = keyOf(v);
      const arr = groups.get(key);
      if (arr) arr.push(v); else groups.set(key, [v]);
    }

    const aliasMap = new Map<string, string>();
    const canonical: ProductVariant[] = [];

    for (const group of groups.values()) {
      if (group.length === 1) {
        canonical.push(group[0]);
        continue;
      }

      // Same product group + SKU + spec name appears more than once: merge into a single
      // row so the UI stops showing the same product spec twice, while recording an alias
      // so any purchase/private order item pointing at a merged-away row still resolves to
      // a real product instead of "未知商品".
      //
      // The primary (the row whose fields "win" for anything that isn't explicitly summed
      // below, e.g. waca_auto_quantity / myacg_auto_quantity / effective_myacg_quantity) is
      // chosen by most-recent updated_at first — these are computed/synced values, not meant
      // to be summed across duplicates, so we want whichever row was most recently
      // recalculated/pushed rather than an arbitrary sort_order/id pick.
      const updatedAtMs = (v: ProductVariant): number => {
        const t = v.updated_at ? Date.parse(v.updated_at) : NaN;
        return Number.isFinite(t) ? t : 0;
      };
      const sorted = [...group].sort((a, b) => {
        const aTime = updatedAtMs(a);
        const bTime = updatedAtMs(b);
        if (aTime !== bTime) return bTime - aTime; // newest updated_at first
        const aSort = a.sort_order ?? 999999;
        const bSort = b.sort_order ?? 999999;
        if (aSort !== bSort) return aSort - bSort;
        return (a.id || '').localeCompare(b.id || '');
      });

      const [primary, ...dupes] = sorted;
      const merged: ProductVariant = { ...primary };

      // Manual adjustment fields (waca/myacg/private/purchased) are NOT summed across
      // duplicates — only the primary's own value is kept, same as the auto-computed
      // quantity fields above. Summing used to cause a specific bug: editing the canonical
      // row's value would still leave the untouched duplicate row's stale value in raw
      // storage (kept alive by saveProductVariants' restoredDupes safety net so "未知商品"
      // stays fixed), and the next merge would silently add that stale value back on top of
      // the freshly-edited one. Reading only primary's value means an edit takes effect
      // immediately on the next read, with no write needed anywhere (including Supabase).
      for (const dup of dupes) {
        if (merged.default_jpy_cost == null && dup.default_jpy_cost != null) merged.default_jpy_cost = dup.default_jpy_cost;
        if (merged.default_twd_cost == null && dup.default_twd_cost != null) merged.default_twd_cost = dup.default_twd_cost;
        if (!merged.note && dup.note) merged.note = dup.note;
        aliasMap.set(dup.id, primary.id);
      }

      canonical.push(merged);
    }

    return { canonical, aliasMap };
  }

  private remapVariantIds<T extends { product_variant_id: string }>(items: T[], aliasMap: Map<string, string>): T[] {
    if (aliasMap.size === 0) return items;
    return items.map(item => {
      const canonicalId = aliasMap.get(item.product_variant_id);
      return canonicalId ? { ...item, product_variant_id: canonicalId } : item;
    });
  }

  // Diagnostic only (not auto-logged): lists product_variants that were merged as
  // duplicates so an operator can decide whether to clean them up in Supabase later.
  // Call from a browser console via `await window.db.getVariantDuplicateReport()`.
  async getVariantDuplicateReport(): Promise<Array<{
    product_group_id?: string;
    myacg_item_code: string;
    spec: string;
    product_title?: string;
    count: number;
    ids: string[];
  }>> {
    const rawVariants = await this.get<ProductVariant[]>('erp_product_variants', []);
    const { aliasMap } = this.getCachedVariantDedupe(rawVariants);
    if (aliasMap.size === 0) return [];

    const byId = new Map(rawVariants.map(v => [v.id, v]));
    const dupIdsByPrimary = new Map<string, string[]>();
    for (const [dupId, primaryId] of aliasMap.entries()) {
      const arr = dupIdsByPrimary.get(primaryId);
      if (arr) arr.push(dupId); else dupIdsByPrimary.set(primaryId, [dupId]);
    }

    const report: Array<{
      product_group_id?: string;
      myacg_item_code: string;
      spec: string;
      product_title?: string;
      count: number;
      ids: string[];
    }> = [];

    for (const [primaryId, dupIds] of dupIdsByPrimary.entries()) {
      const primary = byId.get(primaryId);
      if (!primary) continue;
      report.push({
        product_group_id: primary.product_group_id,
        myacg_item_code: primary.myacg_item_code,
        spec: primary.raw_variant_name || primary.variant_name || '',
        product_title: primary.product_title,
        count: dupIds.length + 1,
        ids: [primaryId, ...dupIds]
      });
    }
    return report;
  }

  async getProductVariants(options?: { recalc?: boolean; raw?: boolean }): Promise<ProductVariant[]> {
    const rawVariants = await this.get<ProductVariant[]>('erp_product_variants', []);
    console.log(`[IndexedDB Read Variants] count: ${rawVariants.length}`);
    console.log('[IndexedDB Read Variants] sample:', rawVariants.length > 0 ? JSON.stringify(rawVariants[0]) : 'empty');

    // Keep the raw collection available for database-level statistics. All
    // existing callers retain the canonical/deduped view by default.
    if (options?.raw) return rawVariants;

    const recalc = options?.recalc ?? false;
    const inventory = await this.getInventory();

    if (!recalc || inventory.length === 0) {
      console.log(`[getProductVariants IndexedDB] Skipping recalculation. recalc=${recalc}, inventory=${inventory.length}`);
      const { canonical, aliasMap } = this.getCachedVariantDedupe(rawVariants);
      if (import.meta.env.DEV && aliasMap.size > 0) {
        console.log(`[Variant Dedupe][DEV] merged ${aliasMap.size} duplicate variant row(s) at read time`);
      }
      return canonical;
    }

    const salesOrderItems = await this.getSalesOrderItems();
    const orders = await this.getSalesOrders();
    const orderMap = new Map(orders.map(o => [o.id, o]));

    // 1. Calculate orders demand for myacg
    const myacgOrderDemandMap = new Map<string, number>();

    for (const item of salesOrderItems) {
      if (item.order_status && item.order_status.includes('已取消')) continue;
      const order = orderMap.get(item.order_id);
      if (!order) continue;
      const platform = order.platform || 'myacg';
      const cleanItemCode = item.myacg_item_code.trim().toUpperCase();
      if (platform === 'myacg') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      } else if (platform === 'ruten') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      }
    }

    let changed = false;
    for (const v of rawVariants) {
      // Find matching inventory item using fuzzy matching helpers
      const invItem = findMatchingInventoryItem(v, inventory);

      const rawMyacg = calculateFinalMyacgDemand(v, inventory, salesOrderItems);
      const effectiveMyacg = rawMyacg >= 0 ? rawMyacg : (v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity !== null && v.effective_myacg_quantity >= 0 ? v.effective_myacg_quantity : 0);
      const autoMyacg = rawMyacg >= 0 ? rawMyacg : (v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity !== null && v.myacg_auto_quantity >= 0 ? v.myacg_auto_quantity : 0);

      if (invItem) {
        const inventoryDemand = invItem.myacg_sold_quantity ?? invItem.myacg_demand_quantity;
        if (inventoryDemand == null || inventoryDemand === 0) {
          console.warn(`找到 SKU 但 myacg_sold_quantity 為空: ${v.myacg_item_code}`);
        }
      } else {
        console.warn(`找不到 InventoryItem 對應 SKU: ${v.myacg_item_code}`);
      }

      if (
        v.effective_myacg_quantity !== effectiveMyacg ||
        v.myacg_auto_quantity !== autoMyacg
      ) {
        v.effective_myacg_quantity = effectiveMyacg;
        v.myacg_auto_quantity = autoMyacg;
        changed = true;
      }
    }

    if (changed) {
      await this.saveProductVariants(rawVariants);
    }
    const { canonical, aliasMap } = this.getCachedVariantDedupe(rawVariants);
    if (import.meta.env.DEV && aliasMap.size > 0) {
      console.log(`[Variant Dedupe][DEV] merged ${aliasMap.size} duplicate variant row(s) at read time`);
    }
    return canonical;
  }

  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    if (variants.length === 0) {
      console.warn("[IndexedDB Save Variants] SKIP empty variants save");
      return;
    }

    // Safety net: some callers (e.g. the cloud sync's "recalculate then save back" step)
    // read via getProductVariants() — which returns the deduped/canonical view — and pass
    // that straight back into saveProductVariants(). Without this guard, any row that was
    // merged away purely as a duplicate would be permanently dropped from raw storage on
    // every such round-trip. Here we detect exactly that case using the CURRENT raw
    // storage's own alias map: a raw row is only restored if it's a known duplicate of an
    // id that's present in the incoming array — this never resurrects a variant that was
    // genuinely deleted/soft-deleted (those aren't in the alias map at all), it only
    // prevents dedupe from silently shrinking what's actually stored.
    const currentRaw = await this.get<ProductVariant[]>('erp_product_variants', []);
    const { aliasMap } = this.getCachedVariantDedupe(currentRaw);
    const incomingIds = new Set(variants.map(v => v.id));
    const restoredDupes = currentRaw.filter(v => {
      const primaryId = aliasMap.get(v.id);
      return primaryId !== undefined && incomingIds.has(primaryId) && !incomingIds.has(v.id);
    });
    const finalVariants = restoredDupes.length > 0 ? [...variants, ...restoredDupes] : variants;
    if (restoredDupes.length > 0) {
      console.log(`[IndexedDB Save Variants] restored ${restoredDupes.length} duplicate row(s) that the incoming save would have dropped`);
    }

    console.log(`[IndexedDB Save Variants] count: ${finalVariants.length}`);
    await this.set('erp_product_variants', finalVariants);
    this.variantVersion++;
  }

  /**
   * Replace only the isolated Cloud cache with a complete, successful server
   * response. This intentionally accepts an empty array; Local authoritative
   * data must continue to use saveProductVariants() and its destructive guard.
   */
  async replaceProductVariantsFromAuthoritativeCloud(variants: ProductVariant[]): Promise<void> {
    if (this.databaseName !== CLOUD_CACHE_INDEXED_DB_NAME) {
      throw new Error('Authoritative Cloud Variant replacement is restricted to the Cloud cache namespace.');
    }
    await this.set('erp_product_variants', variants);
    this.variantVersion++;
  }

  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    const whitelist = new Set([
      'myacg_manual_adjustment',
      'waca_manual_adjustment',
      'private_manual_adjustment',
      'purchased_manual_adjustment',
      'default_jpy_cost',
      'default_twd_cost',
      'note',
      'updated_at',
      'version',
      'variant_name',
      'myacg_item_code'
    ]);
    for (const key of Object.keys(patch)) {
      if (!whitelist.has(key)) {
        throw new Error(`Field '${key}' is not allowed to be patched in updateProductVariantPatch`);
      }
    }

    const variants = await this.getProductVariants();
    const targetIdx = variants.findIndex(v => v.id === id);
    if (targetIdx !== -1) {
      variants[targetIdx] = { ...variants[targetIdx], ...patch };
      await this.saveProductVariants(variants);
    }
  }

  async deleteProductVariant(id: string): Promise<void> {
    const variants = await this.getProductVariants();
    const updated = variants.filter(v => v.id !== id);
    await this.saveProductVariants(updated);
  }

  async updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void> {
    const whitelist = new Set([
      'myacg_manual_adjustment',
      'waca_manual_adjustment',
      'private_manual_adjustment',
      'purchased_manual_adjustment',
      'default_jpy_cost',
      'default_twd_cost',
      'note',
      'updated_at',
      'version',
      'variant_name',
      'myacg_item_code'
    ]);
    for (const item of patches) {
      for (const key of Object.keys(item.patch)) {
        if (!whitelist.has(key)) {
          throw new Error(`Field '${key}' is not allowed to be patched in updateProductVariantPatchBulk`);
        }
      }
    }

    const variants = await this.getProductVariants();
    let changed = false;
    for (const item of patches) {
      const targetIdx = variants.findIndex(v => v.id === item.id);
      if (targetIdx !== -1) {
        variants[targetIdx] = { ...variants[targetIdx], ...item.patch };
        changed = true;
      }
    }
    if (changed) {
      await this.saveProductVariants(variants);
    }
  }

  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return this.get<PurchaseBatch[]>('erp_purchase_batches', []);
  }

  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    await this.set('erp_purchase_batches', batches);
  }

  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    const items = await this.get<PurchaseBatchItem[]>('erp_purchase_batch_items', []);
    const rawVariants = await this.get<ProductVariant[]>('erp_product_variants', []);
    const { aliasMap } = this.getCachedVariantDedupe(rawVariants);
    return this.remapVariantIds(items, aliasMap);
  }

  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    await this.set('erp_purchase_batch_items', items);
  }

  async savePurchaseBatchTransaction(batches: PurchaseBatch[], items: PurchaseBatchItem[]): Promise<void> {
    const database = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      store.put(batches, 'erp_purchase_batches');
      store.put(items, 'erp_purchase_batch_items');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Purchase Batch cache transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Purchase Batch cache transaction aborted'));
    });
  }

  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return this.get<PrivateOrder[]>('erp_private_orders', []);
  }

  async applyRelatedTransaction(command:RelatedTransactionCommand):Promise<void> {
    const database=await this.dbPromise;
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction('kv','readwrite');const store=tx.objectStore('kv');
      const current:Record<string,Record<string,unknown>[]>={};
      const entries=Object.entries(RELATED_STORAGE); let pending=entries.length;let failure:unknown;
      for(const [entity,key] of entries){
        const request=store.get(key);
        request.onsuccess=()=>{
          current[entity]=request.result??[];
          if(--pending)return;
          try{
            const next=mergeRelatedCollections(current,command);
            const writes=relatedWriteEntities(command);
            for(const [name,storageKey] of entries)if(writes.has(name))store.put(next[name],storageKey);
          }catch(error){failure=error;tx.abort();}
        };
      }
      tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(failure??tx.error??new Error('關聯交易未完成。'));
    });
  }

  async savePrivateOrderTransaction(command: PrivateOrderTransactionCommand): Promise<void> {
    const database=await this.dbPromise;
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction('kv','readwrite'); const store=tx.objectStore('kv');
      const orders=store.get('erp_private_orders'); const items=store.get('erp_private_order_items');
      const variants=store.get('erp_product_variants'); let pending=3; let failure:unknown;
      const ready=()=>{
        if(--pending) return;
        try {
          const next=mergePrivateOrderState(orders.result??[],items.result??[],command);
          if(!command.remove && command.items.some(i=>!(variants.result??[]).some((v:ProductVariant)=>v.id===i.product_variant_id && v.product_group_id===command.order.product_group_id))) throw new Error('登記規格不存在或不屬於此商品。');
          store.put(next.orders,'erp_private_orders'); store.put(next.items,'erp_private_order_items');
        } catch(error){ failure=error; tx.abort(); }
      };
      orders.onsuccess=ready; items.onsuccess=ready; variants.onsuccess=ready;
      tx.oncomplete=()=>resolve(); tx.onerror=tx.onabort=()=>reject(failure??tx.error??new Error('私下登記交易未完成。'));
    });
  }

  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    await this.set('erp_private_orders', orders);
  }

  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    const items = await this.get<PrivateOrderItem[]>('erp_private_order_items', []);
    const rawVariants = await this.get<ProductVariant[]>('erp_product_variants', []);
    const { aliasMap } = this.getCachedVariantDedupe(rawVariants);
    return this.remapVariantIds(items, aliasMap);
  }

  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    await this.set('erp_private_order_items', items);
  }

  async deletePrivateOrderItems(ids: string[]): Promise<void> {
    const allItems = await this.getPrivateOrderItems();
    const updated = allItems.filter(i => !ids.includes(i.id));
    await this.savePrivateOrderItems(updated);
  }

  async getImportBatches(): Promise<ImportBatch[]> {
    return this.get<ImportBatch[]>('erp_import_batches', []);
  }

  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    await this.set('erp_import_batches', batches);
  }

  async getBundleComponents(): Promise<BundleComponent[]> {
    return this.get<BundleComponent[]>('erp_bundle_components', []);
  }

  async saveBundleComponents(components: BundleComponent[]): Promise<void> {
    await this.set('erp_bundle_components', components);
  }

  async exportData(): Promise<void> {
    const images = await getAllDashboardCategoryImages();
    const data = {
      inventory: await this.getInventory(),
      salesOrders: await this.getSalesOrders(),
      salesOrderItems: await this.getSalesOrderItems(),
      productGroups: await this.getProductGroups(),
      productCategories: await this.getProductCategories(),
      // Backup must contain every stored variant, including rows hidden by the read-time dedupe view.
      productVariants: await this.getProductVariants({ raw: true }),
      purchaseBatches: await this.getPurchaseBatches(),
      purchaseBatchItems: await this.getPurchaseBatchItems(),
      privateOrders: await this.getPrivateOrders(),
      privateOrderItems: await this.getPrivateOrderItems(),
      japanPackages: await this.getJapanPackages(),
      japanPackageItems: await this.getJapanPackageItems(),
      outboundShipments: await this.getOutboundShipments(),
      outboundShipmentItems: await this.getOutboundShipmentItems(),
      bundleComponents: await this.getBundleComponents(),
      importBatches: await this.getImportBatches(),
      wacaOrders: await this.get<unknown[]>('erp_waca_orders_v1', []),
      wacaItems: await this.get<unknown[]>('erp_waca_items_v1', []),
      wacaMappings: await this.get<unknown[]>('erp_waca_mappings_v1', []),
      wacaImportBatches: await this.get<unknown[]>('erp_waca_import_batches_v1', []),
      myacgMasterLinks: await this.get<unknown[]>('erp_myacg_master_links_v1', []),
      wacaCutoverAudit: await this.get<unknown[]>('erp_waca_cutover_audit_v2', []),
      wacaCutoverState: [await this.get<WacaCutoverState>('erp_waca_cutover_state_v1', {
        mode: 'LEGACY_QUANTITY_ACTIVE', updatedAt: new Date().toISOString(), sourceBackupFormatVersion: null,
      })],
      backupFormatVersion: WORKBENCH_BACKUP_FORMAT_VERSION,
      dashboardCategoryImages: DASHBOARD_IMAGE_CATEGORY_KEYS.map(categoryKey => ({
        categoryKey, dataUrl: images[categoryKey] ?? '',
      })),
      ...(this.databaseName === 'daigou-erp-db-next-v1' ? await readDeadlineDurableBackup('next') : {
        deadlineVerifiedMappings: [], deadlineApplyBatches: [], deadlineApplyItems: [],
      }),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workbench-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  async importData(jsonString: string, source: 'backup' | 'cloud-sync' = 'backup'): Promise<boolean> {
    try {
      if (source === 'cloud-sync' && this.databaseName !== CLOUD_CACHE_INDEXED_DB_NAME) {
        throw new Error('CLOUD_CACHE_IMPORT_TARGET_INVALID');
      }
      // Validate the complete backup before opening a write transaction. This
      // prevents malformed later collections from leaving an earlier subset
      // committed to the database.
      const entries = validateAtomicImportPayload(jsonString, source);
      const database = await this.dbPromise;

      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('kv', 'readwrite');
        const store = transaction.objectStore('kv');
        let synchronousFailure: unknown = null;

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('JSON 匯入 transaction 失敗。'));
        transaction.onabort = () => reject(
          synchronousFailure instanceof Error
            ? synchronousFailure
            : transaction.error ?? new Error('JSON 匯入已回滾。'),
        );

        try {
          entries.forEach(({ storageKey, value }) => {
            store.put(value, storageKey);
          });
        } catch (error) {
          synchronousFailure = error;
          transaction.abort();
        }
      });

      if (entries.some(({ storageKey }) => storageKey === 'erp_product_variants')) {
        this.variantVersion++;
        this.variantDedupeCache = null;
        this.variantDedupeCacheVersion = -1;
      }

      // IndexedDB is authoritative. Remove duplicate fallbacks only after the
      // all-or-nothing transaction commits successfully.
      entries.forEach(({ storageKey }) => {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // A stale fallback is harmless because IndexedDB remains primary.
        }
      });
      return true;
    } catch (e) {
      console.error('Import failed', e);
      return false;
    }
  }

  async clearData(): Promise<void> {
    try {
      const db = await this.dbPromise;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('kv', 'readwrite');
        const store = transaction.objectStore('kv');
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      console.error('[IndexedDB clearData Error]', e);
    }
    localStorage.removeItem('erp_inventory');
    localStorage.removeItem('erp_sales_orders');
    localStorage.removeItem('erp_sales_order_items');
    localStorage.removeItem('erp_product_groups');
    localStorage.removeItem('erp_product_categories');
    localStorage.removeItem('erp_product_variants');
    localStorage.removeItem('erp_purchase_batches');
    localStorage.removeItem('erp_purchase_batch_items');
    localStorage.removeItem('erp_private_orders');
    localStorage.removeItem('erp_private_order_items');
    localStorage.removeItem('erp_bundle_components');
    localStorage.removeItem('erp_japan_packages');
    localStorage.removeItem('erp_japan_package_items');
  }

  async clearPurchaseRecords(): Promise<void> {
    const keysToRemove = [
      'erp_product_groups',
      'erp_product_categories',
      'erp_product_variants',
      'erp_purchase_batches',
      'erp_purchase_batch_items',
      'erp_private_orders',
      'erp_private_order_items',
    ];
    try {
      const db = await this.dbPromise;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('kv', 'readwrite');
        const store = transaction.objectStore('kv');
        let completed = 0;
        let hasError = false;
        keysToRemove.forEach(key => {
          const req = store.delete(key);
          req.onsuccess = () => {
            completed++;
            if (completed === keysToRemove.length && !hasError) {
              resolve();
            }
          };
          req.onerror = () => {
            hasError = true;
            reject(req.error);
          };
        });
      });
    } catch (e) {
      console.error('[IndexedDB clearPurchaseRecords Error]', e);
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
  }

  async getJapanPackages(): Promise<JapanPackage[]> {
    return this.get<JapanPackage[]>('erp_japan_packages', []);
  }

  async saveJapanPackages(packages: JapanPackage[]): Promise<void> {
    await this.set('erp_japan_packages', packages);
  }

  async getJapanPackageItems(): Promise<JapanPackageItem[]> {
    return this.get<JapanPackageItem[]>('erp_japan_package_items', []);
  }

  async saveJapanPackageItems(items: JapanPackageItem[]): Promise<void> {
    await this.set('erp_japan_package_items', items);
  }

  async saveJapanPackageTransaction(packages: JapanPackage[], items: JapanPackageItem[]): Promise<void> {
    const database = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      store.put(packages, 'erp_japan_packages');
      store.put(items, 'erp_japan_package_items');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Japan Package cache transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Japan Package cache transaction aborted'));
    });
  }

  async getOutboundShipments(): Promise<OutboundShipment[]> {
    return this.get<OutboundShipment[]>('erp_outbound_shipments', []);
  }

  async saveOutboundShipments(shipments: OutboundShipment[]): Promise<void> {
    await this.set('erp_outbound_shipments', shipments);
  }

  async getOutboundShipmentItems(): Promise<OutboundShipmentItem[]> {
    return this.get<OutboundShipmentItem[]>('erp_outbound_shipment_items', []);
  }

  async saveOutboundShipmentItems(items: OutboundShipmentItem[]): Promise<void> {
    await this.set('erp_outbound_shipment_items', items);
  }

  async saveOutboundShipmentTransaction(shipments: OutboundShipment[], items: OutboundShipmentItem[]): Promise<void> {
    const database = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      store.put(shipments, 'erp_outbound_shipments');
      store.put(items, 'erp_outbound_shipment_items');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Outbound shipment cache transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Outbound shipment cache transaction aborted'));
    });
  }

  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return this.get<{ data: string; timestamp: string } | null>('erp_last_import_backup', null);
  }

  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    await this.set('erp_last_import_backup', backup);
  }
}

export const localDb = new IndexedDbAdapter(
  LOCAL_AUTHORITATIVE_INDEXED_DB_NAME,
  { migrateLegacyLocalData: true },
);

export const cloudCacheDb = new IndexedDbAdapter(
  CLOUD_CACHE_INDEXED_DB_NAME,
  { allowLegacyLocalStorageFallback: false },
);

/** Backward-compatible name: direct callers always mean Local authoritative data. */
export const db: DatabaseAdapter = localDb;
export const notifyLocalVariantCollectionChanged = (): void => localDb.invalidateVariantDedupeCache();
if (typeof window !== 'undefined') {
  // Diagnostic only: lets an operator run `await window.db.getVariantDuplicateReport()`
  // in the browser console to see which product_variants rows were merged as duplicates.
  (window as any).db = db;
}
