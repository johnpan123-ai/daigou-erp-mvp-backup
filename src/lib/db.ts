export interface InventoryItem {
  import_sort_index?: number;
  myacg_item_code: string; // PK
  product_id?: string;
  product_title: string;
  normalized_product_title?: string;
  raw_variant_name: string;
  listing_type: string;
  final_price: number;
  myacg_available_quantity: number;
  myacg_sold_quantity: number;
  myacg_listed_at: string;
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
  myacg_manual_adjustment?: number;
  waca_auto_quantity?: number;
  waca_manual_adjustment?: number;
  private_manual_adjustment?: number;
  purchased_manual_adjustment?: number;

  note: string;
  sort_order: number;

  // Order Import specific flags
  catalog_missing?: boolean;
  source?: "inventory_import" | "myacg_order_import";
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
    /\d{2}年\d{2}月/g,
    /\d{4}年\d{2}月/g,
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
  
  // Step 1: Count prefix frequencies
  const prefixCounts: Record<string, number> = {};
  rawNames.forEach(name => {
    if (!name) return;
    const parts = name.trim().split(/\s+/);
    if (parts.length > 1) {
      prefixCounts[parts[0]] = (prefixCounts[parts[0]] || 0) + 1;
    }
  });

  // Step 2: Resolve
  rawNames.forEach(name => {
    if (!name) {
      result[''] = { category_label: null, variant_label: '' };
      return;
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length > 1 && prefixCounts[parts[0]] > 1) {
      // Multiple items share this prefix -> category
      result[name] = {
        category_label: parts[0],
        variant_label: parts.slice(1).join(' ')
      };
    } else {
      // Unique or no prefix -> single item
      result[name] = {
        category_label: null,
        variant_label: name.trim()
      };
    }
  });

  return result;
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
  upsertInventory(items: InventoryItem[]): Promise<ImportStats>;
  
  getSalesOrders(): Promise<SalesOrder[]>;
  saveSalesOrders(items: SalesOrder[]): Promise<void>;
  getSalesOrderItems(): Promise<SalesOrderItem[]>;
  saveSalesOrderItems(items: SalesOrderItem[]): Promise<void>;

  getProductGroups(): Promise<ProductGroup[]>;
  saveProductGroups(groups: ProductGroup[]): Promise<void>;
  getProductCategories(): Promise<ProductCategory[]>;
  saveProductCategories(categories: ProductCategory[]): Promise<void>;
  getProductVariants(): Promise<ProductVariant[]>;
  saveProductVariants(variants: ProductVariant[]): Promise<void>;

  getPurchaseBatches(): Promise<PurchaseBatch[]>;
  savePurchaseBatches(batches: PurchaseBatch[]): Promise<void>;
  getPurchaseBatchItems(): Promise<PurchaseBatchItem[]>;
  savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void>;

  getPrivateOrders(): Promise<PrivateOrder[]>;
  savePrivateOrders(orders: PrivateOrder[]): Promise<void>;
  getPrivateOrderItems(): Promise<PrivateOrderItem[]>;
  savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void>;

  getImportBatches(): Promise<ImportBatch[]>;
  saveImportBatches(batches: ImportBatch[]): Promise<void>;

  exportData(): Promise<void>;
  importData(jsonString: string): Promise<boolean>;
  clearData(): Promise<void>;
  clearPurchaseRecords(): Promise<void>;
  createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void>;
  reparseProductVariants(): Promise<void>;
  reparseProductTitles(): Promise<void>;
  syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }>;
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

export class LocalStorageAdapter implements DatabaseAdapter {
  async getInventory(): Promise<InventoryItem[]> {
    return loadData<InventoryItem[]>('erp_inventory', []);
  }

  async saveInventory(items: InventoryItem[]): Promise<void> {
    saveData('erp_inventory', items);
  }

  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    const current = await this.getInventory();
    const currentMap = new Map(current.map(i => [i.myacg_item_code, i]));
    
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    const groupSet = new Set<string>();

    for (const item of items) {
      item.normalized_product_title = normalizeProductTitle(item.product_title);
      item.listing_type = determineListingType(item.product_title);
      groupSet.add(item.normalized_product_title);

      const existing = currentMap.get(item.myacg_item_code);
      if (!existing) {
        newCount++;
        currentMap.set(item.myacg_item_code, item);
      } else {
        const isChanged = 
          existing.product_title !== item.product_title ||
          existing.raw_variant_name !== item.raw_variant_name ||
          existing.final_price !== item.final_price ||
          existing.myacg_available_quantity !== item.myacg_available_quantity ||
          existing.myacg_sold_quantity !== item.myacg_sold_quantity ||
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
        let variant = variants.find(v => v.myacg_item_code === item.myacg_item_code && v.product_group_id === group!.id);
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
            waca_auto_quantity: 0,
            note: '',
            sort_order: variants.filter(v => v.product_group_id === group!.id).length
          };
          variants.push(variant);
          variantsUpdated = true;
        } else if (variant.variant_name !== spec.variant_label || variant.product_category_id !== categoryId) {
          variant.variant_name = spec.variant_label;
          variant.raw_variant_name = item.raw_variant_name;
          variant.product_category_id = categoryId;
          variantsUpdated = true;
        }
      }
      
      // Update existing variants that were already in the group
      for (const existingVar of existingVars) {
        if (existingVar.raw_variant_name) {
          const spec = resolvedSpecs[existingVar.raw_variant_name];
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

            if (existingVar.variant_name !== spec.variant_label || existingVar.product_category_id !== categoryId) {
              existingVar.variant_name = spec.variant_label;
              existingVar.product_category_id = categoryId;
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
            const invItem = targetItems.find(i => i.myacg_item_code === v.myacg_item_code);
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
    const variants = await this.getProductVariants();

    let categoriesUpdated = false;
    let variantsUpdated = false;

    for (const group of groups) {
      const groupVariants = variants.filter(v => v.product_group_id === group.id);
      
      // We will ensure raw_variant_name is populated first
      groupVariants.forEach(v => {
        if (!v.raw_variant_name) {
          const invItem = inventoryMap.get(v.myacg_item_code);
          if (invItem) v.raw_variant_name = invItem.raw_variant_name;
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

  
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {
    const allInventory = await this.getInventory();
    const groups = await this.getProductGroups();
    const variants = await this.getProductVariants();
    let categories = await this.getProductCategories();

    let filledVariantsCount = 0;
    let affectedGroupsCount = 0;
    let anyGroupChanged = false;

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
      const existingCodes = new Set(existingVariants.map(v => v.myacg_item_code));

      const missingItems = matchingItems.filter(item => !existingCodes.has(item.myacg_item_code));
      
      let groupChanged = false;

      // 1. Process existing variants: check if they are missing from catalog and update sort_order
      for (const v of existingVariants) {
        const invItem = matchingItems.find(i => i.myacg_item_code === v.myacg_item_code);
        if (invItem) {
          if (v.catalog_missing !== false || v.sort_order !== (invItem.import_sort_index ?? 9999)) {
            v.catalog_missing = false;
            v.sort_order = invItem.import_sort_index ?? 9999;
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
            
            const existingVar = variants.find(v => v.myacg_item_code === item.myacg_item_code);
            if (existingVar) {
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
                    existingVar.product_category_id = cat.id;
                    existingVar.variant_name = spec.variant_label;
                } else if (spec) {
                    existingVar.product_category_id = undefined;
                    existingVar.variant_name = spec.variant_label;
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

    return { filledVariantsCount, affectedGroupsCount };
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
    
    const orders = await this.getSalesOrders();
    const orderMap = new Map(orders.map(o => [o.id, o]));

    // Recalculate platform_demand for all variants
    const variants = await this.getProductVariants();
    
    // Reset all platform_demand
    for (const v of variants) {
      v.myacg_auto_quantity = 0;
      v.waca_auto_quantity = 0;
    }

    let variantsUpdated = false;
    for (const item of items) {
      if (item.order_status && item.order_status.includes('已取消')) continue;
      
      const order = orderMap.get(item.order_id);
      if (!order) continue;
      
      const platform = order.platform || 'myacg'; 
      
      for (const v of variants) {
        if (v.myacg_item_code === item.myacg_item_code) {
          
          if (platform === 'myacg') v.myacg_auto_quantity = (v.myacg_auto_quantity || 0) + item.quantity;
          if (platform === 'waca' || platform === 'ruten') v.waca_auto_quantity = (v.waca_auto_quantity || 0) + item.quantity;
          
          variantsUpdated = true;
        }
      }
    }
    
    if (variantsUpdated) {
      await this.saveProductVariants(variants);
    }
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

  async getProductVariants(): Promise<ProductVariant[]> {
    // Dynamically update demands just in case
    const variants = loadData<ProductVariant[]>('erp_product_variants', []);
    const salesOrderItems = await this.getSalesOrderItems();
    const orders = await this.getSalesOrders();
    const orderMap = new Map(orders.map(o => [o.id, o]));
    
    // Reset platform_demand
    for (const v of variants) {
      v.myacg_auto_quantity = 0;
      v.waca_auto_quantity = 0;
    }

    let changed = false;
    for (const item of salesOrderItems) {
      if (item.order_status && item.order_status.includes('已取消')) continue;
      
      const order = orderMap.get(item.order_id);
      if (!order) continue;
      const platform = order.platform || 'myacg';
      
      for (const v of variants) {
        if (v.myacg_item_code === item.myacg_item_code) {
          
          if (platform === 'myacg') v.myacg_auto_quantity = (v.myacg_auto_quantity || 0) + item.quantity;
          if (platform === 'waca' || platform === 'ruten') v.waca_auto_quantity = (v.waca_auto_quantity || 0) + item.quantity;
          
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      await this.saveProductVariants(variants);
    }
    return variants;
  }

  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    saveData('erp_product_variants', variants);
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
}

// Singleton export
export const db: DatabaseAdapter = new LocalStorageAdapter();
