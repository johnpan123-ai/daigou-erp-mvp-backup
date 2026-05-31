import { calculateFinalMyacgDemand, LocalStorageAdapter } from '../src/lib/db.js';

// Mock localStorage
const store = {};
global.localStorage = {
  getItem: (key) => store[key] || null,
  setItem: (key, val) => { store[key] = val; },
  removeItem: (key) => { delete store[key]; }
};

const mockInventory = [
  {
    myacg_item_code: "SKU001",
    product_title: "Hololive Card",
    raw_variant_name: "Red",
    listing_type: "一般預購",
    final_price: 100,
    myacg_available_quantity: 10,
    myacg_sold_quantity: 5,
    myacg_listed_at: "2026-05-01"
  }
];

const mockSalesOrders = [
  {
    id: "order-1",
    platform: "myacg",
    order_number: "ORD001",
    buyer_name: "Buyer A",
    created_at: "2026-05-05"
  }
];

const mockSalesOrderItems = [
  {
    id: "item-1",
    order_id: "order-1",
    myacg_item_code: "SKU001",
    quantity: 3,
    order_status: "已完成"
  },
  {
    id: "item-2",
    order_id: "order-1",
    myacg_item_code: undefined, // Undefined SKU
    quantity: 1,
    order_status: "已完成"
  }
];

store['erp_inventory'] = JSON.stringify(mockInventory);
store['erp_sales_orders'] = JSON.stringify(mockSalesOrders);
store['erp_sales_order_items'] = JSON.stringify(mockSalesOrderItems);

try {
  console.log("Testing calculateFinalMyacgDemand...");
  const demand = calculateFinalMyacgDemand("SKU001", mockInventory, mockSalesOrderItems);
  console.log("Demand calculated:", demand);
  
  console.log("Testing LocalStorageAdapter.getProductVariants...");
  const adapter = new LocalStorageAdapter();
  const variants = await adapter.getProductVariants();
  console.log("Product variants loaded successfully, count:", variants.length);
} catch (err) {
  console.error("Test failed with error:", err);
}
