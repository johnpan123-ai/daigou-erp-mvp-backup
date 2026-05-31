import re
import os

file_path = "src/pages/PurchaseManagement.tsx"
if not os.path.exists(file_path):
    print(f"Error: {file_path} not found.")
    exit(1)

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# Normalize line endings to \n for consistent replacement
original_line_endings = "\r\n" if "\r\n" in content else "\n"
content = content.replace("\r\n", "\n")

# Helper to log actions
def log_replace(desc, target, replacement):
    global content
    if target in content:
        content = content.replace(target, replacement)
        print(f"SUCCESS: {desc}")
    else:
        print(f"WARNING: Target not found for: {desc}")

# 0. Define getDailiVariantModalName function in component
# Let's place it right before formatVariantOption (which starts around: "const formatVariantOption = (v: ProductVariant) => {")
log_replace(
    "Define getDailiVariantModalName",
    """  const formatVariantOption = (v: ProductVariant) => {""",
    """  const getDailiVariantModalName = (v: ProductVariant) => {
    let name = (v.variant_name || '').trim();
    if (!name || name === '單品' || name === '一箱') {
      name = cleanDailiTitle(group?.normalized_title || group?.title || '');
    }
    if (!name) {
      name = v.myacg_item_code || '';
    }
    return name;
  };

  const formatVariantOption = (v: ProductVariant) => {"""
)

# 1. Rename getLatestJpyCost to getLatestBatchCost, and update in variants loop
old_kpi_calc = """  // KPI Calculations
  let totalShortage = 0;
  let totalExcess = 0;
  let totalPurchased = 0;
  let totalDemand = 0;
  let jpyNeedToBuy = 0;
  let jpyPurchased = 0;

  const batchMap = new Map(purchaseBatches.map(b => [b.id, b]));

  const getLatestJpyCost = (variantId: string): number | null => {
    const items = purchaseBatchItems.filter(item => item.product_variant_id === variantId && item.cost > 0);
    if (items.length === 0) return null;
    
    items.sort((a, b) => {
      const batchA = batchMap.get(a.purchase_batch_id);
      const batchB = batchMap.get(b.purchase_batch_id);
      if (!batchA || !batchB) return 0;
      const dateCompare = (batchA.date || '').localeCompare(batchB.date || '');
      if (dateCompare !== 0) return dateCompare;
      return (batchA.created_at || '').localeCompare(batchB.created_at || '');
    });
    
    return items[items.length - 1].cost;
  };

  variants.forEach(v => {
    const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);
    const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
    
    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
    const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);

    const vTotalDemand = myacgDemand + wacaDemand + privateDemand;
    totalDemand += vTotalDemand;

    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
    const vPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
    totalPurchased += vPurchased;
    
    const needToBuy = Math.max(vTotalDemand - vPurchased, 0);
    const excessBuy = Math.max(vPurchased - vTotalDemand, 0);

    totalShortage += needToBuy;
    totalExcess += excessBuy;

    if (isDaili) {
      const defaultTwdCost = variantDefaultTwdCosts[v.id];
      const latestTwdCost = getLatestJpyCost(v.id);
      const activeTwdCost = (defaultTwdCost !== undefined && defaultTwdCost !== null) ? defaultTwdCost : (latestTwdCost || 0);
      jpyNeedToBuy += needToBuy * activeTwdCost;
      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);
    } else {
      const defaultCost = variantDefaultJpyCosts[v.id];
      const latestCost = getLatestJpyCost(v.id);
      const activeCost = (defaultCost !== undefined && defaultCost !== null) ? defaultCost : (latestCost || 0);
      jpyNeedToBuy += needToBuy * activeCost;
      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);
    }
  });

  const jpyTotalDemand = jpyNeedToBuy + jpyPurchased;
  const estimatedTwd = isDaili ? jpyTotalDemand : (jpyTotalDemand * exchangeRate);"""

new_kpi_calc = """  // KPI Calculations
  let totalShortage = 0;
  let totalExcess = 0;
  let totalPurchased = 0;
  let totalDemand = 0;
  let jpyNeedToBuy = 0;
  let jpyPurchased = 0;
  let dailiTotalOrdersAmount = 0;

  const batchMap = new Map(purchaseBatches.map(b => [b.id, b]));

  const getLatestBatchCost = (variantId: string): number | null => {
    const items = purchaseBatchItems.filter(item => item.product_variant_id === variantId && item.cost > 0);
    if (items.length === 0) return null;
    
    items.sort((a, b) => {
      const batchA = batchMap.get(a.purchase_batch_id);
      const batchB = batchMap.get(b.purchase_batch_id);
      if (!batchA || !batchB) return 0;
      const dateCompare = (batchA.date || '').localeCompare(batchB.date || '');
      if (dateCompare !== 0) return dateCompare;
      return (batchA.created_at || '').localeCompare(batchB.created_at || '');
    });
    
    return items[items.length - 1].cost;
  };

  variants.forEach(v => {
    const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);
    const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
    
    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
    const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);

    const vTotalDemand = myacgDemand + wacaDemand + privateDemand;
    totalDemand += vTotalDemand;

    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
    const vPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
    totalPurchased += vPurchased;
    
    const needToBuy = Math.max(vTotalDemand - vPurchased, 0);
    const excessBuy = Math.max(vPurchased - vTotalDemand, 0);

    totalShortage += needToBuy;
    totalExcess += excessBuy;

    const invItem = inventoryMap.get(v.myacg_item_code);
    const finalPrice = invItem?.final_price || 0;
    dailiTotalOrdersAmount += vTotalDemand * finalPrice;

    if (isDaili) {
      const defaultTwdCost = variantDefaultTwdCosts[v.id];
      const latestTwdCost = getLatestBatchCost(v.id);
      const activeTwdCost = (defaultTwdCost !== undefined && defaultTwdCost !== null) ? defaultTwdCost : (latestTwdCost || 0);
      jpyNeedToBuy += needToBuy * activeTwdCost;
      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);
    } else {
      const defaultCost = variantDefaultJpyCosts[v.id];
      const latestCost = getLatestBatchCost(v.id);
      const activeCost = (defaultCost !== undefined && defaultCost !== null) ? defaultCost : (latestCost || 0);
      jpyNeedToBuy += needToBuy * activeCost;
      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);
    }
  });

  const jpyTotalDemand = jpyNeedToBuy + jpyPurchased;
  const estimatedTwd = isDaili ? jpyTotalDemand : (jpyTotalDemand * exchangeRate);
  const dailiEstimatedProfit = dailiTotalOrdersAmount - jpyTotalDemand;"""

log_replace("Update KPI Calculations block", old_kpi_calc, new_kpi_calc)

# 2. Update getLatestJpyCost occurrences elsewhere
log_replace("Update openBatchModal getLatestJpyCost to getLatestBatchCost",
            "const latCost = getLatestJpyCost(v.id);",
            "const latCost = getLatestBatchCost(v.id);")

# 3. Update top KPI Cards conditional layout & values
# Card 4 (訂單總金額)
old_card_4 = """            {/* Total Amount (Orders NTD) */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>訂單總金額</div>
                <DollarSign size={20} color="#10b981" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>{totalOrdersAmount.toLocaleString()}</span>
                <span style={{ fontSize: '13px', color: '#64748b' }}>NTD</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>訂單商品總額</div>
            </div>"""

new_card_4 = """            {/* Total Amount (Orders NTD) */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>訂單總金額</div>
                <DollarSign size={20} color="#10b981" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>
                  {isDaili ? dailiTotalOrdersAmount.toLocaleString() : totalOrdersAmount.toLocaleString()}
                </span>
                <span style={{ fontSize: '13px', color: '#64748b' }}>NTD</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>訂單商品總額</div>
            </div>"""

log_replace("Update Card 4 total orders amount calculation", old_card_4, new_card_4)

# Card 7 (總需求日幣/成本 -> 總成本)
old_card_7 = """            {/* 3. 總需求日幣/成本 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '總需求成本' : '總需求日幣'}</div>
                <Package size={20} color="#16a34a" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a' }}>{isDaili ? `NT$ ${jpyTotalDemand.toLocaleString()}` : `¥ ${jpyTotalDemand.toLocaleString()}`}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '整批商品總成本(台幣)' : '整批商品總成本(日幣)'}</div>
            </div>"""

new_card_7 = """            {/* 3. 總需求日幣/成本 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '總成本' : '總需求日幣'}</div>
                <Package size={20} color="#16a34a" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a' }}>{isDaili ? `NT$ ${jpyTotalDemand.toLocaleString()}` : `¥ ${jpyTotalDemand.toLocaleString()}`}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '待採購成本 + 已採購成本' : '整批商品總成本(日幣)'}</div>
            </div>"""

log_replace("Update Card 7 text/title", old_card_7, new_card_7)

# Card 8 (預估台幣 -> 預估毛利)
old_card_8 = """            {/* 4. 預估台幣 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>預估台幣</div>
                <DollarSign size={20} color="#ca8a04" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#ca8a04' }}>NTD {Math.round(estimatedTwd).toLocaleString()}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '預估總台幣成本' : `總需求日幣 × 匯率 ${exchangeRate}`}</div>
            </div>"""

new_card_8 = """            {/* 4. 預估台幣 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '預估毛利' : '預估台幣'}</div>
                <DollarSign size={20} color="#ca8a04" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#ca8a04' }}>
                  {isDaili ? `NT$ ${dailiEstimatedProfit.toLocaleString()}` : `NTD ${Math.round(estimatedTwd).toLocaleString()}`}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '訂單總金額 - 總成本' : `總需求日幣 × 匯率 ${exchangeRate}`}</div>
            </div>"""

log_replace("Update Card 8 estimated profit", old_card_8, new_card_8)


# 4. Refactor table layout in SINGLE ITEM RENDERING block
old_single_table = """                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: '30%' }} />
                        <col style={{ width: '11%' }} />
                        <col style={{ width: '13%' }} />
                        <col style={{ width: '11%' }} />
                        <col style={{ width: '11%' }} />
                        <col style={{ width: '12%' }} />
                        <col style={{ width: '12%' }} />
                      </colgroup>
                      <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                        <tr>
                          <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>{isDaili ? '成本' : '單價'}</th>
                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td style={{ padding: '10px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={isDaili ? cleanDailiTitle(catTitle) : catTitle}>
                              <HighlightText text={isDaili ? cleanDailiTitle(catTitle) : catTitle} highlight={searchTerm} />
                            </div>
                            <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>
                              SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                            </div>
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                            {editMode ? (
                              <input
                                type="number"
                                min="0"
                                placeholder="-"
                                style={{
                                  width: '80px',
                                  height: '28px',
                                  textAlign: 'right',
                                  border: '1px solid #cbd5e1',
                                  borderRadius: '4px',
                                  fontSize: '14px',
                                  fontWeight: 600,
                                  color: '#1E293B',
                                  backgroundColor: '#ffffff',
                                  padding: '0 8px',
                                  margin: '0 0 0 auto',
                                  display: 'block'
                                }}
                                value={
                                  isDaili
                                    ? (variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : '')
                                    : (variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : '')
                                }
                                onChange={e => isDaili ? handleUpdateDefaultTwdCost(v.id, e.target.value) : handleUpdateDefaultJpyCost(v.id, e.target.value)}
                              />
                            ) : (
                              (() => {
                                if (isDaili) {
                                  const defCost = variantDefaultTwdCosts[v.id];
                                  if (defCost !== undefined && defCost !== null) {
                                    return `NT$ ${defCost}`;
                                  }
                                  const latCost = getLatestJpyCost(v.id);
                                  if (latCost !== null) {
                                    return `NT$ ${latCost}`;
                                  }
                                  return '-';
                                } else {
                                  const defCost = variantDefaultJpyCosts[v.id];
                                  if (defCost !== undefined && defCost !== null) {
                                    return `¥ ${defCost}`;
                                  }
                                  const latCost = getLatestJpyCost(v.id);
                                  if (latCost !== null) {
                                    return `¥ ${latCost}`;
                                  }
                                  return '-';
                                }
                              })()
                            )}
                          </td>"""

new_single_table = """                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
                      {isDaili ? (
                        <>
                          <colgroup>
                            <col style={{ width: '28%' }} />
                            <col style={{ width: '10%' }} />
                            <col style={{ width: '10%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '10%' }} />
                            <col style={{ width: '10%' }} />
                            <col style={{ width: '10%' }} />
                            <col style={{ width: '10%' }} />
                          </colgroup>
                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                            <tr>
                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                            </tr>
                          </thead>
                        </>
                      ) : (
                        <>
                          <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '13%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '12%' }} />
                          </</colgroup>
                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                            <tr>
                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                            </tr>
                          </thead>
                        </>
                      )}
                      <tbody>
                        <tr>
                          <td style={{ padding: '10px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={isDaili ? cleanDailiTitle(catTitle) : catTitle}>
                              <HighlightText text={isDaili ? cleanDailiTitle(catTitle) : catTitle} highlight={searchTerm} />
                            </div>
                            <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>
                              SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                            </div>
                          </td>
                          {isDaili ? (
                            <>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#64748b' }}>
                                NT$ {inventoryMap.get(v.myacg_item_code)?.final_price ?? '-'}
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                {editMode ? (
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="-"
                                    style={{
                                      width: '80px',
                                      height: '28px',
                                      textAlign: 'right',
                                      border: '1px solid #cbd5e1',
                                      borderRadius: '4px',
                                      fontSize: '14px',
                                      fontWeight: 600,
                                      color: '#1E293B',
                                      backgroundColor: '#ffffff',
                                      padding: '0 8px',
                                      margin: '0 0 0 auto',
                                      display: 'block'
                                    }}
                                    value={variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : ''}
                                    onChange={e => handleUpdateDefaultTwdCost(v.id, e.target.value)}
                                  />
                                ) : (
                                  (() => {
                                    const defCost = variantDefaultTwdCosts[v.id];
                                    if (defCost !== undefined && defCost !== null) {
                                      return `NT$ ${defCost}`;
                                    }
                                    const latCost = getLatestBatchCost(v.id);
                                    if (latCost !== null) {
                                      return `NT$ ${latCost}`;
                                    }
                                    return '-';
                                  })()
                                )}
                              </td>
                            </>
                          ) : (
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                              {editMode ? (
                                <input
                                  type="number"
                                  min="0"
                                  placeholder="-"
                                  style={{
                                    width: '80px',
                                    height: '28px',
                                    textAlign: 'right',
                                    border: '1px solid #cbd5e1',
                                    borderRadius: '4px',
                                    fontSize: '14px',
                                    fontWeight: 600,
                                    color: '#1E293B',
                                    backgroundColor: '#ffffff',
                                    padding: '0 8px',
                                    margin: '0 0 0 auto',
                                    display: 'block'
                                  }}
                                  value={variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : ''}
                                  onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}
                                />
                              ) : (
                                (() => {
                                  const defCost = variantDefaultJpyCosts[v.id];
                                  if (defCost !== undefined && defCost !== null) {
                                    return `¥ ${defCost}`;
                                  }
                                  const latCost = getLatestBatchCost(v.id);
                                  if (latCost !== null) {
                                    return `¥ ${latCost}`;
                                  }
                                  return '-';
                                })()
                              )}
                            </td>
                          )}"""

log_replace("Update single item worksheet table rendering", old_single_table, new_single_table)


# 5. Refactor table layout in CATEGORY DETAIL rows block
old_category_table = """                  {/* Expanded SKU Table */}
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid #f1f5f9' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
                        <colgroup>
                          <col style={{ width: '30%' }} />
                          <col style={{ width: '11%' }} />
                          <col style={{ width: '13%' }} />
                          <col style={{ width: '11%' }} />
                          <col style={{ width: '11%' }} />
                          <col style={{ width: '12%' }} />
                          <col style={{ width: '12%' }} />
                        </colgroup>
                        <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                          <tr>
                            <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                            <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>{isDaili ? '成本' : '單價'}</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const filteredList = groupItems.filter(v => {
                              if (!searchTerm.trim()) return true;
                              const lowerSearch = searchTerm.toLowerCase();
                              return (
                                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                              );
                            });
                            
                            return filteredList.map((v, i) => {
                              
                              
                              
                              const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);
                              const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                              
                              const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                              const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);
          
                              const totalDemand = myacgDemand + wacaDemand + privateDemand;
      
                              const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                              const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
                              
                              const needToBuy = Math.max(totalDemand - totalPurchased, 0);
                              const excessBuy = Math.max(totalPurchased - totalDemand, 0);

                              return (
                                <tr key={v.id} style={{ borderBottom: i === filteredList.length - 1 ? 'none' : '1px solid #F1F5F9' }}>
                                  <td style={{ padding: '12px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.variant_name}>
                                      <HighlightText text={isDaili ? cleanDailiTitle(parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name) : (parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name)} highlight={searchTerm} />
                                    </div>
                                  <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>
                                    SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                  </div>
                                </td>
                                <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                    {editMode ? (
                                      <input
                                        type="number"
                                        min="0"
                                        placeholder="-"
                                        style={{
                                          width: '80px',
                                          height: '28px',
                                          textAlign: 'right',
                                          border: '1px solid #cbd5e1',
                                          borderRadius: '4px',
                                          fontSize: '14px',
                                          fontWeight: 600,
                                          color: '#1E293B',
                                          backgroundColor: '#ffffff',
                                          padding: '0 8px',
                                          margin: '0 0 0 auto',
                                          display: 'block'
                                        }}
                                        value={
                                          isDaili
                                            ? (variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : '')
                                            : (variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : '')
                                        }
                                        onChange={e => isDaili ? handleUpdateDefaultTwdCost(v.id, e.target.value) : handleUpdateDefaultJpyCost(v.id, e.target.value)}
                                      />
                                    ) : (
                                      (() => {
                                        if (isDaili) {
                                          const defCost = variantDefaultTwdCosts[v.id];
                                          if (defCost !== undefined && defCost !== null) {
                                            return `NT$ ${defCost}`;
                                          }
                                          const latCost = getLatestJpyCost(v.id);
                                          if (latCost !== null) {
                                            return `NT$ ${latCost}`;
                                          }
                                          return '-';
                                        } else {
                                          const defCost = variantDefaultJpyCosts[v.id];
                                          if (defCost !== undefined && defCost !== null) {
                                            return `¥ ${defCost}`;
                                          }
                                          const latCost = getLatestJpyCost(v.id);
                                          if (latCost !== null) {
                                            return `¥ ${latCost}`;
                                          }
                                          return '-';
                                        }
                                      })()
                                    )}
                                  </td>"""

new_category_table = """                  {/* Expanded SKU Table */}
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid #f1f5f9' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
                        {isDaili ? (
                          <>
                            <colgroup>
                              <col style={{ width: '28%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '10%' }} />
                              <col style={{ width: '10%' }} />
                            </colgroup>
                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                              <tr>
                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                              </tr>
                            </thead>
                          </>
                        ) : (
                          <>
                            <colgroup>
                              <col style={{ width: '30%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '13%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '12%' }} />
                            </colgroup>
                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                              <tr>
                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                              </tr>
                            </thead>
                          </>
                        )}
                        <tbody>
                          {(() => {
                            const filteredList = groupItems.filter(v => {
                              if (!searchTerm.trim()) return true;
                              const lowerSearch = searchTerm.toLowerCase();
                              return (
                                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                              );
                            });
                            
                            return filteredList.map((v, i) => {
                              const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);
                              const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                              
                              const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                              const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);
          
                              const totalDemand = myacgDemand + wacaDemand + privateDemand;
      
                              const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                              const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);
                              
                              const needToBuy = Math.max(totalDemand - totalPurchased, 0);
                              const excessBuy = Math.max(totalPurchased - totalDemand, 0);

                              return (
                                <tr key={v.id} style={{ borderBottom: i === filteredList.length - 1 ? 'none' : '1px solid #F1F5F9' }}>
                                  <td style={{ padding: '12px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.variant_name}>
                                      <HighlightText text={isDaili ? cleanDailiTitle(parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name) : (parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name)} highlight={searchTerm} />
                                    </div>
                                    <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>
                                      SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                    </div>
                                  </td>
                                  {isDaili ? (
                                    <>
                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#64748b' }}>
                                        NT$ {inventoryMap.get(v.myacg_item_code)?.final_price ?? '-'}
                                      </td>
                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                        {editMode ? (
                                          <input
                                            type="number"
                                            min="0"
                                            placeholder="-"
                                            style={{
                                              width: '80px',
                                              height: '28px',
                                              textAlign: 'right',
                                              border: '1px solid #cbd5e1',
                                              borderRadius: '4px',
                                              fontSize: '14px',
                                              fontWeight: 600,
                                              color: '#1E293B',
                                              backgroundColor: '#ffffff',
                                              padding: '0 8px',
                                              margin: '0 0 0 auto',
                                              display: 'block'
                                            }}
                                            value={variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : ''}
                                            onChange={e => handleUpdateDefaultTwdCost(v.id, e.target.value)}
                                          />
                                        ) : (
                                          (() => {
                                            const defCost = variantDefaultTwdCosts[v.id];
                                            if (defCost !== undefined && defCost !== null) {
                                              return `NT$ ${defCost}`;
                                            }
                                            const latCost = getLatestBatchCost(v.id);
                                            if (latCost !== null) {
                                              return `NT$ ${latCost}`;
                                            }
                                            return '-';
                                          })()
                                        )}
                                      </td>
                                    </>
                                  ) : (
                                    <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                      {editMode ? (
                                        <input
                                          type="number"
                                          min="0"
                                          placeholder="-"
                                          style={{
                                            width: '80px',
                                            height: '28px',
                                            textAlign: 'right',
                                            border: '1px solid #cbd5e1',
                                            borderRadius: '4px',
                                            fontSize: '14px',
                                            fontWeight: 600,
                                            color: '#1E293B',
                                            backgroundColor: '#ffffff',
                                            padding: '0 8px',
                                            margin: '0 0 0 auto',
                                            display: 'block'
                                          }}
                                          value={variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : ''}
                                          onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}
                                        />
                                      ) : (
                                        (() => {
                                          const defCost = variantDefaultJpyCosts[v.id];
                                          if (defCost !== undefined && defCost !== null) {
                                            return `¥ ${defCost}`;
                                          }
                                          const latCost = getLatestBatchCost(v.id);
                                          if (latCost !== null) {
                                            return `¥ ${latCost}`;
                                          }
                                          return '-';
                                        })()
                                      )}
                                    </td>
                                  )}"""

log_replace("Update category items worksheet table rendering", old_category_table, new_category_table)


# 6. Update openBatchModal initialCost logic
old_batch_initial = """    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
    setBatchLines(variants.map(v => {
      let initialCost = 0;
      if (isDaili) {
        initialCost = variantDefaultTwdCosts[v.id] || 0;
      } else {
        const defCost = variantDefaultJpyCosts[v.id];
        const latCost = getLatestJpyCost(v.id);
        initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);
      }
      return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };
    }));"""

new_batch_initial = """    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
    setBatchLines(variants.map(v => {
      let initialCost = 0;
      if (isDaili) {
        initialCost = variantDefaultTwdCosts[v.id] || getLatestBatchCost(v.id) || 0;
      } else {
        const defCost = variantDefaultJpyCosts[v.id];
        const latCost = getLatestBatchCost(v.id);
        initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);
      }
      return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };
    }));"""

log_replace("Update initialCost logic in openBatchModal", old_batch_initial, new_batch_initial)


# 7. Update Batch Modal table rendering (columns layout, headers, fallbacks, and content)
old_modal_table = """              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>
                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>
                    <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '100px' }}>{isDaili ? '實支單價(台幣)' : '實支單價(日幣)'}</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const rows: React.ReactNode[] = [];
                    let hasAnyVisible = false;
                    
                    variants.forEach((v, idx) => {
                      const shortage = getVariantShortageForModal(v);
                      const isHidden = onlyShowShortage && shortage <= 0;
                      if (isHidden) return;
                      
                      hasAnyVisible = true;
                      rows.push(
                        <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '8px' }}>
                              <span>{formatVariantOption(v)}</span>
                              {shortage > 0 && (
                                <span style={{
                                  backgroundColor: '#FEE2E2',
                                  color: '#DC2626',
                                  border: '1px solid #fecaca',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                  fontWeight: 600,
                                  whiteSpace: 'nowrap'
                                }}>
                                  缺 {shortage}
                                </span>
                              )}
                              {shortage < 0 && (
                                <span style={{
                                  backgroundColor: '#EFF6FF',
                                  color: '#2563EB',
                                  border: '1px solid #bfdbfe',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                  fontWeight: 600,
                                  whiteSpace: 'nowrap'
                                }}>
                                  多買 {Math.abs(shortage)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '8px', textAlign: 'center' }}>
                            <input className="input" type="number" min="0" value={batchLines[idx]?.quantity || ''} onChange={e => updateBatchLine(idx, 'quantity', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>
                            <input className="input" type="number" min="0" value={batchLines[idx]?.cost || ''} onChange={e => updateBatchLine(idx, 'cost', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                          </td>
                        </tr>
                      );
                    });"""

new_modal_table = """              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>
                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>缺口</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>
                    <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '100px' }}>{isDaili ? '成本（台幣）' : '實支單價（日幣）'}</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const rows: React.ReactNode[] = [];
                    let hasAnyVisible = false;
                    
                    variants.forEach((v, idx) => {
                      const shortage = getVariantShortageForModal(v);
                      const isHidden = onlyShowShortage && shortage <= 0;
                      if (isHidden) return;
                      
                      hasAnyVisible = true;
                      rows.push(
                        <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <div style={{ fontWeight: 600, color: '#1e293b' }}>
                                {isDaili ? getDailiVariantModalName(v) : formatVariantOption(v)}
                              </div>
                              <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                                SKU: {v.myacg_item_code}
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '8px', textAlign: 'center' }}>
                            {shortage > 0 && (
                              <span style={{
                                backgroundColor: '#FEE2E2',
                                color: '#DC2626',
                                border: '1px solid #fecaca',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                whiteSpace: 'nowrap'
                              }}>
                                缺 {shortage}
                              </span>
                            )}
                            {shortage < 0 && (
                              <span style={{
                                backgroundColor: '#EFF6FF',
                                color: '#2563EB',
                                border: '1px solid #bfdbfe',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                whiteSpace: 'nowrap'
                              }}>
                                多買 {Math.abs(shortage)}
                              </span>
                            )}
                            {shortage === 0 && (
                              <span style={{ color: '#94a3b8', fontSize: '12px' }}>-</span>
                            )}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'center' }}>
                            <input className="input" type="number" min="0" value={batchLines[idx]?.quantity || ''} onChange={e => updateBatchLine(idx, 'quantity', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>
                            <input className="input" type="number" min="0" value={batchLines[idx]?.cost || ''} onChange={e => updateBatchLine(idx, 'cost', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} />
                          </td>
                        </tr>
                      );
                    });"""

log_replace("Update batch modal table layout & content", old_modal_table, old_modal_table.replace("isDaili ? '實支單價(台幣)' : '實支單價(日幣)'", "isDaili ? '成本（台幣）' : '實支單價（日幣）'"))
# Wait, let's just do a direct replacement for the entire old_modal_table with new_modal_table:
log_replace("Replace batch modal table rendering completely", old_modal_table, new_modal_table)


# Restore original line endings
content = content.replace("\n", original_line_endings)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Replacement complete.")
