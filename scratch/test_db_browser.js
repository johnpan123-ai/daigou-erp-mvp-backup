import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('http://localhost:5174/');
    
    // Evaluate a script in the browser to fetch all product groups from the database
    const groups = await page.evaluate(async () => {
      // Access IndexedDB directly
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('daigou-erp-db');
        request.onsuccess = (event) => {
          const db = event.target.result;
          const transaction = db.transaction(['product_groups'], 'readonly');
          const store = transaction.objectStore('product_groups');
          const getRequest = store.getAll();
          getRequest.onsuccess = () => {
            resolve(getRequest.result);
          };
          getRequest.onerror = () => {
            reject(getRequest.error);
          };
        };
        request.onerror = (event) => {
          reject(event.target.error);
        };
      });
    });

    console.log(`Successfully fetched ${groups.length} product groups:`);
    groups.forEach(g => {
      console.log(`- Title: "${g.title}", ListingType: "${g.listing_type}", SourceType: "${g.source_type}", ClosingDate: "${g.closing_date}"`);
    });
  } catch (err) {
    console.error('Error during DB query:', err);
  } finally {
    await browser.close();
  }
}

run();
