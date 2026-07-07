import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import type { ProductGroup, ProductVariant, ProductCategory, PrivateOrderItem, InventoryItem, PurchaseBatchItem, SalesOrderItem, PurchaseBatch } from '../lib/db';
import { calculateVariantDemandAndPurchased } from '../lib/db';
import { ArrowLeft, ChevronRight, Search, ClipboardList, Trash2, ExternalLink, Plus } from 'lucide-react';
import PurchaseBatchModal from '../components/PurchaseBatchModal';
import { useViewport } from '../contexts/ViewportContext';

interface VariantDetail {
  id: string;
  displayName: string;
  demand: number;
  amount: number;
  purchased: number;
  gap: number;
  cost: number;
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
  purchased: number;
  gap: number;
  toPurchaseCost: number;
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

const cleanDailiTitle = (title: string): string => {
  if (!title) return '';
  let res = title;
  const keywords = [
    '【小河馬日本代購】',
    '【小河馬代購】',
    '小河馬日本代購',
    '小河馬代購',
    '預購',
    '現貨',
    '日本代購',
    '現地代購',
    '代理版',
    '代理',
    '日版',
    '再版',
    '預約'
  ];
  keywords.forEach(kw => {
    res = res.replaceAll(kw, '');
  });
  res = res.replace(/\d{2,4}年\d{1,2}月/g, '');
  res = res.replace(/\s+/g, ' ').trim();
  return res;
};

export default function Purchasing() {
  const { isMobile } = useViewport();
  const navigate = useNavigate();
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [purchaseBatchItems, setPurchaseBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<SalesOrderItem[]>([]);
  const [purchaseBatches, setPurchaseBatches] = useState<PurchaseBatch[]>([]);
  const [showBatchModal, setShowBatchModal] = useState(false);
  
  const [loading, setLoading] = useState(true);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedGroupId) {
      if (window.location.hash !== '#detail') {
        window.history.pushState({ type: 'purchasing-detail', groupId: selectedGroupId }, '', '#detail');
      }
    }
  }, [selectedGroupId]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const state = event.state;
      if (state && state.type === 'purchasing-detail' && state.groupId) {
        setSelectedGroupId(state.groupId);
      } else {
        setSelectedGroupId(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!selectedGroupId && window.location.hash === '#detail') {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [selectedGroupId]);

  const handleBack = () => {
    if (window.location.hash === '#detail') {
      window.history.back();
    } else {
      setSelectedGroupId(null);
    }
  };
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());

  // New states for selection mode and stale protection
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [isStale, setIsStale] = useState(false);

  const activeProductGroup = useMemo(() => {
    if (!selectedGroupId) return null;
    return groups.find(g => g.id === selectedGroupId) || null;
  }, [groups, selectedGroupId]);

  const groupCatIds = useMemo(() => {
    if (!selectedGroupId) return new Set<string>();
    return new Set(categories.filter(c => c.product_group_id === selectedGroupId).map(c => c.id));
  }, [categories, selectedGroupId]);

  const groupVars = useMemo(() => {
    if (!selectedGroupId) return [];
    const filtered = variants.filter(v => v.product_group_id === selectedGroupId || (v.product_category_id && groupCatIds.has(v.product_category_id)));
    
    // Sort Catalog variants of this group by SKU to define sorting index
    const catalogVars = filtered.filter(v => v.source !== 'manual');
    catalogVars.sort((a, b) => {
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
    });
    const catalogIds = catalogVars.map(v => v.id);

    const getSortVal = (x: ProductVariant) => {
      if (x.source === 'manual') {
        return x.sort_order ?? 999999;
      } else {
        const catIdx = catalogIds.indexOf(x.id);
        return catIdx !== -1 ? catIdx * 10 : 999999;
      }
    };

    filtered.sort((a, b) => {
      const valA = getSortVal(a);
      const valB = getSortVal(b);
      if (valA !== valB) return valA - valB;
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
    });

    return filtered;
  }, [variants, selectedGroupId, groupCatIds]);

  const categoryMap = useMemo(() => {
    return new Map(categories.map(c => [c.id, c]));
  }, [categories]);

  const getDisplayProductName = (v: ProductVariant): string => {
    const variantName = (v.variant_name || '').trim();
    const productTitle = activeProductGroup?.normalized_title || activeProductGroup?.title || '';
    const isDaili = activeProductGroup?.listing_type === '代理版';
    
    if (isDaili) {
      if (variantName && variantName !== '單品' && variantName !== '一箱') {
        return variantName;
      }
      const targetTitle = v.product_title || productTitle;
      const cleaned = cleanDailiTitle(targetTitle);
      if (cleaned) {
        return cleaned;
      }
      if (targetTitle) {
        return targetTitle;
      }
      return v.myacg_item_code || '未命名規格';
    } else {
      if (v.product_category_id) {
        const cat = categoryMap.get(v.product_category_id);
        if (cat && cat.title && cat.title !== '單品') {
          return `${cat.title} - ${variantName || '單品'}`;
        }
      }
      if (variantName) {
        return variantName;
      }
      if (productTitle) {
        return productTitle;
      }
      return v.myacg_item_code || '未命名規格';
    }
  };

  useEffect(() => {
    setExpandedCats(new Set());
  }, [selectedGroupId]);

  useEffect(() => {
    const unsubscribe = dataProvider.onStaleChange(setIsStale);
    setIsStale(dataProvider.checkIsStaleLive());
    return unsubscribe;
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    try {
      const [
        fetchedGroups,
        fetchedVars,
        fetchedCats,
        fetchedPrivateItems,
        fetchedInventory,
        fetchedBatchItems,
        fetchedSalesOrderItems,
        fetchedBatches
      ] = await Promise.all([
        dataProvider.getProductGroups().catch(() => []),
        dataProvider.getProductVariants().catch(() => []),
        dataProvider.getProductCategories().catch(() => []),
        dataProvider.getPrivateOrderItems().catch(() => []),
        dataProvider.getInventory().catch(() => []),
        dataProvider.getPurchaseBatchItems().catch(() => []),
        dataProvider.getSalesOrderItems().catch(() => []),
        dataProvider.getPurchaseBatches().catch(() => [])
      ]);

      setGroups(fetchedGroups);
      setVariants(fetchedVars);
      setCategories(fetchedCats);
      setPrivateOrderItems(fetchedPrivateItems);
      setInventory(fetchedInventory);
      setPurchaseBatchItems(fetchedBatchItems);
      setSalesOrderItems(fetchedSalesOrderItems);
      setPurchaseBatches(fetchedBatches);
      dataProvider.registerFreshLoad();
    } catch (err) {
      console.error("Failed to load data for mobile purchase summary:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
  }, []);

  const guardAgainstStaleWrite = (): boolean => {
    const liveStale = dataProvider.checkIsStaleLive();
    if (isStale || liveStale) {
      alert('資料已在其他分頁更新，請重新載入最新資料後再編輯。');
      return true;
    }
    return false;
  };

  const handleSingleRemove = async (id: string) => {
    if (guardAgainstStaleWrite()) return;
    const confirmRemove = window.confirm('確定將此商品移出採購總表？');
    if (!confirmRemove) return;

    try {
      const nextGroups = groups.map(g => {
        if (g.id === id) {
          return { ...g, show_in_purchase_list: false } as ProductGroup;
        }
        return g;
      });

      setGroups(nextGroups);
      await dataProvider.saveProductGroups(nextGroups);
      alert('已成功移出採購總表。');
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadAllData();
        return;
      }
      alert('移出採購總表失敗，請重試。');
      console.error(err);
    }
  };

  const handleBatchRemove = async () => {
    if (guardAgainstStaleWrite()) return;
    if (selectedGroupIds.size === 0) return;
    const confirmRemove = window.confirm(`確定將已選取的 ${selectedGroupIds.size} 筆商品移出採購總表？`);
    if (!confirmRemove) return;

    try {
      const nextGroups = groups.map(g => {
        if (selectedGroupIds.has(g.id)) {
          return { ...g, show_in_purchase_list: false } as ProductGroup;
        }
        return g;
      });

      setGroups(nextGroups);
      await dataProvider.saveProductGroups(nextGroups);
      alert(`已成功將 ${selectedGroupIds.size} 筆商品移出採購總表。`);
      setSelectedGroupIds(new Set());
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadAllData();
        return;
      }
      alert('批次移出採購總表失敗，請重試。');
      console.error(err);
    }
  };

  // Compute summary for each group
  const groupSummaries: GroupSummary[] = useMemo(() => {
    const purchaseGroups = groups.filter(g => g.show_in_purchase_list === true);
    if (purchaseGroups.length === 0) return [];

    const categoryMap = new Map(categories.map(c => [c.id, c]));
    const inventoryMap = new Map(inventory.map(inv => [inv.myacg_item_code, inv]));

    const variantDefaultJpyCosts = (() => {
      try {
        const stored = localStorage.getItem('variant_default_jpy_costs');
        return stored ? JSON.parse(stored) : {};
      } catch (e) {
        return {};
      }
    })();

    return purchaseGroups.map(g => {
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
        const res = calculateVariantDemandAndPurchased(
          v,
          privateOrderItems,
          purchaseBatchItems,
          inventory,
          salesOrderItems
        );
        const totalDemand = res.myacg + res.waca + res.privateOrder;
        const gap = res.gap;
        const purchased = res.purchased;

        // Get selling price
        const invItem = inventoryMap.get(v.myacg_item_code);
        const price = invItem?.final_price ?? 0;
        const amount = totalDemand * price;

        // Get cost
        const cost = (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null)
          ? v.default_jpy_cost
          : (variantDefaultJpyCosts[v.id] ?? 0);

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
            purchased,
            gap,
            amount,
            cost
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
      let groupPurchased = 0;
      let groupGap = 0;
      let groupToPurchaseCost = 0;
      categoryGroups.forEach(cg => {
        cg.variants.forEach(v => {
          groupDemand += v.demand;
          groupAmount += v.amount;
          groupPurchased += v.purchased;
          groupGap += v.gap;
          if (v.gap > 0) {
            groupToPurchaseCost += v.gap * (v.cost ?? 0);
          }
        });
      });

      return {
        id: g.id,
        title: g.normalized_title || g.title,
        demand: groupDemand,
        amount: groupAmount,
        purchased: groupPurchased,
        gap: groupGap,
        toPurchaseCost: groupToPurchaseCost,
        categories: categoryGroups
      };
    })
    .filter(g => g.demand > 0) // Only show items with actual demand
    .sort((a, b) => b.demand - a.demand); // Sort by demand quantity descending
  }, [groups, variants, categories, privateOrderItems, inventory, purchaseBatchItems, salesOrderItems]);

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
        .btn-toggle-select {
          height: 44px;
          padding: 0 12px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          font-weight: 600;
          font-size: 13px;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .variant-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid #f1f5f9;
          background-color: #f8fafc;
          border-radius: 6px;
          border: 1px solid #f1f5f9;
        }

        .variant-name {
          font-size: 14px;
          font-weight: 600;
          color: #334155;
          flex: 1;
          padding-right: 8px;
        }

        .variant-right-section {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
          flex-shrink: 0;
        }

        .variant-gap {
          color: #dc2626;
          font-size: 14px;
          font-weight: 700;
        }

        .variant-price {
          font-weight: 600;
          color: #475569;
          font-size: 13px;
        }

        @media (min-width: 1024px) {
          .mobile-summary-container {
            max-width: none !important;
            width: 100% !important;
            padding: 32px !important;
          }
          .purchasing-page-inner {
            max-width: 760px !important;
            margin: 0 auto !important;
            width: 100% !important;
            box-sizing: border-box;
          }
          .detail-view {
            max-width: 860px !important;
            margin: 0 auto !important;
            width: 100% !important;
            padding: 36px 48px !important;
            box-sizing: border-box;
          }
          .detail-summary-cards {
            max-width: 100% !important;
            margin: 0 auto 30px !important;
          }
          
          /* Scaled elements on desktop */
          .summary-header {
            padding: 36px 40px !important;
            margin-bottom: 24px !important;
          }
          .summary-title, .summary-title span {
            font-size: 28px !important;
          }
          .summary-title svg {
            width: 28px !important;
            height: 28px !important;
          }
          .summary-subtitle {
            font-size: 15px !important;
            margin-top: 8px !important;
          }
          .search-input {
            height: 48px !important;
            font-size: 15px !important;
            padding-left: 46px !important;
          }
          .search-icon {
            top: 15px !important;
            width: 20px !important;
            height: 20px !important;
          }
          .btn-toggle-select {
            height: 48px !important;
            font-size: 15px !important;
            padding: 0 16px !important;
          }
          
          /* Card list scaled up */
          .summary-card {
            padding: 24px !important;
            gap: 16px !important;
            border-radius: 12px !important;
          }
          .card-title {
            font-size: 17px !important;
          }
          .card-variant-summary {
            font-size: 14.5px !important;
          }
          .card-stats {
            font-size: 15px !important;
            gap: 16px !important;
          }
          .stat-demand {
            font-size: 14.5px !important;
            padding: 4px 10px !important;
          }
          .stat-amount {
            font-size: 15px !important;
          }
          
          /* Detail Page elements scaled up */
          .detail-title {
            font-size: 26px !important;
            margin-bottom: 24px !important;
          }
          .detail-stat-card {
            padding: 20px 24px !important;
            border-radius: 12px !important;
          }
          .detail-stat-card .stat-label {
            font-size: 14px !important;
            margin-bottom: 6px !important;
          }
          .detail-stat-card .stat-value {
            font-size: 24px !important;
          }
          
          /* Specifications List scaled up */
          .variant-section-title {
            font-size: 17px !important;
            margin-bottom: 16px !important;
            padding-left: 10px !important;
            border-left-width: 4px !important;
          }
          .category-title {
            font-size: 17px !important;
            padding-bottom: 10px !important;
            margin-top: 24px !important;
            margin-bottom: 12px !important;
          }
          .variant-row {
            padding: 12px 18px !important;
            border-radius: 8px !important;
          }
          .variant-name {
            font-size: 15.5px !important;
          }
          .variant-gap {
            font-size: 15.5px !important;
          }
          .variant-price {
            font-size: 14.5px !important;
          }
        }
      `}</style>

      {!selectedGroup ? (
        // List View
        <div className="purchasing-page-inner">
          <div className="summary-header">
            <h1 className="summary-title">
              <ClipboardList size={22} />
              <span>採購總表</span>
            </h1>
            <p className="summary-subtitle">唯讀需求清單與預估總金額 (日本現地小幫手專用)</p>
          </div>

          <div className="search-wrapper" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search className="search-icon" size={18} />
              <input 
                type="text"
                placeholder="搜尋商品名稱..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>
            <button
              onClick={() => {
                setIsSelectMode(!isSelectMode);
                setSelectedGroupIds(new Set());
              }}
              className="btn-toggle-select"
              style={{
                backgroundColor: isSelectMode ? '#2563eb' : '#ffffff',
                color: isSelectMode ? '#ffffff' : '#475569',
              }}
            >
              {isSelectMode ? '退出選取' : '選取模式'}
            </button>
          </div>

          {isSelectMode && selectedGroupIds.size > 0 && (
            <div style={{
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '12px',
              padding: '16px',
              marginBottom: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px'
            }}>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#1e40af' }}>
                已選取 {selectedGroupIds.size} 筆商品
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={handleBatchRemove}
                  style={{
                    padding: '0 16px',
                    height: '36px',
                    backgroundColor: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <Trash2 size={14} />
                  <span>批次移出</span>
                </button>
                <button
                  onClick={() => setSelectedGroupIds(new Set())}
                  style={{
                    padding: '0 16px',
                    height: '36px',
                    backgroundColor: '#ffffff',
                    color: '#4b5563',
                    border: '1px solid #d1d5db',
                    borderRadius: '8px',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {filteredSummaries.length > 0 ? (
            <div className="summary-list">
              {filteredSummaries.map(item => {
                const isChecked = selectedGroupIds.has(item.id);
                return (
                  <div 
                    key={item.id} 
                    className="summary-card"
                    onClick={() => {
                      if (isSelectMode) {
                        const next = new Set(selectedGroupIds);
                        if (next.has(item.id)) {
                          next.delete(item.id);
                        } else {
                          next.add(item.id);
                        }
                        setSelectedGroupIds(next);
                      } else {
                        setSelectedGroupId(item.id);
                      }
                    }}
                    style={{
                      borderColor: isChecked ? '#2563eb' : '#e2e8f0',
                      backgroundColor: isChecked ? '#eff6ff' : '#ffffff'
                    }}
                  >
                    {isSelectMode && (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}} // handled by card onClick
                        style={{
                          width: '18px',
                          height: '18px',
                          marginRight: '4px',
                          cursor: 'pointer',
                          accentColor: '#2563eb'
                        }}
                      />
                    )}
                    <div className="card-content" style={{ cursor: 'pointer' }}>
                      <h2 className="card-title">{item.title}</h2>
                      <div className="card-stats">
                        {item.gap > 0 && (
                          <span style={{ backgroundColor: '#fef2f2', color: '#dc2626', fontWeight: 700, padding: '2px 8px', borderRadius: '4px' }}>
                            待採購 {item.gap}
                          </span>
                        )}
                        <span className="stat-amount">待採購金額 ¥{item.toPurchaseCost.toLocaleString()}</span>
                      </div>
                    </div>

                    {!isSelectMode && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          onTouchStart={(e) => {
                            e.stopPropagation();
                          }}
                          onTouchEnd={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            handleSingleRemove(item.id);
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSingleRemove(item.id);
                          }}
                          title="移出採購總表"
                          style={{
                            border: 'none',
                            background: 'none',
                            color: '#64748b',
                            padding: '6px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '4px',
                            transition: 'all 0.2s'
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                        <ChevronRight className="card-arrow" size={18} />
                      </div>
                    )}
                    {isSelectMode && <ChevronRight className="card-arrow" size={18} />}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <p>沒有符合條件或有需求的商品。</p>
            </div>
          )}
        </div>
      ) : (
        // Detail View
        <div className="detail-view" style={{ padding: isMobile ? '12px' : undefined }}>
          {isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
              <div>
                <button className="btn-back" type="button" onClick={handleBack} style={{ margin: 0, height: '44px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <ArrowLeft size={16} />
                  <span>返回清單</span>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowBatchModal(true)}
                style={{
                  width: '100%',
                  height: '44px',
                  backgroundColor: '#f0fdf4',
                  color: '#166534',
                  border: '1px solid #bbf7d0',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  transition: 'all 0.2s',
                  userSelect: 'none',
                  WebkitUserSelect: 'none'
                }}
              >
                <Plus size={16} />
                <span>新增採購批次</span>
              </button>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => navigate(`/purchase-records/${selectedGroup.id}`, { state: { from: '/purchasing' } })}
                  style={{
                    flex: 1,
                    height: '44px',
                    backgroundColor: '#eff6ff',
                    color: '#2563eb',
                    border: '1px solid #bfdbfe',
                    borderRadius: '8px',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    transition: 'all 0.2s',
                    userSelect: 'none',
                    WebkitUserSelect: 'none'
                  }}
                >
                  <ExternalLink size={14} />
                  <span>前往訂購紀錄</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleSingleRemove(selectedGroup.id);
                    setSelectedGroupId(null);
                  }}
                  style={{
                    flex: 1,
                    height: '44px',
                    backgroundColor: '#ffffff',
                    color: '#ef4444',
                    border: '1px solid #fee2e2',
                    borderRadius: '8px',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    transition: 'all 0.2s',
                    userSelect: 'none',
                    WebkitUserSelect: 'none'
                  }}
                >
                  <Trash2 size={14} />
                  <span>移出採購總表</span>
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <button className="btn-back" type="button" onClick={handleBack} style={{ marginBottom: 0 }}>
                <ArrowLeft size={16} />
                <span>返回清單</span>
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    setShowBatchModal(true);
                  }}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: '#f0fdf4',
                    color: '#166534',
                    border: '1px solid #bbf7d0',
                    borderRadius: '6px',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    transition: 'all 0.2s'
                  }}
                >
                  <Plus size={14} />
                  <span>新增採購批次</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigate(`/purchase-records/${selectedGroup.id}`, { state: { from: '/purchasing' } });
                  }}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: '#eff6ff',
                    color: '#2563eb',
                    border: '1px solid #bfdbfe',
                    borderRadius: '6px',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    transition: 'all 0.2s'
                  }}
                >
                  <ExternalLink size={14} />
                  <span>前往訂購紀錄</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleSingleRemove(selectedGroup.id);
                    setSelectedGroupId(null);
                  }}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: '#ffffff',
                    color: '#ef4444',
                    border: '1px solid #fee2e2',
                    borderRadius: '6px',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    transition: 'all 0.2s'
                  }}
                >
                  <Trash2 size={14} />
                  <span>移出採購總表</span>
                </button>
              </div>
            </div>
          )}
          
          <h2 className="detail-title" style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 600, marginTop: isMobile ? '12px' : '0', marginBottom: '16px', color: '#0f172a' }}>{selectedGroup.title}</h2>
          
          <div className="detail-summary-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '24px' }}>
            <div className="detail-stat-card">
              <span className="stat-label">待採購數量</span>
              <span className="stat-value" style={{ color: selectedGroup.gap > 0 ? '#dc2626' : '#16a34a' }}>
                {selectedGroup.gap}
              </span>
            </div>
            <div className="detail-stat-card">
              <span className="stat-label">待採購金額</span>
              <span className="stat-value success">¥{selectedGroup.toPurchaseCost.toLocaleString()}</span>
            </div>
          </div>

          {(() => {
            const visibleCategories = selectedGroup.categories
              .map(cat => {
                const visibleVariants = cat.variants.filter(v => v.gap > 0);
                return { ...cat, variants: visibleVariants };
              })
              .filter(cat => cat.variants.length > 0);

            if (visibleCategories.length === 0) {
              return (
                <div className="empty-state" style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>
                  <p>目前沒有待採購規格。</p>
                </div>
              );
            }

            return (
              <div style={{ marginTop: '20px' }}>
                <h3 className="variant-section-title">本次採購清單</h3>
                {visibleCategories.map((cat, catIdx) => {
                  const catGap = cat.variants.reduce((sum, v) => sum + v.gap, 0);
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
                          <span>
                            {cat.title} (待採購 {catGap})
                          </span>
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
                          {cat.title} (待採購 {catGap})
                        </div>
                      )}
                      
                      {isExpanded && (
                        <div className="variant-list" style={{ paddingLeft: '12px', display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                          {cat.variants.map((v, vIdx) => (
                            <div 
                              key={vIdx} 
                              className="variant-row"
                            >
                              {/* Left Side: Variant Display Name */}
                              <div className="variant-name">
                                {v.displayName}
                              </div>
                              {/* Right Side: Gap and Price stacked vertically */}
                              <div className="variant-right-section">
                                <span className="variant-gap">
                                  待採購 {v.gap}
                                </span>
                                <span className="variant-price">
                                  ¥{(v.cost ?? 0).toLocaleString()}
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
            );
          })()}
        </div>
      )}
      
      {showBatchModal && activeProductGroup && (
        <PurchaseBatchModal
          show={showBatchModal}
          onClose={() => setShowBatchModal(false)}
          group={activeProductGroup}
          variants={groupVars}
          inventory={inventory}
          salesOrderItems={salesOrderItems}
          privateOrderItems={privateOrderItems}
          purchaseBatchItems={purchaseBatchItems}
          purchaseBatches={purchaseBatches}
          editingBatchId={null}
          onSaveSuccess={async () => {
            await loadAllData();
          }}
          onStale={() => {
            setIsStale(true);
            loadAllData();
          }}
          getDisplayProductName={getDisplayProductName}
        />
      )}

      {/* Version Tag */}
      <div className="purchasing-version-tag" style={{
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        backgroundColor: '#1e293b',
        color: '#ffffff',
        padding: '6px 12px',
        borderRadius: '6px',
        fontSize: '12px',
        fontWeight: 'bold',
        zIndex: 9999,
        pointerEvents: 'none',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
      }}>
        Purchasing UI width fix v1
      </div>
    </div>
  );
}
