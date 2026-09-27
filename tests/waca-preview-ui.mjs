import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1366, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto('http://127.0.0.1:4194/waca-preview.html');
    await page.getByRole('heading', { name: 'WACA 訂單整合' }).waitFor();
    assert.equal(await page.getByText('ISOLATED · 0 LIVE WRITE').count(), 1);
    assert.equal(await page.getByRole('button', { name: '在記憶體中預覽匯入' }).isDisabled(), true);
    for (const tab of ['結果摘要', '訂單明細', '商品對照', '未配對', '狀態衝突', '匯入紀錄']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
    }
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      main: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
    }));
    assert.ok(geometry.scroll <= geometry.viewport, `${width} horizontal overflow: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.main > width * 0.75, `${width} preview is too narrow`);
    console.log(`PASS WACA isolated preview ${width}px ${JSON.stringify(geometry)}`);
    await page.close();
  }
  const sourceFiles = [
    process.env.WACA_SAMPLE_XLSX || join(process.env.USERPROFILE || '', 'Downloads', 'waca資料.xlsx'),
    process.env.WACA_MYACG_XLS || join(process.env.USERPROFILE || '', 'Downloads', '399375_2026-09-27.xls'),
    process.env.WACA_ERP_SNAPSHOT || join(process.env.USERPROFILE || '', 'Downloads', 'cloud-erp-snapshot-2026-09-26-162318.json'),
  ];
  if (sourceFiles.every(existsSync)) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto('http://127.0.0.1:4194/waca-preview.html');
    await page.getByLabel('WACA 訂單 Excel').setInputFiles(sourceFiles[0]);
    await page.getByLabel('買動漫商品匯出').setInputFiles(sourceFiles[1]);
    await page.getByLabel('ERP 2.0 JSON 快照').setInputFiles(sourceFiles[2]);
    await page.getByRole('button', { name: '在記憶體中預覽匯入' }).click();
    await page.getByText('有效數量 111 = 已配對 103 + 待處理 8').waitFor();
    await page.getByRole('button', { name: '未配對', exact: true }).click();
    assert.equal(await page.locator('.waca-review-list article').count(), 10, '8 distinct unmatched features span 10 order-item records');
    await page.getByRole('button', { name: '商品對照', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 52);
    await page.close();
    console.log('PASS WACA actual workbook UI upload / result / 10 unmatched item records / 52 mappings');
  } else {
    console.log('SKIP WACA actual workbook UI upload: local user-supplied files not materialized');
  }
} finally {
  await browser.close();
}
