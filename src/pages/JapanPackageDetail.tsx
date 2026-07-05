import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, CheckCircle2, Clock, Truck, ExternalLink, Package, Save, CheckSquare, Square, Info } from 'lucide-react';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import type { JapanPackage, JapanPackageItem, ProductGroup, ProductVariant, ProductCategory, PurchaseBatch, PurchaseBatchItem, BundleComponent } from '../lib/db';
import { useViewport } from '../contexts/ViewportContext';

const cleanDisplayProductTitle = (title: string): string => {
  if (!title) return '';
  let cleaned = title
    .replace(/【小河馬日本代購】/g, '')
    .replace(/預購\s*/g, '')
    .replace(/\d{2,4}年\d{1,2}月/g, '')
    .replace(/代理版|通販|現地代購/g, '')
    .trim();
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned;
};

export default function JapanPackageDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isMobile } = useViewport();

  const [pkg, setPkg] = useState<JapanPackage | null>(null);
  const [packageItems, setPackageItems] = useState<JapanPackageItem[]>([]);
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  
  // Batches for import
  const [batches, setBatches] = useState<PurchaseBatch[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  
  // Existing package item batch item IDs to prevent duplicate import
  const existingBatchItemIds = useMemo(() => {
    return new Set(packageItems.map(item => item.purchase_batch_item_id).filter(Boolean));
  }, [packageItems]);
  
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Edit Package Form State
  const [pkgForm, setPkgForm] = useState({
    title: '',
    vendor_name: '',
    carrier: '',
    tracking_number: '',
    shipped_at: '',
    expected_arrival_at: '',
    arrived_at: '',
    status: 'registered',
    note: ''
  });

  // Adding Items State
  const [activeAddTab, setActiveAddTab] = useState<'batch' | 'manual'>('batch');
  
  // Method A: Batch Import
  const [importGroupId, setImportGroupId] = useState<string>('');
  const [importGroupSearch, setImportGroupSearch] = useState<string>('');
  const [isImportDropdownOpen, setIsImportDropdownOpen] = useState<boolean>(false);
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(new Set());
  const [batchImportLines, setBatchImportLines] = useState<{
    purchase_batch_id: string;
    purchase_batch_item_id: string;
    product_variant_id: string;
    selected: boolean;
    quantity: number;
  }[]>([]);

  // Method B: Manual Import
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [selectedGroupSearch, setSelectedGroupSearch] = useState<string>('');
  const [isSelectedDropdownOpen, setIsSelectedDropdownOpen] = useState<boolean>(false);
  const [variantFilterSearch, setVariantFilterSearch] = useState<string>('');
  const [cardQuantities, setCardQuantities] = useState<Record<string, number>>({});

  // Group collapsing state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [bundleComponents, setBundleComponents] = useState<BundleComponent[]>([]);
  const [expandedBundleItems, setExpandedBundleItems] = useState<Set<string>>(new Set());
  const [showDetailedInfo, setShowDetailedInfo] = useState<boolean>(false);

  const getBundleComponents = (parentVar: ProductVariant): ProductVariant[] => {
    const compIds = new Set(
      bundleComponents
        .filter(bc => bc.bundle_variant_id === parentVar.id)
        .map(bc => bc.component_variant_id)
    );
    if (compIds.size === 0) return [];
    return variants.filter(v => compIds.has(v.id));
  };

  const toggleBundleExpand = (itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedBundleItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const checkAndAutoUpdateStatus = async (updatedItems: JapanPackageItem[]) => {
    if (!pkg) return;
    const totalQty = updatedItems.reduce((sum, item) => sum + item.quantity, 0);
    const checkedQty = updatedItems.filter(item => item.checked).reduce((sum, item) => sum + item.quantity, 0);
    const isCompleted = totalQty > 0 && checkedQty === totalQty;

    let targetStatus = pkg.status;
    if (isCompleted) {
      targetStatus = 'confirmed';
    } else if (pkg.status === 'confirmed') {
      targetStatus = 'arrived';
    }

    if (targetStatus !== pkg.status) {
      let arrivedAtVal = pkg.arrived_at;
      if (targetStatus === 'arrived' && !arrivedAtVal) {
        arrivedAtVal = new Date().toISOString().split('T')[0];
      }
      const updatedPkg: JapanPackage = {
        ...pkg,
        status: targetStatus,
        arrived_at: arrivedAtVal,
        updated_at: new Date().toISOString()
      };
      try {
        const allPkgs = await dataProvider.getJapanPackages();
        const updatedList = allPkgs.map(p => p.id === id ? updatedPkg : p);
        await dataProvider.saveJapanPackages(updatedList);
        setPkg(updatedPkg);
        setPkgForm(prev => ({ ...prev, status: targetStatus, arrived_at: arrivedAtVal || '' }));
      } catch (err) {
        console.error('Auto status update failed:', err);
      }
    }
  };

  const handleQuickUpdateStatus = async (newStatus: string) => {
    if (!pkg) return;
    setIsSaving(true);
    let arrivedAtVal = pkg.arrived_at;
    if (newStatus === 'arrived' && !arrivedAtVal) {
      arrivedAtVal = new Date().toISOString().split('T')[0];
    }
    const updatedPkg: JapanPackage = {
      ...pkg,
      status: newStatus as any,
      arrived_at: arrivedAtVal,
      updated_at: new Date().toISOString()
    };
    try {
      const allPkgs = await dataProvider.getJapanPackages();
      const updatedList = allPkgs.map(p => p.id === id ? updatedPkg : p);
      await dataProvider.saveJapanPackages(updatedList);
      setPkg(updatedPkg);
      setPkgForm(prev => ({ ...prev, status: newStatus as any, arrived_at: arrivedAtVal || '' }));
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        await loadData(id || '');
      } else {
        alert('狀態更新失敗，請重試！');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Mobile UI States
  const [mobileInfoExpanded, setMobileInfoExpanded] = useState<boolean>(false);
  const [mobileExpandedGroups, setMobileExpandedGroups] = useState<Set<string>>(new Set());

  // URL Sync for Mobile Group Expansion
  const [searchParams, setSearchParams] = useSearchParams();
  const groupQuery = searchParams.get('group') || '';

  useEffect(() => {
    if (isMobile) {
      if (groupQuery) {
        setMobileExpandedGroups(new Set([groupQuery]));
      } else {
        setMobileExpandedGroups(new Set());
      }
    }
  }, [groupQuery, isMobile]);

  const toggleMobileGroupExpand = (groupId: string) => {
    if (!isMobile) return;
    const isCurrentlyExpanded = mobileExpandedGroups.has(groupId);
    const newParams = new URLSearchParams(searchParams);
    if (isCurrentlyExpanded) {
      newParams.delete('group');
      setSearchParams(newParams, { replace: true });
    } else {
      newParams.set('group', groupId);
      setSearchParams(newParams, { replace: false });
    }
  };

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // Collapsible Import Panel State (Default to collapsed per requirements)
  const [isImportCollapsed, setIsImportCollapsed] = useState<boolean>(true);

  // Bulk operation updates restricted to checked, checked_at, and updated_at fields
  const handleBulkToggleCheck = async (itemIds: string[], checkedVal: boolean) => {
    const itemIdsSet = new Set(itemIds);
    const allItems = await dataProvider.getJapanPackageItems();
    const now = new Date().toISOString();
    
    const updatedAllItems = allItems.map(item => {
      if (itemIdsSet.has(item.id)) {
        return {
          ...item,
          checked: checkedVal,
          checked_at: checkedVal ? now : (null as any),
          updated_at: now
        };
      }
      return item;
    });

    try {
      await dataProvider.saveJapanPackageItems(updatedAllItems);
      const updatedPackageItems = packageItems.map(item => itemIdsSet.has(item.id) ? {
        ...item,
        checked: checkedVal,
        checked_at: checkedVal ? now : undefined
      } : item);
      setPackageItems(updatedPackageItems);
      await checkAndAutoUpdateStatus(updatedPackageItems);
    } catch (e) {
      console.error(e);
      alert('批量修改點收狀態失敗！');
    }
  };

  // Group bulk operations with confirm check
  const handleGroupBulkCheck = async (groupTitle: string, items: JapanPackageItem[], checkedVal: boolean) => {
    if (items.length === 0) return;
    const actionText = checkedVal ? '已點收' : '未點收';
    const confirmMsg = `確定要將此群組 "${groupTitle}" ${items.length} 項商品全部標記為【${actionText}】嗎？`;
    if (window.confirm(confirmMsg)) {
      await handleBulkToggleCheck(items.map(x => x.id), checkedVal);
    }
  };

  // Whole package/page bulk operations with confirm check
  const handlePageBulkCheck = async (checkedVal: boolean) => {
    if (packageItems.length === 0) return;
    const actionText = checkedVal ? '已點收' : '未點收';
    const confirmMsg = `確定要將此包裹內所有 ${packageItems.length} 項商品全部標記為【${actionText}】嗎？`;
    if (window.confirm(confirmMsg)) {
      await handleBulkToggleCheck(packageItems.map(x => x.id), checkedVal);
    }
  };

  // Format timestamp safely to '上午/下午 HH:MM' format
  const formatCheckTime = (isoString?: string): string => {
    if (!isoString) return '';
    try {
      const date = new Date(isoString);
      const hours = date.getHours();
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const period = hours < 12 ? '上午' : '下午';
      const displayHours = hours % 12 === 0 ? 12 : hours % 12;
      return `${period} ${displayHours}:${minutes}`;
    } catch (e) {
      return '';
    }
  };

  function getProductGroupTitle(vId?: string) {
    if (!vId) return '';
    const v = variants.find(x => x.id === vId);
    if (!v) return '';
    const group = productGroups.find(g => g.id === v.product_group_id);
    return group ? cleanDisplayProductTitle(group.title) : '';
  }

  // Group items by product_group_id, fallback to product_title
  const groupedItems = useMemo(() => {
    const groups: Record<string, {
      id: string;
      title: string;
      items: JapanPackageItem[];
    }> = {};

    packageItems.forEach(item => {
      let groupId = item.product_group_id || '';
      let groupTitle = '';

      if (groupId) {
        const matchingGroup = productGroups.find(g => g.id === groupId);
        groupTitle = matchingGroup ? matchingGroup.title : (item.product_title || '未分類商品');
      } else {
        groupTitle = item.product_title || getProductGroupTitle(item.product_variant_id) || '未分類商品';
        groupId = `title-${groupTitle}`;
      }

      const cleanTitle = cleanDisplayProductTitle(groupTitle);

      if (!groups[groupId]) {
        groups[groupId] = {
          id: groupId,
          title: cleanTitle,
          items: []
        };
      }
      groups[groupId].items.push(item);
    });

    return Object.values(groups).sort((a, b) => a.title.localeCompare(b.title));
  }, [packageItems, productGroups]);

  useEffect(() => {
    if (id) {
      loadData(id || '');
    }
  }, [id]);

  const loadData = async (pkgId: string) => {
    setIsLoading(true);
    try {
      const allPkgs = await dataProvider.getJapanPackages();
      const currentPkg = allPkgs.find(p => p.id === pkgId);
      if (!currentPkg) {
        alert('找不到該包裹資料！');
        navigate('/japan-packages');
        return;
      }
      setPkg(currentPkg);
      setPkgForm({
        title: currentPkg.title || '',
        vendor_name: currentPkg.vendor_name || '',
        carrier: currentPkg.carrier || '',
        tracking_number: currentPkg.tracking_number || '',
        shipped_at: currentPkg.shipped_at || '',
        expected_arrival_at: currentPkg.expected_arrival_at || '',
        arrived_at: currentPkg.arrived_at || '',
        status: currentPkg.status || 'registered',
        note: currentPkg.note || ''
      });

      const allItems = await dataProvider.getJapanPackageItems();
      const currentItems = allItems.filter(item => item.japan_package_id === pkgId);
      setPackageItems(currentItems);

      // Load products metadata
      const [fetchedGroups, fetchedVars, fetchedCats, fetchedBatches, fetchedBatchItems, fetchedBundleComponents] = await Promise.all([
        dataProvider.getProductGroups().catch(() => []),
        dataProvider.getProductVariants().catch(() => []),
        dataProvider.getProductCategories().catch(() => []),
        dataProvider.getPurchaseBatches().catch(() => []),
        dataProvider.getPurchaseBatchItems().catch(() => []),
        dataProvider.getBundleComponents().catch(() => [])
      ]);

      setProductGroups(fetchedGroups || []);
      setVariants(fetchedVars || []);
      setCategories(fetchedCats || []);
      setBatches(fetchedBatches || []);
      setBatchItems(fetchedBatchItems || []);
      setBundleComponents(fetchedBundleComponents || []);
    } catch (e) {
      console.error('Failed to load package details:', e);
    } finally {
      setIsLoading(false);
    }
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.import-group-select-container')) {
        setIsImportDropdownOpen(false);
      }
      if (!target.closest('.selected-group-select-container')) {
        setIsSelectedDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Split text into tokens for similarity match (supporting CJK and English)
  const tokenize = (text: string): string[] => {
    if (!text) return [];
    const rawTokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    const tokens: string[] = [];
    
    rawTokens.forEach(t => {
      // English words
      const engMatches = t.match(/[a-zA-Z0-9’']+/g) || [];
      engMatches.forEach(m => tokens.push(m));
      
      // CJK characters
      const cjkMatches = t.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]+/g) || [];
      cjkMatches.forEach(m => {
        tokens.push(m);
        if (m.length > 1) {
          for (let i = 0; i < m.length; i++) {
            tokens.push(m[i]);
          }
        }
      });
    });
    
    return Array.from(new Set(tokens)).filter(t => t.length > 1 || /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]/.test(t));
  };

  // Score a product group based on current query or package properties
  const getProductGroupScore = (g: ProductGroup, query: string): number => {
    const titleLower = (g.title || '').toLowerCase();
    
    if (query.trim()) {
      const qClean = query.trim().toLowerCase();
      let score = 0;
      
      // Rule 1: 商品群組 title 完整包含搜尋字：+100
      if (titleLower.includes(qClean)) {
        score += 100;
      }
      // Rule 2: 搜尋字完整包含在 title：+100
      if (qClean.includes(titleLower)) {
        score += 100;
      }
      
      // Blank split search terms matching:
      const terms = qClean.split(/\s+/).filter(Boolean);
      terms.forEach(term => {
        if (titleLower.includes(term)) {
          score += 50;
        }
      });
      return score;
    } else {
      // Recommendation score based on package properties (title, vendor, note)
      let score = 0;
      
      // Match keywords in package title
      const pkgTitle = pkg?.title || '';
      const titleTokens = tokenize(pkgTitle);
      titleTokens.forEach(t => {
        if (titleLower.includes(t)) {
          score += 20; // 每個 +20
        }
      });

      // Match keywords in package note
      const pkgNote = pkg?.note || '';
      const noteTokens = tokenize(pkgNote);
      noteTokens.forEach(t => {
        if (titleLower.includes(t)) {
          score += 5;
        }
      });
      
      // Match vendor name
      if (pkg?.vendor_name) {
        const vendorClean = pkg.vendor_name.toLowerCase().trim();
        if (vendorClean && titleLower.includes(vendorClean)) {
          score += 15; // title 包含 vendor_name：+15
        }
      }
      
      return score;
    }
  };

  // Memos for sorted product groups (top 30)
  const sortedImportGroups = useMemo(() => {
    const scored = productGroups.map(g => ({
      g,
      score: getProductGroupScore(g, importGroupSearch)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30);
  }, [productGroups, importGroupSearch, pkg]);

  const sortedSelectedGroups = useMemo(() => {
    const scored = productGroups.map(g => ({
      g,
      score: getProductGroupScore(g, selectedGroupSearch)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30);
  }, [productGroups, selectedGroupSearch, pkg]);

  const getDisplaySearchValue = (groupId: string, query: string, isOpen: boolean) => {
    if (isOpen) return query;
    if (!groupId) return '';
    const g = productGroups.find(x => x.id === groupId);
    return g ? cleanDisplayProductTitle(g.title) : '';
  };

  // Tracking link Yamato / Sagawa / JP Post
  const getTrackingUrl = (carrier: string, trackingNumber: string) => {
    if (!trackingNumber) return null;
    const cleanNum = trackingNumber.trim();
    const c = (carrier || '').toLowerCase();
    if (c.includes('yamato') || c.includes('ヤマト') || c.includes('黑貓') || c.includes('宅急便') || c.includes('大和')) {
      return `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?document_no=${cleanNum}`;
    }
    if (c.includes('sagawa') || c.includes('佐川')) {
      return `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${cleanNum}`;
    }
    if (c.includes('post') || c.includes('jp') || c.includes('郵便') || c.includes('ems')) {
      return `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${cleanNum}`;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(carrier + ' ' + cleanNum)}`;
  };

  // Status handler to auto-fill arrived_at today
  const handleFormStatusChange = (statusVal: string) => {
    let arrivedAtVal = pkgForm.arrived_at;
    if ((statusVal === 'arrived' || statusVal === 'confirmed') && !arrivedAtVal) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      arrivedAtVal = `${yyyy}-${mm}-${dd}`;
    }
    setPkgForm({ ...pkgForm, status: statusVal, arrived_at: arrivedAtVal });
  };

  const handleSavePkgDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pkg || !id) return;
    setIsSaving(true);

    const updatedPkg: JapanPackage = {
      ...pkg,
      title: pkgForm.title.trim(),
      vendor_name: pkgForm.vendor_name.trim() || undefined,
      carrier: pkgForm.carrier.trim() || undefined,
      tracking_number: pkgForm.tracking_number.trim() || undefined,
      shipped_at: pkgForm.shipped_at || undefined,
      expected_arrival_at: pkgForm.expected_arrival_at || undefined,
      arrived_at: pkgForm.arrived_at || undefined,
      status: pkgForm.status,
      note: pkgForm.note.trim() || undefined,
      updated_at: new Date().toISOString()
    };

    try {
      const allPkgs = await dataProvider.getJapanPackages();
      const updatedList = allPkgs.map(p => p.id === id ? updatedPkg : p);
      await dataProvider.saveJapanPackages(updatedList);
      setPkg(updatedPkg);
      alert('保存包裹成功！');
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        await loadData(id || '');
      } else {
        alert('保存失敗，請重試！');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Checkbox confirmation toggling
  const handleToggleCheck = async (itemId: string, checkedVal: boolean) => {
    const allItems = await dataProvider.getJapanPackageItems();
    const now = new Date().toISOString();
    const updatedAllItems = allItems.map(item => {
      if (item.id === itemId) {
        return {
          ...item,
          checked: checkedVal,
          checked_at: checkedVal ? now : (null as any),
          updated_at: now
        };
      }
      return item;
    });

    try {
      await dataProvider.saveJapanPackageItems(updatedAllItems);
      const updatedPackageItems = packageItems.map(item => item.id === itemId ? {
        ...item,
        checked: checkedVal,
        checked_at: checkedVal ? now : undefined
      } : item);
      setPackageItems(updatedPackageItems);
      await checkAndAutoUpdateStatus(updatedPackageItems);
    } catch (e) {
      console.error(e);
      alert('同步勾選狀態失敗！');
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!window.confirm('確定要從包裹中移除此商品嗎？')) return;
    try {
      const allItems = await dataProvider.getJapanPackageItems();
      const updatedAllItems = allItems.filter(item => item.id !== itemId);
      await dataProvider.saveJapanPackageItems(updatedAllItems);
      const updatedPackageItems = packageItems.filter(item => item.id !== itemId);
      setPackageItems(updatedPackageItems);
      await checkAndAutoUpdateStatus(updatedPackageItems);
    } catch (e) {
      alert('移除商品失敗！');
    }
  };

  // Method A: Select product group and load its batches & items
  const handleImportGroupChange = (groupId: string) => {
    setImportGroupId(groupId);
    setExpandedBatchIds(new Set());
    if (!groupId) {
      setBatchImportLines([]);
      return;
    }
    // Filter batches that belong to this group
    const groupBatches = batches.filter(b => b.product_group_id === groupId);
    const groupBatchIds = new Set(groupBatches.map(b => b.id));

    // Get all batch items in these batches
    const items = batchItems.filter(bi => groupBatchIds.has(bi.purchase_batch_id));
    const lines = items.map(bi => ({
      purchase_batch_id: bi.purchase_batch_id,
      purchase_batch_item_id: bi.id,
      product_variant_id: bi.product_variant_id,
      selected: false, // Default to unchecked per requirement 1
      quantity: bi.quantity
    }));
    setBatchImportLines(lines);
  };

  const handleToggleBatchSelect = (batchId: string, checked: boolean) => {
    setBatchImportLines(prev => prev.map(line => {
      if (line.purchase_batch_id === batchId) {
        // Skip checking if already imported to prevent duplicates
        if (existingBatchItemIds.has(line.purchase_batch_item_id)) {
          return line;
        }
        return { ...line, selected: checked };
      }
      return line;
    }));
  };

  const handleToggleItemSelect = (batchItemId: string, checked: boolean) => {
    setBatchImportLines(prev => prev.map(line => {
      if (line.purchase_batch_item_id === batchItemId) {
        return { ...line, selected: checked };
      }
      return line;
    }));
  };

  const handleItemQtyChange = (batchItemId: string, qty: number) => {
    setBatchImportLines(prev => prev.map(line => {
      if (line.purchase_batch_item_id === batchItemId) {
        return { ...line, quantity: qty };
      }
      return line;
    }));
  };

  const toggleBatchExpanded = (batchId: string) => {
    setExpandedBatchIds(prev => {
      const next = new Set(prev);
      if (next.has(batchId)) {
        next.delete(batchId);
      } else {
        next.add(batchId);
      }
      return next;
    });
  };

  const handleBatchImportSubmit = async () => {
    if (!id || !pkg) return;
    
    // Filter to selected lines that are not already imported in this package
    const selectedLines = batchImportLines.filter(
      l => l.selected && l.quantity > 0 && !existingBatchItemIds.has(l.purchase_batch_item_id)
    );
    
    if (selectedLines.length === 0) {
      alert('請先選擇要匯入的商品（已在包裹中的商品無法重複加入）！');
      return;
    }

    try {
      const allItems = await dataProvider.getJapanPackageItems();
      const newItems: JapanPackageItem[] = [];

      selectedLines.forEach(line => {
        const bi = batchItems.find(item => item.id === line.purchase_batch_item_id);
        const variant = variants.find(v => v.id === line.product_variant_id);
        if (!variant) return;
        
        const group = productGroups.find(g => g.id === variant.product_group_id);
        const category = categories.find(c => c.id === variant.product_category_id);

        const newItem: JapanPackageItem = {
          id: crypto.randomUUID(),
          japan_package_id: id,
          product_group_id: variant.product_group_id,
          product_variant_id: variant.id,
          purchase_batch_id: line.purchase_batch_id,
          purchase_batch_item_id: line.purchase_batch_item_id,
          product_title: group?.title || '',
          category_name: category?.title || '',
          variant_name: variant.variant_name || '',
          sku: variant.myacg_item_code || '',
          quantity: line.quantity,
          note: bi?.note || '',
          checked: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        newItems.push(newItem);
      });

      const updatedAllItems = [...allItems, ...newItems];
      await dataProvider.saveJapanPackageItems(updatedAllItems);

      // Reload package items
      const updatedPackageItems = [...packageItems, ...newItems];
      setPackageItems(updatedPackageItems);
      await checkAndAutoUpdateStatus(updatedPackageItems);
      
      // Reset state
      setImportGroupId('');
      setBatchImportLines([]);
      setExpandedBatchIds(new Set());
      alert(`成功將 ${newItems.length} 項商品從採購批次加入包裹！`);
    } catch (e) {
      console.error(e);
      alert('匯入失敗！');
    }
  };

  // Method B: Manual import
  const handleGroupSelect = (groupId: string) => {
    setSelectedGroupId(groupId);
    setVariantFilterSearch('');
    setCardQuantities({});
  };

  const filteredVariants = useMemo(() => {
    if (!selectedGroupId) return [];
    const groupVars = variants.filter(v => v.product_group_id === selectedGroupId);
    
    if (!variantFilterSearch.trim()) return groupVars;
    
    const filterLower = variantFilterSearch.trim().toLowerCase();
    return groupVars.filter(v => {
      const cat = categories.find(c => c.id === v.product_category_id);
      const catName = (cat?.title || '').toLowerCase();
      const varName = (v.variant_name || '').toLowerCase();
      const sku = (v.myacg_item_code || '').toLowerCase();
      
      return catName.includes(filterLower) || varName.includes(filterLower) || sku.includes(filterLower);
    });
  }, [variants, selectedGroupId, variantFilterSearch, categories]);

  const handleAddCardItem = async (variantId: string, quantity: number) => {
    if (!id || !variantId || quantity <= 0) return;

    const variant = variants.find(v => v.id === variantId);
    if (!variant) return;

    const group = productGroups.find(g => g.id === variant.product_group_id);
    const category = categories.find(c => c.id === variant.product_category_id);

    const newItem: JapanPackageItem = {
      id: crypto.randomUUID(),
      japan_package_id: id,
      product_group_id: variant.product_group_id,
      product_variant_id: variant.id,
      product_title: group?.title || '',
      category_name: category?.title || '',
      variant_name: variant.variant_name || '',
      sku: variant.myacg_item_code || '',
      quantity: quantity,
      note: '',
      checked: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    try {
      const allItems = await dataProvider.getJapanPackageItems();
      const updatedAllItems = [...allItems, newItem];
      await dataProvider.saveJapanPackageItems(updatedAllItems);

      const updatedPackageItems = [...packageItems, newItem];
      setPackageItems(updatedPackageItems);
      await checkAndAutoUpdateStatus(updatedPackageItems);
      alert('加入商品成功！');
    } catch (err) {
      alert('加入商品失敗！');
    }
  };


  const getBatchName = (batchId?: string) => {
    if (!batchId) return '-';
    const batch = batches.find(b => b.id === batchId);
    if (!batch) return '-';
    return batch.date ? `${batch.date} ${batch.name}` : batch.name;
  };

  const getBatchItemLabel = (vId: string) => {
    const v = variants.find(x => x.id === vId);
    if (!v) return '未知商品';
    const cat = categories.find(c => c.id === v.product_category_id);
    const catName = cat?.title || '';
    const varName = v.variant_name || '';
    return [catName, varName].filter(Boolean).join(' - ');
  };

  // Checked stats
  const checkedStats = useMemo(() => {
    const totalCount = packageItems.length;
    const checkedCount = packageItems.filter(item => item.checked).length;
    const totalQty = packageItems.reduce((sum, item) => sum + item.quantity, 0);
    const checkedQty = packageItems.filter(item => item.checked).reduce((sum, item) => sum + item.quantity, 0);
    
    return {
      totalCount,
      checkedCount,
      totalQty,
      checkedQty,
      allChecked: totalCount > 0 && totalCount === checkedCount
    };
  }, [packageItems]);

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'registered': return 'badge-neutral';
      case 'arrived': return 'badge-info';
      case 'confirmed': return 'badge-success';
      case 'problem': return 'badge-danger';
      default: return 'badge-neutral';
    }
  };

  const getStatusName = (status: string) => {
    switch (status) {
      case 'registered': return '已登記';
      case 'arrived': return '已到小幫手家';
      case 'confirmed': return '已點收';
      case 'problem': return '有問題';
      default: return status;
    }
  };

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 20px', color: '#64748b' }}>
        <Clock size={28} style={{ animation: 'spin 1.5s infinite linear' }} />
        <p style={{ marginTop: '12px' }}>載入包裹詳情中...</p>
      </div>
    );
  }

  if (!pkg) return null;

  if (isMobile) {
    return (
      <div className="container" style={{ padding: '16px 16px 80px 16px', background: '#f8fafc', minHeight: '100vh', boxSizing: 'border-box', maxWidth: 'none', width: '100%', margin: '0' }}>
        <style>{`
          .badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
          }
          .badge-success { background: #d1fae5; color: #065f46; }
          .badge-warning { background: #fef3c7; color: #92400e; }
          .badge-danger { background: #fee2e2; color: #991b1b; }
          .badge-info { background: #e0f2fe; color: #075985; }
          .badge-neutral { background: #f1f5f9; color: #334155; }
          .form-group {
            margin-bottom: 14px;
          }
          .form-label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: #475569;
            margin-bottom: 6px;
          }
          .input {
            width: 100%;
            height: 38px;
            padding: 8px 12px;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            font-size: 14px;
            outline: none;
            transition: border-color 0.15s;
            background: #fff;
            box-sizing: border-box;
          }
          .input:focus {
            border-color: #2563eb;
          }
          .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 8px 16px;
            font-size: 14px;
            font-weight: 600;
            border-radius: 6px;
            border: 1px solid transparent;
            cursor: pointer;
            transition: all 0.15s;
          }
          .btn-primary {
            background: #2563eb;
            color: #fff;
          }
          .btn-primary:hover {
            background: #1d4ed8;
          }
          .btn-outline {
            border-color: #cbd5e1;
            background: #fff;
            color: #475569;
          }
          .btn-outline:hover {
            background: #f8fafc;
          }
        `}</style>

        {/* Back button */}
        <div 
          onClick={() => navigate('/japan-packages')} 
          style={{ 
            marginBottom: '16px', 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            color: '#64748b', 
            fontSize: '14px', 
            cursor: 'pointer',
            fontWeight: 500
          }}
        >
          <ArrowLeft size={16} />
          返回日本包裹列表
        </div>

        <div className="mobile-detail-layout" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* 1. 包裹資訊區 (Collapsible) */}
          <div className="mobile-pkg-info-card" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <div 
              style={{ padding: '16px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '10px', borderBottom: mobileInfoExpanded ? '1px solid #f1f5f9' : 'none' }}
              onClick={() => setMobileInfoExpanded(!mobileInfoExpanded)}
            >
              {/* Row 1: Title (up to 2 lines) */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 }}>
                <Truck size={18} style={{ color: '#2563eb', flexShrink: 0, marginTop: '2px' }} />
                <span style={{ 
                  fontWeight: 700, 
                  fontSize: '15px', 
                  color: '#0f172a',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'normal',
                  wordBreak: 'break-all',
                  flex: 1
                }}>
                  {pkg.title}
                </span>
              </div>

              {/* Row 2: Status Badge + Expand/Collapse Button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', paddingLeft: '26px', flexWrap: 'wrap' }}>
                <span className={`badge ${getStatusBadgeClass(pkg.status)}`} style={{ fontSize: '11px', padding: '2px 8px' }}>
                  {getStatusName(pkg.status)}
                </span>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 600 }}>
                  {mobileInfoExpanded ? '收合 ▲' : '展開 ▼'}
                </span>
                
                {/* Quick Status Buttons */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '6px', width: '100%' }}>
                  <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>快速切換：</span>
                  {['registered', 'arrived', 'confirmed', 'problem'].map(st => {
                    const active = pkg.status === st;
                    return (
                      <button
                        key={st}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleQuickUpdateStatus(st);
                        }}
                        style={{
                          padding: '3px 8px',
                          fontSize: '11px',
                          borderRadius: '4px',
                          border: '1px solid',
                          borderColor: active ? 'transparent' : '#cbd5e1',
                          background: active ? '#2563eb' : '#ffffff',
                          color: active ? '#ffffff' : '#475569',
                          fontWeight: active ? 700 : 500,
                          cursor: 'pointer',
                          lineHeight: 1
                        }}
                      >
                        {getStatusName(st)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Row 3: Progress text */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: '#475569', marginTop: '2px' }}>
                <span>總進度：{checkedStats.checkedQty} / {checkedStats.totalQty} 已完成</span>
                <span>{checkedStats.totalQty > 0 ? Math.round((checkedStats.checkedQty / checkedStats.totalQty) * 100) : 0}%</span>
              </div>

              {/* Row 4: Progress Bar */}
              <div style={{ width: '100%', height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden' }}>
                <div 
                  style={{ 
                    width: `${checkedStats.totalQty > 0 ? (checkedStats.checkedQty / checkedStats.totalQty) * 100 : 0}%`, 
                    height: '100%', 
                    background: '#10b981', 
                    borderRadius: '4px' 
                  }} 
                />
              </div>
            </div>
            {mobileInfoExpanded && (
              <div style={{ padding: '16px', background: '#f8fafc' }}>
                <form onSubmit={handleSavePkgDetails}>
                  <div className="form-group">
                    <label className="form-label">包裹名稱 *</label>
                    <input 
                      type="text" 
                      className="input" 
                      required
                      value={pkgForm.title}
                      onChange={e => setPkgForm({ ...pkgForm, title: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">寄件廠商</label>
                    <input 
                      type="text" 
                      className="input" 
                      placeholder="例如: Booth"
                      value={pkgForm.vendor_name}
                      onChange={e => setPkgForm({ ...pkgForm, vendor_name: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">物流狀態</label>
                    <select 
                      className="input"
                      value={pkgForm.status}
                      onChange={e => handleFormStatusChange(e.target.value)}
                    >
                      <option value="registered">已登記 (registered)</option>
                      <option value="arrived">已到小幫手家 (arrived)</option>
                      <option value="confirmed">已點收 (confirmed)</option>
                      <option value="problem">有問題 (problem)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">日本國內物流</label>
                    <input 
                      type="text" 
                      className="input" 
                      placeholder="例如: ヤマト運輸 (Yamato)"
                      value={pkgForm.carrier}
                      onChange={e => setPkgForm({ ...pkgForm, carrier: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">追蹤單號</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input 
                        type="text" 
                        className="input" 
                        placeholder="物流單號"
                        value={pkgForm.tracking_number}
                        onChange={e => setPkgForm({ ...pkgForm, tracking_number: e.target.value })}
                      />
                      {pkgForm.tracking_number && (() => {
                        const url = getTrackingUrl(pkgForm.carrier, pkgForm.tracking_number);
                        return url ? (
                          <a 
                            href={url} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            className="btn btn-outline" 
                            style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            title="日本物流官網查詢"
                          >
                            <ExternalLink size={16} />
                          </a>
                        ) : null;
                      })()}
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">寄出日期</label>
                    <input 
                      type="date" 
                      className="input" 
                      value={pkgForm.shipped_at}
                      onChange={e => setPkgForm({ ...pkgForm, shipped_at: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">實際抵達日期 (Arrived At)</label>
                    <input 
                      type="date" 
                      className="input" 
                      value={pkgForm.arrived_at}
                      onChange={e => setPkgForm({ ...pkgForm, arrived_at: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">備註說明</label>
                    <textarea 
                      className="input" 
                      placeholder="請輸入此包裹的備註資訊..."
                      rows={2}
                      value={pkgForm.note}
                      onChange={e => setPkgForm({ ...pkgForm, note: e.target.value })}
                      style={{ resize: 'vertical', height: 'auto' }}
                    />
                  </div>

                  <button 
                    type="submit" 
                    className="btn btn-primary" 
                    style={{ width: '100%', marginTop: '10px', height: '38px', borderRadius: '8px' }}
                    disabled={isSaving}
                  >
                    <Save size={16} />
                    {isSaving ? '保存中...' : '保存包裹資訊'}
                  </button>
                </form>
              </div>
            )}
          </div>

          {/* 2. 商品清單依活動分組 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '0 4px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Package size={18} style={{ color: '#2563eb' }} />
                <span style={{ fontSize: '15px', fontWeight: 700 }}>商品點收清單</span>
              </div>
              {packageItems.length > 0 && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: '#475569', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={showDetailedInfo}
                    onChange={(e) => setShowDetailedInfo(e.target.checked)}
                    style={{ width: '15px', height: '15px', cursor: 'pointer' }}
                  />
                  顯示詳細資訊
                </label>
              )}
            </div>

            {packageItems.length === 0 ? (
              <div style={{ padding: '40px 10px', textAlign: 'center', color: '#64748b', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px' }}>
                <Info size={36} style={{ color: '#cbd5e1', marginBottom: '8px' }} />
                <p style={{ fontSize: '13px' }}>包裹內尚無任何商品。</p>
              </div>
            ) : (
              groupedItems.map(g => {
                const isExpanded = mobileExpandedGroups.has(g.id);
                const totalGroupQty = g.items.reduce((sum, item) => sum + item.quantity, 0);
                const checkedGroupQty = g.items.filter(item => item.checked).reduce((sum, item) => sum + item.quantity, 0);
                const percent = totalGroupQty > 0 ? Math.round((checkedGroupQty / totalGroupQty) * 100) : 0;

                return (
                  <div key={g.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.02)' }}>
                    {/* Group Header */}
                    <div 
                      style={{ padding: '12px 14px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '6px' }}
                      onClick={() => toggleMobileGroupExpand(g.id)}
                    >
                      {/* First Line: Title + Arrow right-aligned */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        <span style={{ 
                          fontSize: '14px', 
                          fontWeight: 700, 
                          color: '#1e293b', 
                          display: '-webkit-box', 
                          WebkitLineClamp: 2, 
                          WebkitBoxOrient: 'vertical', 
                          overflow: 'hidden', 
                          textOverflow: 'ellipsis', 
                          whiteSpace: 'normal', 
                          wordBreak: 'break-all', 
                          flex: 1 
                        }}>
                          📦 {g.title}
                        </span>
                        <span style={{ 
                          fontSize: '12px', 
                          color: '#64748b', 
                          transition: 'transform 0.2s', 
                          transform: isExpanded ? 'rotate(90deg)' : 'none', 
                          display: 'inline-block',
                          flexShrink: 0,
                          marginTop: '4px'
                        }}>
                          ▶
                        </span>
                      </div>

                      {/* Second Line: Stats */}
                      <div style={{ fontSize: '12.5px', color: '#475569', fontWeight: 600 }}>
                        已完成 {checkedGroupQty} / {totalGroupQty}・共 {totalGroupQty} 件・{percent}%
                      </div>

                      {/* Third Line: Full-width Progress Bar */}
                      <div style={{ width: '100%', height: '6px', background: '#e2e8f0', borderRadius: '3px', overflow: 'hidden', marginTop: '2px' }}>
                        <div style={{ width: `${percent}%`, height: '100%', background: '#10b981', borderRadius: '3px' }} />
                      </div>
                    </div>

                    {/* Group Items (Body) */}
                    {isExpanded && (
                      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px', background: '#fafafa' }}>
                        {g.items.map(item => {
                          const catAndVariant = [item.category_name, item.variant_name].filter(Boolean).join(' - ') 
                            || getBatchItemLabel(item.product_variant_id || '');
                          const v = variants.find(x => x.id === item.product_variant_id);
                          const bundleComps = v ? getBundleComponents(v) : [];
                          const isBundleExpanded = expandedBundleItems.has(item.id);
                          return (
                            <div 
                              key={item.id} 
                              style={{ 
                                display: 'flex', 
                                alignItems: 'flex-start', 
                                gap: '10px', 
                                padding: '12px 14px', 
                                background: item.checked ? '#f0fdf4' : '#ffffff', 
                                border: '1px solid',
                                borderColor: item.checked ? '#bbf7d0' : '#e2e8f0',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                              }}
                              onClick={() => handleToggleCheck(item.id, !item.checked)}
                            >
                              {/* Checkbox */}
                              <div 
                                style={{ 
                                  width: '24px', 
                                  height: '24px', 
                                  borderRadius: '6px', 
                                  border: '2px solid',
                                  borderColor: item.checked ? '#10b981' : '#cbd5e1',
                                  background: item.checked ? '#10b981' : '#fff',
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  justifyContent: 'center',
                                  color: '#fff',
                                  flexShrink: 0,
                                  marginTop: '2px'
                                }}
                              >
                                {item.checked && <CheckSquare size={16} />}
                              </div>

                              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', minWidth: 0, padding: '2px 0' }}>
                                {/* Main Item spec title + quantity */}
                                <div style={{ fontWeight: 700, color: item.checked ? '#047857' : '#1e293b', wordBreak: 'break-all', fontSize: '14px', lineHeight: 1.3 }}>
                                  <span>{catAndVariant}</span>
                                  <span style={{ marginLeft: '8px', color: '#2563eb', fontWeight: 800 }}>
                                    ×{item.quantity}
                                  </span>
                                </div>

                                {/* Source always visible, SKU completely removed */}
                                <div style={{ color: '#475569', fontSize: '12px', lineHeight: 1.3 }}>
                                  來源：<strong style={{ color: '#2563eb' }}>{getBatchName(item.purchase_batch_id) || '-'}</strong>
                                </div>

                                {/* Expand Button */}
                                {bundleComps.length > 0 && (
                                  <div style={{ marginTop: '2px' }} onClick={e => e.stopPropagation()}>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleBundleExpand(item.id, e);
                                      }}
                                      style={{
                                        padding: '3px 8px',
                                        fontSize: '11px',
                                        background: isBundleExpanded ? '#f1f5f9' : '#eff6ff',
                                        color: isBundleExpanded ? '#475569' : '#1d4ed8',
                                        border: '1px solid',
                                        borderColor: isBundleExpanded ? '#cbd5e1' : '#bfdbfe',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontWeight: 600,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '4px'
                                      }}
                                    >
                                      {isBundleExpanded ? '▲ 套組內容' : '▼ 套組內容'}
                                      <span style={{ fontSize: '10px', opacity: 0.85 }}>({bundleComps.length})</span>
                                    </button>
                                  </div>
                                )}

                                {/* Child bundle components card display */}
                                {bundleComps.length > 0 && isBundleExpanded && (
                                  <div 
                                    style={{
                                      marginTop: '4px',
                                      fontSize: '12.5px',
                                      color: '#475569',
                                      backgroundColor: '#f1f5f9',
                                      padding: '8px 12px',
                                      borderRadius: '6px',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: '4px',
                                      border: '1px solid #e2e8f0'
                                    }}
                                    onClick={e => e.stopPropagation()}
                                  >
                                    <div style={{ fontWeight: 700, color: '#334155', marginBottom: '2px' }}>
                                      📦 套組內容 ({bundleComps.length})
                                    </div>
                                    {bundleComps.map((comp) => {
                                      const compLabel = comp.variant_name || '單品';
                                      return (
                                        <div key={comp.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '2px' }}>
                                          <span style={{ color: '#94a3b8' }}>•</span>
                                          <span style={{ fontWeight: 500 }}>{compLabel}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}

                                {item.note && (
                                  <div style={{ fontSize: '11.5px', color: '#dc2626', fontWeight: 600, marginTop: '4px', backgroundColor: '#fef2f2', padding: '4px 8px', borderRadius: '4px', border: '1px solid #fee2e2', width: 'fit-content' }}>
                                    備註：{item.note}
                                  </div>
                                )}

                                {/* Checked Timestamp (only visible when checked and showDetailedInfo checked) */}
                                {showDetailedInfo && item.checked && item.checked_at && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#10b981', marginTop: '4px', fontWeight: 600 }}>
                                    <CheckCircle2 size={12} />
                                    <span>已點收：{formatCheckTime(item.checked_at)}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Sticky Mobile Footer Action Bar */}
          <div style={{ 
            position: 'fixed', 
            bottom: 0, 
            left: 0, 
            right: 0, 
            background: 'rgba(255, 255, 255, 0.95)', 
            backdropFilter: 'blur(8px)',
            borderTop: '1px solid #e2e8f0', 
            padding: '12px 16px', 
            zIndex: 999, 
            display: 'flex', 
            justifyContent: 'center', 
            boxShadow: '0 -4px 12px rgba(0,0,0,0.05)' 
          }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', maxWidth: '400px', height: '44px', borderRadius: '8px', fontSize: '15px', fontWeight: 700 }}
              onClick={(e) => {
                e.stopPropagation();
                handlePageBulkCheck(true);
              }}
              disabled={packageItems.length === 0}
            >
              全部標記為已點收
            </button>
          </div>
        </div>
        <div 
          style={{ 
            position: 'fixed', 
            bottom: '10px', 
            right: '10px', 
            background: 'rgba(15, 23, 42, 0.8)', 
            color: '#ffffff', 
            padding: '4px 8px', 
            borderRadius: '4px', 
            fontSize: '11px', 
            zIndex: 99999,
            pointerEvents: 'none',
            fontFamily: 'monospace'
          }}
        >
          JapanDetail UI v2.2
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px 0', maxWidth: 'none', width: '100%', margin: '0' }}>
      <style>{`
        .custom-select-container {
          position: relative;
          width: 100%;
        }
        .dropdown-menu {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.08);
          max-height: 250px;
          overflow-y: auto;
          z-index: 1000;
          margin-top: 4px;
        }
        .dropdown-item {
          transition: background-color 0.15s;
        }
        .dropdown-item:hover {
          background-color: #f1f5f9;
        }
        .checklist-group {
          margin-bottom: 28px;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          overflow: hidden;
          background: #fff;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02), 0 2px 4px -1px rgba(0,0,0,0.01);
        }
        .checklist-group-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 18px 26px;
          background: #f8fafc;
          border-bottom: 2px solid #e2e8f0;
          cursor: pointer;
          user-select: none;
          font-weight: 700;
          color: #1e293b;
          font-size: 18px;
          transition: background-color 0.15s;
          flex-wrap: wrap;
          gap: 12px;
        }
        .checklist-group-header:hover {
          background: #f1f5f9;
        }
        .checklist-group-title-area {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 1;
          min-width: 200px;
        }
        .group-header-right {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-shrink: 0;
          flex-wrap: wrap;
        }
        .group-progress-wrapper {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .group-progress-text {
          font-size: 14px;
          color: #475569;
          font-weight: 600;
        }
        .group-progress-bar-bg {
          width: 150px;
          height: 9px;
          background-color: #cbd5e1;
          border-radius: 9999px;
          overflow: hidden;
        }
        .group-progress-bar-fill {
          height: 100%;
          background-color: #10b981;
          border-radius: 9999px;
          transition: width 0.3s ease;
        }
        .group-bulk-actions {
          display: flex;
          gap: 6px;
        }
        .btn-bulk {
          padding: 5px 12px;
          font-size: 13px;
          font-weight: 600;
          background: #fff;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          color: #475569;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .btn-bulk:hover {
          background: #f3f4f6;
          border-color: #9ca3af;
          color: #1f2937;
        }
        .checklist-item-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          padding: 20px 26px;
          border-bottom: 1px solid #f1f5f9;
          background-color: #ffffff;
          border-left: 4px solid transparent;
          transition: all 0.15s ease;
        }
        .checklist-item-row:last-child {
          border-bottom: none;
        }
        .checklist-item-row:hover {
          background-color: #f8fafc;
        }
        .checklist-item-row.checked {
          background-color: #f0fdf4;
          border-left-color: #10b981;
        }
        .checklist-item-row.checked:hover {
          background-color: #e6fced;
        }
        .checklist-item-left {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          flex: 1;
          min-width: 0;
        }
        .checklist-item-content {
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex: 1;
          min-width: 0;
        }
        .checklist-item-header {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .checklist-item-title {
          font-size: 17px;
          font-weight: 700;
          color: #0f172a;
        }
        .checklist-item-title.checked {
          text-decoration: line-through;
          color: #64748b;
        }
        .checklist-item-qty {
          font-size: 17px;
          font-weight: 800;
          color: #2563eb;
        }
        .checklist-item-qty.checked {
          color: #64748b;
        }
        .checklist-item-meta-row {
          font-size: 13.5px;
          color: #64748b;
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          font-weight: 500;
        }
        .checklist-item-checked-row {
          font-size: 13.5px;
          color: #059669;
          font-weight: 600;
          margin-top: 2px;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .clamp-2 {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-overflow: ellipsis;
          word-break: break-all;
          white-space: normal;
        }
        .nowrap-ellipsis {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
          display: block;
        }
        .back-link {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: #64748b;
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          margin-bottom: 20px;
          cursor: pointer;
        }
        .back-link:hover {
          color: #0f172a;
        }
        .page-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          flex-wrap: wrap;
          gap: 12px;
        }
        .pkg-title-section {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .pkg-title {
          font-size: 22px;
          font-weight: 700;
          color: #0f172a;
        }
        .detail-grid {
          display: flex;
          align-items: flex-start;
          gap: 24px;
        }
        .package-info-card {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 28px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          height: fit-content;
          width: 430px;
          flex-shrink: 0;
        }
        .package-info-card .input,
        .package-info-card select,
        .package-info-card textarea {
          font-size: 14.5px;
          height: 44px;
          padding: 8px 12px;
        }
        .package-info-card textarea {
          height: auto;
        }
        .package-info-card .btn {
          height: 44px;
          font-size: 15px;
        }
        .items-section-card {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 32px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          flex: 1;
          min-width: 0;
          margin-left: 0;
        }
        .section-subtitle {
          font-size: 16px;
          font-weight: 700;
          color: #1e293b;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .form-group {
          margin-bottom: 14px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        @media (min-width: 1025px) {
          .page-content-full {
            padding: 24px 12px !important;
          }
        }
        @media (min-width: 1400px) {
          .pkg-title {
            font-size: 26px !important;
          }
          .package-info-card {
            padding: 32px !important;
            width: 460px !important;
          }
          .package-info-card .input,
          .package-info-card select,
          .package-info-card textarea {
            font-size: 15.5px !important;
            height: 48px !important;
            padding: 10px 14px !important;
          }
          .package-info-card textarea {
            height: auto !important;
          }
          .package-info-card .btn {
            height: 48px !important;
            font-size: 16px !important;
          }
          .items-section-card {
            padding: 36px !important;
          }
          .checklist-group-header {
            padding: 22px 30px !important;
            font-size: 20px !important;
          }
          .checklist-item-row {
            padding: 24px 30px !important;
          }
          .checklist-item-title {
            font-size: 19px !important;
          }
          .checklist-item-qty {
            font-size: 19px !important;
          }
          .checklist-item-meta-row {
            font-size: 15px !important;
          }
          .checklist-item-checked-row {
            font-size: 15px !important;
          }
          .group-progress-text {
            font-size: 15.5px !important;
          }
          .group-progress-bar-bg {
            width: 180px !important;
            height: 11px !important;
          }
          .btn-bulk {
            padding: 7px 14px !important;
            font-size: 14.5px !important;
          }
        }
        @media (min-width: 2500px) {
          .pkg-title {
            font-size: 30px !important;
          }
          .package-info-card {
            padding: 36px !important;
            width: 500px !important;
          }
          .package-info-card .input,
          .package-info-card select,
          .package-info-card textarea {
            font-size: 17.5px !important;
            height: 54px !important;
            padding: 12px 18px !important;
          }
          .package-info-card textarea {
            height: auto !important;
          }
          .package-info-card .btn {
            height: 54px !important;
            font-size: 18px !important;
          }
          .items-section-card {
            padding: 42px !important;
          }
          .checklist-group-header {
            padding: 26px 36px !important;
            font-size: 22px !important;
          }
          .checklist-item-row {
            padding: 28px 36px !important;
          }
          .checklist-item-title {
            font-size: 21px !important;
          }
          .checklist-item-qty {
            font-size: 21px !important;
          }
          .checklist-item-meta-row {
            font-size: 17px !important;
          }
          .checklist-item-checked-row {
            font-size: 17px !important;
          }
          .group-progress-text {
            font-size: 17.5px !important;
          }
          .group-progress-bar-bg {
            width: 220px !important;
            height: 13px !important;
          }
          .btn-bulk {
            padding: 9px 18px !important;
            font-size: 16.5px !important;
          }
        }
        .form-label {
          font-size: 14px;
          font-weight: 600;
          color: #475569;
        }
        .tab-bar {
          display: flex;
          border-bottom: 1px solid #e2e8f0;
          margin-bottom: 20px;
        }
        .tab-btn {
          padding: 10px 16px;
          font-size: 14px;
          font-weight: 600;
          color: #64748b;
          border: none;
          background: none;
          cursor: pointer;
          border-bottom: 2px solid transparent;
        }
        .tab-btn.active {
          color: #2563eb;
          border-bottom-color: #2563eb;
        }
        .import-box {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 16px;
          margin-bottom: 24px;
        }
        /* Mobile Card */
        .mobile-item-card {
          border: 1px solid #e2e8f0;
          background: #fff;
          border-radius: 8px;
          padding: 12px 16px;
          margin-bottom: 10px;
          display: flex;
          align-items: flex-start;
          gap: 12px;
        }
        .mobile-item-checked {
          background-color: #f0fdf4;
          border-color: #bbf7d0;
        }
        @media (max-width: 1024px) {
          .detail-grid {
            flex-direction: column;
          }
          .package-info-card {
            width: 100%;
          }
        }
      `}</style>

      {/* Back button */}
      <div className="back-link" onClick={() => navigate('/japan-packages')}>
        <ArrowLeft size={16} />
        返回日本包裹列表
      </div>

      {/* Header */}
      <div className="page-header">
        <div className="pkg-title-section">
          <Truck size={24} style={{ color: '#2563eb' }} />
          <h1 className="pkg-title">{pkg.title}</h1>
          <span className={`badge ${getStatusBadgeClass(pkg.status)}`} style={{ fontSize: '13px', padding: '4px 10px' }}>
            {getStatusName(pkg.status)}
          </span>
          
          {/* Quick Status Buttons */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '16px' }}>
            <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 600 }}>快速切換：</span>
            {['registered', 'arrived', 'confirmed', 'problem'].map(st => {
              const active = pkg.status === st;
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => handleQuickUpdateStatus(st)}
                  style={{
                    padding: '3px 8px',
                    fontSize: '12px',
                    borderRadius: '4px',
                    border: '1px solid',
                    borderColor: active ? 'transparent' : '#cbd5e1',
                    background: active ? '#2563eb' : '#ffffff',
                    color: active ? '#ffffff' : '#475569',
                    fontWeight: active ? 700 : 500,
                    cursor: 'pointer'
                  }}
                >
                  {getStatusName(st)}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="detail-grid">
        {/* Left: Package details editor */}
        <div className="package-info-card">
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#1e293b', marginBottom: '16px', borderBottom: '1px solid #f1f5f9', paddingBottom: '10px' }}>
            包裹基本資訊
          </h2>
          <form onSubmit={handleSavePkgDetails}>
            <div className="form-group">
              <label className="form-label">包裹名稱 *</label>
              <input 
                type="text" 
                className="input" 
                required
                value={pkgForm.title}
                onChange={e => setPkgForm({ ...pkgForm, title: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">寄件廠商</label>
              <input 
                type="text" 
                className="input" 
                placeholder="例如: Booth"
                value={pkgForm.vendor_name}
                onChange={e => setPkgForm({ ...pkgForm, vendor_name: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">物流狀態</label>
              <select 
                className="input"
                value={pkgForm.status}
                onChange={e => handleFormStatusChange(e.target.value)}
              >
                <option value="registered">已登記 (registered)</option>
                <option value="arrived">已到小幫手家 (arrived)</option>
                <option value="confirmed">已點收 (confirmed)</option>
                <option value="problem">有問題 (problem)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">日本國內物流</label>
              <input 
                type="text" 
                className="input" 
                placeholder="例如: ヤマト運輸 (Yamato)"
                value={pkgForm.carrier}
                onChange={e => setPkgForm({ ...pkgForm, carrier: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">追蹤單號</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="物流單號"
                  value={pkgForm.tracking_number}
                  onChange={e => setPkgForm({ ...pkgForm, tracking_number: e.target.value })}
                />
                {pkgForm.tracking_number && (() => {
                  const url = getTrackingUrl(pkgForm.carrier, pkgForm.tracking_number);
                  return url ? (
                    <a 
                      href={url} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="btn btn-outline" 
                      style={{ padding: '6px 10px' }}
                      title="日本物流官網查詢"
                    >
                      <ExternalLink size={16} />
                    </a>
                  ) : null;
                })()}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">寄出日期</label>
              <input 
                type="date" 
                className="input" 
                value={pkgForm.shipped_at}
                onChange={e => setPkgForm({ ...pkgForm, shipped_at: e.target.value })}
              />
            </div>


            <div className="form-group">
              <label className="form-label">實際抵達日期 (Arrived At)</label>
              <input 
                type="date" 
                className="input" 
                value={pkgForm.arrived_at}
                onChange={e => setPkgForm({ ...pkgForm, arrived_at: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">備註說明</label>
              <textarea 
                className="input" 
                rows={3} 
                placeholder="包裹備註..."
                style={{ resize: 'vertical' }}
                value={pkgForm.note}
                onChange={e => setPkgForm({ ...pkgForm, note: e.target.value })}
              />
            </div>

            <button 
              type="submit" 
              className="btn btn-primary" 
              style={{ width: '100%', marginTop: '10px', height: '38px', borderRadius: '8px' }}
              disabled={isSaving}
            >
              <Save size={16} />
              {isSaving ? '保存中...' : '保存包裹資訊'}
            </button>
          </form>
        </div>

        {/* Right: Items detail and checking */}
        <div className="items-section-card">
          {/* Add items panel (Collapsible) */}
          <div 
            onClick={() => setIsImportCollapsed(!isImportCollapsed)}
            style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              cursor: 'pointer',
              paddingBottom: '14px',
              borderBottom: '1px solid #e2e8f0',
              marginBottom: '18px',
              userSelect: 'none'
            }}
          >
            <h2 style={{ fontSize: '17px', fontWeight: 700, color: '#1e293b', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Plus size={20} style={{ color: '#2563eb' }} />
              新增商品到此包裹
            </h2>
            <span style={{ fontSize: '14px', color: '#2563eb', fontWeight: 600 }}>
              {isImportCollapsed ? '展開搜尋與匯入 ⚡' : '收合面板 ✕'}
            </span>
          </div>
          
          {!isImportCollapsed && (
            <>
              <div className="tab-bar">
                <button 
                  className={`tab-btn ${activeAddTab === 'batch' ? 'active' : ''}`}
                  onClick={() => setActiveAddTab('batch')}
                >
                  從採購批次匯入
                </button>
                <button 
                  className={`tab-btn ${activeAddTab === 'manual' ? 'active' : ''}`}
                  onClick={() => setActiveAddTab('manual')}
                >
                  手動搜尋商品加入
                </button>
              </div>

              {activeAddTab === 'batch' ? (
                <div className="import-box">
                  <div className="form-group">
                    <label className="form-label">選擇商品群組 / 賣場</label>
                    <div className="import-group-select-container custom-select-container">
                      <input 
                        type="text" 
                        className="input" 
                        placeholder="輸入關鍵字搜尋或從推薦清單選擇..."
                        value={getDisplaySearchValue(importGroupId, importGroupSearch, isImportDropdownOpen)}
                        onChange={e => {
                          setImportGroupSearch(e.target.value);
                          setIsImportDropdownOpen(true);
                        }}
                        onFocus={() => {
                          setImportGroupSearch('');
                          setIsImportDropdownOpen(true);
                        }}
                      />
                      {importGroupId && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleImportGroupChange('');
                            setImportGroupSearch('');
                            setIsImportDropdownOpen(false);
                          }}
                          style={{
                            position: 'absolute',
                            right: '10px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#94a3b8',
                            fontSize: '18px',
                            fontWeight: 'bold',
                            padding: '4px',
                            zIndex: 10
                          }}
                        >
                          ×
                        </button>
                      )}
                      {isImportDropdownOpen && (
                        <div className="dropdown-menu">
                          {sortedImportGroups.length === 0 ? (
                            <div style={{ padding: '10px 14px', color: '#64748b', fontSize: '13px', textAlign: 'center' }}>
                              無匹配商品群組
                            </div>
                          ) : (
                            sortedImportGroups.map(({ g, score }) => {
                              const isRecommended = score > 0;
                              const badgeText = importGroupSearch.trim() ? '搜尋結果' : '相似度推薦';
                              return (
                                <div
                                  key={g.id}
                                  className="dropdown-item"
                                  onClick={() => {
                                    handleImportGroupChange(g.id);
                                    setIsImportDropdownOpen(false);
                                  }}
                                  style={{
                                    padding: '10px 14px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    borderBottom: '1px solid #f1f5f9'
                                  }}
                                >
                                  <span style={{ fontWeight: 500, color: '#334155', fontSize: '13px' }}>{cleanDisplayProductTitle(g.title)}</span>
                                  {isRecommended && (
                                    <span 
                                      style={{ 
                                        fontSize: '10px', 
                                        padding: '2px 6px', 
                                        borderRadius: '4px', 
                                        fontWeight: 600,
                                        background: importGroupSearch.trim() ? '#eff6ff' : '#ecfdf5',
                                        color: importGroupSearch.trim() ? '#2563eb' : '#059669',
                                        border: importGroupSearch.trim() ? '1px solid #bfdbfe' : '1px solid #a7f3d0'
                                      }}
                                    >
                                      {badgeText}
                                    </span>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {importGroupId && (() => {
                    const groupBatches = batches.filter(b => b.product_group_id === importGroupId);
                    if (groupBatches.length === 0) {
                      return (
                        <div style={{ padding: '16px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                          此商品群組目前無任何採購批次記錄
                        </div>
                      );
                    }

                    return (
                      <div style={{ marginTop: '16px' }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#334155', marginBottom: '10px' }}>
                          請勾選要匯入的採購批次及商品：
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {groupBatches.map(b => {
                            const linesInBatch = batchImportLines.filter(l => l.purchase_batch_id === b.id);
                            const importableLines = linesInBatch.filter(l => !existingBatchItemIds.has(l.purchase_batch_item_id));
                            const allSelected = importableLines.length > 0 && importableLines.every(l => l.selected);
                            const isBatchDisabled = importableLines.length === 0;
                            const showChecked = isBatchDisabled ? linesInBatch.length > 0 : allSelected;
                            const isExpanded = expandedBatchIds.has(b.id);
                            const totalQty = linesInBatch.reduce((sum, l) => sum + l.quantity, 0);

                            return (
                              <div 
                                key={b.id} 
                                style={{ 
                                  border: '1px solid #e2e8f0', 
                                  borderRadius: '8px', 
                                  background: '#fff',
                                  overflow: 'hidden'
                                }}
                              >
                                {/* Batch Header */}
                                <div 
                                  style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    justifyContent: 'space-between', 
                                    padding: '10px 14px', 
                                    background: '#f8fafc',
                                    borderBottom: isExpanded ? '1px solid #e2e8f0' : 'none',
                                    cursor: 'pointer'
                                  }}
                                  onClick={() => toggleBatchExpanded(b.id)}
                                >
                                  <div 
                                    style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
                                    onClick={e => e.stopPropagation()}
                                  >
                                    <input 
                                      type="checkbox"
                                      disabled={isBatchDisabled}
                                      checked={showChecked}
                                      onChange={e => handleToggleBatchSelect(b.id, e.target.checked)}
                                      style={{ width: '18px', height: '18px', cursor: isBatchDisabled ? 'not-allowed' : 'pointer' }}
                                    />
                                    <span style={{ fontWeight: 700, color: isBatchDisabled ? '#94a3b8' : '#334155', fontSize: '13.5px' }}>
                                      {b.date ? `${b.date} ` : ''}{b.name}
                                    </span>
                                  </div>

                                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }} onClick={e => e.stopPropagation()}>
                                    <span style={{ fontSize: '12px', color: '#475569', fontWeight: 500 }}>
                                      共 {linesInBatch.length} 款 / {totalQty} 件
                                    </span>
                                    <button 
                                      type="button"
                                      className="btn btn-ghost" 
                                      style={{ padding: '2px 8px', fontSize: '12px', height: 'auto' }}
                                      onClick={() => toggleBatchExpanded(b.id)}
                                    >
                                      {isExpanded ? '收合' : '展開明細'}
                                    </button>
                                  </div>
                                </div>

                                {/* Batch Items (if expanded) */}
                                {isExpanded && (
                                  <div style={{ padding: '8px 12px', background: '#ffffff' }}>
                                    {linesInBatch.length === 0 ? (
                                      <div style={{ padding: '8px', color: '#64748b', fontSize: '12px', textAlign: 'center' }}>
                                        無規格商品
                                      </div>
                                    ) : (
                                      linesInBatch.map((line, idx) => {
                                        const isAlreadyImported = existingBatchItemIds.has(line.purchase_batch_item_id);
                                        const label = getBatchItemLabel(line.product_variant_id);
                                        return (
                                          <div 
                                            key={line.purchase_batch_item_id}
                                            style={{
                                              display: 'flex',
                                              alignItems: 'center',
                                              justifyContent: 'space-between',
                                              padding: '8px 10px',
                                              borderBottom: idx < linesInBatch.length - 1 ? '1px solid #f1f5f9' : 'none',
                                              fontSize: '12.5px',
                                              opacity: isAlreadyImported ? 0.75 : 1
                                            }}
                                          >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, marginRight: '16px' }}>
                                              <input 
                                                type="checkbox"
                                                disabled={isAlreadyImported}
                                                checked={isAlreadyImported || line.selected}
                                                onChange={e => handleToggleItemSelect(line.purchase_batch_item_id, e.target.checked)}
                                                style={{ cursor: isAlreadyImported ? 'not-allowed' : 'pointer', width: '17px', height: '17px' }}
                                              />
                                              <span style={{ color: isAlreadyImported ? '#94a3b8' : '#475569', fontWeight: 500 }}>
                                                {label}
                                                {isAlreadyImported && (
                                                  <span style={{ color: '#059669', fontSize: '11px', fontWeight: 600, marginLeft: '6px' }}>
                                                    (已在包裹中)
                                                  </span>
                                                )}
                                              </span>
                                            </div>

                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                              <span style={{ color: '#64748b', fontSize: '11px' }}>數量:</span>
                                              <input 
                                                type="number"
                                                className="input"
                                                disabled={isAlreadyImported}
                                                style={{ 
                                                  width: '55px', 
                                                  padding: '2px 6px', 
                                                  textAlign: 'center', 
                                                  fontSize: '12px',
                                                  cursor: isAlreadyImported ? 'not-allowed' : 'text'
                                                }}
                                                value={line.quantity}
                                                onChange={e => {
                                                  const val = parseInt(e.target.value, 10) || 0;
                                                  handleItemQtyChange(line.purchase_batch_item_id, val);
                                                }}
                                              />
                                            </div>
                                          </div>
                                        );
                                      })
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleBatchImportSubmit}
                          >
                            匯入所選批次商品到包裹
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="import-box">
                  <div className="form-grid">
                    <div className="form-group">
                      <label className="form-label">選擇商品群組</label>
                      <div className="selected-group-select-container custom-select-container">
                        <input 
                          type="text" 
                          className="input" 
                          placeholder="輸入關鍵字搜尋或從推薦清單選擇..."
                          value={getDisplaySearchValue(selectedGroupId, selectedGroupSearch, isSelectedDropdownOpen)}
                          onChange={e => {
                            setSelectedGroupSearch(e.target.value);
                            setIsSelectedDropdownOpen(true);
                          }}
                          onFocus={() => {
                            setSelectedGroupSearch('');
                            setIsSelectedDropdownOpen(true);
                          }}
                        />
                        {selectedGroupId && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleGroupSelect('');
                              setSelectedGroupSearch('');
                              setIsSelectedDropdownOpen(false);
                            }}
                            style={{
                              position: 'absolute',
                              right: '10px',
                              top: '50%',
                              transform: 'translateY(-50%)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              color: '#94a3b8',
                              fontSize: '18px',
                              fontWeight: 'bold',
                              padding: '4px',
                              zIndex: 10
                            }}
                          >
                            ×
                          </button>
                        )}
                        {isSelectedDropdownOpen && (
                          <div className="dropdown-menu">
                            {sortedSelectedGroups.length === 0 ? (
                              <div style={{ padding: '10px 14px', color: '#64748b', fontSize: '13px', textAlign: 'center' }}>
                                無匹配商品群組
                              </div>
                            ) : (
                              sortedSelectedGroups.map(({ g, score }) => {
                                const isRecommended = score > 0;
                                const badgeText = selectedGroupSearch.trim() ? '搜尋結果' : '相似度推薦';
                                return (
                                  <div
                                    key={g.id}
                                    className="dropdown-item"
                                    onClick={() => {
                                      handleGroupSelect(g.id);
                                      setIsSelectedDropdownOpen(false);
                                    }}
                                    style={{
                                      padding: '10px 14px',
                                      cursor: 'pointer',
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      borderBottom: '1px solid #f1f5f9'
                                    }}
                                  >
                                    <span style={{ fontWeight: 500, color: '#334155', fontSize: '13px' }}>{cleanDisplayProductTitle(g.title)}</span>
                                    {isRecommended && (
                                      <span 
                                        style={{ 
                                          fontSize: '10px', 
                                          padding: '2px 6px', 
                                          borderRadius: '4px', 
                                          fontWeight: 600,
                                          background: selectedGroupSearch.trim() ? '#eff6ff' : '#ecfdf5',
                                          color: selectedGroupSearch.trim() ? '#2563eb' : '#059669',
                                          border: selectedGroupSearch.trim() ? '1px solid #bfdbfe' : '1px solid #a7f3d0'
                                        }}
                                      >
                                        {badgeText}
                                      </span>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {selectedGroupId && (
                    <div style={{ marginTop: '14px', borderTop: '1px dashed #cbd5e1', paddingTop: '14px' }}>
                      <div className="form-group" style={{ marginBottom: '12px' }}>
                        <label className="form-label">搜尋/篩選商品規格</label>
                        <input
                          type="text"
                          className="input"
                          placeholder="過濾規格名稱、分類或 SKU..."
                          value={variantFilterSearch}
                          onChange={e => setVariantFilterSearch(e.target.value)}
                        />
                      </div>

                      <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }}>
                        {filteredVariants.length === 0 ? (
                          <div style={{ padding: '20px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                            無匹配的商品規格
                          </div>
                        ) : (
                          filteredVariants.map(v => {
                            const cat = categories.find(c => c.id === v.product_category_id);
                            const catName = cat?.title || '';
                            const qty = cardQuantities[v.id] ?? 1;

                            return (
                              <div 
                                key={v.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  padding: '10px 14px',
                                  background: '#fff',
                                  border: '1px solid #e2e8f0',
                                  borderRadius: '8px',
                                  fontSize: '13px',
                                  boxShadow: '0 1px 2px rgba(0,0,0,0.02)'
                                }}
                              >
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, marginRight: '16px' }}>
                                  <div style={{ fontWeight: 700, color: '#334155' }}>
                                    {catName} - {v.variant_name}
                                  </div>
                                  {v.myacg_item_code && (
                                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                                      SKU: <code>{v.myacg_item_code}</code>
                                    </div>
                                  )}
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <input 
                                    type="number"
                                    className="input"
                                    min={1}
                                    style={{ width: '55px', padding: '4px 6px', textAlign: 'center', height: '32px' }}
                                    value={qty}
                                    onChange={e => {
                                      const val = Math.max(1, parseInt(e.target.value, 10) || 1);
                                      setCardQuantities(prev => ({ ...prev, [v.id]: val }));
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-primary"
                                    style={{ height: '32px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}
                                    onClick={() => handleAddCardItem(v.id, qty)}
                                  >
                                    <Plus size={14} />
                                    加入
                                  </button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Package items check list */}
          <div className="section-subtitle" style={{ borderTop: '1px solid #e2e8f0', paddingTop: '24px', marginTop: '12px', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <Package size={18} style={{ color: '#2563eb' }} />
              <span style={{ fontSize: '16px', fontWeight: 700 }}>包裹內商品清單</span>
              <span style={{ fontSize: '13px', color: '#475569', fontWeight: 'normal', marginLeft: '8px' }}>
                (點收進度: <strong style={{ color: checkedStats.allChecked ? '#059669' : '#d97706' }}>{checkedStats.checkedQty} / {checkedStats.totalQty} 件</strong>, 共 {checkedStats.checkedCount} / {checkedStats.totalCount} 項)
              </span>
            </div>
            {packageItems.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#475569', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={showDetailedInfo}
                    onChange={(e) => setShowDetailedInfo(e.target.checked)}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  顯示詳細資訊
                </label>
                {!isMobile && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 600 }}>整頁批量操作：</span>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '4px 10px', fontSize: '12.5px', height: 'auto', borderRadius: '6px' }}
                      onClick={() => handlePageBulkCheck(true)}
                    >
                      全選已點收
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '4px 10px', fontSize: '12.5px', height: 'auto', borderRadius: '6px' }}
                      onClick={() => handlePageBulkCheck(false)}
                    >
                      全取消點收
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {packageItems.length === 0 ? (
            <div style={{ padding: '40px 10px', textAlign: 'center', color: '#64748b' }}>
              <Info size={36} style={{ color: '#cbd5e1', marginBottom: '8px' }} />
              <p style={{ fontSize: '13px' }}>包裹內尚無任何商品。請利用上方工具將採購的商品或手動商品加入！</p>
            </div>
          ) : isMobile ? (
            // Mobile Card View
            <div>
              {packageItems.map(item => {
                const v = variants.find(x => x.id === item.product_variant_id);
                const bundleComps = v ? getBundleComponents(v) : [];
                const isBundleExpanded = expandedBundleItems.has(item.id);
                const catAndVariant = [item.category_name, item.variant_name].filter(Boolean).join(' - ') || getBatchItemLabel(item.product_variant_id || '');
                return (
                  <div 
                    key={item.id} 
                    className={`mobile-item-card ${item.checked ? 'mobile-item-checked' : ''}`}
                  >
                    <button 
                      onClick={() => handleToggleCheck(item.id, !item.checked)}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: item.checked ? '#059669' : '#94a3b8', alignSelf: 'flex-start', marginTop: '2px' }}
                    >
                      {item.checked ? <CheckSquare size={24} /> : <Square size={24} />}
                    </button>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', padding: '2px 0' }}>
                      {/* Product Group title (e.g. VTuber project name) */}
                      <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', lineHeight: 1.2 }}>
                        {cleanDisplayProductTitle(item.product_title || getProductGroupTitle(item.product_variant_id))}
                      </div>

                      {/* Main Item spec title + quantity */}
                      <div style={{ fontWeight: 700, color: '#1e293b', fontSize: '14px', lineHeight: 1.3 }}>
                        <span>{catAndVariant}</span>
                        <span style={{ marginLeft: '8px', color: '#2563eb', fontWeight: 800 }}>
                          ×{item.quantity}
                        </span>
                      </div>

                      {/* Source always visible, SKU completely removed */}
                      <div style={{ color: '#475569', fontSize: '12px', lineHeight: 1.3 }}>
                        來源：<strong style={{ color: '#2563eb' }}>{getBatchName(item.purchase_batch_id) || '-'}</strong>
                      </div>

                      {/* Expand Button */}
                      {bundleComps.length > 0 && (
                        <div style={{ marginTop: '2px' }}>
                          <button
                            type="button"
                            onClick={(e) => toggleBundleExpand(item.id, e)}
                            style={{
                              padding: '3px 8px',
                              fontSize: '11px',
                              background: isBundleExpanded ? '#f1f5f9' : '#eff6ff',
                              color: isBundleExpanded ? '#475569' : '#1d4ed8',
                              border: '1px solid',
                              borderColor: isBundleExpanded ? '#cbd5e1' : '#bfdbfe',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}
                          >
                            {isBundleExpanded ? '▲ 套組內容' : '▼ 套組內容'}
                            <span style={{ fontSize: '10px', opacity: 0.85 }}>({bundleComps.length})</span>
                          </button>
                        </div>
                      )}

                      {/* Child bundle components card display */}
                      {bundleComps.length > 0 && isBundleExpanded && (
                        <div 
                          style={{
                            marginTop: '4px',
                            fontSize: '12.5px',
                            color: '#475569',
                            backgroundColor: '#f1f5f9',
                            padding: '8px 12px',
                            borderRadius: '6px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            border: '1px solid #e2e8f0'
                          }}
                          onClick={e => e.stopPropagation()}
                        >
                          <div style={{ fontWeight: 700, color: '#334155', marginBottom: '2px' }}>
                            📦 套組內容 ({bundleComps.length})
                          </div>
                          {bundleComps.map((comp) => {
                            const compLabel = comp.variant_name || '單品';
                            return (
                              <div key={comp.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '2px' }}>
                                <span style={{ color: '#94a3b8' }}>•</span>
                                <span style={{ fontWeight: 500 }}>{compLabel}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {item.note && (
                        <div style={{ fontSize: '11.5px', color: '#dc2626', fontWeight: 600, marginTop: '4px', backgroundColor: '#fef2f2', padding: '4px 8px', borderRadius: '4px', border: '1px solid #fee2e2', width: 'fit-content' }}>
                          備註：{item.note}
                        </div>
                      )}

                      {/* Checked Timestamp (only visible when checked and showDetailedInfo checked) */}
                      {showDetailedInfo && item.checked && item.checked_at && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#10b981', marginTop: '4px', fontWeight: 600 }}>
                          <CheckCircle2 size={12} />
                          <span>已點收：{formatCheckTime(item.checked_at)}</span>
                        </div>
                      )}
                    </div>
                    <button 
                      className="btn btn-ghost" 
                      onClick={() => handleDeleteItem(item.id)}
                      style={{ color: '#ef4444', padding: '4px', alignSelf: 'flex-start', marginTop: '2px' }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            // Grouped Checklist Desktop View
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {groupedItems.map(g => {
                const isCollapsed = collapsedGroups.has(g.id);
                const totalGroupItems = g.items.length;
                const checkedGroupItems = g.items.filter(item => item.checked).length;
                const percent = totalGroupItems > 0 ? Math.round((checkedGroupItems / totalGroupItems) * 100) : 0;

                return (
                  <div key={g.id} className="checklist-group">
                    <div 
                      className="checklist-group-header" 
                      onClick={() => toggleGroupCollapse(g.id)}
                    >
                      <div className="checklist-group-title-area">
                        <span style={{ fontSize: '13px', color: '#64748b' }}>
                          {isCollapsed ? '▶' : '▼'}
                        </span>
                        <span style={{ fontSize: '15px', fontWeight: 700 }}>📦 {g.title}</span>
                        <span style={{ fontSize: '12.5px', color: '#64748b', fontWeight: 'normal' }}>
                          （共 {totalGroupItems} 項）
                        </span>
                      </div>
                      
                      <div className="group-header-right" onClick={e => e.stopPropagation()}>
                        <div className="group-progress-wrapper" title={`點收進度: ${checkedGroupItems} / ${totalGroupItems}`}>
                          <span className="group-progress-text">完成 {checkedGroupItems} / {totalGroupItems} ({percent}%)</span>
                          <div className="group-progress-bar-bg">
                            <div className="group-progress-bar-fill" style={{ width: `${percent}%` }} />
                          </div>
                        </div>

                        <div className="group-bulk-actions">
                          <button
                            type="button"
                            className="btn-bulk"
                            onClick={() => handleGroupBulkCheck(g.title, g.items, true)}
                            title="將此群組所有商品標記為已點收"
                          >
                            全選已點收
                          </button>
                          <button
                            type="button"
                            className="btn-bulk"
                            onClick={() => handleGroupBulkCheck(g.title, g.items, false)}
                            title="取消此群組所有商品的已點收狀態"
                          >
                            全取消點收
                          </button>
                        </div>
                      </div>
                    </div>
                    
                    {!isCollapsed && (
                      <div className="checklist-group-body">
                        {g.items.map(item => {
                          const catAndVariant = [item.category_name, item.variant_name].filter(Boolean).join('－') 
                            || getBatchItemLabel(item.product_variant_id || '');
                          const v = variants.find(x => x.id === item.product_variant_id);
                          const bundleComps = v ? getBundleComponents(v) : [];
                          const isBundleExpanded = expandedBundleItems.has(item.id);
                          return (
                            <div 
                              key={item.id} 
                              className={`checklist-item-row ${item.checked ? 'checked' : ''}`}
                            >
                              <div className="checklist-item-left">
                                <input 
                                  type="checkbox"
                                  checked={item.checked}
                                  onChange={e => handleToggleCheck(item.id, e.target.checked)}
                                  style={{ cursor: 'pointer', width: '22px', height: '22px', flexShrink: 0, marginTop: '1px' }}
                                />
                                <div className="checklist-item-content">
                                  {/* Line 1: Spec title + quantity text (No badge pill styling) */}
                                  <div className="checklist-item-header">
                                    <span className={`checklist-item-title ${item.checked ? 'checked' : ''}`}>
                                      {catAndVariant}
                                    </span>
                                    <span className={`checklist-item-qty ${item.checked ? 'checked' : ''}`}>
                                      ×{item.quantity}
                                    </span>
                                    {bundleComps.length > 0 && (
                                      <button
                                        type="button"
                                        onClick={(e) => toggleBundleExpand(item.id, e)}
                                        style={{
                                          marginLeft: '8px',
                                          padding: '2px 8px',
                                          fontSize: '11px',
                                          background: isBundleExpanded ? '#f1f5f9' : '#eff6ff',
                                          color: isBundleExpanded ? '#475569' : '#1d4ed8',
                                          border: '1px solid',
                                          borderColor: isBundleExpanded ? '#cbd5e1' : '#bfdbfe',
                                          borderRadius: '4px',
                                          cursor: 'pointer',
                                          fontWeight: 600,
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: '4px'
                                        }}
                                      >
                                        {isBundleExpanded ? '▲ 套組內容' : '▼ 套組內容'}
                                        <span style={{ fontSize: '10px', opacity: 0.85, marginLeft: '2px' }}>({bundleComps.length})</span>
                                      </button>
                                    )}
                                  </div>
                                  
                                  {/* Line 2: Source Batch and Note */}
                                  <div className="checklist-item-meta-row">
                                    <span>來源：<strong>{getBatchName(item.purchase_batch_id) || '-'}</strong></span>
                                    {item.note && (
                                      <>
                                        <span style={{ color: '#cbd5e1', margin: '0 4px' }}>｜</span>
                                        <span style={{ color: '#ef4444', fontWeight: 600 }}>備註：{item.note}</span>
                                      </>
                                    )}
                                  </div>

                                  {/* Child bundle components card display */}
                                  {bundleComps.length > 0 && isBundleExpanded && (
                                    <div 
                                      style={{
                                        marginTop: '8px',
                                        fontSize: '13px',
                                        color: '#475569',
                                        backgroundColor: '#f1f5f9',
                                        padding: '8px 12px',
                                        borderRadius: '6px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '4px',
                                        border: '1px solid #e2e8f0',
                                        width: 'fit-content',
                                        minWidth: '240px'
                                      }}
                                      onClick={e => e.stopPropagation()}
                                    >
                                      <div style={{ fontWeight: 700, color: '#334155', marginBottom: '2px' }}>
                                        📦 套組內容 ({bundleComps.length})
                                      </div>
                                      {bundleComps.map((comp) => {
                                        const compLabel = comp.variant_name || '單品';
                                        return (
                                          <div key={comp.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '2px' }}>
                                            <span style={{ color: '#94a3b8' }}>•</span>
                                            <span style={{ fontWeight: 500 }}>{compLabel}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}

                                  {/* Line 3: Checked Timestamp (only visible when checked) */}
                                  {showDetailedInfo && item.checked && item.checked_at && (
                                    <div className="checklist-item-checked-row">
                                      <CheckCircle2 size={13} style={{ color: '#10b981' }} />
                                      <span>已點收：{formatCheckTime(item.checked_at)}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                              
                              <button 
                                className="btn btn-ghost" 
                                onClick={() => handleDeleteItem(item.id)}
                                style={{ color: '#ef4444', padding: '4px', flexShrink: 0, marginTop: '2px' }}
                                title="移除商品"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Quick Mark Confirmed block */}
          {pkg.status !== 'confirmed' && checkedStats.totalCount > 0 && (
            <div 
              style={{ 
                marginTop: '20px', 
                padding: '16px', 
                background: '#eff6ff', 
                border: '1px solid #bfdbfe', 
                borderRadius: '8px', 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '12px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle2 size={20} style={{ color: '#2563eb' }} />
                <span style={{ fontSize: '13px', color: '#1e3a8a', fontWeight: 500 }}>
                  已經確認完畢此包裹內的所有商品？您可以直接將包裹狀態改為「已確認/已點收」。
                </span>
              </div>
              <button 
                className="btn btn-primary"
                style={{ backgroundColor: '#2563eb', padding: '8px 16px', borderRadius: '6px' }}
                onClick={async () => {
                  const today = new Date();
                  const yyyy = today.getFullYear();
                  const mm = String(today.getMonth() + 1).padStart(2, '0');
                  const dd = String(today.getDate()).padStart(2, '0');
                  const arrivedAtVal = pkgForm.arrived_at || `${yyyy}-${mm}-${dd}`;
                  
                  const updatedPkg: JapanPackage = {
                    ...pkg,
                    status: 'confirmed',
                    arrived_at: arrivedAtVal,
                    updated_at: new Date().toISOString()
                  };
                  
                  try {
                    const allPkgs = await dataProvider.getJapanPackages();
                    const updatedList = allPkgs.map(p => p.id === id ? updatedPkg : p);
                    await dataProvider.saveJapanPackages(updatedList);
                    setPkg(updatedPkg);
                    setPkgForm(prev => ({
                      ...prev,
                      status: 'confirmed',
                      arrived_at: arrivedAtVal
                    }));
                    alert('已成功將包裹標記為【已確認】並自動填寫點收抵達日期！');
                  } catch (e) {
                    alert('點收失敗！');
                  }
                }}
              >
                確認點收包裹
              </button>
            </div>
          )}
        </div>
      </div>
      <div 
        style={{ 
          position: 'fixed', 
          bottom: '10px', 
          right: '10px', 
          background: 'rgba(15, 23, 42, 0.8)', 
          color: '#ffffff', 
          padding: '4px 8px', 
          borderRadius: '4px', 
          fontSize: '11px', 
          zIndex: 99999,
          pointerEvents: 'none',
          fontFamily: 'monospace'
        }}
      >
        JapanDetail UI v2.2
      </div>
    </div>
  );
}