import * as XLSX from 'xlsx';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';

export async function exportToExcelBackup(currentUserEmail?: string): Promise<string> {
  // 1. Fetch all data from data provider
  const [
    groups,
    categories,
    variants,
    batches,
    batchItems,
    privateOrders,
    privateOrderItems
  ] = await Promise.all([
    dataProvider.getProductGroups(),
    dataProvider.getProductCategories(),
    dataProvider.getProductVariants(),
    dataProvider.getPurchaseBatches(),
    dataProvider.getPurchaseBatchItems(),
    dataProvider.getPrivateOrders(),
    dataProvider.getPrivateOrderItems()
  ]);

  const groupMap = new Map(groups.map(g => [g.id, g.title]));
  const catMap = new Map(categories.map(c => [c.id, c.title]));
  const varMap = new Map(variants.map(v => [v.id, v]));

  // =================== Sheet 1: 商品群組 (Product Groups) ===================
  const groupsData = groups.map(g => ({
    '商品群組 ID (product_group_id)': g.id,
    '商品名稱 (title)': g.title,
    '標準化商品名稱 (normalized_title)': g.normalized_title || '',
    '刊登類型 (listing_type)': g.listing_type || '',
    '優先級 (priority)': g.priority || '',
    '官方結單日 (closing_date)': g.closing_date || '',
    '發售月份 (release_month)': g.release_month || '',
    '官網連結 (product_url)': g.product_url || '',
    '建立時間 (created_at)': g.created_at || ''
  }));

  // =================== Sheet 2: 商品規格 (Product Variants) ===================
  const variantsData = variants.map(v => {
    const groupTitle = groupMap.get(v.product_group_id || '') || v.product_title || '';
    const catTitle = catMap.get(v.product_category_id || '') || '';
    
    // Sum purchase quantities for this variant
    const localPurchased = batchItems
      .filter(pbi => pbi.product_variant_id === v.id)
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      
    // Calculate final purchased quantity based on ERP logic
    const rawPurchased = v.purchased_manual_adjustment ?? (v as any).ordered_quantity ?? (v as any).ordered_qty ?? localPurchased;
    const finalPurchased = rawPurchased >= 0 ? rawPurchased : 0;

    return {
      '規格變體 ID (product_variant_id)': v.id,
      '商品群組 ID (product_group_id)': v.product_group_id || '',
      '商品群組名稱': groupTitle,
      '分類 ID (product_category_id)': v.product_category_id || '',
      '分類名稱 (category_title)': catTitle,
      '規格名稱 (variant_name)': v.variant_name || '',
      '原始規格名稱 (raw_variant_name)': v.raw_variant_name || '',
      '買動漫商品代碼 (myacg_item_code)': v.myacg_item_code || '',
      'Waca SKU (waca_sku)': v.waca_sku || '',
      '自訂 SKU (custom_sku)': v.custom_sku || '',
      '資料來源 (source)': v.source || '',
      '缺於 Catalog (catalog_missing)': v.catalog_missing ? '是' : '否',
      '買動漫自動統計數量': v.myacg_auto_quantity || 0,
      '實際買動漫需求': v.effective_myacg_quantity || 0,
      '買動漫手動調整數量': v.myacg_manual_adjustment || 0,
      'WACA 自動統計數量': v.waca_auto_quantity || 0,
      '私下登記調整數量': v.private_manual_adjustment || 0,
      '已採購手動調整': v.purchased_manual_adjustment !== null && v.purchased_manual_adjustment !== undefined ? v.purchased_manual_adjustment : '',
      '歷史已採購數量 (ordered_quantity)': (v as any).ordered_quantity !== null && (v as any).ordered_quantity !== undefined ? (v as any).ordered_quantity : '',
      '歷史已採購數量 (ordered_qty)': (v as any).ordered_qty !== null && (v as any).ordered_qty !== undefined ? (v as any).ordered_qty : '',
      '批次累計已採購數量 (local_purchased)': localPurchased,
      '最終已採購統計 (final_purchased)': finalPurchased,
      '顯示排序 (sort_order)': v.sort_order || 0
    };
  });

  // =================== Sheet 3: 採購批次 (Purchase Batches) ===================
  const batchesData = batches.map(b => ({
    '採購批次 ID (purchase_batch_id)': b.id,
    '商品群組 ID (product_group_id)': b.product_group_id || '',
    '批次名稱 (name)': b.name || '',
    '採購日期 (date)': b.date || '',
    '備註 (note)': b.note || '',
    '建立時間 (created_at)': b.created_at || ''
  }));

  // =================== Sheet 4: 採購批次明細 (Purchase Batch Items) ===================
  const batchItemsData = batchItems.map(pbi => {
    const variant = varMap.get(pbi.product_variant_id || '');
    const groupTitle = variant ? (groupMap.get(variant.product_group_id || '') || variant.product_title || '') : '';
    const catTitle = variant ? (catMap.get(variant.product_category_id || '') || '') : '';
    const variantName = variant ? (variant.variant_name || '') : '';
    const rawVariantName = variant ? (variant.raw_variant_name || '') : '';
    const sku = variant ? (variant.myacg_item_code || '') : '';

    return {
      '採購明細 ID (purchase_batch_item_id)': pbi.id,
      '採購批次 ID (purchase_batch_id)': pbi.purchase_batch_id || '',
      '規格變體 ID (product_variant_id)': pbi.product_variant_id || '',
      '商品群組名稱': groupTitle,
      '分類名稱': catTitle,
      '規格名稱': variantName,
      '原始規格名稱': rawVariantName,
      '商品代碼 (SKU)': sku,
      '數量 (quantity)': pbi.quantity || 0,
      '成本 (cost)': pbi.cost || 0,
      '備註 (note)': pbi.note || ''
    };
  });

  // =================== Sheet 5: 私下登記明細 (Private Orders) ===================
  const privateOrdersData = privateOrderItems.map(poi => {
    const variant = varMap.get(poi.product_variant_id || '');
    const groupTitle = variant ? (groupMap.get(variant.product_group_id || '') || variant.product_title || '') : '';
    const catTitle = variant ? (catMap.get(variant.product_category_id || '') || '') : '';
    const variantName = variant ? (variant.variant_name || '') : '';
    const sku = variant ? (variant.myacg_item_code || '') : '';
    
    // Find parent private order to get customer name
    const parentOrder = privateOrders.find(po => po.id === poi.private_order_id);
    const customerName = parentOrder ? (parentOrder.customer_name || '') : '';

    return {
      '登記明細 ID (private_order_item_id)': poi.id,
      '私下登記 ID (private_order_id)': poi.private_order_id || '',
      '規格變體 ID (product_variant_id)': poi.product_variant_id || '',
      '商品群組名稱': groupTitle,
      '分類名稱': catTitle,
      '規格名稱': variantName,
      '商品代碼 (SKU)': sku,
      '客戶名稱': customerName,
      '數量 (quantity)': poi.quantity || 0,
      '登記金額 (amount)': poi.amount || 0,
      '備註 (note)': poi.note || ''
    };
  });

  // =================== Sheet 6: 匯出資訊 (Export Info) ===================
  const exportInfoData = [{
    '匯出時間 (export_time)': new Date().toISOString(),
    '連線模式 (provider_mode)': getProviderMode(),
    '登入使用者 Email (user_email)': currentUserEmail || '未登入',
    '商品群組總數 (product_groups_count)': groups.length,
    '商品規格總數 (product_variants_count)': variants.length,
    '採購批次總數 (purchase_batches_count)': batches.length,
    '採購明細總數 (purchase_batch_items_count)': batchItems.length,
    '私下登記明細總數 (private_order_items_count)': privateOrderItems.length
  }];

  // 2. Build workbook
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(groupsData), '商品群組');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(variantsData), '商品規格');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(batchesData), '採購批次');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(batchItemsData), '採購批次明細');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(privateOrdersData), '私下登記明細');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportInfoData), '匯出資訊');

  // 3. Format filename: daigou_erp_backup_YYYYMMDD_HHMMSS.xlsx
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const filename = `daigou_erp_backup_${yyyy}${mm}${dd}_${hh}${min}${ss}.xlsx`;

  // 4. Trigger download
  XLSX.writeFile(wb, filename);

  return filename;
}
