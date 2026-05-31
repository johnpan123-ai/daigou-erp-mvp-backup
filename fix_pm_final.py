import re

with open("src/pages/PurchaseManagement.tsx", "r", encoding="utf-8") as f:
    code = f.read()

# First, fix standardizations
code = code.replace("待處理", "待採購")
code = code.replace(">完成<", ">已完成<")

# Extract the big block between {/* Card List Area */} and {/* Render Purchase Batch Tab */}
start_marker = "{/* Card List Area (Standard Mode) */}"
if start_marker not in code:
    start_marker = "{/* Card List Area */}"
    
end_marker = "{/* Render Purchase Batch Tab */}"

start_idx = code.find(start_marker)
end_idx = code.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print("Markers not found")
    exit(1)

comp_start = code.find("export default function PurchaseManagement")
if comp_start == -1:
    print("Component not found")
    exit(1)

render_shopping_list = """
const RenderShoppingList = ({ sortedGroupEntries, privateOrderItems, purchaseBatchItems, searchTerm, toggleGroup, expandedGroups }: any) => {
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
       const lowerSearch = searchTerm.lower();
       const groupMatch = title.toLowerCase().includes(lowerSearch);
       const hasMatch = missingItems.some((v: any) => v.name && v.name.toLowerCase().includes(lowerSearch));
       if (!groupMatch && !hasMatch) return null;
     }

     kinds += 1;
     totalMissing += groupMissing;
     
     return {
        title: title.startswith('__single__') ? (missingItems[0].name || title) : title,
        items: missingItems,
        missing: groupMissing,
        isSingle: title.startswith('__single__') || fullGroupItems.length === 1
     };
  }).filter(bool);

  groups.sort((a: any, b: any) => b['missing'] - a['missing']);

  if (groups.length === 0) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>無缺貨商品</div>;
  }

  return (
    <div style={{ backgroundColor: '#fff', borderRadius: '12px', border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e2e8f0' }}>
        <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}>缺貨採購清單</div>
        <div style={{ fontSize: '14px', color: '#64748b' }}>
           共 {kinds} 種商品 <span style={{ color: '#ef4444', fontWeight: 700, marginLeft: '12px', fontSize: '16px' }}>待採購 {totalMissing}</span>
        </div>
      </div>

      {/* Body */}
      <div>
         {groups.map((g: any, i: number) => (
           <div key={i} style={{ padding: '24px', borderBottom: i < groups.length - 1 ? '1px solid #e2e8f0' : 'none' }}>
             <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
               <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                 <ShoppingCart size={22} color="#ef4444" />
                 {g['title'].replace('__single__', '')}
               </div>
               <div style={{ color: '#ef4444', fontWeight: 700, fontSize: '18px' }}>
                 待採購 {g['missing']}
               </div>
             </div>
             {!g['isSingle'] && g['items'].length > 0 && (
               <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '16px', paddingLeft: '34px' }}>
                 {g['items'].map((item: any) => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '16px', color: '#334155' }}>
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
      <div style={{ padding: '16px 24px', backgroundColor: '#f8fafc', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <Info size={20} color="#64748b" style={{ flexShrink: 0, marginTop: '2px' }} />
        <div style={{ fontSize: '14px', color: '#475569', lineHeight: 1.6 }}>
          此為缺貨採購模式，僅顯示待採購的商品與數量。<br/>出發採購前請再次確認清單。
        </div>
      </div>
    </div>
  );
};
"""

if "Info" not in code[:comp_start]:
    code = code.replace("ShoppingCart,", "ShoppingCart, Info,")

if "const RenderShoppingList =" not in code:
    code = code[:comp_start] + render_shopping_list + "\n\n" + code[comp_start:]

new_block = """{/* Card List Area (Standard Mode) */}
        {activeTab === 'worksheet' && viewMode === 'standard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, paddingBottom: '40px' }}>
            {sortedGroupEntries.map(([title, fullGroupItems]) => {
              let groupItems = fullGroupItems;

              if (searchTerm) {
                const lowerSearch = searchTerm.toLowerCase();
                const groupMatch = title.toLowerCase().includes(lowerSearch);
                const hasMatch = groupItems.some(v => 
                  (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                  (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                );

                if (!groupMatch && !hasMatch) {
                  return null;
                }
              }

              const pDemand = groupItems.reduce((sum, v) => sum + (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0) + (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0) + privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0), 0);
              const pPurchased = groupItems.reduce((sum, v) => sum + purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0), 0);
              const pManual = groupItems.reduce((sum, v) => sum + privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0), 0);

              const isSingle = title.startsWith('__single__');
              const group = productGroups.find(g => g.id === groupItems[0].product_group_id) || { title: groupItems[0].variant_name, id: '' };
              const isExpanded = isSingle || expandedGroups[title];

              return (
                <div key={title} style={{ backgroundColor: '#fff', borderRadius: '12px', border: '1px solid #e2e8f0', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  {!isSingle && (
                    <div 
                      style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', backgroundColor: isExpanded ? '#f8fafc' : '#fff', borderBottom: isExpanded ? '1px solid #e2e8f0' : 'none' }}
                      onClick={() => toggleGroup(title)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ fontWeight: 700, color: '#1e293b', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Package size={18} color="#64748b" />
                          <HighlightText text={title} highlight={searchTerm} />
                        </div>
                        <div style={{ fontSize: '12px', color: '#64748b', backgroundColor: '#f1f5f9', padding: '2px 8px', borderRadius: '12px', fontWeight: 500 }}>
                          共 {groupItems.length} 款
                        </div>
                        <RenderStatusBadge demand={pDemand} purchased={pPurchased} />
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px', color: '#64748b' }}>
                        <span>總需求 {pDemand}</span>
                        <span>已採購 {pPurchased}</span>
                        <span>待採購 {Math.max(pDemand - pPurchased, 0)}</span>
                        <span>私下 {pManual}</span>
                        <div style={{ color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                          {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                        </div>
                      </div>
                    </div>
                  )}

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
                        {groupItems.map((v) => (
                          <RenderSkuRow key={v.id} v={v} inv={inventoryMap.get(v.myacg_item_code)} title={title} searchTerm={searchTerm} isSingle={isSingle} isEditMode={isEditMode} editDrafts={editDrafts} handleDraftChange={handleDraftChange} privateOrderItems={privateOrderItems} purchaseBatchItems={purchaseBatchItems} group={group}  viewMode={viewMode} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Shopping List Area (Shortage Mode) */}
        {activeTab === 'worksheet' && viewMode === 'shortage' && (
          <div style={{ paddingBottom: '40px' }}>
            <RenderShoppingList 
               sortedGroupEntries={sortedGroupEntries} 
               privateOrderItems={privateOrderItems} 
               purchaseBatchItems={purchaseBatchItems} 
               searchTerm={searchTerm} 
               toggleGroup={toggleGroup} 
               expandedGroups={expandedGroups} 
            />
          </div>
        )}

        """

code = code[:start_idx] + new_block + code[end_idx:]

# Remove unused viewMode == shortage in RenderSkuRow
code = re.sub(r"\s*//.*?\n\s*//.*?\n\s*if \(viewMode === 'shortage'\) \{.*?\n\s*\}", "", code, flags=re.DOTALL)

with open("src/pages/PurchaseManagement.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("Done")
