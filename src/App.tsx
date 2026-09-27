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
import PasswordRecovery from './pages/PasswordRecovery';
import UnlistedItems from './pages/UnlistedItems';
import DuplicateVariants from './pages/DuplicateVariants';
import OutboundShipmentsList from './pages/OutboundShipmentsList';
import OutboundShipmentDetail from './pages/OutboundShipmentDetail';
import NextRawDbIntegrityProbe from './pages/NextRawDbIntegrityProbe';
import WacaIntegration from './pages/WacaIntegration';
import { CloudRealtimeSyncBoundary } from './contexts/CloudRealtimeSyncContext';
import type { SupabaseClient } from '@supabase/supabase-js';

interface AppProps {
  authClient?: SupabaseClient;
  navigateAuth?: (path: string) => void;
}

function App({ authClient, navigateAuth }: AppProps = {}) {
  return (
    <ErrorBoundary>
    <ViewportProvider>
      <AuthProvider authClient={authClient} navigateAuth={navigateAuth}>
        <BrowserRouter>
          <CloudRealtimeSyncBoundary>
          <StorageWarningBanner />
          <AppLayout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/inventory" element={<Inventory />} />

              <Route path="/orders-import" element={<OrdersImport />} />
              <Route path="/purchase-records" element={<PurchaseRecords />} />
              <Route path="/waca" element={<WacaIntegration />} />
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
              <Route path="/auth/recovery" element={<PasswordRecovery />} />
              <Route path="/diagnostics/next-raw-db" element={<NextRawDbIntegrityProbe />} />
            </Routes>
          </AppLayout>
          </CloudRealtimeSyncBoundary>
        </BrowserRouter>
      </AuthProvider>
    </ViewportProvider>
    </ErrorBoundary>
  );
}

export default App;
