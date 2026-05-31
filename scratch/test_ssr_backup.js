import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard_backup.js';

// Setup mock storage
const store = {};
global.localStorage = {
  getItem: (key) => store[key] || null,
  setItem: (key, val) => { store[key] = val; },
  removeItem: (key) => { delete store[key]; }
};

const runTest = (name, data) => {
  console.log(`\n--- Running test: ${name} ---`);
  // Clear storage
  for (const k in store) delete store[k];
  
  // Populate storage
  if (data.inventory) store['erp_inventory'] = JSON.stringify(data.inventory);
  if (data.groups) store['erp_product_groups'] = JSON.stringify(data.groups);
  if (data.variants) store['erp_product_variants'] = JSON.stringify(data.variants);
  if (data.salesOrders) store['erp_sales_orders'] = JSON.stringify(data.salesOrders);
  if (data.salesOrderItems) store['erp_sales_order_items'] = JSON.stringify(data.salesOrderItems);
  if (data.categories) store['erp_product_categories'] = JSON.stringify(data.categories);
  if (data.batchItems) store['erp_purchase_batch_items'] = JSON.stringify(data.batchItems);
  if (data.privateOrderItems) store['erp_private_order_items'] = JSON.stringify(data.privateOrderItems);

  try {
    const html = ReactDOMServer.renderToString(
      React.createElement(MemoryRouter, null, 
        React.createElement(Dashboard, null)
      )
    );
    console.log(`Render successful! HTML length: ${html.length}`);
  } catch (error) {
    console.error(`Render FAILED:`, error);
  }
};

// Test Case 1: Minimal valid data
runTest("Minimal Valid Data", {
  groups: [{ id: "g1", title: "Hololive Item", closing_date: "2026-06-10" }],
  variants: [{ id: "v1", product_group_id: "g1", myacg_item_code: "SKU001", variant_name: "Ver A" }]
});

// Test Case 2: Variant with undefined SKU code or empty string
runTest("Variant with empty/undefined SKU", {
  groups: [{ id: "g1", title: "Item 1", closing_date: "2026-06-10" }],
  variants: [
    { id: "v1", product_group_id: "g1", myacg_item_code: "", variant_name: "Ver A" },
    { id: "v2", product_group_id: "g1", myacg_item_code: undefined, variant_name: "Ver B" }
  ]
});

// Test Case 3: Missing fields in group, categories, orders
runTest("Missing group closing_date or priority", {
  groups: [{ id: "g1", title: "Item 1", closing_date: undefined }],
  variants: [{ id: "v1", product_group_id: "g1", myacg_item_code: "SKU001" }]
});

// Test Case 4: Category listing type matching when listing_type is missing
runTest("Missing group listing_type", {
  groups: [{ id: "g1", title: "Item 1", closing_date: "2026-06-10", listing_type: undefined }],
  variants: [{ id: "v1", product_group_id: "g1", myacg_item_code: "SKU001" }]
});

// Test Case 5: Non-string group titles (e.g. number)
runTest("Group title is a number", {
  groups: [{ id: "g1", title: 12345, closing_date: "2026-06-10" }],
  variants: [{ id: "v1", product_group_id: "g1", myacg_item_code: "SKU001" }]
});

// Test Case 6: Malformed salesOrderItems in database
runTest("Sales order item SKU is undefined", {
  groups: [{ id: "g1", title: "Item 1", closing_date: "2026-06-10" }],
  variants: [{ id: "v1", product_group_id: "g1", myacg_item_code: "SKU001" }],
  salesOrderItems: [
    { id: "so1", order_id: "o1", myacg_item_code: "SKU001", quantity: 1 },
    { id: "so2", order_id: "o1", myacg_item_code: undefined, quantity: 2 } // Undefined SKU
  ],
  salesOrders: [{ id: "o1", platform: "myacg" }]
});
