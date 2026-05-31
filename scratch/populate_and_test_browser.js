import { chromium } from 'playwright';
import { ClassicLevel } from 'classic-level';
import path from 'path';

const tempDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_temp'
);

async function readLevelDB() {
  const db = new ClassicLevel(tempDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  const data = {};

  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      const targetKeys = [
        'erp_inventory',
        'erp_product_variants',
        'erp_sales_order_items',
        'erp_purchase_batch_items',
        'erp_private_order_items',
        'erp_product_groups',
        'erp_product_categories',
        'erp_sales_orders'
      ];
      
      for (const tKey of targetKeys) {
        if (keyStr.includes(tKey)) {
          const valSlice = valBuf.slice(1);
          let parsedVal = null;
          try {
            parsedVal = JSON.parse(valSlice.toString('utf16le'));
          } catch (e) {
            try {
              parsedVal = JSON.parse(valSlice.toString('utf8'));
            } catch (e2) {
              try {
                parsedVal = JSON.parse(valBuf.toString('utf16le'));
              } catch (e3) {
                try {
                  parsedVal = JSON.parse(valBuf.toString('utf8'));
                } catch (e4) {}
              }
            }
          }
          if (parsedVal) {
            data[tKey] = parsedVal;
          }
        }
      }
    }
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }
  return data;
}

async function run() {
  const dbData = await readLevelDB();
  console.log('Read LevelDB. Found data keys:', Object.keys(dbData));

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
    
    console.log('Setting actual localStorage data...');
    await page.evaluate((data) => {
      localStorage.clear();
      if (data.erp_inventory) localStorage.setItem('erp_inventory', JSON.stringify(data.erp_inventory));
      if (data.erp_product_groups) localStorage.setItem('erp_product_groups', JSON.stringify(data.erp_product_groups));
      if (data.erp_product_variants) localStorage.setItem('erp_product_variants', JSON.stringify(data.erp_product_variants));
      if (data.erp_sales_orders) localStorage.setItem('erp_sales_orders', JSON.stringify(data.erp_sales_orders));
      if (data.erp_sales_order_items) localStorage.setItem('erp_sales_order_items', JSON.stringify(data.erp_sales_order_items));
      if (data.erp_product_categories) localStorage.setItem('erp_product_categories', JSON.stringify(data.erp_product_categories));
      if (data.erp_purchase_batch_items) localStorage.setItem('erp_purchase_batch_items', JSON.stringify(data.erp_purchase_batch_items));
      if (data.erp_private_order_items) localStorage.setItem('erp_private_order_items', JSON.stringify(data.erp_private_order_items));
    }, dbData);
    
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
