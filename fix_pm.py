import re

with open("src/pages/PurchaseManagement.tsx", "r", encoding="utf-8") as f:
    code = f.read()

# 1. Add ShoppingCart, Info imports
if "ShoppingCart," not in code:
    code = code.replace("import {", "import { ShoppingCart, Info,", 1)

# 2. Add RenderShoppingList before PurchaseManagement
render_shopping_list = """
const RenderShoppingList = ({ sortedGroupEntries, privateOrderItems, purchaseBatchItems, searchTerm, expandedGroups, toggleGroup }: any) => {
  let kinds = 0;
  let totalMissing = 0;
  
  const groups = sortedGroupEntries.map(([title, fullGroupItems]: any) => {
     const missingItems = fullGroupItems.map((v: any) => {
        const mDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
        const wDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
        const pDemand = privateOrderItems.filter((poi: any) => poi.product_variant_id === v.id).reduce((s: any, i: any) => s + i.quantity, 0) + (v.private_manual_adjustment || 0);
        const tDemand = mDemand + wDemand + pDemand;
        const tPurchased = purchaseBatchItems.filter((pbi: any) => pbi.product_variant_id === v.id).reduce((s: any, i: any) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0);
        return {
           id: v.id,
           name: v.variant_name,
           missing: tDemand - tPurchased
        };
     }).filter((item: any) => item.missing > 0);

     if (missingItems.length === 0) return null;

     const groupMissing = missingItems.reduce((s: any, i: any) => s + i.missing, 0);
     
     if (searchTerm) {
       const lowerSearch = searchTerm.toLowerCase();
       const groupMatch = title.toLowerCase().includes(lowerSearch);
       const hasMatch = missingItems.some((v: any) => v.name && v.name.toLowerCase().includes(lowerSearch));
       if (!groupMatch && !hasMatch) return null;
     }

     kinds += 1;
     totalMissing += groupMissing;
     
     return {
        title: title.startsWith('__single__') ? (missingItems[0].name || title) : title,
        items: missingItems,
        missing: groupMissing,
        isSingle: title.startsWith('__single__') || fullGroupItems.length === 1
     };
  }).filter(Boolean);

  groups.sort((a: any, b: any) => b['missing'] - a['missing']);

  if (groups.length === 0) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>無缺貨商品</div>;
  }

  return (
    <div style={{ backgroundColor: '#fff', borderRadius: '12px', border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e2e8f0' }}>
        <div style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>缺貨採購清單</div>
        <div style={{ fontSize: '14px', color: '#64748b' }}>
           共 {kinds} 種商品 <span style={{ color: '#ef4444', fontWeight: 700, marginLeft: '12px', fontSize: '16px' }}>待採購 {totalMissing}</span>
        </div>
      </div>

      {/* Body */}
      <div>
         {groups.map((g: any, i: number) => (
           <div key={i} style={{ padding: '20px', borderBottom: i < groups.length - 1 ? '1px solid #e2e8f0' : 'none' }}>
             <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
               <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                 <ShoppingCart size={20} color="#ef4444" />
                 {g['title'].replace('__single__', '')}
               </div>
               <div style={{ color: '#ef4444', fontWeight: 700, fontSize: '16px' }}>
                 待採購 {g['missing']}
               </div>
             </div>
             {!g['isSingle'] && g['items'].length > 0 && (
               <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px', paddingLeft: '32px' }}>
                 {g['items'].map((item: any) => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: '#334155' }}>
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#94a3b8' }}></div>
                      <span style={{ fontWeight: 500 }}>{item.name}</span>
                      <span style={{ color: '#0f172a', fontWeight: 600 }}>× {item.missing}</span>
                    </div>
                 ))}
               </div>
             )}
           </div>
         ))}
      </div>

      {/* Footer */}
      <div style={{ padding: '16px 20px', backgroundColor: '#f8fafc', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <Info size={18} color="#64748b" style={{ flexShrink: 0, marginTop: '2px' }} />
        <div style={{ fontSize: '14px', color: '#475569', lineHeight: 1.6 }}>
          此為缺貨採購模式，僅顯示待採購的商品與數量。<br/>出發採購前請再次確認清單。
        </div>
      </div>
    </div>
  );
};
"""

comp_start = code.find("export default function PurchaseManagement")
if "const RenderShoppingList =" not in code:
    code = code[:comp_start] + render_shopping_list + "\n\n" + code[comp_start:]

# 3. Replace the table area with Grid
table_start = code.find("{/* Expanded SKU Table */}")
if table_start != -1:
    end_div_after_table = code.find("</div>\n                </div>\n              );", table_start)
    if end_div_after_table != -1:
        new_grid = """{/* Expanded SKU Table */}
                  {isExpanded && (
                    <div style={{ borderTop: isSingle ? 'none' : '1px solid #f1f5f9' }}>
                      {!isSingle && (
                        <div style={{ display: 'grid', gridTemplateColumns: '30% 12% 12% 12% 12% 12% 10%', alignItems: 'center', padding: '8px 16px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '12px', fontWeight: 600, borderBottom: '1px solid #e2e8f0', minHeight: '36px' }}>
                          <div style={{ paddingRight: '8px' }}>商品名稱 / SKU</div>
                          <div style={{ textAlign: 'center' }}>單價</div>
                          <div style={{ textAlign: 'center' }}>狀態</div>
                          <div style={{ textAlign: 'center' }}>買動漫</div>
                          <div style={{ textAlign: 'center' }}>WACA</div>
                          <div style={{ textAlign: 'center' }}>私下登記</div>
                          <div style={{ textAlign: 'center' }}>已採購</div>
                        </div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {groupItems.map((v: any, i: number) => {
                          const inv = inventoryMap.get(v.myacg_item_code);
                          const price = inv ? inv.final_price : 0;
                          
                          const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                          const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                          
                          const vPrivateItems = privateOrderItems.filter((poi: any) => poi.product_variant_id === v.id);
                          const privateDemand = vPrivateItems.reduce((sum: number, item: any) => sum + item.quantity, 0) + (v.private_manual_adjustment || 0);
                          
                          const totalDemand = myacgDemand + wacaDemand + privateDemand;
                          
                          const vBatchItems = purchaseBatchItems.filter((pbi: any) => pbi.product_variant_id === v.id);
                          const totalPurchased = vBatchItems.reduce((sum: number, item: any) => sum + item.quantity, 0) + (v.purchased_manual_adjustment || 0);
                          
                          const diff = totalPurchased - totalDemand;
                          
                          return (
                            <div key={v.id} style={{ display: 'grid', gridTemplateColumns: '30% 12% 12% 12% 12% 12% 10%', alignItems: 'center', padding: '8px 16px', borderBottom: i === groupItems.length - 1 ? 'none' : '1px solid #f1f5f9', minHeight: '40px' }}>
                              <div style={{ paddingRight: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                <div style={{ fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
                                  <HighlightText text={isSingle ? title.replace('__single__', '') : v.variant_name} highlight={searchTerm} />
                                </div>
                                <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                                  SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                </div>
                              </div>
                              <div style={{ textAlign: 'center', fontSize: '13px', color: '#475569' }}>¥ {price}</div>
                              <div style={{ textAlign: 'center' }}>
                                {diff < 0 ? (
                                  <span style={{ backgroundColor: '#fef2f2', color: '#ef4444', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>待採購 {Math.abs(diff)}</span>
                                ) : diff > 0 ? (
                                  <span style={{ backgroundColor: '#ffedd5', color: '#f97316', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>多買 {diff}</span>
                                ) : totalDemand > 0 ? (
                                  <span style={{ backgroundColor: '#f0fdf4', color: '#22c55e', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>已完成</span>
                                ) : (
                                  <span style={{ color: '#cbd5e1', fontSize: '13px', fontWeight: 600 }}>-</span>
                                )}
                              </div>
                              <div style={{ textAlign: 'center', fontSize: '14px', fontWeight: 600, color: '#0f172a' }}>{myacgDemand}</div>
                              <div style={{ textAlign: 'center', fontSize: '14px', fontWeight: 600, color: '#0f172a' }}>{wacaDemand}</div>
                              <div style={{ textAlign: 'center', fontSize: '14px', fontWeight: 600, color: '#0f172a' }}>{privateDemand}</div>
                              <div style={{ textAlign: 'center', fontSize: '14px', fontWeight: 600, color: '#2563eb' }}>{totalPurchased}</div>
                            </div>
                          );
                        })}
                      </div>"""
        code = code[:table_start] + new_grid + code[end_div_after_table:]

# 4. Extract viewMode logic to support Shortage mode
code = code.replace("{/* Card List Area */}\n        {activeTab === 'worksheet' && (", """{/* Card List Area */}
        {activeTab === 'worksheet' && filterMode === 'all' && (""")

code = code.replace("{/* Render Purchase Batch Tab */}", """
        {/* Shopping List Area (Shortage Mode) */}
        {activeTab === 'worksheet' && filterMode === 'shortage' && (
          <div style={{ paddingBottom: '40px' }}>
            <RenderShoppingList 
               sortedGroupEntries={sortedGroupEntries} 
               privateOrderItems={privateOrderItems} 
               purchaseBatchItems={purchaseBatchItems} 
               searchTerm={searchTerm} 
               expandedGroups={expandedGroups} 
               toggleGroup={toggleManualGroup} 
            />
          </div>
        )}

        {/* Render Purchase Batch Tab */}""")

with open("src/pages/PurchaseManagement.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("Done")
