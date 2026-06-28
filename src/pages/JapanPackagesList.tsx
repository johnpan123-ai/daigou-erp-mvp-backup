import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Search, Plus, ExternalLink, Clock, Trash2, Package, MapPin, CheckCircle2, Pencil, Eye, AlertTriangle, ChevronRight } from 'lucide-react';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import type { JapanPackage, JapanPackageItem } from '../lib/db';
import { useViewport } from '../contexts/ViewportContext';

const CARRIERS_LIST = [
  { name: 'ヤマト運輸 (Yamato)', keyword: 'yamato' },
  { name: '佐川急便 (Sagawa)', keyword: 'sagawa' },
  { name: '日本郵便 (Japan Post)', keyword: 'post' }
];

const getShortCarrierName = (carrier: string) => {
  if (!carrier) return '其他';
  const c = carrier.toLowerCase();
  if (c.includes('post') || c.includes('郵便') || c.includes('郵政')) return 'JP Post';
  if (c.includes('yamato') || c.includes('ヤマト') || c.includes('黑貓') || c.includes('宅急便') || c.includes('大和')) return 'Yamato';
  if (c.includes('sagawa') || c.includes('佐川')) return 'Sagawa';
  if (c.includes('amazon') || c.includes('亞馬遜') || c.includes('アマゾン')) return 'Amazon';
  return carrier.split(' ')[0] || carrier;
};

const getCarrierLabel = (val: string) => {
  switch (val) {
    case 'all': return '全部物流';
    case 'post': return 'JP Post';
    case 'yamato': return 'Yamato';
    case 'sagawa': return 'Sagawa';
    case 'custom': return '其他';
    default: return '全部';
  }
};

export default function JapanPackagesList() {
  const navigate = useNavigate();
  const { isMobile } = useViewport();

  const [packages, setPackages] = useState<JapanPackage[]>([]);
  const [packageItems, setPackageItems] = useState<JapanPackageItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Filters & Search
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [carrierFilter, setCarrierFilter] = useState<string>('all');
  const [showCarrierDrawer, setShowCarrierDrawer] = useState<boolean>(false);
  const [animateCarrierDrawer, setAnimateCarrierDrawer] = useState<boolean>(false);

  const openCarrierDrawer = () => {
    setShowCarrierDrawer(true);
    setTimeout(() => setAnimateCarrierDrawer(true), 20);
  };

  const closeCarrierDrawer = () => {
    setAnimateCarrierDrawer(false);
    setTimeout(() => setShowCarrierDrawer(false), 220);
  };

  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);

  const handleEditClick = (p: JapanPackage, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingPackageId(p.id);
    
    // Determine if carrier is custom
    const isStandard = CARRIERS_LIST.some(c => c.name === p.carrier);
    
    setNewPackageForm({
      title: p.title || '',
      vendor_name: p.vendor_name || '',
      carrier: isStandard ? (p.carrier || 'ヤマト運輸 (Yamato)') : (p.carrier ? 'custom' : 'ヤマト運輸 (Yamato)'),
      custom_carrier: isStandard ? '' : (p.carrier || ''),
      tracking_number: p.tracking_number || '',
      shipped_at: p.shipped_at || '',
      expected_arrival_at: p.expected_arrival_at || '',
      arrived_at: p.arrived_at || '',
      status: p.status || 'registered',
      note: p.note || ''
    });
    openAddModal();
  };

  const handleTrackingClick = (p: JapanPackage, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = getTrackingUrl(p.carrier || '', p.tracking_number || '');
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      alert('無有效追蹤單號！');
    }
  };

  const renderCarrierBadge = (carrier: string) => {
    if (!carrier) return null;
    const c = carrier.toLowerCase();
    
    let emoji = '📦';
    let label = carrier;
    let bg = '#f8fafc';
    let text = '#475569';
    let border = '#e2e8f0';

    if (c.includes('post') || c.includes('郵便') || c.includes('郵政')) {
      emoji = '📮';
      label = 'JP Post';
      bg = '#fff1f2';
      text = '#e11d48';
      border = '#ffe4e6';
    } else if (c.includes('yamato') || c.includes('ヤマト') || c.includes('黑貓') || c.includes('宅急便') || c.includes('大和')) {
      emoji = '🐈';
      label = 'Yamato';
      bg = '#fef9c3';
      text = '#854d0e';
      border = '#fef08a';
    } else if (c.includes('sagawa') || c.includes('佐川')) {
      emoji = '🚚';
      label = 'Sagawa';
      bg = '#eff6ff';
      text = '#1e40af';
      border = '#dbeafe';
    } else if (c.includes('amazon') || c.includes('亞馬遜') || c.includes('アマゾン')) {
      emoji = '📦';
      label = 'Amazon';
      bg = '#ffedd5';
      text = '#b45309';
      border = '#fed7aa';
    }

    return (
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        background: bg,
        color: text,
        border: `1px solid ${border}`,
        padding: '4px 10px',
        borderRadius: '8px',
        fontSize: '12px',
        fontWeight: 700,
        whiteSpace: 'nowrap'
      }}>
        <span style={{ fontSize: '14px', display: 'inline-block', lineHeight: 1 }}>{emoji}</span>
        <span>{label}</span>
      </span>
    );
  };

  // Add Package Modal
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [animateAddModal, setAnimateAddModal] = useState<boolean>(false);

  const openAddModal = () => {
    setShowAddModal(true);
    setTimeout(() => setAnimateAddModal(true), 20);
  };

  const closeAddModal = () => {
    setAnimateAddModal(false);
    setTimeout(() => setShowAddModal(false), 220);
  };
  const [newPackageForm, setNewPackageForm] = useState({
    title: '',
    vendor_name: '',
    carrier: 'ヤマト運輸 (Yamato)',
    custom_carrier: '',
    tracking_number: '',
    shipped_at: '',
    expected_arrival_at: '',
    arrived_at: '',
    status: 'registered',
    note: ''
  });

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showAddModal) closeAddModal();
        if (showCarrierDrawer) closeCarrierDrawer();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal, showCarrierDrawer]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const fetchedPkgs = await dataProvider.getJapanPackages();
      const fetchedItems = await dataProvider.getJapanPackageItems();
      setPackages(fetchedPkgs || []);
      setPackageItems(fetchedItems || []);
    } catch (e) {
      console.error('Failed to load Japan packages:', e);
    } finally {
      setIsLoading(false);
    }
  };

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

  // Status Auto fill arrived_at today
  const handleStatusChange = (statusVal: string, currentArrivedAt: string) => {
    let arrivedAtVal = currentArrivedAt;
    if ((statusVal === 'arrived' || statusVal === 'confirmed') && !currentArrivedAt) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      arrivedAtVal = `${yyyy}-${mm}-${dd}`;
    }
    return { statusVal, arrivedAtVal };
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPackageForm.title.trim()) return;

    const carrierName = newPackageForm.carrier === 'custom' 
      ? newPackageForm.custom_carrier 
      : newPackageForm.carrier;

    // Apply auto arrived_at logic
    const { statusVal, arrivedAtVal } = handleStatusChange(newPackageForm.status, newPackageForm.arrived_at);

    if (editingPackageId) {
      // Edit mode
      const updatedList = packages.map(p => {
        if (p.id === editingPackageId) {
          return {
            ...p,
            title: newPackageForm.title.trim(),
            vendor_name: newPackageForm.vendor_name.trim() || undefined,
            carrier: carrierName.trim() || undefined,
            tracking_number: newPackageForm.tracking_number.trim() || undefined,
            shipped_at: newPackageForm.shipped_at || undefined,
            expected_arrival_at: newPackageForm.expected_arrival_at || undefined,
            arrived_at: arrivedAtVal || undefined,
            status: statusVal,
            note: newPackageForm.note.trim() || undefined,
            updated_at: new Date().toISOString()
          };
        }
        return p;
      });

      try {
        await dataProvider.saveJapanPackages(updatedList);
        setPackages(updatedList);
        setEditingPackageId(null);
        closeAddModal();
        // Reset form
        setNewPackageForm({
          title: '',
          vendor_name: '',
          carrier: 'ヤマト運輸 (Yamato)',
          custom_carrier: '',
          tracking_number: '',
          shipped_at: '',
          expected_arrival_at: '',
          arrived_at: '',
          status: 'registered',
          note: ''
        });
      } catch (err) {
        alert('儲存失敗，請重試！');
      }
    } else {
      // Add mode
      const newPkg: JapanPackage = {
        id: crypto.randomUUID(),
        title: newPackageForm.title.trim(),
        vendor_name: newPackageForm.vendor_name.trim() || undefined,
        carrier: carrierName.trim() || undefined,
        tracking_number: newPackageForm.tracking_number.trim() || undefined,
        shipped_at: newPackageForm.shipped_at || undefined,
        expected_arrival_at: newPackageForm.expected_arrival_at || undefined,
        arrived_at: arrivedAtVal || undefined,
        status: statusVal,
        note: newPackageForm.note.trim() || undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      try {
        const updatedList = [...packages, newPkg];
        await dataProvider.saveJapanPackages(updatedList);
        setPackages(updatedList);
        closeAddModal();
        // Reset form
        setNewPackageForm({
          title: '',
          vendor_name: '',
          carrier: 'ヤマト運輸 (Yamato)',
          custom_carrier: '',
          tracking_number: '',
          shipped_at: '',
          expected_arrival_at: '',
          arrived_at: '',
          status: 'registered',
          note: ''
        });
      } catch (err) {
        if (err instanceof StaleDataError) {
          alert(err.message);
          await loadData();
        } else {
          alert('儲存失敗，請重試！');
        }
      }
    }
  };

  const handleDeletePackage = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('確定要刪除此包裹嗎？這會同時刪除包裹內的所有商品明細。')) return;

    try {
      const updatedPkgs = packages.filter(p => p.id !== id);
      const updatedItems = packageItems.filter(item => item.japan_package_id !== id);
      
      await dataProvider.saveJapanPackages(updatedPkgs);
      await dataProvider.saveJapanPackageItems(updatedItems);
      
      setPackages(updatedPkgs);
      setPackageItems(updatedItems);
    } catch (err) {
      alert('刪除失敗，請重試！');
    }
  };

  // Stats Computations
  const stats = useMemo(() => {
    return {
      total: packages.length,
      registered: packages.filter(p => p.status === 'registered').length,
      arrived: packages.filter(p => p.status === 'arrived').length,
      confirmed: packages.filter(p => p.status === 'confirmed').length,
      problem: packages.filter(p => p.status === 'problem').length,
    };
  }, [packages]);

  // Filtered packages
  const filteredPackages = useMemo(() => {
    return packages.filter(p => {
      // Search
      const titleMatch = (p.title || '').toLowerCase().includes(searchTerm.toLowerCase());
      const vendorMatch = (p.vendor_name || '').toLowerCase().includes(searchTerm.toLowerCase());
      const trackingMatch = (p.tracking_number || '').toLowerCase().includes(searchTerm.toLowerCase());
      const searchMatch = titleMatch || vendorMatch || trackingMatch;

      // Status
      const statusMatch = statusFilter === 'all' || p.status === statusFilter;

      // Carrier
      const carrierLower = (p.carrier || '').toLowerCase();
      let carrierMatch = true;
      if (carrierFilter !== 'all') {
        if (carrierFilter === 'custom') {
          const isStandard = carrierLower.includes('post') || carrierLower.includes('郵便') || carrierLower.includes('郵政') ||
                             carrierLower.includes('yamato') || carrierLower.includes('ヤマト') || carrierLower.includes('大和') ||
                             carrierLower.includes('sagawa') || carrierLower.includes('佐川') ||
                             carrierLower.includes('amazon') || carrierLower.includes('亞馬遜') || carrierLower.includes('アマゾン');
          carrierMatch = !isStandard;
        } else {
          carrierMatch = carrierLower.includes(carrierFilter.toLowerCase());
        }
      }

      return searchMatch && statusMatch && carrierMatch;
    }).sort((a, b) => {
      // Sort by updated_at descending, or created_at descending
      const aTime = a.updated_at || a.created_at || '';
      const bTime = b.updated_at || b.created_at || '';
      return bTime.localeCompare(aTime);
    });
  }, [packages, searchTerm, statusFilter, carrierFilter]);



  const getStatusName = (status: string) => {
    switch (status) {
      case 'registered': return '已登記';
      case 'arrived': return '已到小幫手家';
      case 'confirmed': return '已點收';
      case 'problem': return '有問題';
      default: return status;
    }
  };

  const renderStatusBadge = (status: string) => {
    let bg = '#fffbeb'; 
    let color = '#d97706';
    let border = '#fef3c7';
    let dot = '🟡';
    let label = '已登記';

    switch (status) {
      case 'registered':
        bg = '#fffbeb';
        color = '#d97706';
        border = '#fef3c7';
        dot = '🟡';
        label = '已登記';
        break;
      case 'arrived':
        bg = '#f0f9ff';
        color = '#0284c7';
        border = '#e0f2fe';
        dot = '🔵';
        label = '已到小幫手家';
        break;
      case 'confirmed':
        bg = '#f0fdf4';
        color = '#16a34a';
        border = '#d1fae5';
        dot = '🟢';
        label = '已點收';
        break;
      case 'problem':
      case 'issue':
        bg = '#fef2f2';
        color = '#dc2626';
        border = '#fee2e2';
        dot = '🔴';
        label = '有問題';
        break;
      default:
        bg = '#f8fafc';
        color = '#64748b';
        border = '#e2e8f0';
        dot = '⚪';
        label = status;
    }

    return (
      <div style={{
        background: bg,
        color: color,
        border: `1px solid ${border}`,
        padding: '6px 12px',
        borderRadius: '20px',
        fontSize: '13px',
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        whiteSpace: 'nowrap'
      }}>
        <span style={{ fontSize: '12px', display: 'inline-block', lineHeight: 1 }}>{dot}</span>
        <span>{label}</span>
      </div>
    );
  };

  // Get items count inside package
  const getPackageItemsCount = (pkgId: string) => {
    return packageItems.filter(item => item.japan_package_id === pkgId).reduce((sum, item) => sum + item.quantity, 0);
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1800px', width: '100%', margin: '0 auto' }}>
      <style>{`
        .header-section {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
        }
        .header-title {
          font-size: 24px;
          font-weight: 800;
          color: #0f172a;
          display: flex;
          align-items: center;
          gap: 10px;
          letter-spacing: -0.5px;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 16px;
          margin-bottom: 28px;
        }
        .stat-card {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 18px 22px;
          display: flex;
          align-items: center;
          gap: 16px;
          box-shadow: 0 1px 3px 0 rgba(0,0,0,0.02);
          transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
        }
        .stat-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 20px -5px rgba(0,0,0,0.04), 0 4px 6px -2px rgba(0,0,0,0.02);
          border-color: #cbd5e1;
        }
        .stat-icon-wrapper {
          width: 52px;
          height: 52px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .stat-info {
          display: flex;
          flex-direction: column;
        }
        .stat-number {
          font-size: 32px;
          font-weight: 800;
          color: #0f172a;
          line-height: 1;
        }
        .stat-label {
          font-size: 13px;
          color: #64748b;
          font-weight: 600;
          margin-top: 6px;
        }
        .toolbar {
          display: flex;
          flex-direction: column;
          gap: 16px;
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 20px;
          margin-bottom: 28px;
          box-shadow: 0 1px 3px 0 rgba(0,0,0,0.02);
        }
        .toolbar-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          width: 100%;
        }
        .toolbar-filters {
          display: flex;
          align-items: center;
          gap: 24px;
          flex-wrap: wrap;
          border-top: 1px solid #f1f5f9;
          padding-top: 16px;
          width: 100%;
        }
        .filter-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .filter-group-label {
          font-size: 13px;
          font-weight: 700;
          color: #475569;
          white-space: nowrap;
        }
        .chips-row {
          display: flex;
          gap: 6px;
        }
        .chip {
          padding: 6px 14px;
          border-radius: 8px;
          font-size: 12.5px;
          font-weight: 600;
          border: 1px solid #e2e8f0;
          background: #f8fafc;
          color: #475569;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          white-space: nowrap;
        }
        .chip:hover {
          background: #f1f5f9;
          border-color: #cbd5e1;
          color: #0f172a;
        }
        .chip.active {
          background: #2563eb;
          color: #fff;
          border-color: #2563eb;
          box-shadow: 0 2px 4px rgba(37, 99, 235, 0.15);
        }
        .search-wrapper {
          position: relative;
          width: 100%;
        }
        .search-icon {
          position: absolute;
          left: 14px;
          top: 50%;
          transform: translateY(-50%);
          color: #94a3b8;
        }
        .search-input {
          padding-left: 42px !important;
          height: 42px;
          font-size: 14px;
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          width: 100%;
        }
        .search-input:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }
        .package-cards-list {
          display: flex;
          flex-direction: column;
          gap: 16px;
          margin-bottom: 28px;
        }
        .package-card {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 24px;
          display: grid;
          grid-template-columns: 2.8fr 1fr 1.2fr 1.2fr 1.5fr;
          align-items: center;
          gap: 24px;
          box-shadow: 0 1px 3px 0 rgba(0,0,0,0.02);
          transition: transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out, border-color 0.2s ease-in-out;
          cursor: pointer;
        }
        .package-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 12px 20px -8px rgba(0,0,0,0.04), 0 4px 12px -2px rgba(0,0,0,0.03);
          border-color: #cbd5e1;
        }
        .status-pill-dashboard {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 13px;
          font-weight: 700;
          white-space: nowrap;
        }
        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }
        
        .status-registered { background: #fffbeb; color: #d97706; border: 1px solid #fef3c7; }
        .status-dot-registered { background: #f59e0b; }
        
        .status-shipped { background: #fff7ed; color: #ea580c; border: 1px solid #ffedd5; }
        .status-dot-shipped { background: #f97316; }
        
        .status-arrived { background: #f0f9ff; color: #0284c7; border: 1px solid #e0f2fe; }
        .status-dot-arrived { background: #3b82f6; }
        
        .status-confirmed { background: #f0fdf4; color: #16a34a; border: 1px solid #d1fae5; }
        .status-dot-confirmed { background: #10b981; }

        .status-problem { background: #fef2f2; color: #dc2626; border: 1px solid #fee2e2; }
        .status-dot-problem { background: #ef4444; }

        .btn-dash-action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          background: #fff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 12.5px;
          font-weight: 600;
          color: #334155;
          cursor: pointer;
          transition: all 0.15s ease-in-out;
          height: 36px;
        }
        .btn-dash-action:hover {
          background: #f8fafc;
          border-color: #94a3b8;
          color: #0f172a;
        }
        .btn-dash-delete {
          color: #ef4444;
          border-color: #fca5a5;
        }
        .btn-dash-delete:hover {
          background: #fef2f2;
          border-color: #ef4444;
          color: #dc2626;
        }
        
        .empty-state {
          background: #fff;
          border: 1px dashed #cbd5e1;
          border-radius: 16px;
          padding: 64px 32px;
          text-align: center;
          max-width: 540px;
          margin: 40px auto;
          box-shadow: 0 1px 3px 0 rgba(0,0,0,0.02);
        }
        .empty-icon-wrapper {
          width: 72px;
          height: 72px;
          border-radius: 50%;
          background: #eff6ff;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 20px;
        }
        .empty-title {
          font-size: 18px;
          font-weight: 800;
          color: #1e293b;
          margin-bottom: 8px;
        }
        .empty-desc {
          font-size: 14px;
          color: #64748b;
          line-height: 1.6;
        }


        .modal-header {
          padding: 18px 24px;
          border-bottom: 1px solid #e2e8f0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .modal-body {
          padding: 24px;
          max-height: 70vh;
          overflow-y: auto;
        }
        .modal-footer {
          padding: 16px 24px;
          border-top: 1px solid #e2e8f0;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          background: #f8fafc;
        }
        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .form-group {
          margin-bottom: 16px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .form-group.full-width {
          grid-column: span 2;
        }
        .form-label {
          font-size: 13px;
          font-weight: 600;
          color: #334155;
        }
        
        .mobile-package-card {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 16px;
          margin-bottom: 12px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.02);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        @media (max-width: 1200px) {
          .package-card {
            grid-template-columns: 2.2fr 1fr 1.2fr 1fr 1.2fr;
            gap: 16px;
            padding: 20px;
          }
        }
        @media (max-width: 1024px) {
          .package-card {
            grid-template-columns: 1.5fr 1fr 1.2fr 1.2fr;
          }
          .package-card > :last-child {
            grid-column: span 4;
            margin-top: 8px;
          }
        }
        @media (max-width: 768px) {
          .stats-grid {
            display: none !important;
          }
          .toolbar {
            display: none !important;
          }
          .mobile-toolbar {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 16px;
            width: 100%;
          }
          .mobile-search-row {
            position: relative;
            width: 100%;
          }
          .mobile-search-icon {
            position: absolute;
            left: 12px;
            top: 50%;
            transform: translateY(-50%);
            color: #94a3b8;
          }
          .mobile-search-input {
            width: 100%;
            height: 44px;
            padding-left: 38px;
            padding-right: 12px;
            border-radius: 10px;
            border: 1px solid #cbd5e1;
            font-size: 14px;
            outline: none;
            background: #fff;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02);
            box-sizing: border-box;
          }
          .mobile-search-input:focus {
            border-color: #3b82f6;
          }
          .mobile-chips-wrap {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            width: 100%;
            margin-top: 4px;
          }
          .mobile-wrap-chip {
            padding: 8px 12px;
            border-radius: 20px;
            font-size: 12.5px;
            font-weight: 600;
            border: 1px solid #e2e8f0;
            background: #f8fafc;
            color: #475569;
            cursor: pointer;
            transition: all 0.15s;
            height: 32px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
          }
          .mobile-wrap-chip.active {
            background: #2563eb;
            color: #fff;
            border-color: #2563eb;
          }
          .mobile-logistics-row {
            width: 100%;
            margin-top: 2px;
          }
          .mobile-logistics-btn {
            width: 100%;
            height: 40px;
            background: #fff;
            border: 1px solid #cbd5e1;
            border-radius: 8px;
            font-size: 13.5px;
            font-weight: 700;
            color: #334155;
            padding: 0 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            box-sizing: border-box;
          }
          .mobile-logistics-btn:active {
            background: #f8fafc;
          }
          
          /* Mobile Card */
          .mobile-package-card {
            background: #fff;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 12px 14px !important;
            margin-bottom: 10px !important;
            box-shadow: 0 1px 3px rgba(0,0,0,0.02) !important;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            height: auto !important;
            min-height: 120px !important;
            max-height: none !important;
            box-sizing: border-box !important;
            gap: 8px !important;
          }
          .mobile-card-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            width: 100%;
          }
          .mobile-card-header {
            margin-bottom: 4px;
          }
          .mobile-card-title {
            font-size: 15px;
            font-weight: 700;
            color: #0f172a;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 60%;
          }
          .mobile-status-pill {
            padding: 2px 8px !important;
            font-size: 11px !important;
            border-radius: 6px !important;
            height: 20px !important;
          }
          .mobile-card-meta {
            font-size: 12px;
            color: #64748b;
            justify-content: flex-start;
            gap: 6px;
            margin-bottom: 6px;
          }
          .mobile-meta-divider {
            color: #cbd5e1;
            font-size: 10px;
          }
          .mobile-card-footer {
            border-top: 1px solid #f1f5f9;
            padding-top: 8px;
            margin-top: auto;
          }
          .mobile-footer-info {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: #475569;
          }
          .mobile-footer-actions {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .mobile-card-delete-btn {
            background: none;
            border: none;
            color: #94a3b8;
            padding: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: color 0.15s;
          }
          .mobile-card-delete-btn:hover, .mobile-card-delete-btn:active {
            color: #ef4444;
          }
          .mobile-card-link {
            color: #2563eb;
            font-size: 13px;
            font-weight: 700;
            display: flex;
            align-items: center;
          }
          .fab-btn {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: #2563eb;
            color: #fff;
            border: none;
            box-shadow: 0 4px 10px rgba(37, 99, 235, 0.3), 0 2px 4px rgba(0,0,0,0.1);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999;
            cursor: pointer;
            transition: transform 0.2s, background 0.2s;
          }
          .fab-btn:active {
            transform: scale(0.95);
            background: #1d4ed8;
          }

          .drawer-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            border-bottom: 1px solid #f1f5f9;
            padding-bottom: 12px;
          }
          .drawer-title {
            font-size: 16px;
            font-weight: 700;
            color: #0f172a;
          }
          .drawer-close {
            background: none;
            border: none;
            font-size: 24px;
            color: #64748b;
            cursor: pointer;
            padding: 0 4px;
          }
          .drawer-body {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .drawer-item {
            width: 100%;
            height: 48px;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            font-size: 14.5px;
            font-weight: 600;
            color: #475569;
            text-align: left;
            padding: 0 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            transition: all 0.15s;
            box-sizing: border-box;
          }
          .drawer-item.active {
            background: #eff6ff;
            border-color: #3b82f6;
            color: #2563eb;
          }
        }
        @media (min-width: 1400px) {
          .header-title {
            font-size: 28px !important;
          }
          .stats-grid {
            gap: 20px !important;
            margin-bottom: 32px !important;
          }
          .stat-card {
            padding: 22px 26px !important;
            gap: 20px !important;
          }
          .stat-number {
            font-size: 36px !important;
          }
          .stat-label {
            font-size: 14.5px !important;
          }
          .toolbar {
            padding: 24px !important;
            gap: 20px !important;
            margin-bottom: 32px !important;
          }
          .search-input {
            height: 48px !important;
            font-size: 15.5px !important;
            padding-left: 46px !important;
          }
          .chip {
            padding: 8px 18px !important;
            font-size: 14px !important;
          }
          .filter-group-label {
            font-size: 14.5px !important;
          }
          .package-card {
            padding: 28px !important;
          }
          .pkg-primary-info .pkg-name-link {
            font-size: 18px !important;
          }
          .pkg-field-label {
            font-size: 13.5px !important;
          }
          .pkg-field-value {
            font-size: 15.5px !important;
          }
        }
        @media (min-width: 2500px) {
          .header-title {
            font-size: 32px !important;
          }
          .stats-grid {
            gap: 24px !important;
            margin-bottom: 40px !important;
          }
          .stat-card {
            padding: 26px 32px !important;
            gap: 24px !important;
            border-radius: 18px !important;
          }
          .stat-number {
            font-size: 42px !important;
          }
          .stat-label {
            font-size: 16.5px !important;
          }
          .toolbar {
            padding: 32px !important;
            gap: 24px !important;
            margin-bottom: 40px !important;
            border-radius: 20px !important;
          }
          .search-input {
            height: 54px !important;
            font-size: 17.5px !important;
            padding-left: 52px !important;
          }
          .chip {
            padding: 10px 22px !important;
            font-size: 16px !important;
          }
          .filter-group-label {
            font-size: 16.5px !important;
          }
          .package-card {
            padding: 32px !important;
            border-radius: 20px !important;
          }
          .pkg-primary-info .pkg-name-link {
            font-size: 20px !important;
          }
          .pkg-field-label {
            font-size: 15px !important;
          }
          .pkg-field-value {
            font-size: 17.5px !important;
          }
        }
      `}</style>

      {/* Header with Title and Add Button */}
      <div className="header-section">
        <h1 className="header-title" style={isMobile ? { fontSize: '20px' } : undefined}>
          <Truck size={isMobile ? 20 : 24} style={{ color: '#2563eb' }} />
          日本包裹管理
        </h1>
        {!isMobile && (
          <button 
            className="btn btn-primary" 
            onClick={() => {
              setEditingPackageId(null);
              setNewPackageForm({
                title: '',
                vendor_name: '',
                carrier: 'ヤマト運輸 (Yamato)',
                custom_carrier: '',
                tracking_number: '',
                shipped_at: '',
                expected_arrival_at: '',
                arrived_at: '',
                status: 'registered',
                note: ''
              });
              setShowAddModal(true);
            }}
            style={{ padding: '8px 16px', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Plus size={18} />
            登記新包裹
          </button>
        )}
      </div>

      {/* Statistics & Search Toolbar */}
      {isMobile ? (
        <div className="mobile-toolbar">
          {/* Search Bar */}
          <div className="mobile-search-row">
            <Search size={16} className="mobile-search-icon" />
            <input 
              type="text" 
              placeholder="搜尋包裹 / 單號 / 廠商" 
              className="mobile-search-input"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>

          {/* Filter Row 1: Status Wrap Chips (No Horizontal Scroll) */}
          <div className="mobile-chips-wrap">
            {[
              { key: 'all', label: '全部', count: stats.total },
              { key: 'registered', label: '已登記', count: stats.registered },
              { key: 'arrived', label: '已到小幫手', count: stats.arrived },
              { key: 'confirmed', label: '已點收', count: stats.confirmed },
              { key: 'problem', label: '有問題', count: stats.problem }
            ].map(item => (
              <button 
                key={item.key}
                className={`mobile-wrap-chip ${statusFilter === item.key ? 'active' : ''}`}
                onClick={() => setStatusFilter(item.key)}
              >
                {item.label} {item.count}
              </button>
            ))}
          </div>

          {/* Filter Row 2: Carrier Dropdown Button */}
          <div className="mobile-logistics-row">
            <button 
              className="mobile-logistics-btn"
              onClick={openCarrierDrawer}
            >
              <span>篩選物流：{getCarrierLabel(carrierFilter)}</span>
              <ChevronRight size={16} style={{ color: '#64748b', transform: 'rotate(90deg)' }} />
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Statistics Cards */}
          <div className="stats-grid">
            <div className="stat-card" style={{ borderLeft: '4px solid #2563eb' }}>
              <div className="stat-icon-wrapper" style={{ background: '#eff6ff', color: '#2563eb' }}>
                <Package size={24} />
              </div>
              <div className="stat-info">
                <div className="stat-number">{stats.total}</div>
                <div className="stat-label">總包裹數量</div>
              </div>
            </div>
            <div className="stat-card" style={{ borderLeft: '4px solid #f59e0b' }}>
              <div className="stat-icon-wrapper" style={{ background: '#fef3c7', color: '#f59e0b' }}>
                <Clock size={24} />
              </div>
              <div className="stat-info">
                <div className="stat-number">{stats.registered}</div>
                <div className="stat-label">已登記</div>
              </div>
            </div>
            <div className="stat-card" style={{ borderLeft: '4px solid #0284c7' }}>
              <div className="stat-icon-wrapper" style={{ background: '#e0f2fe', color: '#0284c7' }}>
                <MapPin size={24} />
              </div>
              <div className="stat-info">
                <div className="stat-number">{stats.arrived}</div>
                <div className="stat-label">已到小幫手家</div>
              </div>
            </div>
            <div className="stat-card" style={{ borderLeft: '4px solid #10b981' }}>
              <div className="stat-icon-wrapper" style={{ background: '#ecfdf5', color: '#10b981' }}>
                <CheckCircle2 size={24} />
              </div>
              <div className="stat-info">
                <div className="stat-number">{stats.confirmed}</div>
                <div className="stat-label">已點收</div>
              </div>
            </div>
            <div className="stat-card" style={{ borderLeft: '4px solid #ef4444' }}>
              <div className="stat-icon-wrapper" style={{ background: '#fef2f2', color: '#ef4444' }}>
                <AlertTriangle size={24} />
              </div>
              <div className="stat-info">
                <div className="stat-number">{stats.problem}</div>
                <div className="stat-label">有問題</div>
              </div>
            </div>
          </div>

          {/* Search & Filter Toolbar */}
          <div className="toolbar">
            <div className="toolbar-top">
              <div className="search-wrapper" style={{ flex: 1, maxWidth: '480px' }}>
                <Search size={16} className="search-icon" />
                <input 
                  type="text" 
                  placeholder="搜尋包裹名稱、寄件廠商、物流單號..." 
                  className="input search-input"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="toolbar-filters">
              <div className="filter-group">
                <span className="filter-group-label">物流廠商：</span>
                <div className="chips-row">
                  <button 
                    className={`chip ${carrierFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setCarrierFilter('all')}
                  >
                    全部
                  </button>
                  <button 
                    className={`chip ${carrierFilter === 'post' ? 'active' : ''}`}
                    onClick={() => setCarrierFilter('post')}
                  >
                    JP Post
                  </button>
                  <button 
                    className={`chip ${carrierFilter === 'yamato' ? 'active' : ''}`}
                    onClick={() => setCarrierFilter('yamato')}
                  >
                    Yamato
                  </button>
                  <button 
                    className={`chip ${carrierFilter === 'sagawa' ? 'active' : ''}`}
                    onClick={() => setCarrierFilter('sagawa')}
                  >
                    Sagawa
                  </button>
                  <button 
                    className={`chip ${carrierFilter === 'custom' ? 'active' : ''}`}
                    onClick={() => setCarrierFilter('custom')}
                  >
                    其他
                  </button>
                </div>
              </div>
              <div className="filter-group">
                <span className="filter-group-label">包裹狀態：</span>
                <div className="chips-row">
                  <button 
                    className={`chip ${statusFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setStatusFilter('all')}
                  >
                    全部
                  </button>
                  <button 
                    className={`chip ${statusFilter === 'registered' ? 'active' : ''}`}
                    onClick={() => setStatusFilter('registered')}
                  >
                    已登記
                  </button>
                  <button 
                    className={`chip ${statusFilter === 'arrived' ? 'active' : ''}`}
                    onClick={() => setStatusFilter('arrived')}
                  >
                    已到小幫手家
                  </button>
                  <button 
                    className={`chip ${statusFilter === 'confirmed' ? 'active' : ''}`}
                    onClick={() => setStatusFilter('confirmed')}
                  >
                    已點收
                  </button>
                  <button 
                    className={`chip ${statusFilter === 'problem' ? 'active' : ''}`}
                    onClick={() => setStatusFilter('problem')}
                  >
                    有問題
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Package List */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
          <Clock size={24} style={{ animation: 'spin 1.5s infinite linear' }} />
          <p style={{ marginTop: '8px' }}>載入包裹資料中...</p>
        </div>
      ) : filteredPackages.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon-wrapper">
            <Truck size={36} style={{ color: '#2563eb' }} />
          </div>
          <h3 className="empty-title">尚無日本包裹</h3>
          <p className="empty-desc">沒有符合篩選條件的日本國內包裹，請調整上方搜尋或點擊右上角登記第一筆包裹。</p>
        </div>
      ) : isMobile ? (
        // Mobile layout
        <div>
          {filteredPackages.map(p => {
            const itemsCount = getPackageItemsCount(p.id);
            return (
              <div 
                key={p.id} 
                className="mobile-package-card"
                onClick={() => navigate(`/japan-packages/${p.id}`)}
              >
                {/* Title Area (up to 2 lines) */}
                <div style={{ width: '100%' }}>
                  <div style={{ 
                    fontSize: '15px', 
                    fontWeight: 700, 
                    color: '#0f172a',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'normal',
                    wordBreak: 'break-all',
                    width: '100%',
                    lineHeight: '1.4',
                    marginBottom: '4px'
                  }}>
                    {p.title || '無標題包裹'}
                  </div>
                </div>

                {/* Status Row */}
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
                  <span className={`status-pill-dashboard status-${p.status} mobile-status-pill`}>
                    <span className={`status-dot status-dot-${p.status}`}></span>
                    <span>{getStatusName(p.status)}</span>
                  </span>
                </div>

                {/* Second Row: Carrier & Tracking Number */}
                <div className="mobile-card-row mobile-card-meta">
                  <span>物流：{p.carrier ? getShortCarrierName(p.carrier) : '其他'}</span>
                  <span className="mobile-meta-divider">|</span>
                  <span>單號：{p.tracking_number || '無'}</span>
                  {p.tracking_number && (() => {
                    const url = getTrackingUrl(p.carrier || '', p.tracking_number || '');
                    return url ? (
                      <a 
                        href={url} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        onClick={e => e.stopPropagation()} 
                        style={{ color: '#2563eb', marginLeft: '4px', display: 'inline-flex', alignItems: 'center' }}
                      >
                        <ExternalLink size={12} />
                      </a>
                    ) : null;
                  })()}
                </div>

                {/* Third Row: Items count, Date & Action Buttons */}
                <div className="mobile-card-row mobile-card-footer">
                  <div className="mobile-footer-info">
                    <span>商品 {itemsCount} 件</span>
                    <span className="mobile-meta-divider">|</span>
                    <span>到貨：{p.arrived_at ? p.arrived_at.replace(/-/g, '/') : '未到貨'}</span>
                  </div>
                  
                  <div className="mobile-footer-actions">
                    <button 
                      className="mobile-card-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeletePackage(p.id, e);
                      }}
                      title="刪除包裹"
                    >
                      <Trash2 size={13} />
                    </button>
                    <span className="mobile-card-link">
                      查看內容
                      <ChevronRight size={14} style={{ marginLeft: '1px' }} />
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // Desktop Logistics Dashboard Cards Layout
        <div className="package-cards-list">
          {filteredPackages.map(p => {
            const itemsCount = getPackageItemsCount(p.id);
            return (
              <div 
                key={p.id} 
                className="package-card"
                onClick={() => navigate(`/japan-packages/${p.id}`)}
              >
                {/* Column 1: Carrier & Package Meta */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {p.carrier ? renderCarrierBadge(p.carrier) : (
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        background: '#f1f5f9',
                        color: '#475569',
                        border: '1px solid #e2e8f0',
                        padding: '4px 10px',
                        borderRadius: '8px',
                        fontSize: '12px',
                        fontWeight: 700
                      }}>
                        <span style={{ fontSize: '14px' }}>📦</span>
                        <span>其他物流</span>
                      </span>
                    )}
                    {p.vendor_name && (
                      <span style={{ 
                        background: '#f8fafc', 
                        color: '#64748b', 
                        border: '1px solid #e2e8f0',
                        padding: '4px 10px', 
                        borderRadius: '8px', 
                        fontSize: '12px', 
                        fontWeight: 600 
                      }}>
                        {p.vendor_name}
                      </span>
                    )}
                  </div>
                  
                  <div style={{ 
                    fontSize: '16px', 
                    fontWeight: 700, 
                    color: '#0f172a', 
                    wordBreak: 'break-word', 
                    lineHeight: 1.4 
                  }}>
                    {p.title}
                  </div>

                  {p.tracking_number ? (
                    <div style={{ fontSize: '13px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 500 }}>物流單號：</span>
                      <code style={{ 
                        fontWeight: 700, 
                        color: '#0f172a', 
                        background: '#f1f5f9', 
                        padding: '2px 8px', 
                        borderRadius: '6px', 
                        fontFamily: 'monospace',
                        fontSize: '13px'
                      }}>
                        {p.tracking_number}
                      </code>
                      {(() => {
                        const url = getTrackingUrl(p.carrier || '', p.tracking_number || '');
                        return url ? (
                          <a 
                            href={url} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            onClick={e => e.stopPropagation()} 
                            style={{ 
                              color: '#2563eb', 
                              display: 'inline-flex', 
                              alignItems: 'center', 
                              gap: '4px',
                              fontSize: '12px',
                              fontWeight: 600,
                              textDecoration: 'none'
                            }}
                            title="點一下直接查詢物流"
                          >
                            <span>🔗</span>
                            <span style={{ textDecoration: 'underline' }}>點擊查詢</span>
                          </a>
                        ) : null;
                      })()}
                    </div>
                  ) : (
                    <div style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic' }}>無物流單號</div>
                  )}
                </div>

                {/* Column 2: Goods Quantity */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', borderLeft: '1px solid #f1f5f9', borderRight: '1px solid #f1f5f9', padding: '0 8px', height: '100%' }}>
                  <span style={{ fontSize: '20px' }}>📦</span>
                  <span style={{ fontSize: '32px', fontWeight: 800, color: '#1e293b', lineHeight: 1 }}>{itemsCount}</span>
                  <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 600 }}>件商品</span>
                </div>

                {/* Column 3: Shipped Date */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px', color: '#475569', paddingLeft: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '16px' }}>📅</span>
                    <div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>寄出：</div>
                      <div style={{ fontWeight: 700, color: '#334155' }}>{p.shipped_at || '-'}</div>
                    </div>
                  </div>
                </div>

                {/* Column 4: Status Badge */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
                  {renderStatusBadge(p.status)}
                  <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>包裹狀態</div>
                </div>

                {/* Column 5: Action Button Grid */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }} onClick={e => e.stopPropagation()}>
                  <button 
                    className="btn btn-primary"
                    onClick={() => navigate(`/japan-packages/${p.id}`)}
                    style={{ 
                      width: '100%', 
                      height: '38px',
                      fontSize: '13.5px',
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--color-primary)',
                      color: '#fff',
                      border: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    <Eye size={15} />
                    <span>查看內容</span>
                  </button>
                  <div style={{ display: 'flex', gap: '6px', width: '100%' }}>
                    <button 
                      className="btn-dash-action" 
                      onClick={(e) => handleTrackingClick(p, e)}
                      style={{ flex: 1, padding: '0 8px', fontSize: '11.5px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                    >
                      <Truck size={12} />
                      <span>查詢物流</span>
                    </button>
                    <button 
                      className="btn-dash-action" 
                      onClick={(e) => handleEditClick(p, e)}
                      style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      title="編輯"
                    >
                      <Pencil size={12} />
                    </button>
                    <button 
                      className="btn-dash-action btn-dash-delete" 
                      onClick={(e) => handleDeletePackage(p.id, e)}
                      style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      title="刪除"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isMobile && (
        <>
          {/* Floating Action Button for Mobile */}
          <button
            className="fab-btn"
            onClick={() => {
              setEditingPackageId(null);
              setNewPackageForm({
                title: '',
                vendor_name: '',
                carrier: 'ヤマト運輸 (Yamato)',
                custom_carrier: '',
                tracking_number: '',
                shipped_at: '',
                expected_arrival_at: '',
                arrived_at: '',
                status: 'registered',
                note: ''
              });
              openAddModal();
            }}
            title="登記新包裹"
          >
            <Plus size={24} />
          </button>

          {/* Bottom Sheet Drawer for Carrier Selection */}
          {showCarrierDrawer && (
            <div 
              className={`drawer-overlay ${animateCarrierDrawer ? 'active' : ''}`} 
              onClick={closeCarrierDrawer}
            >
              <div 
                className="drawer-content" 
                onClick={e => e.stopPropagation()}
              >
                <div className="drawer-header">
                  <span className="drawer-title">選擇物流廠商</span>
                  <button 
                    className="drawer-close"
                    onClick={closeCarrierDrawer}
                  >
                    &times;
                  </button>
                </div>
                <div className="drawer-body">
                  {[
                    { key: 'all', label: '全部物流' },
                    { key: 'post', label: 'JP Post' },
                    { key: 'yamato', label: 'Yamato' },
                    { key: 'sagawa', label: 'Sagawa' },
                    { key: 'custom', label: '其他' }
                  ].map(item => (
                    <button
                      key={item.key}
                      className={`drawer-item ${carrierFilter === item.key ? 'active' : ''}`}
                      onClick={() => {
                        setCarrierFilter(item.key);
                        closeCarrierDrawer();
                      }}
                    >
                      <span>{item.label}</span>
                      {carrierFilter === item.key && <CheckCircle2 size={16} style={{ color: '#2563eb' }} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Add / Edit Package Modal */}
      {showAddModal && (
        <div 
          className={`modal-overlay ${animateAddModal ? 'active' : ''}`} 
          onClick={closeAddModal}
        >
          <div 
            className="modal-content" 
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '580px' }}
          >
            <div className="modal-header">
              <h3 style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Plus size={18} style={{ color: '#2563eb' }} />
                {editingPackageId ? '修改日本國內包裹資訊' : '登記日本國內新包裹'}
              </h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={closeAddModal}>
                <Plus size={18} style={{ transform: 'rotate(45deg)' }} />
              </button>
            </div>
            <form onSubmit={handleAddSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">包裹名稱 <span style={{ color: '#ef4444' }}>*</span></label>
                  <input 
                    type="text" 
                    className="input" 
                    placeholder="例如: 駿河屋 5月訂單包裹 / Booth 六月新娘周邊"
                    required
                    value={newPackageForm.title}
                    onChange={e => setNewPackageForm({ ...newPackageForm, title: e.target.value })}
                  />
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">寄件廠商 (Vendor)</label>
                    <input 
                      type="text" 
                      className="input" 
                      placeholder="例如: Booth / 駿河屋 / animate"
                      value={newPackageForm.vendor_name}
                      onChange={e => setNewPackageForm({ ...newPackageForm, vendor_name: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">包裹狀態</label>
                    <select 
                      className="input"
                      value={newPackageForm.status}
                      onChange={e => {
                        const { statusVal, arrivedAtVal } = handleStatusChange(e.target.value, newPackageForm.arrived_at);
                        setNewPackageForm({ ...newPackageForm, status: statusVal, arrived_at: arrivedAtVal });
                      }}
                    >
                      <option value="registered">已登記 (registered)</option>
                      <option value="arrived">已到小幫手家 (arrived)</option>
                      <option value="confirmed">已點收 (confirmed)</option>
                      <option value="problem">有問題 (problem)</option>
                    </select>
                  </div>
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">日本物流公司</label>
                    <select 
                      className="input"
                      value={newPackageForm.carrier}
                      onChange={e => setNewPackageForm({ ...newPackageForm, carrier: e.target.value })}
                    >
                      {CARRIERS_LIST.map(c => (
                        <option key={c.keyword} value={c.name}>{c.name}</option>
                      ))}
                      <option value="custom">其他 (請手動輸入)</option>
                    </select>
                  </div>

                  {newPackageForm.carrier === 'custom' && (
                    <div className="form-group">
                      <label className="form-label">自訂物流公司名稱</label>
                      <input 
                        type="text" 
                        className="input" 
                        placeholder="例如: 西濃運輸"
                        required
                        value={newPackageForm.custom_carrier}
                        onChange={e => setNewPackageForm({ ...newPackageForm, custom_carrier: e.target.value })}
                      />
                    </div>
                  )}

                  <div className="form-group">
                    <label className="form-label">日本國內追蹤單號</label>
                    <input 
                      type="text" 
                      className="input" 
                      placeholder="追蹤單號"
                      value={newPackageForm.tracking_number}
                      onChange={e => setNewPackageForm({ ...newPackageForm, tracking_number: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">出貨日期 (Shipped At)</label>
                    <input 
                      type="date" 
                      className="input" 
                      value={newPackageForm.shipped_at}
                      onChange={e => setNewPackageForm({ ...newPackageForm, shipped_at: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">實際抵達日期 (Arrived At)</label>
                    <input 
                      type="date" 
                      className="input" 
                      value={newPackageForm.arrived_at}
                      onChange={e => setNewPackageForm({ ...newPackageForm, arrived_at: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-group full-width">
                  <label className="form-label">備註</label>
                  <textarea 
                    className="input" 
                    rows={3} 
                    placeholder="輸入備註說明..."
                    style={{ resize: 'vertical' }}
                    value={newPackageForm.note}
                    onChange={e => setNewPackageForm({ ...newPackageForm, note: e.target.value })}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={closeAddModal}>取消</button>
                <button type="submit" className="btn btn-primary" disabled={!newPackageForm.title.trim()}>
                  {editingPackageId ? '儲存修改' : '儲存登記'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}    </div>
  );
}
