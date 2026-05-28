export interface InventoryItem {
  myacg_item_code: string; // PK
  product_id?: string;
  product_title: string;
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
  myacg_item_code: string; // FK
  quantity: number; // Demand
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

  note: string;
  sort_order: number;
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

export interface DatabaseAdapter {
  getInventory(): Promise<InventoryItem[]>;
  upsertInventory(items: InventoryItem[]): Promise<void>;
  
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

  exportData(): Promise<void>;
  importData(jsonString: string): Promise<boolean>;
  clearData(): Promise<void>;
  clearPurchaseRecords(): Promise<void>;
  createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void>;
  reparseProductVariants(): Promise<void>;
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

  async upsertInventory(items: InventoryItem[]): Promise<void> {
    const current = await this.getInventory();
    const currentMap = new Map(current.map(i => [i.myacg_item_code, i]));
    for (const item of items) {
      currentMap.set(item.myacg_item_code, { ...currentMap.get(item.myacg_item_code), ...item });
    }
    await this.saveInventory(Array.from(currentMap.values()));
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
      const order = orderMap.get(item.order_id);
      if (!order) continue;
      const platform = order.platform || 'myacg';
      
      for (const v of variants) {
        if (v.myacg_item_code === item.myacg_item_code) {
          
          if (platform === 'myacg') v.myacg_auto_quantity = (v.myacg_auto_quantity || 0) + item.quantity;
          if (platform === 'waca' || platform === 'ruten') v.waca_auto_quantity = (v.waca_auto_quantity || 0) + item.quantity;
          
          changed = true;
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
