import { chromium } from 'playwright';

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
    await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' });
    console.log('Page loaded. Title:', await page.title());
    
    // Check if there is any visible text
    const bodyText = await page.innerText('body');
    console.log('Length of body text:', bodyText.trim().length);
    console.log('Body snippet:', bodyText.substring(0, 500));
    
    // Check if #root or main app element has content
    const rootHtml = await page.innerHTML('#root');
    console.log('Length of #root HTML:', rootHtml.length);
    console.log('#root HTML snippet:', rootHtml.substring(0, 500));
    
  } catch (err) {
    console.error('Error during browser execution:', err);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

run();
