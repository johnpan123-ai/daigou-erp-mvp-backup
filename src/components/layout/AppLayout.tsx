import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PackageSearch, Settings, Box, FileText, Receipt, Menu, X, Monitor, Smartphone, LayoutDashboard, Layout, Truck, ChevronLeft, ChevronRight, Archive, Layers } from 'lucide-react';
import { useViewport } from '../../contexts/ViewportContext';
import { getProviderMode, setProviderMode } from '../../providers/providerMode';
import { useAuth } from '../../auth/AuthProvider';
import { useRole } from '../../auth/useRole';
import '../../styles/layout.css'; // Ensure layout classes are applied

interface SidebarItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  state?: any;
}

function SidebarItem({ to, icon, label, onClick, state }: SidebarItemProps) {
  const location = useLocation();
  const { isMobile } = useViewport();
  const isActive = 
    (to === '/dashboard' || to === '/')
      ? (location.pathname === '/' || location.pathname === '/dashboard')
      : (to === '/inventory')
        ? location.pathname === '/inventory'
        : location.pathname.startsWith(to);

  // Dynamically resize Lucide icons on mobile to 26px
  const clonedIcon = isMobile && React.isValidElement(icon)
    ? React.cloneElement(icon, { size: 26 } as any)
    : icon;

  return (
    <Link 
      to={to} 
      state={state}
      onClick={onClick}
      className={`nav-item ${isActive ? 'active' : ''}`}
      style={isMobile ? {
        height: '64px',
        minHeight: '64px',
        margin: '10px 0',
        padding: '0 20px',
        gap: '22px',
        borderRadius: '12px',
        fontSize: '20px',
        fontWeight: 600
      } : undefined}
    >
      <span className="nav-icon" style={isMobile ? { width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}>
        {clonedIcon}
      </span>
      <span className="nav-label">{label}</span>
    </Link>
  );
}


export function AppLayout({ children }: { children: React.ReactNode }) {
  const { mode, setMode, isMobile } = useViewport();
  const { user, loading, signOut } = useAuth();
  const { role, displayName, isProfileLoading, canViewPage } = useRole();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('sidebar_collapsed');
    return saved === 'true';
  });
  const location = useLocation();
  const navigate = useNavigate();

  const toggleSidebar = () => {
    setIsCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
  };

  useEffect(() => {
    if (!loading && !isProfileLoading) {
      if (!canViewPage(location.pathname)) {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [loading, isProfileLoading, location.pathname, navigate, canViewPage]);

  // Force automatic mode on mount so the layout responds dynamically to simulated or real mobile screens
  useEffect(() => {
    if (mode === 'desktop') {
      setMode('auto');
    }
  }, []);

  // Prevent background scrolling when mobile menu is open
  useEffect(() => {
    if (isMobile && isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobile, isMobileMenuOpen]);

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
    <div className={`app-shell ${(!isMobile && isCollapsed) ? 'sidebar-collapsed' : ''}`}>
      
      {/* Backdrop overlay for mobile drawer */}
      {isMobile && (
        <div 
          className={`mobile-backdrop ${isMobileMenuOpen ? 'active' : ''}`}
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`app-sidebar ${isMobile ? (isMobileMenuOpen ? 'mobile-open' : 'mobile-hidden') : ''}`} style={{ zIndex: isMobile ? 9999 : undefined }}>
        
        {/* Sidebar Logo */}
        <div className="flex items-center justify-between sidebar-logo">
          <div className="flex items-center logo-text-group">
            <div className="logo-icon-box">
              <Box size={26} />
            </div>
            <span className="logo-text">採購工作台</span>
          </div>
          {isMobile ? (
            <button className="btn btn-ghost close-mobile-menu" onClick={() => setIsMobileMenuOpen(false)}>
              <X size={18} />
            </button>
          ) : (
            <button className="btn-toggle-sidebar" onClick={toggleSidebar} title={isCollapsed ? '展開選單' : '收合選單'}>
              {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          )}
        </div>

        <nav className="flex-col sidebar-nav-container">
          <div className="sidebar-section-title">
            主選單
          </div>
          <SidebarItem to="/dashboard" icon={<LayoutDashboard size={20} />} label="主頁面" onClick={() => setIsMobileMenuOpen(false)} />
          {user && canViewPage('/inventory') && (
            <SidebarItem to="/inventory" icon={<PackageSearch size={20} />} label="商品清單匯入" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          {/* Hiding 訂單快速匯入 per request, but keeping code/page intact */}
          {/* {canViewPage('/orders-import') && (
            <SidebarItem to="/orders-import" icon={<ListOrdered size={20} />} label="訂單快速匯入" onClick={() => setIsMobileMenuOpen(false)} />
          )} */}
          <SidebarItem to="/purchase-records" state={{ resetSearch: Date.now() }} icon={<Receipt size={20} />} label="訂購紀錄表" onClick={() => setIsMobileMenuOpen(false)} />
          {canViewPage('/purchasing') && (
            <SidebarItem to="/purchasing" icon={<FileText size={20} />} label="採購總表" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          {canViewPage('/japan-packages') && (
            <SidebarItem to="/japan-packages" icon={<Truck size={20} />} label="日本包裹管理" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          <SidebarItem to="/unlisted-items" icon={<Archive size={20} />} label="待下架商品" onClick={() => setIsMobileMenuOpen(false)} />
          {canViewPage('/duplicate-variants') && (
            <SidebarItem to="/duplicate-variants" icon={<Layers size={20} />} label="重複品項管理" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          {canViewPage('/settings') && (
            <SidebarItem to="/settings" icon={<Settings size={20} />} label="設定" onClick={() => setIsMobileMenuOpen(false)} />
          )}
          {isMobile && (
            <>
              {/* Connection Mode & Account block */}
              <div className="sidebar-mobile-auth" style={{ 
                padding: '24px 20px', 
                backgroundColor: '#f8fafc', 
                borderRadius: '16px', 
                border: '1px solid #e2e8f0', 
                marginTop: '40px',
                display: 'flex',
                flexDirection: 'column',
                gap: '20px'
              }}>
                {/* 系統狀態 */}
                <div className="flex flex-col gap-xs">
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    系統狀態
                  </span>
                  {(() => {
                    const mode = getProviderMode();
                    let modeLabel = '本地模式';
                    let dotColor = '#10B981'; // green

                    if (mode === 'cloud') {
                      modeLabel = '雲端模式';
                      dotColor = '#6366f1'; // indigo
                    } else if (mode === 'fallback') {
                      modeLabel = '備援模式';
                      dotColor = '#3b82f6'; // blue
                    }

                    return (
                      <div className="flex items-center gap-xs" style={{ fontSize: '16px', fontWeight: 600, color: '#0f172a', marginTop: '2px' }}>
                        <span style={{ 
                          width: '8px', 
                          height: '8px', 
                          borderRadius: '50%', 
                          backgroundColor: dotColor, 
                          display: 'inline-block' 
                        }}></span>
                        {modeLabel}
                      </div>
                    );
                  })()}
                </div>

                {/* 目前身分 / 帳號資訊 */}
                {(() => {
                  if (loading || isProfileLoading) {
                    return <div className="text-xs text-muted">載入中...</div>;
                  }
                  
                  const isCloud = providerMode === 'cloud' || providerMode === 'fallback';
                  
                  if (!user) {
                    return (
                      <div className="flex flex-col gap-md">
                        <div className="flex flex-col gap-xs">
                          <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            目前身分
                          </span>
                          <div style={{ fontSize: '16px', fontWeight: 600, color: '#0f172a', marginTop: '2px' }}>
                            {isCloud ? '訪客 (雲端唯讀)' : '本地管理員（OWNER）'}
                          </div>
                        </div>
                        <Link 
                          to="/login" 
                          onClick={() => setIsMobileMenuOpen(false)} 
                          className="btn btn-primary" 
                          style={{ 
                            width: '100%', 
                            textAlign: 'center', 
                            padding: '12px', 
                            fontSize: '14px', 
                            color: '#fff', 
                            backgroundColor: 'var(--color-primary)', 
                            border: 'none', 
                            borderRadius: '10px', 
                            fontWeight: 600, 
                            display: 'block', 
                            textDecoration: 'none',
                            boxShadow: '0 2px 4px rgba(59, 130, 246, 0.15)'
                          }}
                        >
                          {isCloud ? '管理員登入' : '登入雲端'}
                        </Link>
                      </div>
                    );
                  }

                  return (
                    <div className="flex flex-col gap-md">
                      <div className="flex flex-col gap-xs">
                        <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          目前身分
                        </span>
                        <div style={{ fontSize: '16px', fontWeight: 600, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                          {displayName || user.email?.split('@')[0] || '已登入'}
                          <span className="badge" style={{ 
                            backgroundColor: role === 'owner' ? '#fed7d7' : role === 'staff' ? '#feebc8' : '#e2e8f0', 
                            color: role === 'owner' ? '#9b2c2c' : role === 'staff' ? '#9c4221' : '#4a5568', 
                            border: '1px solid currentColor', 
                            padding: '2px 6px', 
                            borderRadius: '6px', 
                            fontSize: '10px',
                            textTransform: 'uppercase',
                            fontWeight: 700
                          }}>
                            {role || 'viewer'}
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: '#64748b', wordBreak: 'break-all', opacity: 0.8, marginTop: '2px' }}>
                          {user.email}
                        </div>
                      </div>
                      <button 
                        onClick={() => {
                          signOut();
                          setIsMobileMenuOpen(false);
                        }}
                        className="btn btn-ghost text-danger" 
                        style={{ 
                          width: '100%', 
                          padding: '12px', 
                          fontSize: '14px', 
                          border: '1px solid #fed7d7', 
                          color: 'var(--color-danger)', 
                          backgroundColor: '#fff5f5', 
                          borderRadius: '10px', 
                          fontWeight: 600, 
                          cursor: 'pointer' 
                        }}
                      >
                        登出
                      </button>
                    </div>
                  );
                })()}
              </div>

              {/* Viewport Switcher (DevTools) */}
              <div style={{ 
                marginTop: '20px', 
                padding: '20px', 
                backgroundColor: '#f1f5f9', 
                borderRadius: '16px', 
                border: '1px solid #e2e8f0',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px'
              }}>
                <div style={{ margin: 0, padding: 0, fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  版面預覽 (開發者工具)
                </div>
                <div className="flex items-center gap-xs" style={{ border: '1px solid #cbd5e1', padding: '3px', borderRadius: '10px', backgroundColor: '#fff' }}>
                  <button 
                    onClick={() => {
                      setMode('auto');
                      setIsMobileMenuOpen(false);
                    }} 
                    className={`btn ${mode === 'auto' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '8px 4px', borderRadius: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', border: 'none', cursor: 'pointer', backgroundColor: mode === 'auto' ? 'var(--color-primary)' : 'transparent', color: mode === 'auto' ? '#fff' : 'var(--color-text-secondary)' }}
                    title="自動偵測 (Auto)"
                  >
                    <Layout size={12} /> <span>Auto</span>
                  </button>
                  <button 
                    onClick={() => {
                      setMode('desktop');
                      setIsMobileMenuOpen(false);
                    }} 
                    className={`btn ${mode === 'desktop' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '8px 4px', borderRadius: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', border: 'none', cursor: 'pointer', backgroundColor: mode === 'desktop' ? 'var(--color-primary)' : 'transparent', color: mode === 'desktop' ? '#fff' : 'var(--color-text-secondary)' }}
                    title="強制桌機版"
                  >
                    <Monitor size={12} /> <span>Desktop</span>
                  </button>
                  <button 
                    onClick={() => {
                      setMode('mobile');
                      setIsMobileMenuOpen(false);
                    }} 
                    className={`btn ${mode === 'mobile' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '8px 4px', borderRadius: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', border: 'none', cursor: 'pointer', backgroundColor: mode === 'mobile' ? 'var(--color-primary)' : 'transparent', color: mode === 'mobile' ? '#fff' : 'var(--color-text-secondary)' }}
                    title="強制手機版"
                  >
                    <Smartphone size={12} /> <span>Mobile</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </nav>
      </aside>

      {/* Main Area */}
      <main className="main-area">
        
        {/* Global App Header */}
        <header className="app-header">
          <div className="flex items-center gap-sm">
            {isMobile && (
              <button className="btn btn-ghost" style={{ padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>
                {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
              </button>
            )}
            {!isMobile && (
              <span className="text-sm font-semibold text-secondary">WorkSpace /</span>
            )}
            <h2 style={{ fontSize: isMobile ? '18px' : '14px', margin: 0, fontWeight: 600 }}>
              {isMobile ? '採購工作台' : '主系統'}
            </h2>
            {!isMobile && (() => {
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
          {!isMobile && (
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
          )}
        </header>

        {/* Page Content */}
        <div className={`page-content ${location.pathname.startsWith('/japan-packages') ? 'page-content-full' : ''}`}>
          {getProviderMode() === 'local' && location.pathname !== '/login' && (
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
              {!user ? (
                <>
                  <div className="flex items-center gap-sm">
                    <span style={{ fontSize: '16px' }}>💡</span>
                    <span>目前為本地模式，資料只存在此瀏覽器。登入後可啟用雲端同步。</span>
                  </div>
                  <Link to="/login" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px', height: 'auto', minHeight: 'auto', backgroundColor: '#d97706', borderColor: '#d97706', color: '#fff', fontWeight: 600 }}>
                    登入雲端
                  </Link>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-sm">
                    <span style={{ fontSize: '16px' }}>⚠️</span>
                    <span>目前使用本地模式，資料不會同步至雲端。</span>
                  </div>
                  <button 
                    onClick={() => {
                      setProviderMode('cloud');
                      window.location.reload();
                    }}
                    className="btn btn-primary" 
                    style={{ padding: '6px 12px', fontSize: '12px', height: 'auto', minHeight: 'auto', backgroundColor: '#d97706', borderColor: '#d97706', color: '#fff', fontWeight: 600 }}
                  >
                    切換回雲端模式
                  </button>
                </>
              )}
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
