import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ViewportProvider } from './contexts/ViewportContext';
import { AuthProvider } from './auth/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StorageWarningBanner } from './components/StorageWarningBanner';
import { AppLayout } from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import Inventory from './pages/Inventory';
import OrdersImport from './pages/OrdersImport';
import PurchaseRecords from './pages/PurchaseRecords';
import PurchaseManagement from './pages/PurchaseManagement';
import RecentPurchases from './pages/RecentPurchases';
import Purchasing from './pages/Purchasing';
import JapanPackagesList from './pages/JapanPackagesList';
import JapanPackageDetail from './pages/JapanPackageDetail';
import Settings from './pages/Settings';
import Login from './pages/Login';
import UnlistedItems from './pages/UnlistedItems';
import DuplicateVariants from './pages/DuplicateVariants';
import OutboundShipmentsList from './pages/OutboundShipmentsList';
import OutboundShipmentDetail from './pages/OutboundShipmentDetail';

function App() {
  return (
    <ErrorBoundary>
    <ViewportProvider>
      <AuthProvider>
        <BrowserRouter>
          <StorageWarningBanner />
          <AppLayout>
            <div style={{ position: 'fixed', bottom: 10, right: 10, fontSize: '12px', color: '#64748b', zIndex: 9999, pointerEvents: 'none' }}>
              Hotfix H-2 display v2
            </div>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/inventory" element={<Inventory />} />

              <Route path="/orders-import" element={<OrdersImport />} />
              <Route path="/purchase-records" element={<PurchaseRecords />} />
              <Route path="/purchase-records/:id" element={<PurchaseManagement />} />
              <Route path="/recent-purchases" element={<RecentPurchases />} />
              <Route path="/purchasing" element={<Purchasing />} />
              <Route path="/japan-packages" element={<JapanPackagesList />} />
              <Route path="/japan-packages/:id" element={<JapanPackageDetail />} />
              <Route path="/outbound-shipments" element={<OutboundShipmentsList />} />
              <Route path="/outbound-shipments/:id" element={<OutboundShipmentDetail />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/unlisted-items" element={<UnlistedItems />} />
              <Route path="/duplicate-variants" element={<DuplicateVariants />} />
              <Route path="/login" element={<Login />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </AuthProvider>
    </ViewportProvider>
    </ErrorBoundary>
  );
}

export default App;
