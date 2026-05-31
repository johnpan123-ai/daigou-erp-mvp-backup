import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PackageSearch, ListOrdered, Settings, Box, BarChart3, Receipt, Menu, X, Monitor, Smartphone, LayoutDashboard, Layout } from 'lucide-react';
import { useViewport } from '../../contexts/ViewportContext';
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
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

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
          <SidebarItem to="/dashboard" icon={<LayoutDashboard size={20} />} label="Dashboard" onClick={() => setIsMobileMenuOpen(false)} />
          <SidebarItem to="/inventory" icon={<PackageSearch size={20} />} label="商品清單匯入" onClick={() => setIsMobileMenuOpen(false)} />
          <SidebarItem to="/orders-import" icon={<ListOrdered size={20} />} label="訂單快速匯入" onClick={() => setIsMobileMenuOpen(false)} />
          <SidebarItem to="/purchase-records" icon={<Receipt size={20} />} label="訂購紀錄表" onClick={() => setIsMobileMenuOpen(false)} />
          <SidebarItem to="/purchasing" icon={<BarChart3 size={20} />} label="採購差異總覽" onClick={() => setIsMobileMenuOpen(false)} />
          <SidebarItem to="/settings" icon={<Settings size={20} />} label="設定" onClick={() => setIsMobileMenuOpen(false)} />
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
          </div>

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
        </header>

        {/* Page Content */}
        <div className="page-content">
          <div className={(mode === 'mobile' && !isMobile) ? 'mobile-preview-frame' : ''}>
            {children}
          </div>
        </div>

      </main>
    </div>
  );
}
