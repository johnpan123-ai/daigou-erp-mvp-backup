import re

with open("src/pages/PurchaseManagement.tsx", "r", encoding="utf-8") as f:
    code = f.read()

# 1. Update Table Header
old_thead = """<thead style={{ backgroundColor: '#fafafa', color: '#64748b' }}>
                          <tr>
                            <th style={{ padding: '10px 20px', textAlign: 'left', fontWeight: 500, width: '250px' }}>商品名稱</th>
                            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 500 }}>單價</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>還缺</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>多買</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '80px' }}>買動漫</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '80px' }}>WACA</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>私下登記</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>已採購</th>
                          </tr>
                        </thead>"""

new_thead = """<colgroup>
                          <col style={{ width: '30%' }} />
                          <col style={{ width: '12%' }} />
                          <col style={{ width: '12%' }} />
                          <col style={{ width: '12%' }} />
                          <col style={{ width: '12%' }} />
                          <col style={{ width: '12%' }} />
                          <col style={{ width: '10%' }} />
                        </colgroup>
                        <thead style={{ backgroundColor: '#fafafa', color: '#64748b', borderBottom: '1px solid #e2e8f0' }}>
                          <tr>
                            <th style={{ padding: '8px 16px', textAlign: 'left', fontWeight: 600 }}>商品名稱 / SKU</th>
                            <th style={{ padding: '8px 16px', textAlign: 'center', fontWeight: 600 }}>單價</th>
                            <th style={{ padding: '8px 16px', textAlign: 'center', fontWeight: 600 }}>狀態</th>
                            <th style={{ padding: '8px 16px', textAlign: 'center', fontWeight: 600 }}>買動漫</th>
                            <th style={{ padding: '8px 16px', textAlign: 'center', fontWeight: 600 }}>WACA</th>
                            <th style={{ padding: '8px 16px', textAlign: 'center', fontWeight: 600 }}>私下登記</th>
                            <th style={{ padding: '8px 16px', textAlign: 'center', fontWeight: 600 }}>已採購</th>
                          </tr>
                        </thead>"""

code = code.replace(old_thead, new_thead)

# 2. Update Table Row
old_tr = """<tr key={v.id} style={{ borderBottom: i === groupItems.length - 1 ? 'none' : '1px solid #f1f5f9' }}>
                                <td style={{ padding: '12px 20px', textAlign: 'left' }}>
                                  <div style={{ fontWeight: 500, color: '#334155' }}>
                                    <HighlightText text={v.variant_name} highlight={searchTerm} />
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                                    SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                  </div>
                                </td>
                                <td style={{ padding: '12px', textAlign: 'right', color: '#475569' }}>¥ {price}</td>
                                
                                <td style={{ padding: '12px', textAlign: 'center', fontWeight: needToBuy > 0 ? 600 : 400, color: needToBuy > 0 ? '#ef4444' : '#cbd5e1' }}>
                                  {needToBuy > 0 ? needToBuy : '-'}
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center', fontWeight: excessBuy > 0 ? 600 : 400, color: excessBuy > 0 ? '#f97316' : '#cbd5e1' }}>
                                  {excessBuy > 0 ? excessBuy : '-'}
                                </td>

                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <input 
                                    type="number" 
                                    style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                    value={myacgDemand || ''}
                                    placeholder="0"
                                    onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                                  />
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <input 
                                    type="number" 
                                    style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                    value={wacaDemand || ''}
                                    placeholder="0"
                                    onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                                  />
                                </td>
                                
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                                    {privateDemand > 0 ? privateDemand : '-'}
                                  </span>
                                </td>

                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>
                                    {totalPurchased > 0 ? totalPurchased : '-'}
                                  </span>
                                </td>
                              </tr>"""

new_tr = """<tr key={v.id} style={{ borderBottom: i === groupItems.length - 1 ? 'none' : '1px solid #f1f5f9', height: '44px' }}>
                                <td style={{ padding: '6px 16px', textAlign: 'left' }}>
                                  <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '15px' }}>
                                    <HighlightText text={title.startswith('__single__') ? (v.variant_name || title.replace('__single__', '')) : v.variant_name} highlight={searchTerm} />
                                  </div>
                                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                                    SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                  </div>
                                </td>
                                <td style={{ padding: '6px 16px', textAlign: 'center', color: '#475569', fontSize: '14px', fontWeight: 600 }}>¥ {price}</td>
                                
                                <td style={{ padding: '6px 16px', textAlign: 'center' }}>
                                  {needToBuy > 0 ? (
                                    <span style={{ backgroundColor: '#fef2f2', color: '#ef4444', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>待採購 {needToBuy}</span>
                                  ) : excessBuy > 0 ? (
                                    <span style={{ backgroundColor: '#ffedd5', color: '#f97316', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>多買 {excessBuy}</span>
                                  ) : totalDemand > 0 ? (
                                    <span style={{ backgroundColor: '#f0fdf4', color: '#22c55e', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>已完成</span>
                                  ) : (
                                    <span style={{ backgroundColor: '#f1f5f9', color: '#94a3b8', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>無需求</span>
                                  )}
                                </td>

                                <td style={{ padding: '6px 16px', textAlign: 'center' }}>
                                  <input 
                                    type="number" 
                                    style={{ width: '60px', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '14px', fontWeight: 600, color: '#0f172a', margin: '0 auto', display: 'block' }} 
                                    value={myacgDemand || ''}
                                    placeholder="0"
                                    onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                                  />
                                </td>
                                <td style={{ padding: '6px 16px', textAlign: 'center' }}>
                                  <input 
                                    type="number" 
                                    style={{ width: '60px', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '14px', fontWeight: 600, color: '#0f172a', margin: '0 auto', display: 'block' }} 
                                    value={wacaDemand || ''}
                                    placeholder="0"
                                    onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                                  />
                                </td>
                                
                                <td style={{ padding: '6px 16px', textAlign: 'center' }}>
                                  <span style={{ fontWeight: 600, color: '#0f172a', fontSize: '14px' }}>
                                    {privateDemand}
                                  </span>
                                </td>

                                <td style={{ padding: '6px 16px', textAlign: 'center' }}>
                                  <span style={{ fontWeight: 600, color: '#0f172a', fontSize: '14px' }}>
                                    {totalPurchased}
                                  </span>
                                </td>
                              </tr>"""
code = code.replace(old_tr, new_tr)

# 3. Remove Single Item custom block so it uses the table
start_single = code.find("// SINGLE ITEM RENDERING")
end_single = code.find("// CATEGORY CARD RENDERING")
if start_single != -1 and end_single != -1:
    code = code[:start_single] + code[end_single:]

# 4. Hide Category Header if it's a single item, and auto-expand
code = code.replace("const isExpanded = isSearchMatched ? true : manualExpandedGroups.has(title);", 
                    "const isSingle = groupItems.length === 1 || title.startsWith('__single__');\n              const isExpanded = isSingle || (isSearchMatched ? true : manualExpandedGroups.has(title));")

old_cat_header = """{/* Category Header Row */}
                  <div 
                    style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                    onClick={() => toggleManualGroup(title)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>
                        <HighlightText text={title} highlight={searchTerm} />
                      </div>
                      <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                        共 {groupItems.length} 款
                      </span>
                      {pNeed > 0 && <span style={{ color: '#ef4444', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>總缺貨 {pNeed} 件</span>}
                      {pNeed === 0 && pExcess > 0 && <span style={{ color: '#f97316', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>多買 {pExcess} 件</span>}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px', color: '#64748b' }}>
                      <span>總需求 {pDemand}</span>
                      <span>已採購 {pPurchased}</span>
                      <span>還缺 {pNeed}</span>
                      <span>多買 {pExcess}</span>
                      <span>私下 {pManual}</span>
                      <div style={{ color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                        {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                      </div>
                    </div>
                  </div>"""

new_cat_header = """{/* Category Header Row */}
                  {!isSingle && (
                    <div 
                      style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                      onClick={() => toggleManualGroup(title)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ fontWeight: 700, color: '#1e293b', fontSize: '16px' }}>
                          <HighlightText text={title} highlight={searchTerm} />
                        </div>
                        <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                          共 {groupItems.length} 款
                        </span>
                        {pNeed > 0 && <span style={{ color: '#ef4444', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>總缺貨 {pNeed} 件</span>}
                        {pNeed === 0 && pExcess > 0 && <span style={{ color: '#f97316', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>多買 {pExcess} 件</span>}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px', color: '#64748b' }}>
                        <span>總需求 {pDemand}</span>
                        <span>已採購 {pPurchased}</span>
                        <span>還缺 {pNeed}</span>
                        <span>多買 {pExcess}</span>
                        <span>私下 {pManual}</span>
                        <div style={{ color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                          {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                        </div>
                      </div>
                    </div>
                  )}"""

code = code.replace(old_cat_header, new_cat_header)

with open("src/pages/PurchaseManagement.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("Done")
