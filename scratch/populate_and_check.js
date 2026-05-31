import { chromium } from 'playwright';

// Create realistic mock data including potential edge cases (nulls, undefineds, numbers, etc.)
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
  },
  {
    myacg_item_code: "12345", // Numeric-like string code
    product_title: "VSPO Badge",
    raw_variant_name: "Blue",
    listing_type: "一般預購",
    final_price: 150,
    myacg_available_quantity: 20,
    myacg_sold_quantity: 0,
    myacg_listed_at: "2026-05-02"
  }
];

const mockProductGroups = [
  {
    id: "group-1",
    title: "Hololive Item",
    normalized_title: "hololive item",
    listing_type: "一般預購",
    priority: "High",
    purchase_date: "2026-05-15",
    closing_date: "2026-06-05", // Closing in 5 days (urgent)
    release_month: "2026-08",
    has_official_site: false,
    product_url: "",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z"
  },
  {
    id: "group-2",
    title: "VSPO Item",
    normalized_title: "vspo item",
    listing_type: "一般預購",
    priority: "Medium",
    purchase_date: "",
    closing_date: "", // No closing date
    release_month: "",
    has_official_site: false,
    product_url: "",
    created_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z"
  },
  {
    id: "group-3",
    title: "Proxy Item GSC", // Matches proxy keyword
    normalized_title: "proxy item gsc",
    listing_type: "代理版",
    priority: "Low",
    purchase_date: "2026-05-10",
    closing_date: "2026-05-20", // Past closing date
    release_month: "2026-09",
    has_official_site: true,
    product_url: "http://example.com",
    created_at: "2026-05-03T00:00:00.000Z",
    updated_at: "2026-05-03T00:00:00.000Z"
  }
];

const mockProductVariants = [
  {
    id: "variant-1",
    product_group_id: "group-1",
    myacg_item_code: "SKU001",
    product_title: "Hololive Card",
    variant_name: "Red",
    myacg_auto_quantity: 5,
    waca_auto_quantity: 2,
    note: "",
    sort_order: 1
  },
  {
    id: "variant-2",
    product_group_id: "group-2",
    myacg_item_code: "12345",
    product_title: "VSPO Badge",
    variant_name: "Blue",
    myacg_auto_quantity: 0,
    waca_auto_quantity: 0,
    note: "",
    sort_order: 2
  },
  {
    id: "variant-3",
    product_group_id: "group-3",
    myacg_item_code: "", // Empty SKU code
    product_title: "Proxy Item GSC",
    variant_name: "Standard",
    myacg_auto_quantity: 0,
    waca_auto_quantity: 0,
    note: "",
    sort_order: 3
  },
  {
    id: "variant-4",
    product_group_id: "group-3",
    myacg_item_code: undefined, // Undefined SKU code
    product_title: "Proxy Item GSC",
    variant_name: "Special",
    myacg_auto_quantity: 0,
    waca_auto_quantity: 0,
    note: "",
    sort_order: 4
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
    myacg_item_code: undefined, // Undefined SKU on order item
    quantity: 1,
    order_status: "已完成"
  }
];

async function run() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    console.log(`BROWSER CONSOLE [${msg.type()}]: ${msg.text()}`);
  });

  page.on('pageerror', exception => {
    console.error(`BROWSER UNCAUGHT EXCEPTION: ${exception.message}`);
    if (exception.stack) {
      console.error(exception.stack);
    }
  });

  try {
    console.log('Navigating to http://localhost:5174/ ...');
    await page.goto('http://localhost:5174/');
    
    console.log('Setting localStorage data...');
    await page.evaluate((data) => {
      localStorage.setItem('erp_inventory', JSON.stringify(data.inventory));
      localStorage.setItem('erp_product_groups', JSON.stringify(data.groups));
      localStorage.setItem('erp_product_variants', JSON.stringify(data.variants));
      localStorage.setItem('erp_sales_orders', JSON.stringify(data.salesOrders));
      localStorage.setItem('erp_sales_order_items', JSON.stringify(data.salesOrderItems));
    }, {
      inventory: mockInventory,
      groups: mockProductGroups,
      variants: mockProductVariants,
      salesOrders: mockSalesOrders,
      salesOrderItems: mockSalesOrderItems
    });
    
    console.log('Reloading page to load data...');
    await page.reload({ waitUntil: 'networkidle' });
    
    console.log('Page reloaded. Title:', await page.title());
    
    const bodyText = await page.innerText('body');
    console.log('Length of body text:', bodyText.trim().length);
    console.log('Body snippet:', bodyText.substring(0, 500));
    
  } catch (err) {
    console.error('Error during browser execution:', err);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

run();
