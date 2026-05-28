import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ViewportProvider } from './contexts/ViewportContext';
import { AppLayout } from './components/layout/AppLayout';
import Inventory from './pages/Inventory';
import OrdersImport from './pages/OrdersImport';
import PurchaseRecords from './pages/PurchaseRecords';
import PurchaseManagement from './pages/PurchaseManagement';
import Purchasing from './pages/Purchasing';
import Settings from './pages/Settings';

function App() {
  return (
    <ViewportProvider>
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Inventory />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/orders-import" element={<OrdersImport />} />
            <Route path="/purchase-records" element={<PurchaseRecords />} />
            <Route path="/purchase-records/:id" element={<PurchaseManagement />} />
            <Route path="/purchasing" element={<Purchasing />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </ViewportProvider>
  );
}

export default App;
