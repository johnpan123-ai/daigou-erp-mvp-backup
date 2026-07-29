import * as XLSX from 'xlsx';
import { dataProvider } from '../providers/dataProvider';

export async function exportSimplifiedExcel(_currentUserEmail?: string): Promise<string> {
  const [groups, categories, variants, batches, batchItems] = await Promise.all([
    dataProvider.getProductGroups(),
    dataProvider.getProductCategories(),
    dataProvider.getProductVariants(),
    dataProvider.getPurchaseBatches(),
    dataProvider.getPurchaseBatchItems(),
  ]);

  const groupMap = new Map(groups.map(g => [g.id, g]));
  const catMap = new Map(categories.map(c => [c.id, c.title]));
  const varMap = new Map(variants.map(v => [v.id, v]));
  const batchMap = new Map(batches.map(b => [b.id, b]));

  // ── Layer 2: 商品規格 rows sorted by group ──
  const variantRows = variants
    .map(v => {
      const group = groupMap.get(v.product_group_id || '');
      const localPurchased = batchItems
        .filter(pbi => pbi.product_variant_id === v.id)
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const finalPurchased = v.purchased_manual_adjustment ?? (v as any).ordered_quantity ?? (v as any).ordered_qty ?? localPurchased;
      return {
        groupId: v.product_group_id || '',
        groupTitle: group?.title || v.product_title || '',
        cat: catMap.get(v.product_category_id || '') || '',
        variant: v.variant_name || '',
        myacgCode: v.myacg_item_code || '',
        wacaSku: v.waca_sku || '',
        myacgQty: v.effective_myacg_quantity || v.myacg_auto_quantity || 0,
        wacaQty: v.waca_auto_quantity || 0,
        privateQty: v.private_manual_adjustment || 0,
        purchased: finalPurchased >= 0 ? finalPurchased : 0,
      };
    })
    .sort((a, b) => a.groupTitle.localeCompare(b.groupTitle));

  // ── Layer 3: 採購批次 rows sorted by group ──
  const batchRows = batches
    .map(b => {
      const group = groupMap.get(b.product_group_id || '');
      const items = batchItems.filter(bi => bi.purchase_batch_id === b.id);
      const totalQty = items.reduce((s, i) => s + Number(i.quantity || 0), 0);
      const totalCost = items.reduce((s, i) => s + Number(i.cost || 0) * Number(i.quantity || 0), 0);
      return {
        groupId: b.product_group_id || '',
        groupTitle: group?.title || '',
        batchId: b.id,
        batchName: b.name || '',
        date: b.date || '',
        itemCount: items.length,
        totalQty,
        totalCost,
        note: b.note || '',
      };
    })
    .sort((a, b) => a.groupTitle.localeCompare(b.groupTitle) || a.date.localeCompare(b.date));

  // ── Layer 4: 批次明細 rows sorted by batch ──
  const detailRows = batchItems
    .map(pbi => {
      const batch = batchMap.get(pbi.purchase_batch_id || '');
      const variant = varMap.get(pbi.product_variant_id || '');
      const group = variant ? groupMap.get(variant.product_group_id || '') : undefined;
      return {
        batchId: pbi.purchase_batch_id || '',
        batchName: batch?.name || '',
        batchDate: batch?.date || '',
        groupTitle: group?.title || variant?.product_title || '',
        variant: variant?.variant_name || '',
        myacgCode: variant?.myacg_item_code || '',
        quantity: pbi.quantity || 0,
        cost: pbi.cost || 0,
        note: pbi.note || '',
      };
    })
    .sort((a, b) => a.batchName.localeCompare(b.batchName));

  // ── Build index maps for hyperlink targets ──
  // group title → first row in Sheet 2
  const groupFirstVariantRow = new Map<string, number>();
  variantRows.forEach((r, i) => {
    if (!groupFirstVariantRow.has(r.groupTitle)) groupFirstVariantRow.set(r.groupTitle, i + 2);
  });
  // group title → first row in Sheet 3
  const groupFirstBatchRow = new Map<string, number>();
  batchRows.forEach((r, i) => {
    if (!groupFirstBatchRow.has(r.groupTitle)) groupFirstBatchRow.set(r.groupTitle, i + 2);
  });
  // batchId → first row in Sheet 4
  const batchFirstDetailRow = new Map<string, number>();
  detailRows.forEach((r, i) => {
    if (!batchFirstDetailRow.has(r.batchId)) batchFirstDetailRow.set(r.batchId, i + 2);
  });

  const groupVariantCount = new Map<string, number>();
  const groupBatchCount = new Map<string, number>();
  for (const v of variants) {
    const t = groupMap.get(v.product_group_id || '')?.title || v.product_title || '';
    groupVariantCount.set(t, (groupVariantCount.get(t) || 0) + 1);
  }
  for (const b of batches) {
    const t = groupMap.get(b.product_group_id || '')?.title || '';
    groupBatchCount.set(t, (groupBatchCount.get(t) || 0) + 1);
  }

  // ════════ Sheet 1: 商品總覽 ════════
  const s1Data = groups.map(g => ({
    '商品名稱': g.title,
    '規格數': groupVariantCount.get(g.title) || 0,
    '批次數': groupBatchCount.get(g.title) || 0,
    '類型': g.listing_type || '',
    '結單日': g.closing_date || '',
    '發售月份': g.release_month || '',
    '官網連結': g.product_url || '',
    '代理商': g.proxy_agent || '',
  }));
  const ws1 = XLSX.utils.json_to_sheet(s1Data);
  s1Data.forEach((row, i) => {
    const cellA = XLSX.utils.encode_cell({ r: i + 1, c: 0 });
    if (!ws1[cellA]) ws1[cellA] = { t: 's', v: row['商品名稱'] };
    const vRow = groupFirstVariantRow.get(row['商品名稱']);
    if (vRow) {
      ws1[cellA].l = { Target: `#'商品規格'!A${vRow}`, Tooltip: `查看 ${row['規格數']} 項規格` };
    }
    // 規格數 cell → link to Sheet 2
    const cellB = XLSX.utils.encode_cell({ r: i + 1, c: 1 });
    if (!ws1[cellB]) ws1[cellB] = { t: 'n', v: row['規格數'] };
    if (vRow) ws1[cellB].l = { Target: `#'商品規格'!A${vRow}` };
    // 批次數 cell → link to Sheet 3
    const cellC = XLSX.utils.encode_cell({ r: i + 1, c: 2 });
    if (!ws1[cellC]) ws1[cellC] = { t: 'n', v: row['批次數'] };
    const bRow = groupFirstBatchRow.get(row['商品名稱']);
    if (bRow) ws1[cellC].l = { Target: `#'採購批次'!A${bRow}` };
    // 官網連結 → external URL
    if (row['官網連結']) {
      const cellUrl = XLSX.utils.encode_cell({ r: i + 1, c: 6 });
      if (!ws1[cellUrl]) ws1[cellUrl] = { t: 's', v: row['官網連結'] };
      ws1[cellUrl].l = { Target: row['官網連結'] };
    }
  });
  ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: s1Data.length, c: 7 } }) };
  ws1['!cols'] = [{ wch: 45 }, { wch: 7 }, { wch: 7 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 45 }, { wch: 10 }];

  // ════════ Sheet 2: 商品規格 ════════
  const s2Data = variantRows.map(r => ({
    '商品名稱': r.groupTitle,
    '分類': r.cat,
    '規格名稱': r.variant,
    '買動漫代碼': r.myacgCode,
    'WACA SKU': r.wacaSku,
    '買動漫': r.myacgQty,
    'WACA': r.wacaQty,
    '私下登記': r.privateQty,
    '已採購': r.purchased,
  }));
  const ws2 = XLSX.utils.json_to_sheet(s2Data);
  // hyperlinks: 商品名稱 → back to Sheet 1 (find the group row)
  const groupSheet1Row = new Map<string, number>();
  s1Data.forEach((row, i) => { groupSheet1Row.set(row['商品名稱'], i + 2); });
  const linkedGroups2 = new Set<string>();
  s2Data.forEach((row, i) => {
    const cellA = XLSX.utils.encode_cell({ r: i + 1, c: 0 });
    if (!ws2[cellA]) ws2[cellA] = { t: 's', v: row['商品名稱'] };
    // First row of each group → link to Sheet 3 (採購批次)
    if (!linkedGroups2.has(row['商品名稱'])) {
      linkedGroups2.add(row['商品名稱']);
      const bRow = groupFirstBatchRow.get(row['商品名稱']);
      if (bRow) {
        ws2[cellA].l = { Target: `#'採購批次'!A${bRow}`, Tooltip: '查看採購批次 →' };
      }
    } else {
      // Subsequent rows → link back to Sheet 1
      const s1Row = groupSheet1Row.get(row['商品名稱']);
      if (s1Row) {
        ws2[cellA].l = { Target: `#'商品總覽'!A${s1Row}`, Tooltip: '← 返回商品總覽' };
      }
    }
  });
  ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: s2Data.length, c: 8 } }) };
  ws2['!cols'] = [{ wch: 45 }, { wch: 15 }, { wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }];

  // ════════ Sheet 3: 採購批次 ════════
  const s3Data = batchRows.map(r => ({
    '商品名稱': r.groupTitle,
    '批次名稱': r.batchName,
    '採購日期': r.date,
    '品項數': r.itemCount,
    '總數量': r.totalQty,
    '總成本': r.totalCost,
    '備註': r.note,
  }));
  const ws3 = XLSX.utils.json_to_sheet(s3Data);
  const linkedGroups3 = new Set<string>();
  s3Data.forEach((row, i) => {
    // 商品名稱 → back to Sheet 2
    const cellA = XLSX.utils.encode_cell({ r: i + 1, c: 0 });
    if (!ws3[cellA]) ws3[cellA] = { t: 's', v: row['商品名稱'] };
    if (!linkedGroups3.has(row['商品名稱'])) {
      linkedGroups3.add(row['商品名稱']);
      const vRow = groupFirstVariantRow.get(row['商品名稱']);
      if (vRow) {
        ws3[cellA].l = { Target: `#'商品規格'!A${vRow}`, Tooltip: '← 返回規格' };
      }
    } else {
      const s1Row = groupSheet1Row.get(row['商品名稱']);
      if (s1Row) {
        ws3[cellA].l = { Target: `#'商品總覽'!A${s1Row}`, Tooltip: '← 返回總覽' };
      }
    }
    // 批次名稱 → drill into Sheet 4
    const cellB = XLSX.utils.encode_cell({ r: i + 1, c: 1 });
    if (!ws3[cellB]) ws3[cellB] = { t: 's', v: row['批次名稱'] };
    const batchId = batchRows[i].batchId;
    const dRow = batchFirstDetailRow.get(batchId);
    if (dRow) {
      ws3[cellB].l = { Target: `#'批次明細'!A${dRow}`, Tooltip: `查看 ${row['品項數']} 項明細 →` };
    }
  });
  ws3['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: s3Data.length, c: 6 } }) };
  ws3['!cols'] = [{ wch: 45 }, { wch: 25 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 20 }];

  // ════════ Sheet 4: 批次明細 ════════
  const s4Data = detailRows.map(r => ({
    '批次名稱': r.batchName,
    '採購日期': r.batchDate,
    '商品名稱': r.groupTitle,
    '規格名稱': r.variant,
    '買動漫代碼': r.myacgCode,
    '數量': r.quantity,
    '成本': r.cost,
    '備註': r.note,
  }));
  const ws4 = XLSX.utils.json_to_sheet(s4Data);
  const linkedBatches4 = new Set<string>();
  s4Data.forEach((row, i) => {
    // 批次名稱 → back to Sheet 3
    const cellA = XLSX.utils.encode_cell({ r: i + 1, c: 0 });
    if (!ws4[cellA]) ws4[cellA] = { t: 's', v: row['批次名稱'] };
    if (!linkedBatches4.has(row['批次名稱'])) {
      linkedBatches4.add(row['批次名稱']);
      // Find the batch row in Sheet 3
      const batchIdx = s3Data.findIndex(b => b['批次名稱'] === row['批次名稱']);
      if (batchIdx >= 0) {
        ws4[cellA].l = { Target: `#'採購批次'!A${batchIdx + 2}`, Tooltip: '← 返回採購批次' };
      }
    }
    // 商品名稱 → back to Sheet 1
    const cellC = XLSX.utils.encode_cell({ r: i + 1, c: 2 });
    if (!ws4[cellC]) ws4[cellC] = { t: 's', v: row['商品名稱'] };
    const s1Row = groupSheet1Row.get(row['商品名稱']);
    if (s1Row) {
      ws4[cellC].l = { Target: `#'商品總覽'!A${s1Row}`, Tooltip: '← 返回總覽' };
    }
  });
  ws4['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: s4Data.length, c: 7 } }) };
  ws4['!cols'] = [{ wch: 25 }, { wch: 12 }, { wch: 45 }, { wch: 25 }, { wch: 15 }, { wch: 8 }, { wch: 8 }, { wch: 20 }];

  // ════════ Build workbook ════════
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, '商品總覽');
  XLSX.utils.book_append_sheet(wb, ws2, '商品規格');
  XLSX.utils.book_append_sheet(wb, ws3, '採購批次');
  XLSX.utils.book_append_sheet(wb, ws4, '批次明細');

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const filename = `daigou_erp_簡易匯出_${ts}.xlsx`;

  XLSX.writeFile(wb, filename);
  return filename;
}
