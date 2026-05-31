import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ViewportProvider } from './contexts/ViewportContext';
import { AuthProvider } from './auth/AuthProvider';
import { AppLayout } from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import Inventory from './pages/Inventory';
import OrdersImport from './pages/OrdersImport';
import PurchaseRecords from './pages/PurchaseRecords';
import PurchaseManagement from './pages/PurchaseManagement';
import Purchasing from './pages/Purchasing';
import Settings from './pages/Settings';
import Login from './pages/Login';

function App() {
  return (
    <ViewportProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppLayout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/inventory" element={<Inventory />} />

              <Route path="/orders-import" element={<OrdersImport />} />
              <Route path="/purchase-records" element={<PurchaseRecords />} />
              <Route path="/purchase-records/:id" element={<PurchaseManagement />} />
              <Route path="/purchasing" element={<Purchasing />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/login" element={<Login />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </AuthProvider>
    </ViewportProvider>
  );
}

export default App;
