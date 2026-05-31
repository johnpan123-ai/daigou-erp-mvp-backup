const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const filePath = path.join(__dirname, '../src/pages/PurchaseManagement.tsx');

// Reset file to HEAD state first
try {
  execSync('git checkout HEAD -- src/pages/PurchaseManagement.tsx', { cwd: path.join(__dirname, '..') });
  console.log("Successfully reverted PurchaseManagement.tsx to HEAD.");
} catch (e) {
  console.error("Revert failed:", e);
}

if (!fs.existsSync(filePath)) {
  console.error("Error: PurchaseManagement.tsx not found");
  process.exit(1);
}

let content = fs.readFileSync(filePath, 'utf-8');
const originalLineEndings = content.includes('\r\n') ? '\r\n' : '\n';
content = content.split('\r\n').join('\n');

function replaceSlice(desc, startText, endText, newContent, occurrence = 1) {
  let startIdx = -1;
  let currentPos = 0;
  for (let i = 0; i < occurrence; i++) {
    startIdx = content.indexOf(startText, currentPos);
    if (startIdx === -1) {
      console.error("ERROR: Could not find start text for: " + desc + " (occurrence " + (i+1) + ")");
      console.error("Searched: " + startText);
      return false;
    }
    currentPos = startIdx + startText.length;
  }

  const endIdx = content.indexOf(endText, startIdx + startText.length);
  if (endIdx === -1) {
    console.error("ERROR: Could not find end text for: " + desc);
    console.error("Searched: " + endText);
    return false;
  }

  content = content.slice(0, startIdx) + newContent + content.slice(endIdx + endText.length);
  console.log("SUCCESS: " + desc);
  return true;
}

// 0. Define getDailiVariantModalName function in component
const formatVariantOptionDef = "  const formatVariantOption = (v: ProductVariant) => {";
const getDailiVariantModalNameImpl = 
`  const getDailiVariantModalName = (v: ProductVariant) => {
    let name = (v.variant_name || '').trim();
    if (!name || name === '單品' || name === '一箱') {
      name = cleanDailiTitle(group?.normalized_title || group?.title || '');
    }
    if (!name) {
      name = v.myacg_item_code || '';
    }
    return name;
  };

  const formatVariantOption = (v: ProductVariant) => {`;

if (content.includes(formatVariantOptionDef)) {
  content = content.replace(formatVariantOptionDef, getDailiVariantModalNameImpl);
  console.log("SUCCESS: Define getDailiVariantModalName");
} else {
  console.error("ERROR: Could not find formatVariantOption definition");
}

// 1. KPI Calculations Block
const startKpi = "  // KPI Calculations";
const endKpi = "  const estimatedTwd = jpyTotalDemand * exchangeRate;";
const newKpiCalc = 
`  // KPI Calculations
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
  const dailiEstimatedProfit = dailiTotalOrdersAmount - jpyTotalDemand;`;

replaceSlice("KPI Calculations Block", startKpi, endKpi, newKpiCalc);

// 2. Card 4 (訂單總金額)
const startCard4 = "{/* Total Amount (Orders NTD) */}";
const endCard4 = "訂單商品總額</div>\n            </div>";
const newCard4 = 
`{/* Total Amount (Orders NTD) */}
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
            </div>`;

replaceSlice("Card 4 (訂單總金額)", startCard4, endCard4, newCard4);

// 3. Card 5, 6, 7, 8 conditional block replacement
const startCards = "{/* 1. 待採購日幣 */}";
const endCards = "總需求日幣 × 匯率 {exchangeRate}</div>\n            </div>";
const newCards = 
`{/* 1. 待採購日幣/成本 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '待採購成本' : '待採購日幣'}</div>
                <DollarSign size={20} color="#ef4444" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#ef4444' }}>{isDaili ? "NT$ " + jpyNeedToBuy.toLocaleString() : "¥ " + jpyNeedToBuy.toLocaleString()}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '目前還要花多少台幣成本' : '目前還要花多少日幣'}</div>
            </div>

            {/* 2. 已採購日幣/成本 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '已採購成本' : '已採購日幣'}</div>
                <CheckSquare size={20} color="#2563eb" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#2563eb' }}>{isDaili ? "NT$ " + jpyPurchased.toLocaleString() : "¥ " + jpyPurchased.toLocaleString()}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '目前已花掉多少台幣成本' : '目前已花掉多少日幣'}</div>
            </div>

            {/* 3. 總需求日幣/總成本 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '總成本' : '總需求日幣'}</div>
                <Package size={20} color="#16a34a" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a' }}>{isDaili ? "NT$ " + jpyTotalDemand.toLocaleString() : "¥ " + jpyTotalDemand.toLocaleString()}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '待採購成本 + 已採購成本' : '整批商品總成本(日幣)'}</div>
            </div>

            {/* 4. 預估台幣/預估毛利 */}
            <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '預估毛利' : '預估台幣'}</div>
                <DollarSign size={20} color="#ca8a04" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                <span style={{ fontSize: '28px', fontWeight: 700, color: '#ca8a04' }}>
                  {isDaili ? "NT$ " + dailiEstimatedProfit.toLocaleString() : "NTD " + Math.round(estimatedTwd).toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '訂單總金額 - 總成本' : "總需求日幣 × 匯率 " + exchangeRate}</div>
            </div>`;

replaceSlice("Cards 5, 6, 7, 8 conditional block", startCards, endCards, newCards);

// 5. Single Item Table Rendering Block (first table in file)
const tableStartText = "<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>";
const tableEndText = "</table>";

const newSingleTableHtml = 
`<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
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
                                      return "NT$ " + defCost;
                                    }
                                    const latCost = getLatestJpyCost(v.id);
                                    if (latCost !== null) {
                                      return "NT$ " + latCost;
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
                                    return "¥ " + defCost;
                                  }
                                  const latCost = getLatestJpyCost(v.id);
                                  if (latCost !== null) {
                                    return "¥ " + latCost;
                                  }
                                  return '-';
                                })()
                              )}
                            </td>
                          )}
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            {renderStatusBadge(pNeed, pExcess, pDemand)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <input 
                              type="number" 
                              style={{ 
                                width: '64px', 
                                height: '28px', 
                                textAlign: 'center', 
                                border: '1px solid #cbd5e1', 
                                borderRadius: '4px', 
                                fontSize: '14px', 
                                fontWeight: 600, 
                                color: editMode ? '#1E293B' : '#64748b', 
                                backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                cursor: editMode ? 'text' : 'not-allowed',
                                margin: '0 auto', 
                                display: 'block' 
                              }} 
                              value={pMyacg || ''}
                              placeholder="0"
                              onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                              disabled={!editMode}
                            />
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <input 
                              type="number" 
                              style={{ 
                                width: '64px', 
                                height: '28px', 
                                textAlign: 'center', 
                                border: '1px solid #cbd5e1', 
                                borderRadius: '4px', 
                                fontSize: '14px', 
                                fontWeight: 600, 
                                color: editMode ? '#1E293B' : '#64748b', 
                                backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                cursor: editMode ? 'text' : 'not-allowed',
                                margin: '0 auto', 
                                display: 'block' 
                              }} 
                              value={pWaca || ''}
                              placeholder="0"
                              onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                              disabled={!editMode}
                            />
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: pManual > 0 ? '#1E293B' : '#94a3b8', backgroundColor: pManual > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                              {pManual > 0 ? pManual : '-'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: pPurchased > 0 ? '#1E293B' : '#94a3b8' }}>
                              {pPurchased > 0 ? pPurchased : '-'}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>`;

replaceSlice("Single Item Table Rendering Block", tableStartText, tableEndText, newSingleTableHtml, 1);

// 6. Category Items Table Rendering Block (second table in file)
const newCategoryTableHtml = 
`<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
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
                            </</colgroup>
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
                                              return "NT$ " + defCost;
                                            }
                                            const latCost = getLatestJpyCost(v.id);
                                            if (latCost !== null) {
                                              return "NT$ " + latCost;
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
                                            return "¥ " + defCost;
                                          }
                                          const latCost = getLatestJpyCost(v.id);
                                          if (latCost !== null) {
                                            return "¥ " + latCost;
                                          }
                                          return '-';
                                        })()
                                      )}
                                    </td>
                                  )}
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    {renderStatusBadge(needToBuy, excessBuy, totalDemand)}
                                  </td>
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <input 
                                      type="number" 
                                      style={{ 
                                        width: '64px', 
                                        height: '28px', 
                                        textAlign: 'center', 
                                        border: '1px solid #cbd5e1', 
                                        borderRadius: '4px', 
                                        fontSize: '14px', 
                                        fontWeight: 600, 
                                        color: editMode ? '#1E293B' : '#64748b', 
                                        backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                        cursor: editMode ? 'text' : 'not-allowed',
                                        margin: '0 auto', 
                                        display: 'block' 
                                      }} 
                                      value={myacgDemand || ''}
                                      placeholder="0"
                                      onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                                      disabled={!editMode}
                                    />
                                  </td>
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <input 
                                      type="number" 
                                      style={{ 
                                        width: '64px', 
                                        height: '28px', 
                                        textAlign: 'center', 
                                        border: '1px solid #cbd5e1', 
                                        borderRadius: '4px', 
                                        fontSize: '14px', 
                                        fontWeight: 600, 
                                        color: editMode ? '#1E293B' : '#64748b', 
                                        backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                        cursor: editMode ? 'text' : 'not-allowed',
                                        margin: '0 auto', 
                                        display: 'block' 
                                      }} 
                                      value={wacaDemand || ''}
                                      placeholder="0"
                                      onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                                      disabled={!editMode}
                                    />
                                  </td>
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: privateDemand > 0 ? '#1E293B' : '#94a3b8', backgroundColor: privateDemand > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                                      {privateDemand > 0 ? privateDemand : '-'}
                                    </span>
                                  </td>
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: totalPurchased > 0 ? '#1E293B' : '#94a3b8' }}>
                                      {totalPurchased > 0 ? totalPurchased : '-'}
                                    </span>
                                  </td>
                                </tr>
                              );
                            });
                          })()}
                        </tbody>
                      </table>`;

replaceSlice("Category Items Table Rendering Block", tableStartText, tableEndText, newCategoryTableHtml, 2);

// 7. Update openBatchModal initialCost logic
const startBatchInitial = "    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });";
const endBatchInitial = "    }));";
const newBatchInitial = 
`    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
    setBatchLines(variants.map(v => {
      let initialCost = 0;
      if (isDaili) {
        initialCost = variantDefaultTwdCosts[v.id] || getLatestJpyCost(v.id) || 0;
      } else {
        const defCost = variantDefaultJpyCosts[v.id];
        const latCost = getLatestJpyCost(v.id);
        initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);
      }
      return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };
    }));`;

replaceSlice("Update initialCost logic in openBatchModal", startBatchInitial, endBatchInitial, newBatchInitial);

// 8. Update Batch Modal table rendering (columns layout, headers, fallbacks, and content)
const startModalTable = "<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>";
const endModalTable = "</table>";

const newModalTable = 
`<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>
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
                    const rows = [];
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
                    });`;

replaceSlice("Replace batch modal table rendering completely", startModalTable, endModalTable, newModalTable, 2); // 2nd table with marginBottom: '24px' in the file

// Globally rename remaining getLatestJpyCost references to getLatestBatchCost
content = content.split('getLatestJpyCost').join('getLatestBatchCost');

// Restore line endings
content = content.split('\n').join(originalLineEndings);

fs.writeFileSync(filePath, content, 'utf-8');
console.log("Replacement complete.");
