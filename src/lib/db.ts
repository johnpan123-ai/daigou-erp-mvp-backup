export interface InventoryItem {
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
}

export interface SalesOrder {
  id: string; // PK
  platform: string;
  order_number: string;
  buyer_name: string;
  created_at: string;
}

export interface SalesOrderItem {
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
  id: string; // PK
  product_group_id: string; // FK
  name: string;
  date: string;
  note: string;
  created_at: string;
}

export interface PurchaseBatchItem {
  id: string; // PK
  purchase_batch_id: string; // FK
  product_variant_id: string; // FK
  quantity: number;
  cost: number;
  note: string;
}

export interface PrivateOrder {
  id: string; // PK
  product_group_id: string; // FK
  customer_name: string;
  contact: string;
  note: string;
  created_at: string;
}

export interface PrivateOrderItem {
  id: string; // PK
  private_order_id: string; // FK
  product_variant_id: string; // FK
  quantity: number;
  amount: number;
  note: string;
}

export interface ProductGroup {
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
}

export interface ProductCategory {
  id: string; // PK
  product_group_id: string; // FK
  title: string;
  sort_order: number;
}

export interface ProductVariant {
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
  
  // 1. Filter and clean names
  const cleanNames = rawNames.map(n => (n || '').trim()).filter(Boolean);
  
  // 2. Count prefix frequencies (by word combinations)
  const prefixCounts: Record<string, number> = {};
  cleanNames.forEach(name => {
    const parts = name.split(/\s+/);
    // Generate prefixes from 1 word up to N-1 words
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(' ');
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }
  });

  // 3. Find the longest prefix with count > 1 for each name
  cleanNames.forEach(name => {
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
  getProductVariants(options?: { recalc?: boolean }): Promise<ProductVariant[]>;
  saveProductVariants(variants: ProductVariant[]): Promise<void>;
  updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void>;
  updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void>;

  getPurchaseBatches(): Promise<PurchaseBatch[]>;
  savePurchaseBatches(batches: PurchaseBatch[]): Promise<void>;
  getPurchaseBatchItems(): Promise<PurchaseBatchItem[]>;
  savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void>;

  getPrivateOrders(): Promise<PrivateOrder[]>;
  savePrivateOrders(orders: PrivateOrder[]): Promise<void>;
  getPrivateOrderItems(): Promise<PrivateOrderItem[]>;
  savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void>;
  deletePrivateOrderItems(ids: string[]): Promise<void>;

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



  async getProductVariants(options?: { recalc?: boolean }): Promise<ProductVariant[]> {
    const variants = loadData<ProductVariant[]>('erp_product_variants', []);
    console.log(`[IndexedDB Read Variants] count: ${variants.length}`);
    console.log('[IndexedDB Read Variants] sample:', variants.length > 0 ? JSON.stringify(variants[0]) : 'empty');
    
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
    // 2. Calculate orders demand for waca
    const wacaOrderDemandMap = new Map<string, number>();

    for (const item of salesOrderItems) {
      if (item.order_status && item.order_status.includes('已取消')) continue;
      const order = orderMap.get(item.order_id);
      if (!order) continue;
      const platform = order.platform || 'myacg';
      const cleanItemCode = item.myacg_item_code.trim().toUpperCase();
      if (platform === 'myacg') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      } else if (platform === 'waca' || platform === 'ruten') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      }
    }

    const getOrderDemandForVariant = (variantCode: string, demandMap: Map<string, number>): number => {
      const cleanCode = variantCode.trim().toUpperCase();
      
      // 1. Exact match (case-insensitive)
      for (const [code, qty] of demandMap.entries()) {
        if (code.trim().toUpperCase() === cleanCode) {
          return qty;
        }
      }
      
      // 2. Fuzzy base SKU match
      const baseVariant = getBaseSku(cleanCode);
      let sum = 0;
      let matched = false;
      for (const [code, qty] of demandMap.entries()) {
        const normCode = code.trim().toUpperCase();
        const baseNorm = getBaseSku(normCode);
        if (baseNorm === baseVariant && 
            (normCode === baseNorm || cleanCode === baseVariant)) {
          sum += qty;
          matched = true;
        }
      }
      if (matched) return sum;

      // 3. Fallback: match any order code sharing the same base SKU
      for (const [code, qty] of demandMap.entries()) {
        const normCode = code.trim().toUpperCase();
        if (getBaseSku(normCode) === baseVariant) {
          sum += qty;
          matched = true;
        }
      }
      return matched ? sum : 0;
    };

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

      const newWacaAuto = getOrderDemandForVariant(v.myacg_item_code, wacaOrderDemandMap);

      if (
        v.effective_myacg_quantity !== effectiveMyacg || 
        v.myacg_auto_quantity !== autoMyacg || 
        v.waca_auto_quantity !== newWacaAuto
      ) {
        v.effective_myacg_quantity = effectiveMyacg;
        v.myacg_auto_quantity = autoMyacg;
        v.waca_auto_quantity = newWacaAuto;
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

  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return loadData<PrivateOrder[]>('erp_private_orders', []);
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
export class IndexedDbAdapter implements DatabaseAdapter {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    console.log('[IndexedDB Init]');
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        console.warn('[IndexedDB] Not supported in this environment');
        reject(new Error('IndexedDB not supported'));
        return;
      }
      const request = window.indexedDB.open('daigou-erp-db', 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
      };

      request.onsuccess = () => {
        console.log('[IndexedDB Open Success]');
        resolve(request.result);
      };

      request.onerror = () => {
        console.error('[IndexedDB Open Error]', request.error);
        reject(request.error);
      };
    });
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
            const localStored = localStorage.getItem(key);
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
          const localStored = localStorage.getItem(key);
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
      const localStored = localStorage.getItem(key);
      if (localStored) {
        try {
          return JSON.parse(localStored) as T;
        } catch (err) {}
      }
      return defaultValue;
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
          // Keep localStorage in sync as backup
          try {
            localStorage.setItem(key, JSON.stringify(value));
          } catch (e) {}
          resolve();
        };

        request.onerror = () => {
          reject(request.error);
        };
      });
    } catch (e) {
      console.warn(`[IndexedDB Write Fallback] Writing to localStorage for ${key}`, e);
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {}
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

  async getProductVariants(options?: { recalc?: boolean }): Promise<ProductVariant[]> {
    const variants = await this.get<ProductVariant[]>('erp_product_variants', []);
    console.log(`[IndexedDB Read Variants] count: ${variants.length}`);
    console.log('[IndexedDB Read Variants] sample:', variants.length > 0 ? JSON.stringify(variants[0]) : 'empty');
    
    const recalc = options?.recalc ?? false;
    const inventory = await this.getInventory();
    
    if (!recalc || inventory.length === 0) {
      console.log(`[getProductVariants IndexedDB] Skipping recalculation. recalc=${recalc}, inventory=${inventory.length}`);
      return variants;
    }
    
    const salesOrderItems = await this.getSalesOrderItems();
    const orders = await this.getSalesOrders();
    const orderMap = new Map(orders.map(o => [o.id, o]));
    
    // 1. Calculate orders demand for myacg
    const myacgOrderDemandMap = new Map<string, number>();
    // 2. Calculate orders demand for waca
    const wacaOrderDemandMap = new Map<string, number>();

    for (const item of salesOrderItems) {
      if (item.order_status && item.order_status.includes('已取消')) continue;
      const order = orderMap.get(item.order_id);
      if (!order) continue;
      const platform = order.platform || 'myacg';
      const cleanItemCode = item.myacg_item_code.trim().toUpperCase();
      if (platform === 'myacg') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      } else if (platform === 'waca' || platform === 'ruten') {
        myacgOrderDemandMap.set(cleanItemCode, (myacgOrderDemandMap.get(cleanItemCode) || 0) + item.quantity);
      }
    }

    const getOrderDemandForVariant = (variantCode: string, demandMap: Map<string, number>): number => {
      const cleanCode = variantCode.trim().toUpperCase();
      
      // 1. Exact match (case-insensitive)
      for (const [code, qty] of demandMap.entries()) {
        if (code.trim().toUpperCase() === cleanCode) {
          return qty;
        }
      }
      
      // 2. Fuzzy base SKU match
      const baseVariant = getBaseSku(cleanCode);
      let sum = 0;
      let matched = false;
      for (const [code, qty] of demandMap.entries()) {
        const normCode = code.trim().toUpperCase();
        const baseNorm = getBaseSku(normCode);
        if (baseNorm === baseVariant && 
            (normCode === baseNorm || cleanCode === baseVariant)) {
          sum += qty;
          matched = true;
        }
      }
      if (matched) return sum;

      // 3. Fallback: match any order code sharing the same base SKU
      for (const [code, qty] of demandMap.entries()) {
        const normCode = code.trim().toUpperCase();
        if (getBaseSku(normCode) === baseVariant) {
          sum += qty;
          matched = true;
        }
      }
      return matched ? sum : 0;
    };

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

      const newWacaAuto = getOrderDemandForVariant(v.myacg_item_code, wacaOrderDemandMap);

      if (
        v.effective_myacg_quantity !== effectiveMyacg || 
        v.myacg_auto_quantity !== autoMyacg || 
        v.waca_auto_quantity !== newWacaAuto
      ) {
        v.effective_myacg_quantity = effectiveMyacg;
        v.myacg_auto_quantity = autoMyacg;
        v.waca_auto_quantity = newWacaAuto;
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
    await this.set('erp_product_variants', variants);
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
    return this.get<PurchaseBatchItem[]>('erp_purchase_batch_items', []);
  }

  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    await this.set('erp_purchase_batch_items', items);
  }

  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return this.get<PrivateOrder[]>('erp_private_orders', []);
  }

  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    await this.set('erp_private_orders', orders);
  }

  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return this.get<PrivateOrderItem[]>('erp_private_order_items', []);
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
      if (data.importBatches) await this.saveImportBatches(data.importBatches);
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

  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return this.get<{ data: string; timestamp: string } | null>('erp_last_import_backup', null);
  }

  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    await this.set('erp_last_import_backup', backup);
  }
}

export const db: DatabaseAdapter = new IndexedDbAdapter();
