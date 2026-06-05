import { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PackageSearch, ListOrdered, Settings, Box, BarChart3, Receipt, Menu, X, Monitor, Smartphone, LayoutDashboard, Layout } from 'lucide-react';
import { useViewport } from '../../contexts/ViewportContext';
import { getProviderMode } from '../../providers/providerMode';
import { useAuth } from '../../auth/AuthProvider';
import { useRole } from '../../auth/useRole';
import '../../styles/layout.css'; // Ensure layout classes are applied

interface SidebarItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}

function SidebarItem({ to, icon, label, onClick }: SidebarItemProps) {
  const location = useLocation();
  const isActive = 
    (to === '/dashboard' || to === '/')
      ? (location.pathname === '/' || location.pathname === '/dashboard')
      : (to === '/inventory')
        ? location.pathname === '/inventory'
        : location.pathname.startsWith(to);

  return (
    <Link 
      to={to} 
      onClick={onClick}
      className={`nav-item ${isActive ? 'active' : ''}`}
    >
      <span className="nav-icon">
        {icon}
      </span>
      {label}
    </Link>
  );
}


export function AppLayout({ children }: { children: React.ReactNode }) {
  const { mode, setMode, isMobile } = useViewport();
  const { user, loading, signOut } = useAuth();
  const { role, displayName, isProfileLoading, canViewPage } = useRole();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading) {
      if (!canViewPage(location.pathname)) {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [loading, location.pathname, navigate, canViewPage]);

  const providerMode = getProviderMode();
  const isCloudOrFallback = providerMode === 'cloud' || providerMode === 'fallback';

  if (isCloudOrFallback && loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: '16px' }}>
        <div style={{ 
          width: '40px', 
          height: '40px', 
          border: '4px solid #cbd5e1', 
          borderTopColor: 'var(--color-primary)', 
          borderRadius: '50%', 
          animation: 'spin 1s linear infinite' 
        }} />
        <span style={{ fontSize: '14px', color: '#64748b', fontWeight: 500 }}>正在初始化雲端同步...</span>
        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="app-shell">
      
      {/* Sidebar */}
      <aside className={`app-sidebar ${isMobile ? (isMobileMenuOpen ? 'mobile-open' : 'mobile-hidden') : ''}`}>
        
        {/* Sidebar Logo */}
        <div className="flex items-center gap-sm sidebar-logo">
          <div style={{
            width: '28px', height: '28px', backgroundColor: 'var(--color-primary)',
            borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff'
          }}>
            <Box size={16} />
          </div>
          <span>採購工作台</span>
        </div>

        <nav className="flex-col sidebar-nav-container">
          <div className="sidebar-section-title">
            主選單
          </div>
          <SidebarItem to="/dashboard" icon={<LayoutDashboard size={20} />} label="主頁面" onClick={() => setIsMobileMenuOpen(false)} />
          {user && canViewPage('/inventory') && (
            <SidebarItem to="/inventory" icon={<PackageSearch size={20} />} label="商品清單匯入" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          {canViewPage('/orders-import') && (
            <SidebarItem to="/orders-import" icon={<ListOrdered size={20} />} label="訂單快速匯入" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          <SidebarItem to="/purchase-records" icon={<Receipt size={20} />} label="訂購紀錄表" onClick={() => setIsMobileMenuOpen(false)} />
          {canViewPage('/purchasing') && (
            <SidebarItem to="/purchasing" icon={<BarChart3 size={20} />} label="採購差異總覽" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          {canViewPage('/settings') && (
            <SidebarItem to="/settings" icon={<Settings size={20} />} label="設定" onClick={() => setIsMobileMenuOpen(false)} />
          )}
        </nav>
      </aside>

      {/* Main Area */}
      <main className="main-area">
        
        {/* Global App Header */}
        <header className="app-header">
          <div className="flex items-center gap-sm">
            {isMobile && (
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>
                {isMobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
              </button>
            )}
            {!isMobile && (
              <span className="text-sm font-semibold text-secondary">WorkSpace /</span>
            )}
            <h2 style={{ fontSize: '14px', margin: 0, fontWeight: 600 }}>主系統</h2>
            {(() => {
              const mode = getProviderMode();
              let modeLabel = '本地模式';
              let badgeColor = '#319795';
              let badgeBg = '#e6fffa';
              let badgeBorder = '#b2f5ea';

              if (mode === 'cloud') {
                modeLabel = '雲端模式';
                badgeColor = '#6366f1';
                badgeBg = '#e0e7ff';
                badgeBorder = '#c7d2fe';
              } else if (mode === 'fallback') {
                modeLabel = '備援模式';
                badgeColor = '#3182ce';
                badgeBg = '#ebf8ff';
                badgeBorder = '#bee3f8';
              }

              return (
                <span className="badge flex items-center gap-xs" style={{ 
                  fontSize: '11px', 
                  padding: '2px 8px', 
                  borderRadius: '12px', 
                  backgroundColor: badgeBg, 
                  color: badgeColor, 
                  border: `1px solid ${badgeBorder}`,
                  fontWeight: 500
                }}>
                  <span style={{ 
                    width: '6px', 
                    height: '6px', 
                    borderRadius: '50%', 
                    backgroundColor: badgeColor, 
                    display: 'inline-block' 
                  }}></span>
                  {modeLabel}
                </span>
              );
            })()}
          </div>

          {/* Right Side Header Items: Auth Status + Viewport Switcher */}
          <div className="flex items-center gap-md">
            {/* Supabase Auth Status */}
            {(() => {
              if (loading || isProfileLoading) {
                return <span className="text-xs text-muted">載入中...</span>;
              }

              if (!user) {
                const isCloud = providerMode === 'cloud' || providerMode === 'fallback';
                return (
                  <div className="flex items-center gap-sm text-xs" style={{ borderRight: '1px solid var(--color-border)', paddingRight: '12px', marginRight: '4px' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {isCloud ? '雲端唯讀' : '本地端'}
                    </span>
                    <span className="font-semibold" style={{ color: 'var(--color-primary)' }}>
                      {isCloud ? '訪客' : '本地管理員'}
                    </span>
                    {!isCloud && (
                      <span className="badge" style={{ backgroundColor: '#ebf8ff', color: '#2b6cb0', border: '1px solid #bee3f8', padding: '1px 6px', borderRadius: '4px', fontSize: '10px' }}>
                        owner
                      </span>
                    )}
                    <Link to="/login" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px', height: 'auto', minHeight: 'auto', color: '#fff', backgroundColor: 'var(--color-primary)', border: 'none', borderRadius: '4px', fontWeight: 600, marginLeft: '8px' }}>
                      {isCloud ? '管理員登入' : '登入雲端'}
                    </Link>
                  </div>
                );
              }

              return (
                <div className="flex items-center gap-sm text-xs" style={{ borderRight: '1px solid var(--color-border)', paddingRight: '12px', marginRight: '4px' }}>
                  <div className="flex flex-col items-end gap-2xs hide-on-mobile" style={{ lineHeight: '1.2' }}>
                    <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
                      {displayName || '已登入'}
                    </span>
                    <span className="text-muted" style={{ fontSize: '10px' }}>
                      {user.email}
                    </span>
                  </div>
                  <span className="badge" style={{ 
                    backgroundColor: role === 'owner' ? '#fed7d7' : role === 'staff' ? '#feebc8' : role === 'helper' ? '#e2e8f0' : '#e6fffa', 
                    color: role === 'owner' ? '#9b2c2c' : role === 'staff' ? '#9c4221' : role === 'helper' ? '#4a5568' : '#234e52', 
                    border: '1px solid currentColor', 
                    padding: '1px 6px', 
                    borderRadius: '4px', 
                    fontSize: '10px',
                    textTransform: 'uppercase'
                  }}>
                    {role || 'viewer'}
                  </span>
                  <button 
                    onClick={signOut} 
                    className="btn btn-ghost text-danger" 
                    style={{ padding: '4px 8px', fontSize: '12px', height: 'auto', minHeight: 'auto', border: '1px solid #fed7d7', color: 'var(--color-danger)', backgroundColor: '#fff5f5', marginLeft: '8px' }}
                  >
                    登出
                  </button>
                </div>
              );
            })()}

            {/* Viewport Switcher (Dev Tool) */}
            <div className="flex items-center gap-xs" style={{ border: '1px solid var(--color-border)', padding: '2px', borderRadius: 'var(--radius-sm)' }}>
              <button 
                onClick={() => setMode('auto')} 
                className={`btn ${mode === 'auto' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '4px 8px', borderRadius: '2px' }}
                title="自動偵測 (Auto)"
              >
                <Layout size={14} /> <span className="text-xs hide-on-mobile">Auto</span>
              </button>
              <button 
                onClick={() => setMode('desktop')} 
                className={`btn ${mode === 'desktop' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '4px 8px', borderRadius: '2px' }}
                title="強制桌機版預覽 (Desktop Preview)"
              >
                <Monitor size={14} /> <span className="text-xs hide-on-mobile">Desktop</span>
              </button>
              <button 
                onClick={() => setMode('mobile')} 
                className={`btn ${mode === 'mobile' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '4px 8px', borderRadius: '2px' }}
                title="強制手機版預覽 (Mobile Preview)"
              >
                <Smartphone size={14} /> <span className="text-xs hide-on-mobile">Mobile</span>
              </button>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div className="page-content">
          {/* Local Mode Warning Banner */}
          {!user && getProviderMode() === 'local' && location.pathname !== '/login' && (
            <div style={{
              backgroundColor: '#fffbeb',
              border: '1px solid #fef3c7',
              color: '#d97706',
              padding: '12px 20px',
              borderRadius: '8px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '13px',
              fontWeight: 500,
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
            }}>
              <div className="flex items-center gap-sm">
                <span style={{ fontSize: '16px' }}>💡</span>
                <span>目前為本地模式，資料只存在此瀏覽器。登入後可啟用雲端同步。</span>
              </div>
              <Link to="/login" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px', height: 'auto', minHeight: 'auto', backgroundColor: '#d97706', borderColor: '#d97706', color: '#fff', fontWeight: 600 }}>
                登入雲端
              </Link>
            </div>
          )}
          <div className={(mode === 'mobile' && !isMobile) ? 'mobile-preview-frame' : ''}>
            {children}
          </div>
        </div>

      </main>
    </div>
  );
}
