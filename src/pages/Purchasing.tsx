import { useState, useEffect, useMemo } from 'react';
import { dataProvider } from '../providers/dataProvider';
import type { ProductGroup, ProductVariant, ProductCategory, PrivateOrderItem, InventoryItem } from '../lib/db';
import { calculateFinalMyacgDemand } from '../lib/db';
import { ArrowLeft, ChevronRight, Search, ClipboardList } from 'lucide-react';

interface VariantDetail {
  id: string;
  displayName: string;
  demand: number;
  amount: number;
}

interface CategoryGroup {
  title: string;
  variants: VariantDetail[];
}

interface GroupSummary {
  id: string;
  title: string;
  demand: number;
  amount: number;
  categories: CategoryGroup[];
}

interface ParsedVariant {
  categoryTitle: string | null;
  variantDisplayName: string;
}

function cleanVariantName(variantName: string, categoryTitle: string): string {
  let name = variantName.trim();
  const catTitle = categoryTitle.trim();
  if (!catTitle) return name;

  if (name.startsWith(catTitle)) {
    let rest = name.slice(catTitle.length).trim();
    // Remove leading dashes/separators
    if (rest.startsWith('-') || rest.startsWith('_') || rest.startsWith('—')) {
      rest = rest.slice(1).trim();
    }
    if (rest) return rest;
  }
  return name;
}

function parseVariantFallback(v: ProductVariant, categoryMap: Map<string, ProductCategory>): ParsedVariant {
  // Rule 1: product_category_id exists
  if (v.product_category_id) {
    const cat = categoryMap.get(v.product_category_id);
    if (cat) {
      const catTitle = cat.title || (cat as any).name || '';
      const varName = (v.variant_name || v.raw_variant_name || '').trim();
      const displayName = cleanVariantName(varName, catTitle);
      return {
        categoryTitle: catTitle || null,
        variantDisplayName: displayName
      };
    }
  }

  // Rule 2: parse from variant_name or raw_variant_name
  const name = (v.variant_name || v.raw_variant_name || '').trim();
  
  // Check pattern "分類名稱 - 分類名稱 角色名" or "分類名稱 - 角色名"
  if (name.includes(' - ')) {
    const parts = name.split(' - ');
    const prefix = parts[0].trim();
    let rest = parts.slice(1).join(' - ').trim();
    if (rest.startsWith(prefix)) {
      let sub = rest.slice(prefix.length).trim();
      // Remove any leading dash/separator
      if (sub.startsWith('-') || sub.startsWith('_') || sub.startsWith('—')) {
        sub = sub.slice(1).trim();
      }
      return {
        categoryTitle: prefix,
        variantDisplayName: sub || rest
      };
    }
    return {
      categoryTitle: prefix,
      variantDisplayName: rest
    };
  }

  // Check pattern with whitespace: "分類名稱 角色名"
  const whitespaceRegex = /\s+/;
  if (whitespaceRegex.test(name)) {
    const parts = name.split(whitespaceRegex);
    const prefix = parts[0].trim();
    const rest = parts.slice(1).join(' ').trim();
    if (prefix && rest) {
      return {
        categoryTitle: prefix,
        variantDisplayName: rest
      };
    }
  }

  // Fallback: no category parsed
  return {
    categoryTitle: null,
    variantDisplayName: name
  };
}

export default function Purchasing() {
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedCats(new Set());
  }, [selectedGroupId]);

  useEffect(() => {
    async function loadAllData() {
      try {
        const [
          fetchedGroups,
          fetchedVars,
          fetchedCats,
          fetchedPrivateItems,
          fetchedInventory
        ] = await Promise.all([
          dataProvider.getProductGroups().catch(() => []),
          dataProvider.getProductVariants().catch(() => []),
          dataProvider.getProductCategories().catch(() => []),
          dataProvider.getPrivateOrderItems().catch(() => []),
          dataProvider.getInventory().catch(() => [])
        ]);

        setGroups(fetchedGroups);
        setVariants(fetchedVars);
        setCategories(fetchedCats);
        setPrivateOrderItems(fetchedPrivateItems);
        setInventory(fetchedInventory);
      } catch (err) {
        console.error("Failed to load data for mobile purchase summary:", err);
      } finally {
        setLoading(false);
      }
    }
    loadAllData();
  }, []);

  // Compute summary for each group
  const groupSummaries: GroupSummary[] = useMemo(() => {
    if (groups.length === 0) return [];

    const categoryMap = new Map(categories.map(c => [c.id, c]));
    const inventoryMap = new Map(inventory.map(inv => [inv.myacg_item_code, inv]));

    return groups.map(g => {
      // Find all variants of this group
      const catIds = new Set(categories.filter(c => c.product_group_id === g.id).map(c => c.id));
      const groupVars = variants.filter(v => v.product_group_id === g.id || (v.product_category_id && catIds.has(v.product_category_id)));

      // Sort Catalog variants of this group by SKU
      const catalogVars = groupVars.filter(v => v.source !== 'manual');
      catalogVars.sort((a, b) => {
        return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
      });
      const tempCatalogIds = catalogVars.map(v => v.id);

      // Define getSortVal for this group
      const getSortVal = (x: ProductVariant) => {
        if (x.source === 'manual') {
          return x.sort_order ?? 999999;
        } else {
          const catIdx = tempCatalogIds.indexOf(x.id);
          return catIdx !== -1 ? catIdx * 10 : 999999;
        }
      };

      // Sort groupVars using the exact comparator from PurchaseManagement.tsx
      groupVars.sort((a, b) => {
        const valA = getSortVal(a);
        const valB = getSortVal(b);
        if (valA !== valB) return valA - valB;
        return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
      });

      // Group variants by categoryTitle
      const categoryGroupsMap = new Map<string, VariantDetail[]>();

      groupVars.forEach(v => {
        // Calculate MyACG demand
        const rawMyacgQty = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()));
        const localMyacg = (rawMyacgQty >= 0 ? rawMyacgQty : 0) + (v.myacg_manual_adjustment ?? 0);
        const autoMyacg = (v.myacg_auto_quantity !== null && v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity >= 0)
          ? v.myacg_auto_quantity + (v.myacg_manual_adjustment ?? 0)
          : null;
        const rawMyacg = (v.effective_myacg_quantity !== null && v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity >= 0)
          ? v.effective_myacg_quantity + (v.myacg_manual_adjustment ?? 0)
          : (autoMyacg ?? (v as any).myacg_quantity ?? localMyacg);
        const myacgDemand = rawMyacg >= 0 ? rawMyacg : 0;

        // Calculate WACA demand
        const localWaca = (v.waca_auto_quantity ?? 0) + (v.waca_manual_adjustment ?? 0);
        const autoWaca = (v.waca_auto_quantity !== null && v.waca_auto_quantity !== undefined && v.waca_auto_quantity >= 0)
          ? v.waca_auto_quantity + (v.waca_manual_adjustment ?? 0)
          : null;
        const rawWaca = autoWaca ?? (v as any).waca_quantity ?? localWaca;
        const wacaDemand = rawWaca >= 0 ? rawWaca : 0;

        // Calculate Private demand
        const localPrivate = privateOrderItems
          .filter(poi => poi.product_variant_id === v.id)
          .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        const rawPrivate = v.private_manual_adjustment ?? (v as any).private_quantity ?? localPrivate;
        const privateDemand = rawPrivate >= 0 ? rawPrivate : 0;

        const totalDemand = myacgDemand + wacaDemand + privateDemand;

        // Get selling price
        const invItem = inventoryMap.get(v.myacg_item_code);
        const price = invItem?.final_price ?? 0;
        const amount = totalDemand * price;

        // Parse category and variant name
        const parsed = parseVariantFallback(v, categoryMap);
        const catTitle = parsed.categoryTitle || '單品';
        const displayName = parsed.variantDisplayName;

        if (totalDemand > 0) {
          if (!categoryGroupsMap.has(catTitle)) {
            categoryGroupsMap.set(catTitle, []);
          }
          categoryGroupsMap.get(catTitle)!.push({
            id: v.id,
            displayName,
            demand: totalDemand,
            amount
          });
        }
      });

      // Convert category groups map to list
      const categoryGroups: CategoryGroup[] = Array.from(categoryGroupsMap.entries()).map(([title, vars]) => {
        return {
          title,
          variants: vars
        };
      });

      // Sort variants within each category using the exact same variant order
      categoryGroups.forEach(cg => {
        cg.variants.sort((a, b) => {
          const origA = groupVars.find(x => x.id === a.id);
          const origB = groupVars.find(x => x.id === b.id);
          const valA = origA ? getSortVal(origA) : 999999;
          const valB = origB ? getSortVal(origB) : 999999;
          if (valA !== valB) return valA - valB;
          return (origA?.myacg_item_code || '').localeCompare(origB?.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
        });
      });

      // Sort categoryGroups by minSortVal and min SKU of their variants
      const getGroupSortOrder = (cgVariants: VariantDetail[]) => {
        const itemSorts = cgVariants
          .map(v => {
            const orig = groupVars.find(x => x.id === v.id);
            return orig ? getSortVal(orig) : 999999;
          })
          .filter(n => Number.isFinite(n));
        return itemSorts.length > 0 ? Math.min(...itemSorts) : 999999;
      };

      const getGroupMinSku = (cgVariants: VariantDetail[]) => {
        return cgVariants
          .map(v => {
            const orig = groupVars.find(x => x.id === v.id);
            return orig ? orig.myacg_item_code || '' : '';
          })
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))[0] || '';
      };

      categoryGroups.sort((a, b) => {
        const sortA = getGroupSortOrder(a.variants);
        const sortB = getGroupSortOrder(b.variants);
        if (sortA !== sortB) return sortA - sortB;

        const skuA = getGroupMinSku(a.variants);
        const skuB = getGroupMinSku(b.variants);
        return skuA.localeCompare(skuB, undefined, { numeric: true, sensitivity: 'base' });
      });

      // Calculate total demand and amount for the group
      let groupDemand = 0;
      let groupAmount = 0;
      categoryGroups.forEach(cg => {
        cg.variants.forEach(v => {
          groupDemand += v.demand;
          groupAmount += v.amount;
        });
      });

      return {
        id: g.id,
        title: g.normalized_title || g.title,
        demand: groupDemand,
        amount: groupAmount,
        categories: categoryGroups
      };
    })
    .filter(g => g.demand > 0) // Only show items with actual demand
    .sort((a, b) => b.demand - a.demand); // Sort by demand quantity descending
  }, [groups, variants, categories, privateOrderItems, inventory]);

  // Filtered summaries for search
  const filteredSummaries = useMemo(() => {
    if (!searchTerm.trim()) return groupSummaries;
    const cleanSearch = searchTerm.toLowerCase().trim();
    return groupSummaries.filter(g => g.title.toLowerCase().includes(cleanSearch));
  }, [groupSummaries, searchTerm]);

  // Selected group details
  const selectedGroup = useMemo(() => {
    if (!selectedGroupId) return null;
    return groupSummaries.find(g => g.id === selectedGroupId) || null;
  }, [groupSummaries, selectedGroupId]);

  if (loading) {
    return (
      <div className="mobile-summary-loading">
        <div className="spinner"></div>
        <p>載入採購數據中...</p>
      </div>
    );
  }

  return (
    <div className="mobile-summary-container">
      <style>{`
        .mobile-summary-container {
          width: 100%;
          max-width: 600px;
          margin: 0 auto;
          padding: 16px;
          box-sizing: border-box;
          font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          color: #0f172a;
          background-color: #f8fafc;
          min-height: calc(100vh - 64px);
        }

        .mobile-summary-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 300px;
          color: #64748b;
          gap: 12px;
          font-size: 14px;
        }

        .spinner {
          width: 32px;
          height: 32px;
          border: 3px solid #e2e8f0;
          border-top-color: #2563eb;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* Header Style */
        .summary-header {
          background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
          color: #ffffff !important;
          padding: 20px;
          border-radius: 12px;
          margin-bottom: 16px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
        }

        .summary-title, .summary-title span {
          font-size: 20px;
          font-weight: 800;
          margin: 0 0 6px 0;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #ffffff !important;
        }

        .summary-subtitle {
          font-size: 12px;
          color: #94a3b8 !important;
          margin: 0;
          font-weight: 400;
        }

        /* Search input */
        .search-wrapper {
          position: relative;
          margin-bottom: 16px;
        }

        .search-input {
          width: 100%;
          height: 44px;
          padding: 0 16px 0 40px;
          font-size: 14px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background-color: #ffffff;
          box-sizing: border-box;
          color: #0f172a;
          outline: none;
          transition: border-color 0.2s;
        }

        .search-input:focus {
          border-color: #2563eb;
        }

        .search-icon {
          position: absolute;
          left: 14px;
          top: 13px;
          color: #94a3b8;
        }

        /* Card List */
        .summary-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .summary-card {
          background-color: #ffffff;
          border-radius: 8px;
          padding: 16px;
          border: 1px solid #e2e8f0;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          transition: transform 0.1s, box-shadow 0.1s;
        }

        .summary-card:active {
          transform: scale(0.98);
          background-color: #f1f5f9;
        }

        .card-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .card-title {
          font-size: 14px;
          font-weight: 600;
          color: #1e293b;
          margin: 0;
          line-height: 1.35;
        }

        .card-variant-summary {
          font-size: 12px;
          color: #64748b;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          margin-top: -4px;
          margin-bottom: 2px;
        }

        .card-stats {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 13px;
        }

        .stat-demand {
          background-color: #fef2f2;
          color: #dc2626;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 4px;
        }

        .stat-amount {
          color: #475569;
          font-weight: 500;
        }

        .card-arrow {
          color: #94a3b8;
          flex-shrink: 0;
        }

        /* Detail View */
        .detail-view {
          background-color: #ffffff;
          border-radius: 12px;
          padding: 20px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
        }

        .btn-back {
          background: none;
          border: none;
          color: #2563eb;
          font-size: 14px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          padding: 0;
          margin-bottom: 20px;
        }

        .detail-title {
          font-size: 20px;
          font-weight: 700;
          color: #0f172a;
          margin: 0 0 16px 0;
          line-height: 1.3;
          border-bottom: 1px solid #f1f5f9;
          padding-bottom: 12px;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .detail-summary-cards {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 24px;
        }

        .detail-stat-card {
          background-color: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 14px;
          text-align: center;
        }

        .stat-label {
          font-size: 12px;
          color: #64748b;
          margin-bottom: 4px;
          display: block;
        }

        .stat-value {
          font-size: 18px;
          font-weight: 800;
          color: #0f172a;
        }

        .stat-value.primary {
          color: #dc2626;
        }

        .stat-value.success {
          color: #0f766e;
        }

        .variant-section-title {
          font-size: 14px;
          font-weight: 700;
          color: #475569;
          margin-bottom: 12px;
          border-left: 3px solid #2563eb;
          padding-left: 8px;
        }

        .variant-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .variant-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          background-color: #f8fafc;
          border-radius: 6px;
          border: 1px solid #f1f5f9;
        }

        .variant-name {
          font-size: 14px;
          color: #334155;
          font-weight: 500;
        }

        .variant-amount {
          font-size: 13px;
          color: #64748b;
          font-weight: 500;
        }

        .variant-qty {
          font-size: 14px;
          font-weight: 700;
          color: #0f172a;
          background-color: #e2e8f0;
          padding: 2px 8px;
          border-radius: 4px;
          min-width: 24px;
          text-align: center;
        }

        .empty-state {
          text-align: center;
          padding: 40px 20px;
          color: #64748b;
          font-size: 14px;
        }
      `}</style>

      {!selectedGroup ? (
        // List View
        <>
          <div className="summary-header">
            <h1 className="summary-title">
              <ClipboardList size={22} />
              <span>採購總表</span>
            </h1>
            <p className="summary-subtitle">唯讀需求清單與預估總金額 (日本現地小幫手專用)</p>
          </div>

          <div className="search-wrapper">
            <Search className="search-icon" size={18} />
            <input 
              type="text"
              placeholder="搜尋商品名稱..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
          </div>

          {filteredSummaries.length > 0 ? (
            <div className="summary-list">
              {filteredSummaries.map(item => {
                const categoryTitles = item.categories.map(c => c.title).filter(Boolean);
                const variantSummaryText = categoryTitles.length > 0 ? categoryTitles.join(', ') : '無分類';
                return (
                  <div 
                    key={item.id} 
                    className="summary-card"
                    onClick={() => setSelectedGroupId(item.id)}
                  >
                    <div className="card-content">
                      <h2 className="card-title">{item.title}</h2>
                      <div className="card-variant-summary">{variantSummaryText}</div>
                      <div className="card-stats">
                        <span className="stat-demand">需求 {item.demand}</span>
                        <span className="stat-amount">總金額 ¥{item.amount.toLocaleString()}</span>
                      </div>
                    </div>
                    <ChevronRight className="card-arrow" size={18} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <p>沒有符合條件或有需求的商品。</p>
            </div>
          )}
        </>
      ) : (
        // Detail View
        <div className="detail-view">
          <button className="btn-back" onClick={() => setSelectedGroupId(null)}>
            <ArrowLeft size={16} />
            <span>返回清單</span>
          </button>
          
          <h2 className="detail-title">{selectedGroup.title}</h2>
          
          <div className="detail-summary-cards">
            <div className="detail-stat-card">
              <span className="stat-label">總需求數量</span>
              <span className="stat-value primary">{selectedGroup.demand}</span>
            </div>
            <div className="detail-stat-card">
              <span className="stat-label">預估總金額</span>
              <span className="stat-value success">¥{selectedGroup.amount.toLocaleString()}</span>
            </div>
          </div>

          {selectedGroup.categories.length > 0 && (
            <div style={{ marginTop: '20px' }}>
              <h3 className="variant-section-title">規格明細需求</h3>
              {selectedGroup.categories.map((cat, catIdx) => {
                const catDemand = cat.variants.reduce((sum, v) => sum + v.demand, 0);
                const hasMultiple = cat.variants.length > 1;
                const isExpanded = !hasMultiple || expandedCats.has(cat.title);

                return (
                  <div key={catIdx} className="category-group" style={{ marginBottom: '12px' }}>
                    {hasMultiple ? (
                      // Collapsible Header (for 2 or more variants)
                      <div 
                        className="category-title" 
                        onClick={() => {
                          setExpandedCats(prev => {
                            const next = new Set(prev);
                            if (next.has(cat.title)) {
                              next.delete(cat.title);
                            } else {
                              next.add(cat.title);
                            }
                            return next;
                          });
                        }}
                        style={{ 
                          fontSize: '15px', 
                          fontWeight: 700, 
                          color: '#1e293b', 
                          marginTop: '12px', 
                          marginBottom: '6px', 
                          borderBottom: '1px solid #e2e8f0', 
                          paddingBottom: '6px', 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          alignItems: 'center', 
                          cursor: 'pointer',
                          userSelect: 'none'
                        }}
                      >
                        <span>{cat.title}（{catDemand}）</span>
                        <span style={{ fontSize: '12px', color: '#64748b' }}>
                          {isExpanded ? '▼' : '▶'}
                        </span>
                      </div>
                    ) : (
                      // Static Header (for exactly 1 variant)
                      <div 
                        className="category-title" 
                        style={{ 
                          fontSize: '15px', 
                          fontWeight: 700, 
                          color: '#1e293b', 
                          marginTop: '12px', 
                          marginBottom: '6px', 
                          borderBottom: '1px solid #e2e8f0', 
                          paddingBottom: '6px',
                          userSelect: 'none'
                        }}
                      >
                        {cat.title}
                      </div>
                    )}
                    
                    {isExpanded && (
                      <div className="variant-list" style={{ paddingLeft: '12px', display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                        {cat.variants.map((v, vIdx) => (
                          <div 
                            key={vIdx} 
                            className="variant-row" 
                            style={{ 
                              display: 'flex', 
                              justifyContent: 'space-between',
                              alignItems: 'center', 
                              padding: '8px 12px', 
                              borderBottom: '1px solid #f1f5f9', 
                              backgroundColor: '#f8fafc',
                              borderRadius: '6px'
                            }}
                          >
                            {/* Left Side: Variant Display Name */}
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', flex: 1, paddingRight: '8px' }}>
                              {v.displayName}
                            </div>
                            {/* Right Side: Demand and Price stacked vertically */}
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'end', gap: '4px', flexShrink: 0 }}>
                              <span style={{ color: '#dc2626', fontSize: '15px', fontWeight: 700 }}>
                                需求 {v.demand}
                              </span>
                              <span style={{ fontWeight: 600, color: '#475569', fontSize: '13px' }}>
                                ¥{v.amount.toLocaleString()}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
