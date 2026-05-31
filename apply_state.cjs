const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

const importsToReplace = "import { ChevronRight, ChevronDown, Plus, X, ArrowLeft, Search } from 'lucide-react';";
const newImports = "import { ChevronRight, ChevronDown, Plus, X, ArrowLeft, Search, AlertTriangle, Package, CheckSquare, RefreshCw, ShoppingCart, DollarSign, Filter, ListOrdered } from 'lucide-react';";
code = code.replace(importsToReplace, newImports);

const stateInsert = `  // Data for calculation
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<any[]>([]);
  const [filterMode, setFilterMode] = useState<'all' | 'abnormal'>('all');
  const [sortMode, setSortMode] = useState<'catalog' | 'shortage'>('catalog');
`;
code = code.replace('  // Data for calculation', stateInsert);

const loadDataEnd = `
    setPurchaseBatches(groupBatches);
    setPurchaseBatchItems(groupBatchItems);
`;
const newLoadDataEnd = `
    setPurchaseBatches(groupBatches);
    setPurchaseBatchItems(groupBatchItems);

    const allSO = await db.getSalesOrders();
    const allSOI = await db.getSalesOrderItems();
    const groupVariantCodes = new Set(groupVars.map(v => v.myacg_item_code));
    const groupSOI = allSOI.filter(i => groupVariantCodes.has(i.myacg_item_code));
    const groupSOIds = new Set(groupSOI.map(i => i.order_id));
    const groupSO = allSO.filter(o => groupSOIds.has(o.id));

    setSalesOrders(groupSO);
    setSalesOrderItems(groupSOI);
`;
code = code.replace(loadDataEnd, newLoadDataEnd);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('State and logic updated successfully');
