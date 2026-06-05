// Polyfill crypto.randomUUID for insecure contexts (HTTP)
(function polyfillCrypto() {
  try {
    const fallbackUUID = function randomUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };

    const targetGlobals = [];
    if (typeof globalThis !== 'undefined') targetGlobals.push(globalThis);
    if (typeof window !== 'undefined') targetGlobals.push(window);
    if (typeof self !== 'undefined') targetGlobals.push(self);

    for (const g of targetGlobals) {
      let currentCrypto = (g as any).crypto;
      if (!currentCrypto) {
        try {
          Object.defineProperty(g, 'crypto', {
            value: {},
            writable: true,
            configurable: true,
            enumerable: true
          });
          currentCrypto = (g as any).crypto;
        } catch (e) {
          // ignore
        }
      }

      if (currentCrypto && !currentCrypto.randomUUID) {
        try {
          Object.defineProperty(currentCrypto, 'randomUUID', {
            value: fallbackUUID,
            writable: true,
            configurable: true,
            enumerable: false
          });
        } catch (err) {
          // If crypto is read-only or non-extensible
          const originalCrypto = currentCrypto;
          const newCrypto = Object.create(originalCrypto || {});

          Object.defineProperty(newCrypto, 'randomUUID', {
            value: fallbackUUID,
            writable: true,
            configurable: true,
            enumerable: false
          });

          if (originalCrypto && typeof originalCrypto.getRandomValues === 'function') {
            Object.defineProperty(newCrypto, 'getRandomValues', {
              value: originalCrypto.getRandomValues.bind(originalCrypto),
              writable: true,
              configurable: true,
              enumerable: false
            });
          }

          try {
            Object.defineProperty(g, 'crypto', {
              value: newCrypto,
              configurable: true,
              writable: true,
              enumerable: true
            });
          } catch (e2) {
            // Last resort: assign directly
            try {
              (g as any).crypto = newCrypto;
            } catch (e3) {
              console.error('Failed to override crypto object:', e3);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to polyfill crypto.randomUUID:', e);
  }
})();

import { supabase } from './supabaseClient';
import { db } from '../../lib/db';
import { getProviderMode } from '../providerMode';
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUuid = (val: any): boolean => typeof val === 'string' && UUID_REGEX.test(val);
const generateFallbackUuid = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

function getDeterministicUuid(str: string): string {
  if (isValidUuid(str)) {
    return str;
  }
  // Convert standard string (e.g. MYACG_12345) to a deterministic UUID using cyrb128
  const cyrb128 = (s: string) => {
    let h1 = 1779033703, h2 = 302473350, h3 = 336245363, h4 = 50249321;
    for (let i = 0, k; i < s.length; i++) {
      k = s.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1^h2^h3^h4)>>>0, (h2^h1)>>>0, (h3^h1)>>>0, (h4^h1)>>>0];
  };

  const hashes = cyrb128(str);
  const toHex8 = (num: number) => num.toString(16).padStart(8, '0');

  const h1 = toHex8(hashes[0]);
  const h2 = toHex8(hashes[1]);
  const h3 = toHex8(hashes[2]);
  const h4 = toHex8(hashes[3]);

  const part1 = h1;
  const part2 = h2.substring(0, 4);
  const part3 = '5' + h2.substring(5, 8); // version 5
  const variantChar = ['8', '9', 'a', 'b'][parseInt(h3.charAt(0), 16) % 4];
  const part4 = variantChar + h3.substring(1, 4);
  const part5 = h3.substring(4, 8) + h4;

  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

function isSchemaMissingError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';
  return code === '42P01' || msg.includes('could not find the table') || msg.includes('relation') || msg.includes('does not exist');
}


export class SupabaseProvider implements IDataProvider {
  private isPulled = false;
  private pullPromise: Promise<void> | null = null;
  private cachedRole: 'owner' | 'staff' | 'viewer' | 'helper' | null = null;
  private cachedRoleUserId: string | null = null;

  async getRole(): Promise<'owner' | 'staff' | 'viewer' | 'helper' | null> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      this.cachedRole = null;
      this.cachedRoleUserId = null;
      return null;
    }
    
    const userId = session.user.id;
    if (this.cachedRoleUserId === userId && this.cachedRole !== null) {
      return this.cachedRole;
    }
    
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', userId)
        .single();
      
      if (error || !data) {
        return null;
      }
      
      this.cachedRole = data.role as any;
      this.cachedRoleUserId = userId;
      return this.cachedRole;
    } catch (e) {
      return null;
    }
  }

  async canWriteCloud(): Promise<boolean> {
    const role = await this.getRole();
    return role === 'owner' || role === 'staff';
  }

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
  async pullCoreProductData(force = false): Promise<void> {
    if (force) {
      this.isPulled = false;
      this.pullPromise = null;
    }
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
        const [groupsRes, categoriesRes, variantsRes, batchesRes, batchItemsRes, poRes, poiRes] = await Promise.all([
          supabase.from('product_groups').select('*').is('deleted_at', null),
          supabase.from('product_categories').select('*').is('deleted_at', null),
          supabase.from('product_variants').select('*').is('deleted_at', null),
          supabase.from('purchase_batches').select('*').is('deleted_at', null),
          supabase.from('purchase_batch_items').select('*').is('deleted_at', null),
          supabase.from('private_orders').select('*').is('deleted_at', null),
          supabase.from('private_order_items').select('*').is('deleted_at', null)
        ]);

        if (groupsRes.error) throw groupsRes.error;
        if (categoriesRes.error) throw categoriesRes.error;
        if (variantsRes.error) throw variantsRes.error;
        if (batchesRes.error) throw batchesRes.error;
        if (batchItemsRes.error) throw batchItemsRes.error;
        if (poRes.error) throw poRes.error;
        if (poiRes.error) throw poiRes.error;

        const gLen = groupsRes.data?.length || 0;
        const cLen = categoriesRes.data?.length || 0;
        const vLen = variantsRes.data?.length || 0;
        const bLen = batchesRes.data?.length || 0;
        const biLen = batchItemsRes.data?.length || 0;
        const poLen = poRes.data?.length || 0;
        const poiLen = poiRes.data?.length || 0;

        console.log(`[Sync] 從 Supabase 成功拉取到資料：product_groups = ${gLen} 筆, product_categories = ${cLen} 筆, product_variants = ${vLen} 筆, purchase_batches = ${bLen} 筆, purchase_batch_items = ${biLen} 筆, private_orders = ${poLen} 筆, private_order_items = ${poiLen} 筆`);
        console.log(`[Cloud Pull] pulled groups count: ${gLen}`);
        console.log(`[Cloud Pull] pulled variants count: ${vLen}`);
        console.log('[Cloud Pull] variants sample:', variantsRes.data && variantsRes.data.length > 0 ? JSON.stringify(variantsRes.data[0]) : 'empty');
        console.log('[Default Cost Sync] cloud pulled sample:', variantsRes.data && variantsRes.data.length > 0 ? JSON.stringify(variantsRes.data[0]) : 'empty');
        console.log(`[Private Order Sync] cloud pulled orders count: ${poLen}`);
        console.log(`[Private Order Sync] cloud pulled items count: ${poiLen}`);

        // A. Auth/session role check
        const role = await this.getRole();
        console.log(`[Cloud Pull Guard] session ok: ${session.user.email} | role: ${role || 'null'}`);
        if (!role) {
          const roleMsg = `[Cloud Pull Guard] User role is unreadable or null. Aborting sync.`;
          console.warn(roleMsg);
          console.log('[Cloud Pull Guard] abort sync to prevent pushing stale local cache');
          console.log('[Cloud Pull Guard] keep local cache');
          throw new Error(roleMsg);
        }

        // B. Pull 結果完整性防呆
        const localGroups = await db.getProductGroups();
        const localVariants = await db.getProductVariants();
        const localSalesOrders = await db.getSalesOrders();
        const localSalesOrderItems = await db.getSalesOrderItems();

        const lg = localGroups.length;
        const lv = localVariants.length;
        const lso = localSalesOrders.length;
        const lsoi = localSalesOrderItems.length;

        console.log(`[Cloud Pull Guard] local counts - groups: ${lg}, variants: ${lv}, orders: ${lso}, items: ${lsoi}`);
        console.log(`[Cloud Pull Guard] remote counts - groups: ${gLen}, variants: ${vLen}`);

        // If local has data, but remote returns 0 for core tables, treat as suspicious empty pull.
        // Exception: new empty account initialization (local count is 0).
        const isNewAccount = (lg === 0 && lv === 0);
        const isSuspicious = !isNewAccount && (
          (lg > 0 && gLen === 0) || 
          (lv > 0 && vLen === 0)
        );

        if (isSuspicious) {
          const msg = `[Cloud Pull Guard] Suspicious empty pull detected! Local variants: ${lv}, remote variants: ${vLen}. Local groups: ${lg}, remote groups: ${gLen}.`;
          console.warn(msg);
          console.log('[Cloud Pull Guard] abort sync to prevent pushing stale local cache');
          console.log('[Cloud Pull Guard] keep local cache');
          throw new Error(msg);
        }

        // Check if all of them are empty
        if (gLen === 0 && cLen === 0 && vLen === 0 && bLen === 0 && biLen === 0 && poLen === 0 && poiLen === 0) {
          console.log('[Sync Pull] core skipped: empty cloud result');
          this.isPulled = true;
          return;
        }

        // 2. 將雲端拉回的資料覆寫寫入本地 IndexedDB / LocalStorage 快取
        console.log(`[Sync] 正在寫入本地快取：groups: ${gLen} 筆, categories: ${cLen} 筆, variants: ${vLen} 筆, batches: ${bLen} 筆, batchItems: ${biLen} 筆, privateOrders: ${poLen} 筆, privateOrderItems: ${poiLen} 筆`);
        
        await db.saveProductGroups(groupsRes.data || []);
        await db.saveProductCategories(categoriesRes.data || []);
        console.log(`[Before IndexedDB Save Variants] count: ${(variantsRes.data || []).length}`);
        console.log('[Before IndexedDB Save Variants] sample:', (variantsRes.data || []).length > 0 ? JSON.stringify((variantsRes.data || [])[0]) : 'empty');
        await db.saveProductVariants(variantsRes.data || []);
        await db.savePurchaseBatches(batchesRes.data || []);
        const mappedBatchItems = (batchItemsRes.data || []).map((r: any) => ({
          id: r.local_id || r.id,
          purchase_batch_id: r.purchase_batch_id,
          product_variant_id: r.product_variant_id,
          quantity: r.quantity || 0,
          cost: Number(r.cost ?? 0),
          note: r.note || ''
        }));
        await db.savePurchaseBatchItems(mappedBatchItems);

        const mappedOrders: PrivateOrder[] = (poRes.data || []).map(r => ({
          id: r.local_id || r.id,
          product_group_id: r.product_group_id,
          customer_name: r.customer_name,
          contact: r.contact || '',
          note: r.note || '',
          created_at: r.created_at
        }));

        const mappedItems: PrivateOrderItem[] = (poiRes.data || []).map(r => ({
          id: r.local_id || r.id,
          private_order_id: r.private_order_id,
          product_variant_id: r.product_variant_id,
          quantity: r.quantity || 0,
          amount: Number(r.amount || 0),
          note: r.note || ''
        }));

        await db.savePrivateOrders(mappedOrders);
        await db.savePrivateOrderItems(mappedItems);

        // 3. 一併拉取雲端 sales_orders 與 sales_order_items 到本地，並還原 local_id 格式
        await this.pullSalesOrders();
        await this.pullSalesOrderItems();
        await this.pullDashboardCategoryImages();

        // 4. 呼叫既有的重新計算流程（即 db.getProductVariants），依雲端訂單重新計算
        console.log('[Sync] 觸發本地變體 auto quantity 重新計算...');
        const recalculatedVariants = await db.getProductVariants();

        // 5. 將重新計算後的變體資料庫存同步回雲端，維持兩端一致
        await this.saveProductVariants(recalculatedVariants);

        this.isPulled = true;
        console.log(`[Sync Pull] core applied: groups ${gLen} categories ${cLen} variants ${vLen} batches ${bLen} batchItems ${biLen}`);
      } catch (err: any) {
        console.error('[Sync] 商品核心主檔同步失敗:', err);
        if (isSchemaMissingError(err)) {
          alert(`雲端資料庫結構缺失：${err.message || JSON.stringify(err)}。同步流程已中斷，請聯絡管理員匯入 SQL Migration 補建表格！`);
          this.isPulled = false;
          throw err;
        }
        console.log('[Sync Pull] core failed: keep local cache');
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
    const data = await db.getProductGroups();
    console.log(`[IndexedDB Get Groups] count: ${data.length}`);
    return data;
  }

  async getProductCategories(): Promise<ProductCategory[]> {
    await this.pullCoreProductData();
    const data = await db.getProductCategories();
    console.log(`[IndexedDB Get Categories] count: ${data.length}`);
    return data;
  }

  async getProductVariants(): Promise<ProductVariant[]> {
    await this.pullCoreProductData();
    const data = await db.getProductVariants();
    console.log(`[IndexedDB Read Variants] count: ${data.length}`);
    return data;
  }

  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    const sanitizedGroups = [];
    for (const g of groups) {
      if (!isValidUuid(g.id)) {
        const newId = generateFallbackUuid();
        console.warn(`[UUID Stabilization] Detected invalid Group ID "${g.id}". Regenerated to "${newId}".`);
        
        // Update any child categories in IndexedDB
        const cats = await db.getProductCategories();
        const childCats = cats.filter(c => c.product_group_id === g.id);
        if (childCats.length > 0) {
          childCats.forEach(c => c.product_group_id = newId);
          await db.saveProductCategories(cats);
          await this.saveProductCategories(childCats);
        }

        // Update any child variants in IndexedDB
        const vars = await db.getProductVariants();
        const childVars = vars.filter(v => v.product_group_id === g.id);
        if (childVars.length > 0) {
          childVars.forEach(v => v.product_group_id = newId);
          await db.saveProductVariants(vars);
          await this.saveProductVariants(childVars);
        }

        sanitizedGroups.push({ ...g, id: newId });
      } else {
        sanitizedGroups.push(g);
      }
    }

    // 1. 寫入本地 IndexedDB 快取
    await db.saveProductGroups(sanitizedGroups);

    if (!(await this.canWriteCloud())) {
      console.log('[Sync Push] Skip product_groups cloud push (Read-Only Viewer/Helper)');
      return;
    }

    // 2. 如果傳入陣列為空，直接略過，不向 Supabase 發送 upsert
    if (sanitizedGroups.length === 0) {
      return;
    }

    try {
      // 篩選出合法 UUID 的資料
      const validGroups = sanitizedGroups.filter(g => isValidUuid(g.id));

      if (validGroups.length === 0) {
        console.log('[Sync Push] product_groups skipped: no valid rows');
        return;
      }

      console.log(`[Cloud Push] product_groups count: ${validGroups.length}`);

      const upsertData = validGroups.map(g => ({
        id: g.id,
        local_id: g.id,
        title: g.title,
        listing_type: g.listing_type || null,
        purchase_date: g.purchase_date || null,
        closing_date: g.closing_date || null,
        release_month: g.release_month || null,
        product_url: g.product_url || null,
        priority: g.priority || 'Medium',
        normalized_title: g.normalized_title || null,
        has_official_site: g.has_official_site || false
      }));

      const { error } = await supabase
        .from('product_groups')
        .upsert(upsertData);

      if (error) {
        console.error(`[Cloud Push ERROR] Supabase error message: ${error.message}`);
        await this.pullCoreProductData(true);
        alert(`雲端同步商品群組失敗：${error.message || JSON.stringify(error)}。已回復本地快取資料，請重試！`);
        throw error;
      } else {
        console.log(`[Sync Push] product_groups upsert success: ${upsertData.length} rows`);
      }
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      await this.pullCoreProductData(true);
      alert(`雲端同步商品群組發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
  }

  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    const sanitizedCategories = [];
    const groups = await db.getProductGroups();
    const vars = await db.getProductVariants();
    let categoriesChanged = false;
    let variantsChanged = false;

    for (const c of categories) {
      const updatedCat = { ...c };

      // Ensure Category ID is valid UUID
      if (!isValidUuid(c.id)) {
        const newCatId = generateFallbackUuid();
        console.warn(`[UUID Stabilization] Detected invalid Category ID "${c.id}". Regenerated to "${newCatId}".`);
        updatedCat.id = newCatId;
        categoriesChanged = true;

        // Cascade to product_variants in IndexedDB
        const childVars = vars.filter(v => v.product_category_id === c.id);
        if (childVars.length > 0) {
          childVars.forEach(v => {
            v.product_category_id = newCatId;
          });
          variantsChanged = true;
        }
      }

      // Ensure product_group_id is valid UUID
      if (!isValidUuid(updatedCat.product_group_id)) {
        // Try to find the group by title if the invalid ID is actually a title
        const matchingGroup = groups.find(g => g.id === updatedCat.product_group_id || g.title === updatedCat.product_group_id);
        if (matchingGroup && isValidUuid(matchingGroup.id)) {
          updatedCat.product_group_id = matchingGroup.id;
          categoriesChanged = true;
        } else {
          const newGroupId = generateFallbackUuid();
          console.warn(`[UUID Stabilization] Category "${updatedCat.title}" has invalid Group ID "${updatedCat.product_group_id}". Generated fallback Group ID "${newGroupId}".`);
          updatedCat.product_group_id = newGroupId;
          categoriesChanged = true;
        }
      }

      sanitizedCategories.push(updatedCat);
    }

    if (categoriesChanged) {
      await db.saveProductCategories(sanitizedCategories);
    } else {
      await db.saveProductCategories(categories);
    }

    if (variantsChanged) {
      await db.saveProductVariants(vars);
      await this.saveProductVariants(vars);
    }

    if (!(await this.canWriteCloud())) {
      console.log('[Sync Push] Skip product_categories cloud push (Read-Only Viewer/Helper)');
      return;
    }

    // 2. 如果傳入陣列為空，直接略過，不向 Supabase 發送 upsert
    const finalCategories = categoriesChanged ? sanitizedCategories : categories;
    if (finalCategories.length === 0) {
      return;
    }

    try {
      // 篩選出具備合法 UUID 之 id 與 product_group_id 的分類資料
      const validCategories = finalCategories.filter(c => 
        isValidUuid(c.id) && isValidUuid(c.product_group_id)
      );

      if (validCategories.length === 0) {
        console.log('[Sync Push] product_categories skipped: no valid rows');
        return;
      }

      console.log(`[Cloud Push] product_categories count: ${validCategories.length}`);

      const upsertData = validCategories.map(c => ({
        id: c.id,
        local_id: c.id,
        product_group_id: c.product_group_id,
        title: c.title,
        sort_order: c.sort_order || 0
      }));

      const { error } = await supabase
        .from('product_categories')
        .upsert(upsertData);

      if (error) {
        console.error(`[Cloud Push ERROR] Supabase error message: ${error.message}`);
        await this.pullCoreProductData(true);
        alert(`雲端同步商品分類失敗：${error.message || JSON.stringify(error)}。已回復本地快取資料！`);
        throw error;
      } else {
        console.log(`[Sync Push] product_categories upsert success: ${upsertData.length} rows`);
      }
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      await this.pullCoreProductData(true);
      alert(`雲端同步商品分類發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
  }

  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    if (!variants || variants.length === 0) {
      console.warn("[Sync Push] SKIP saveProductVariants because variants array is empty");
      return;
    }
    const sanitizedVariants = [];
    const groups = await db.getProductGroups();
    const categories = await db.getProductCategories();
    let variantsChanged = false;

    for (const v of variants) {
      const updatedVar = { ...v };

      // Ensure Variant ID is valid UUID
      if (!isValidUuid(v.id)) {
        const newVarId = generateFallbackUuid();
        console.warn(`[UUID Stabilization] Detected invalid Variant ID "${v.id}". Regenerated to "${newVarId}".`);
        updatedVar.id = newVarId;
        variantsChanged = true;
      }

      // Ensure product_group_id is valid UUID
      if (!isValidUuid(updatedVar.product_group_id)) {
        const matchingGroup = groups.find(g => g.id === updatedVar.product_group_id || g.title === updatedVar.product_group_id);
        if (matchingGroup && isValidUuid(matchingGroup.id)) {
          updatedVar.product_group_id = matchingGroup.id;
          variantsChanged = true;
        } else {
          const newGroupId = generateFallbackUuid();
          console.warn(`[UUID Stabilization] Variant "${updatedVar.variant_name}" has invalid Group ID "${updatedVar.product_group_id}". Generated fallback Group ID "${newGroupId}".`);
          updatedVar.product_group_id = newGroupId;
          variantsChanged = true;
        }
      }

      // Ensure product_category_id is either valid UUID or null
      if (updatedVar.product_category_id !== undefined && updatedVar.product_category_id !== null) {
        if (!isValidUuid(updatedVar.product_category_id)) {
          const matchingCat = categories.find(c => c.id === updatedVar.product_category_id || c.title === updatedVar.product_category_id);
          if (matchingCat && isValidUuid(matchingCat.id)) {
            updatedVar.product_category_id = matchingCat.id;
            variantsChanged = true;
          } else {
            console.warn(`[UUID Stabilization] Variant "${updatedVar.variant_name}" has invalid Category ID "${updatedVar.product_category_id}". Setting to undefined.`);
            updatedVar.product_category_id = undefined;
            variantsChanged = true;
          }
        }
      }

      sanitizedVariants.push(updatedVar);
    }

    const finalVars = variantsChanged ? sanitizedVariants : variants;
    console.log(`[Before IndexedDB Save Variants] count: ${finalVars.length}`);
    console.log('[Before IndexedDB Save Variants] sample:', finalVars.length > 0 ? JSON.stringify(finalVars[0]) : 'empty');
    if (variantsChanged) {
      await db.saveProductVariants(sanitizedVariants);
    } else {
      await db.saveProductVariants(variants);
    }

    if (!(await this.canWriteCloud())) {
      console.log('[Sync Push] Skip product_variants cloud push (Read-Only Viewer/Helper)');
      return;
    }

    // 2. 如果傳入陣列為空，直接略過，不向 Supabase 發送 upsert
    const finalVariants = variantsChanged ? sanitizedVariants : variants;
    if (finalVariants.length === 0) {
      return;
    }

    try {
      // 篩選出具備合法 UUID 之 id 與 product_group_id 的規格資料
      const validVariants = finalVariants.filter(v => 
        isValidUuid(v.id) && isValidUuid(v.product_group_id)
      );

      if (validVariants.length === 0) {
        console.log('[Sync Push] product_variants skipped: no valid rows');
        return;
      }

      console.log(`[Cloud Push] product_variants count: ${validVariants.length}`);

      const upsertData = validVariants.map(v => ({
        id: v.id,
        local_id: v.id,
        product_group_id: v.product_group_id,
        product_category_id: isValidUuid(v.product_category_id) ? v.product_category_id : null,
        myacg_item_code: v.myacg_item_code,
        variant_name: v.variant_name,
        raw_variant_name: v.raw_variant_name || null,
        product_title: v.product_title,
        myacg_manual_adjustment: v.myacg_manual_adjustment ?? 0,
        waca_manual_adjustment: v.waca_manual_adjustment ?? 0,
        private_manual_adjustment: v.private_manual_adjustment ?? 0,
        purchased_manual_adjustment: v.purchased_manual_adjustment ?? 0,
        myacg_auto_quantity: v.myacg_auto_quantity ?? 0,
        effective_myacg_quantity: v.effective_myacg_quantity ?? 0,
        waca_auto_quantity: v.waca_auto_quantity ?? 0,
        note: v.note || '',
        sort_order: v.sort_order || 0,
        catalog_missing: v.catalog_missing || false,
        source: v.source || null,
        default_jpy_cost: v.default_jpy_cost ?? null,
        default_twd_cost: v.default_twd_cost ?? null
      }));

      console.log('[Default Cost Sync] save payload sample:', upsertData.length > 0 ? JSON.stringify(upsertData[0]) : 'empty');

      const { error } = await supabase
        .from('product_variants')
        .upsert(upsertData);

      if (error) {
        console.error(`[Cloud Push ERROR] Supabase error message: ${error.message}`);
        await this.pullCoreProductData(true);
        alert(`雲端同步商品規格失敗：${error.message || JSON.stringify(error)}。已回復本地快取資料！`);
        throw error;
      } else {
        console.log(`[Sync Push] product_variants upsert success: ${upsertData.length} rows`);
      }
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      await this.pullCoreProductData(true);
      alert(`雲端同步商品規格發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
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

  async saveSalesOrders(orders: SalesOrder[]): Promise<void> {
    // 1. 本地照舊保存
    await db.saveSalesOrders(orders);

    if (!(await this.canWriteCloud())) {
      console.log('[Sync Push] Skip sales_orders cloud push (Read-Only Viewer/Helper)');
      return;
    }

    // 2. Cloud Mode 時 upsert sales_orders
    if (orders.length === 0) {
      return;
    }

    try {
      console.log(`[Sync Push] sales_orders preparing: ${orders.length} rows`);

      const upsertData = orders.map(o => ({
        id: getDeterministicUuid(o.id.trim().toUpperCase()),
        local_id: o.id,
        platform: o.platform,
        order_number: o.order_number,
        buyer_name: o.buyer_name,
        created_at: o.created_at || new Date().toISOString()
      }));

      const { error } = await supabase
        .from('sales_orders')
        .upsert(upsertData, { onConflict: 'order_number' });

      if (error) {
        console.error(`[Cloud Push ERROR] Supabase error message: ${error.message}`);
        await this.pullSalesOrders();
        alert(`雲端同步銷售訂單失敗：${error.message || JSON.stringify(error)}。已回復本地快取資料！`);
        throw error;
      } else {
        console.log(`[Sync Push] sales_orders upsert success: ${upsertData.length} rows`);
      }
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      await this.pullSalesOrders();
      alert(`雲端同步銷售訂單發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
  }

  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return db.getSalesOrderItems();
  }

  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    // 1. 本地照舊保存
    await db.saveSalesOrderItems(items);

    if (!(await this.canWriteCloud())) {
      console.log('[Sync Push] Skip sales_order_items cloud push (Read-Only Viewer/Helper)');
      return;
    }

    // 2. Cloud Mode 時 upsert sales_order_items
    if (items.length === 0) {
      return;
    }

    try {
      console.log(`[Sync Push] sales_order_items preparing: ${items.length} rows`);

      const upsertData = items.map(item => {
        const orderIdPart = item.order_id.trim().toUpperCase();
        const codePart = item.myacg_item_code.trim().toUpperCase();
        const variantPart = (item.variant_name || '').trim().toUpperCase();
        const pricePart = Number(item.price || 0).toString();
        const uniqueKey = `${orderIdPart}_${codePart}_${variantPart}_${pricePart}`;
        const deterministicId = getDeterministicUuid(uniqueKey);

        return {
          id: deterministicId,
          order_id: getDeterministicUuid(orderIdPart),
          product_variant_id: isValidUuid(item.product_variant_id) ? item.product_variant_id : null,
          myacg_item_code: item.myacg_item_code,
          product_name: item.product_name || null,
          variant_name: item.variant_name || null,
          quantity: item.quantity || 0,
          price: item.price !== undefined ? Number(item.price) : 0,
          amount: item.amount !== undefined ? Number(item.amount) : 0,
          order_status: item.order_status || null,
          local_id: item.id
        };
      });

      const { error } = await supabase
        .from('sales_order_items')
        .upsert(upsertData);

      if (error) {
        console.error(`[Cloud Push ERROR] Supabase error message: ${error.message}`);
        await this.pullSalesOrderItems();
        alert(`雲端同步訂單明細失敗：${error.message || JSON.stringify(error)}。已回復本地快取資料！`);
        throw error;
      } else {
        console.log(`[Sync Push] sales_order_items upsert success: ${upsertData.length} rows`);
      }
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      await this.pullSalesOrderItems();
      alert(`雲端同步訂單明細發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
  }

  async pullSalesOrders(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('*')
        .is('deleted_at', null);

      if (error) {
        throw error;
      }

      const localOrders = await db.getSalesOrders();
      const lso = localOrders.length;
      const rso = data?.length || 0;

      console.log(`[Cloud Pull Guard] sales_orders - local count: ${lso}, remote count: ${rso}`);

      if (lso > 0 && rso === 0) {
        const msg = '[Cloud Pull Guard] Suspicious empty pull for sales_orders!';
        console.warn(msg);
        console.log('[Cloud Pull Guard] abort sync to prevent pushing stale local cache');
        console.log('[Cloud Pull Guard] keep local cache');
        throw new Error(msg);
      }

      const rows = data || [];
      const mappedOrders: SalesOrder[] = rows.map(r => ({
        id: r.local_id || r.id,
        platform: r.platform,
        order_number: r.order_number,
        buyer_name: r.buyer_name,
        created_at: r.created_at
      }));

      // Write directly to local DB
      await db.saveSalesOrders(mappedOrders);
      console.log(`[Sync Pull] sales_orders applied: ${mappedOrders.length} rows`);
    } catch (err: any) {
      console.error(`[Sync Pull ERROR] sales_orders failed (Schema 缺失?): ${err.message || err}`);
      if (err.message && (err.message.includes('42P01') || err.message.toLowerCase().includes('relation') || err.message.toLowerCase().includes('could not find the table'))) {
        alert('核心資料表 sales_orders 缺失，請聯絡系統管理員匯入 SQL Migration 建立表格！');
      }
      throw err;
    }
  }

  async pullSalesOrderItems(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('sales_order_items')
        .select('*')
        .is('deleted_at', null);

      if (error) {
        throw error;
      }

      const localItems = await db.getSalesOrderItems();
      const lsoi = localItems.length;
      const rsoi = data?.length || 0;

      console.log(`[Cloud Pull Guard] sales_order_items - local count: ${lsoi}, remote count: ${rsoi}`);

      if (lsoi > 0 && rsoi === 0) {
        const msg = '[Cloud Pull Guard] Suspicious empty pull for sales_order_items!';
        console.warn(msg);
        console.log('[Cloud Pull Guard] abort sync to prevent pushing stale local cache');
        console.log('[Cloud Pull Guard] keep local cache');
        throw new Error(msg);
      }

      const orders = await db.getSalesOrders();
      const orderUuidToLocalIdMap = new Map<string, string>();
      for (const order of orders) {
        const uuid = getDeterministicUuid(order.id.trim().toUpperCase());
        orderUuidToLocalIdMap.set(uuid, order.id);
      }

      const rows = data || [];
      const mappedItems: SalesOrderItem[] = rows.map(r => {
        const localOrderId: string = orderUuidToLocalIdMap.get(r.order_id) || r.order_id;
        return {
          id: r.local_id || r.id,
          order_id: localOrderId,
          product_variant_id: r.product_variant_id || undefined,
          myacg_item_code: r.myacg_item_code,
          product_name: r.product_name || undefined,
          variant_name: r.variant_name || undefined,
          quantity: r.quantity,
          price: r.price !== null ? Number(r.price) : undefined,
          amount: r.amount !== null ? Number(r.amount) : undefined,
          order_status: r.order_status || undefined
        };
      });

      // Write directly to local DB
      await db.saveSalesOrderItems(mappedItems);
      console.log(`[Sync Pull] sales_order_items applied: ${mappedItems.length} rows`);
    } catch (err: any) {
      console.error(`[Sync Pull ERROR] sales_order_items failed (Schema 缺失?): ${err.message || err}`);
      if (err.message && (err.message.includes('42P01') || err.message.toLowerCase().includes('relation') || err.message.toLowerCase().includes('could not find the table'))) {
        alert('核心資料表 sales_order_items 缺失，請聯絡系統管理員匯入 SQL Migration 建立表格！');
      }
      throw err;
    }
  }

  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return db.getPurchaseBatches();
  }

  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    // 1. Identify deleted ones by comparing with current local storage records
    const currentLocal = await db.getPurchaseBatches();
    const incomingIds = new Set(batches.map(b => b.id));
    const removedBatches = currentLocal.filter(b => !incomingIds.has(b.id));

    // 2. Save locally
    await db.savePurchaseBatches(batches);

    if (!(await this.canWriteCloud())) {
      console.log('[Sync Push] Skip purchase_batches cloud push (Read-Only Viewer/Helper)');
      return;
    }

    // 3. Supabase Cloud Sync
    try {
      // (A) Handle soft deletion of removed batches in Supabase
      if (removedBatches.length > 0) {
        const removedIds = removedBatches.map(b => b.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          const nowStr = new Date().toISOString();
          console.log(`[Sync Push] purchase_batches marking deleted_at: ${removedIds.length} rows`);
          const { error: delError } = await supabase
            .from('purchase_batches')
            .update({ deleted_at: nowStr })
            .in('id', removedIds);
          if (delError) {
            console.error('[Sync Push] purchase_batches delete update failed:', delError);
          }
        }
      }

      // (B) Upsert incoming active batches to Supabase
      const activeBatches = batches.filter(b => isValidUuid(b.id) && isValidUuid(b.product_group_id));
      if (activeBatches.length > 0) {
        console.log(`[Sync Push] purchase_batches upserting: ${activeBatches.length} rows`);
        const upsertData = activeBatches.map(b => ({
          id: b.id,
          local_id: b.id,
          product_group_id: b.product_group_id,
          name: b.name,
          date: b.date || null,
          note: b.note || null,
          currency: 'JPY'
        }));

        const { error: upsertError } = await supabase
          .from('purchase_batches')
          .upsert(upsertData);
        if (upsertError) {
          console.error('[Cloud Push ERROR] Supabase error message:', upsertError.message);
          await this.pullCoreProductData(true);
          alert(`雲端同步採購批次失敗：${upsertError.message}。已回復本地快取資料！`);
          throw upsertError;
        }
      }
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      await this.pullCoreProductData(true);
      alert(`雲端同步採購批次發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
  }

  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return db.getPurchaseBatchItems();
  }

  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    // 1. Identify deleted ones by comparing with current local storage records
    const currentLocal = await db.getPurchaseBatchItems();
    const incomingIds = new Set(items.map(i => i.id));
    const removedItems = currentLocal.filter(i => !incomingIds.has(i.id));

    // 2. Save locally (which also triggers auto recalculated quantities updates)
    await db.savePurchaseBatchItems(items);

    if (!(await this.canWriteCloud())) {
      console.log('[Sync Push] Skip purchase_batch_items cloud push (Read-Only Viewer/Helper)');
      return;
    }

    // 3. Supabase Cloud Sync
    try {
      // (A) Handle soft deletion of removed items in Supabase
      if (removedItems.length > 0) {
        const removedIds = removedItems.map(i => i.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          const nowStr = new Date().toISOString();
          console.log(`[Sync Push] purchase_batch_items marking deleted_at: ${removedIds.length} rows`);
          const { error: delError } = await supabase
            .from('purchase_batch_items')
            .update({ deleted_at: nowStr })
            .in('id', removedIds);
          if (delError) {
            console.error('[Sync Push] purchase_batch_items delete update failed:', delError);
          }
        }
      }

      // (B) Upsert incoming active items to Supabase
      const activeItems = items.filter(i => isValidUuid(i.id) && isValidUuid(i.purchase_batch_id) && isValidUuid(i.product_variant_id));
      if (activeItems.length > 0) {
        console.log(`[Sync Push] purchase_batch_items upserting: ${activeItems.length} rows`);
        const upsertData = activeItems.map(i => ({
          id: i.id,
          local_id: i.id,
          purchase_batch_id: i.purchase_batch_id,
          product_variant_id: i.product_variant_id,
          quantity: i.quantity || 0,
          cost: i.cost || 0,
          note: i.note || null
        }));

        const { error: upsertError } = await supabase
          .from('purchase_batch_items')
          .upsert(upsertData);
        if (upsertError) {
          console.error('[Cloud Push ERROR] Supabase error message:', upsertError.message);
          await this.pullCoreProductData(true);
          alert(`雲端同步採購批次明細失敗：${upsertError.message}。已回復本地快取資料！`);
          throw upsertError;
        }
      }
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      await this.pullCoreProductData(true);
      alert(`雲端同步採購批次明細發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
  }

  async getPrivateOrders(): Promise<PrivateOrder[]> {
    return db.getPrivateOrders();
  }

  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    // 1. 本地儲存
    await db.savePrivateOrders(orders);

    // 2. 判斷是否為唯讀 Viewer/Helper
    if (!(await this.canWriteCloud())) {
      const mode = getProviderMode();
      const role = await this.getRole();
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email || 'unknown';
      const msg = `[Sync Push WARNING] Cannot push private_orders to cloud. User: ${email}, Role: ${role}, Provider Mode: ${mode}`;
      console.warn(msg);
      alert(`儲存失敗：您目前在雲端模式下是唯讀權限 (${role || '未登入'})，無法將私下登記紀錄存入雲端。`);
      throw new Error(msg);
    }

    // 3. 防呆與空陣列檢查 (若 orders.length === 0，直接 skip 雲端 upsert)
    if (!orders || orders.length === 0) {
      console.log('[Private Order Sync] skip empty cloud upsert for private_orders');
      return;
    }

    try {
      // 4. 僅過濾出合法 UUID 的 active orders 進行 upsert
      const activeOrders = orders.filter(o => isValidUuid(o.id) && isValidUuid(o.product_group_id));
      if (activeOrders.length === 0) {
        console.log('[Private Order Sync] skip empty active cloud upsert for private_orders');
        return;
      }

      console.log(`[Private Order Sync] upsert orders count: ${activeOrders.length}`);
      const upsertData = activeOrders.map(o => ({
        id: o.id,
        local_id: o.id,
        product_group_id: o.product_group_id,
        customer_name: o.customer_name,
        contact: o.contact || null,
        note: o.note || null,
        status: 'pending'
      }));

      const { error: upsertError } = await supabase
        .from('private_orders')
        .upsert(upsertData);

      if (upsertError) {
        console.error('[Cloud Push ERROR] Supabase error message:', upsertError.message);
        await this.pullCoreProductData(true); // 發生錯誤，將本地快取回滾至雲端最新狀態
        alert(`雲端同步私下訂單失敗：${upsertError.message}。已回復本地快取資料！`);
        throw upsertError;
      }
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      await this.pullCoreProductData(true); // 發生錯誤，將本地快取回滾至雲端最新狀態
      alert(`雲端同步私下訂單發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
  }

  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    return db.getPrivateOrderItems();
  }

  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    // 1. 本地儲存
    await db.savePrivateOrderItems(items);

    // 2. 判斷是否為唯讀 Viewer/Helper
    if (!(await this.canWriteCloud())) {
      const mode = getProviderMode();
      const role = await this.getRole();
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email || 'unknown';
      const msg = `[Sync Push WARNING] Cannot push private_order_items to cloud. User: ${email}, Role: ${role}, Provider Mode: ${mode}`;
      console.warn(msg);
      alert(`儲存失敗：您目前在雲端模式下是唯讀權限 (${role || '未登入'})，無法將私下登記項目存入雲端。`);
      throw new Error(msg);
    }

    // 3. 防呆與空陣列檢查 (若 items.length === 0，直接 skip 雲端 upsert)
    if (!items || items.length === 0) {
      console.log('[Private Order Sync] skip empty cloud upsert for private_order_items');
      return;
    }

    try {
      // 4. 僅過濾出合法 UUID 的 active items
      const activeItems = items.filter(i => isValidUuid(i.id) && isValidUuid(i.private_order_id) && isValidUuid(i.product_variant_id));
      if (activeItems.length === 0) {
        console.log('[Private Order Sync] skip empty active cloud upsert for private_order_items');
        return;
      }

      // 5. 確保父訂單已成功寫入雲端以避免外鍵衝突 (Foreign Key check)
      const parentOrderIds = Array.from(new Set(activeItems.map(i => i.private_order_id)));
      const { data: existingParentOrders, error: checkError } = await supabase
        .from('private_orders')
        .select('id')
        .in('id', parentOrderIds);

      if (checkError) {
        console.error('[Private Order Sync] failed to verify parent orders:', checkError);
        throw checkError;
      }

      const existingParentSet = new Set(existingParentOrders?.map(o => o.id) || []);
      const readyItems = activeItems.filter(i => existingParentSet.has(i.private_order_id));
      const skippedCount = activeItems.length - readyItems.length;

      if (skippedCount > 0) {
        console.warn(`[Private Order Sync] skipped ${skippedCount} items because their parent private_orders do not exist in Supabase yet`);
      }

      if (readyItems.length === 0) {
        console.log('[Private Order Sync] skip items cloud upsert because no items have parent orders in Supabase');
        return;
      }

      console.log(`[Private Order Sync] upsert items count: ${readyItems.length}`);
      const upsertData = readyItems.map(i => ({
        id: i.id,
        local_id: i.id,
        private_order_id: i.private_order_id,
        product_variant_id: i.product_variant_id,
        quantity: i.quantity || 0,
        amount: i.amount || 0,
        note: i.note || null
      }));

      const { error: upsertError } = await supabase
        .from('private_order_items')
        .upsert(upsertData);

      if (upsertError) {
        console.error('[Cloud Push ERROR] Supabase error message:', upsertError.message);
        await this.pullCoreProductData(true);
        alert(`雲端同步私下訂單項目失敗：${upsertError.message}。已回復本地快取資料！`);
        throw upsertError;
      }
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      await this.pullCoreProductData(true);
      alert(`雲端同步私下訂單項目發生異常：${err.message || err}。已回復本地快取資料！`);
      throw err;
    }
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
    await db.createPurchaseRecordFromInventory(itemCodes);
    const groups = await db.getProductGroups();
    const categories = await db.getProductCategories();
    const variants = await db.getProductVariants();
    await this.saveProductGroups(groups);
    await this.saveProductCategories(categories);
    await this.saveProductVariants(variants);
  }

  async reparseProductVariants(): Promise<void> {
    await db.reparseProductVariants();
    const categories = await db.getProductCategories();
    const variants = await db.getProductVariants();
    await this.saveProductCategories(categories);
    await this.saveProductVariants(variants);
  }

  async reparseProductTitles(): Promise<void> {
    await db.reparseProductTitles();
    const groups = await db.getProductGroups();
    await this.saveProductGroups(groups);
  }

  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {
    const result = await db.syncProductGroupsWithInventory();
    const categories = await db.getProductCategories();
    const variants = await db.getProductVariants();
    await this.saveProductCategories(categories);
    await this.saveProductVariants(variants);
    return result;
  }

  async deleteProductGroup(groupId: string): Promise<void> {
    if (!(await this.canWriteCloud())) {
      throw new Error("無權限，viewer 不可刪除商品群組");
    }

    const nowStr = new Date().toISOString();
    const { error: groupError } = await supabase
      .from('product_groups')
      .update({ deleted_at: nowStr })
      .eq('id', groupId);

    if (groupError) {
      console.error('[Supabase] Failed to soft delete group:', groupError);
      throw groupError;
    }

    const { error: catError } = await supabase
      .from('product_categories')
      .update({ deleted_at: nowStr })
      .eq('product_group_id', groupId);
    if (catError) {
      console.error('[Supabase] Failed to soft delete categories:', catError);
      throw catError;
    }

    const { error: varError } = await supabase
      .from('product_variants')
      .update({ deleted_at: nowStr })
      .eq('product_group_id', groupId);
    if (varError) {
      console.error('[Supabase] Failed to soft delete variants:', varError);
      throw varError;
    }

    // Only update local DB cache if Supabase soft delete succeeded
    const groups = await db.getProductGroups();
    const updatedGroups = groups.filter(g => g.id !== groupId);
    await db.saveProductGroups(updatedGroups);

    const categories = await db.getProductCategories();
    const updatedCategories = categories.filter(c => c.product_group_id !== groupId);
    await db.saveProductCategories(updatedCategories);

    const variants = await db.getProductVariants();
    const updatedVariants = variants.filter(v => v.product_group_id !== groupId);
    await db.saveProductVariants(updatedVariants);
  }

  async deleteProductGroups(groupIds: string[]): Promise<void> {
    if (!(await this.canWriteCloud())) {
      throw new Error("無權限，viewer 不可刪除商品群組");
    }

    if (!groupIds || groupIds.length === 0) return;

    const nowStr = new Date().toISOString();
    const { error: groupError } = await supabase
      .from('product_groups')
      .update({ deleted_at: nowStr })
      .in('id', groupIds);

    if (groupError) {
      console.error('[Supabase] Failed to soft delete groups:', groupError);
      throw groupError;
    }

    const { error: catError } = await supabase
      .from('product_categories')
      .update({ deleted_at: nowStr })
      .in('product_group_id', groupIds);
    if (catError) {
      console.error('[Supabase] Failed to soft delete categories:', catError);
      throw catError;
    }

    const { error: varError } = await supabase
      .from('product_variants')
      .update({ deleted_at: nowStr })
      .in('product_group_id', groupIds);
    if (varError) {
      console.error('[Supabase] Failed to soft delete variants:', varError);
      throw varError;
    }

    // Only update local DB cache if Supabase soft delete succeeded
    const groups = await db.getProductGroups();
    const updatedGroups = groups.filter(g => !groupIds.includes(g.id));
    await db.saveProductGroups(updatedGroups);

    const categories = await db.getProductCategories();
    const updatedCategories = categories.filter(c => !c.product_group_id || !groupIds.includes(c.product_group_id));
    await db.saveProductCategories(updatedCategories);

    const variants = await db.getProductVariants();
    const updatedVariants = variants.filter(v => !v.product_group_id || !groupIds.includes(v.product_group_id));
    await db.saveProductVariants(updatedVariants);
  }

  async pullDashboardCategoryImages(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('dashboard_category_images')
        .select('category_key, image_url, storage_path')
        .is('deleted_at', null);

      if (error) throw error;

      if (data) {
        data.forEach(item => {
          if (item.category_key) {
            if (item.image_url) {
              localStorage.setItem(`dashboard_cloud_img_${item.category_key}`, item.image_url);
            } else {
              localStorage.removeItem(`dashboard_cloud_img_${item.category_key}`);
            }
            if (item.storage_path) {
              localStorage.setItem(`dashboard_cloud_path_${item.category_key}`, item.storage_path);
            } else {
              localStorage.removeItem(`dashboard_cloud_path_${item.category_key}`);
            }
          }
        });
        console.log(`[Sync] 成功同步 ${data.length} 筆首頁大類圖片資料`);
      }
    } catch (err: any) {
      console.error('[Sync] 同步首頁大類圖片失敗:', err.message || err);
      if (isSchemaMissingError(err)) {
        alert('雲端資料表 dashboard_category_images 缺失，同步流程已中斷，請匯入 SQL Migration 建立表格！');
        throw err;
      }
    }
  }

  async saveDashboardCategoryImage(categoryKey: string, imageUrl: string | null, storagePath: string | null): Promise<void> {
    // 1. 本地照舊保存
    if (imageUrl) {
      localStorage.setItem(`dashboard_cloud_img_${categoryKey}`, imageUrl);
    } else {
      localStorage.removeItem(`dashboard_cloud_img_${categoryKey}`);
    }
    if (storagePath) {
      localStorage.setItem(`dashboard_cloud_path_${categoryKey}`, storagePath);
    } else {
      localStorage.removeItem(`dashboard_cloud_path_${categoryKey}`);
    }

    if (!(await this.canWriteCloud())) {
      console.log(`[Sync Push] Skip dashboard_category_images cloud push for ${categoryKey} (Read-Only Viewer/Helper)`);
      return;
    }

    try {
      const { error } = await supabase
        .from('dashboard_category_images')
        .upsert({
          category_key: categoryKey,
          image_url: imageUrl,
          storage_path: storagePath,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'category_key'
        });

      if (error) throw error;
      console.log(`[Sync Push] 首頁大類圖片已儲存並推送雲端: ${categoryKey}`);
    } catch (err: any) {
      console.error(`[Sync Push] 推送首頁大類圖片失敗 (${categoryKey}):`, err.message || err);
      throw err;
    }
  }
}

export const supabaseProvider = new SupabaseProvider();
