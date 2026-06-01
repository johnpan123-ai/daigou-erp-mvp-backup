import { supabase } from './supabaseClient';
import { db } from '../../lib/db';
import type { IDataProvider } from '../types';
import type { 
  InventoryItem, 
  SalesOrder, 
  SalesOrderItem, 
  ProductGroup, 
  ProductCategory, 
  ProductVariant, 
  PurchaseBatch, 
  PurchaseBatchItem, 
  PrivateOrder, 
  PrivateOrderItem, 
  ImportBatch,
  ImportStats
} from '../../lib/db';

export class SupabaseProvider implements IDataProvider {
  private isPulled = false;
  private pullPromise: Promise<void> | null = null;

  async testConnection(): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('erp_healthcheck')
        .select('message')
        .limit(1);

      if (error) {
        throw error;
      }

      if (data && data.length > 0) {
        return data[0].message || 'Success';
      }
      return 'Connected, but no test data found.';
    } catch (err: any) {
      console.error('Supabase connection test failed:', err);
      throw new Error(err.message || 'Connection failed');
    }
  }

  /**
   * Phase 3-E-1: 從 Supabase 抓取 3 張核心商品資料表並快取至本地的唯讀同步程序
   * 已修正：增加等待 Supabase Auth 驗證狀態初始化，避免未載入 Session 即以匿名 (anon) 身份拉取空資料。
   */
  async pullCoreProductData(): Promise<void> {
    if (this.isPulled) return;
    if (this.pullPromise) return this.pullPromise;

    this.pullPromise = (async () => {
      try {
        console.log('[Sync] 正在等待 Supabase 驗證狀態初始化...');
        
        // 等待並獲取當前登入的 session，確保 JWT token 已載入 client
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session) {
          console.warn('[Sync] Supabase 尚未偵測到有效登入 Session，略過雲端 Pull 以避免覆蓋本機資料。');
          return;
        }

        console.log(`[Sync] 已驗證登入身份: ${session.user.email}，正在從 Supabase 進行商品核心主檔（Groups, Categories, Variants）的全量只讀同步...`);
        
        // 1. 同時從 Supabase 抓取未刪除的資料
        const [groupsRes, categoriesRes, variantsRes] = await Promise.all([
          supabase.from('product_groups').select('*').is('deleted_at', null),
          supabase.from('product_categories').select('*').is('deleted_at', null),
          supabase.from('product_variants').select('*').is('deleted_at', null)
        ]);

        if (groupsRes.error) throw groupsRes.error;
        if (categoriesRes.error) throw categoriesRes.error;
        if (variantsRes.error) throw variantsRes.error;

        console.log(`[Sync] 從 Supabase 成功拉取到資料：product_groups = ${groupsRes.data?.length || 0} 筆, product_categories = ${categoriesRes.data?.length || 0} 筆, product_variants = ${variantsRes.data?.length || 0} 筆`);

        // 2. 將雲端拉回的資料覆寫寫入本地 IndexedDB / LocalStorage 快取
        console.log(`[Sync] 正在寫入本地快取：groups: ${groupsRes.data?.length || 0} 筆, categories: ${categoriesRes.data?.length || 0} 筆, variants: ${variantsRes.data?.length || 0} 筆`);
        
        await db.saveProductGroups(groupsRes.data || []);
        await db.saveProductCategories(categoriesRes.data || []);
        await db.saveProductVariants(variantsRes.data || []);

        this.isPulled = true;
        console.log('[Sync] 商品核心主檔只讀同步完成，已成功快取至本地端。');
      } catch (err) {
        console.error('[Sync] 商品核心主檔同步失敗，將自動降級讀取本地現有快取:', err);
        // 為了不讓 UI 因為連線問題崩潰，我們不向上拋出錯誤，而是印出錯誤並使用本地現有快取
      } finally {
        this.pullPromise = null;
      }
    })();

    return this.pullPromise;
  }

  // === 3 張 Synced 表讀取 (Pull 後從本地快取讀取) ===
  async getProductGroups(): Promise<ProductGroup[]> {
    await this.pullCoreProductData();
    return db.getProductGroups();
  }

  async getProductCategories(): Promise<ProductCategory[]> {
    await this.pullCoreProductData();
    return db.getProductCategories();
  }

  async getProductVariants(): Promise<ProductVariant[]> {
    await this.pullCoreProductData();
    return db.getProductVariants();
  }

  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    // 1. 寫入本地 IndexedDB 快取
    await db.saveProductGroups(groups);

    // 2. 如果傳入陣列為空，直接略過，不向 Supabase 發送 upsert
    if (groups.length === 0) {
      return;
    }

    try {
      // 篩選出合法 UUID 的資料
      const validGroups = groups.filter(g => 
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.id)
      );

      if (validGroups.length === 0) {
        console.log('[Sync Push] product_groups skipped: no valid rows');
        return;
      }

      console.log(`[Sync Push] product_groups preparing: ${validGroups.length} rows`);

      const upsertData = validGroups.map(g => ({
        id: g.id,
        local_id: g.id,
        title: g.title,
        listing_type: g.listing_type || null,
        purchase_date: g.purchase_date || null,
        closing_date: g.closing_date || null,
        release_month: g.release_month || null,
        product_url: g.product_url || null,
        priority: g.priority || 'Medium'
      }));

      const { error } = await supabase
        .from('product_groups')
        .upsert(upsertData);

      if (error) {
        console.error(`[Sync Push] product_groups upsert failed: ${error.message || JSON.stringify(error)}`);
      } else {
        console.log(`[Sync Push] product_groups upsert success: ${upsertData.length} rows`);
      }
    } catch (err: any) {
      console.error(`[Sync Push] product_groups upsert failed: ${err.message || err}`);
    }
  }

  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    return db.saveProductCategories(categories);
  }

  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    return db.saveProductVariants(variants);
  }

  // === 4 張非 Synced 核心表與本地輔助表 (完全委託本地 db) ===
  async getInventory(): Promise<InventoryItem[]> {
    return db.getInventory();
  }

  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    return db.upsertInventory(items);
  }

  async getSalesOrders(): Promise<SalesOrder[]> {
    return db.getSalesOrders();
  }

  async saveSalesOrders(items: SalesOrder[]): Promise<void> {
    return db.saveSalesOrders(items);
  }

  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return db.getSalesOrderItems();
  }

  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    return db.saveSalesOrderItems(items);
  }

  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return db.getPurchaseBatches();
  }

  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    return db.savePurchaseBatches(batches);
  }

  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return db.getPurchaseBatchItems();
  }

  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    return db.savePurchaseBatchItems(items);
  }

  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return db.getPrivateOrders();
  }

  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    return db.savePrivateOrders(orders);
  }

  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return db.getPrivateOrderItems();
  }

  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    return db.savePrivateOrderItems(items);
  }

  async getImportBatches(): Promise<ImportBatch[]> {
    return db.getImportBatches();
  }

  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    return db.saveImportBatches(batches);
  }

  // === 資料庫管理與輔助方法 (完全委託本地 db) ===
  async exportData(): Promise<void> {
    return db.exportData();
  }

  async importData(jsonString: string): Promise<boolean> {
    return db.importData(jsonString);
  }

  async clearData(): Promise<void> {
    return db.clearData();
  }

  async clearPurchaseRecords(): Promise<void> {
    return db.clearPurchaseRecords();
  }

  async createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void> {
    return db.createPurchaseRecordFromInventory(itemCodes);
  }

  async reparseProductVariants(): Promise<void> {
    return db.reparseProductVariants();
  }

  async reparseProductTitles(): Promise<void> {
    return db.reparseProductTitles();
  }

  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {
    return db.syncProductGroupsWithInventory();
  }
}

export const supabaseProvider = new SupabaseProvider();
