import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.OUTBOUND_SEARCH_IME_PORT || '4317';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort', '--configLoader', 'runner',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitForServer = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${output}`);
};

const setNativeValue = (element, { value, composing = false, inputType = 'insertText' }) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('NATIVE_INPUT_VALUE_SETTER_MISSING');
  setter.call(element, value);
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    data: value,
    inputType,
    isComposing: composing,
  }));
};

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const supabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push({ method: request.method(), url: request.url() });
});

try {
  await page.goto(`${BASE_URL}/outbound-shipments`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  await page.evaluate(async () => {
    await window.dataProvider.saveOutboundShipments([
      { id: 'ime-draft', title: '草稿箱', tracking_number: 'TRACK-001', status: 'draft', created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T00:00:00.000Z' },
      { id: 'ime-shipped', title: '中文出庫', tracking_number: 'TRACK-002', status: 'shipped', created_at: '2026-11-11T00:00:00.000Z', updated_at: '2026-11-11T00:00:00.000Z' },
      { id: 'ime-packing', title: 'English Parcel 123', tracking_number: 'TRACK-003', status: 'packing', created_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-10T00:00:00.000Z' },
    ]);
  });
  await page.reload({ waitUntil: 'networkidle' });
  const input = page.getByTestId('outbound-search');
  await input.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="outbound-shipment-row"]').length === 3);

  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await input.evaluate(setNativeValue, { value: 'ㄓ', composing: true, inputType: 'insertCompositionText' });
  assert.equal(await input.inputValue(), 'ㄓ', 'IME draft must remain visible before candidate selection');
  assert.equal(new URL(page.url()).searchParams.get('q'), null, 'Partial IME phonetics must not rewrite route state');

  await page.getByTestId('outbound-status-draft').click();
  assert.equal(await input.inputValue(), 'ㄓ', 'A route rerender during composition must preserve the draft exactly');
  assert.equal(new URL(page.url()).searchParams.get('status'), 'draft');

  await input.evaluate(setNativeValue, { value: '草稿', composing: true, inputType: 'insertCompositionText' });
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '草稿' }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: '草稿', inputType: 'insertText', isComposing: false }));
  });
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === '草稿');
  assert.equal(await input.inputValue(), '草稿', 'Selected Chinese text must be committed once, without duplication');
  assert.equal(await page.getByTestId('outbound-shipment-row').count(), 1);
  assert.match(await page.getByTestId('outbound-shipment-row').first().innerText(), /草稿箱/u);

  await page.getByTestId('outbound-status-all').click();
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('status'));
  await input.fill('TRACK-002');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'TRACK-002');
  await page.waitForFunction(() => document.querySelector('[data-testid="outbound-shipment-row"]')?.textContent?.includes('中文出庫'));
  assert.match(await page.getByTestId('outbound-shipment-row').first().innerText(), /中文出庫/u, 'English/tracking search must remain unchanged');

  await input.fill('123');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === '123');
  await page.waitForFunction(() => document.querySelector('[data-testid="outbound-shipment-row"]')?.textContent?.includes('English Parcel 123'));
  assert.match(await page.getByTestId('outbound-shipment-row').first().innerText(), /English Parcel 123/u, 'Numeric search must remain unchanged');

  await input.evaluate(setNativeValue, { value: '中文', composing: false, inputType: 'insertFromPaste' });
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === '中文');
  assert.equal(await input.inputValue(), '中文', 'Paste must commit the exact text');

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await sleep(250);
  assert.equal(await input.inputValue(), '中文', 'LINE-style background/foreground events must not append the query');
  assert.equal(new URL(page.url()).searchParams.get('q'), '中文');

  await input.press('Control+A');
  await input.press('Backspace');
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('q'));
  assert.equal(await input.inputValue(), '', 'Delete must clear both draft and committed route state');
  assert.equal(await page.getByTestId('outbound-shipment-row').count(), 3, 'Clearing search must restore the original list');
  assert.deepEqual(supabaseRequests, [], 'The isolated IME regression must never connect to Supabase');

  console.log('PASS Zhuyin composition, candidate selection, route rerender, English, numeric, paste, delete, and continuous input');
  console.log('PASS status filter and search composition remain exact; LINE-style resume preserves query without appending');
  console.log('PASS isolated mobile regression performed zero Supabase requests and zero formal writes');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
