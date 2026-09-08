import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_AUTH_RECOVERY_TEST_PORT || '4227';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/cloud-p0-5-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    if (sessionStorage.getItem('p0_5_initialized') !== 'true') {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('p0_5_local_sentinel', 'LOCAL-A-UNCHANGED');
      localStorage.setItem('p0_5_cloud_sentinel', 'CLOUD-B-UNCHANGED');
      sessionStorage.setItem('p0_5_initialized', 'true');
    }
  });
  const page = await context.newPage();
  const cloudRequests = [];
  const pageErrors = [];
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) cloudRequests.push(request.url());
  });
  page.on('pageerror', error => pageErrors.push(error.message));

  const waitMode = mode => page.waitForFunction(expected => localStorage.getItem('erp_provider_mode') === expected, mode);
  const expectSentinels = async () => assert.deepEqual(await page.evaluate(() => ({
    local: localStorage.getItem('p0_5_local_sentinel'),
    cloud: localStorage.getItem('p0_5_cloud_sentinel'),
  })), { local: 'LOCAL-A-UNCHANGED', cloud: 'CLOUD-B-UNCHANGED' });
  const fillLogin = async (email, password) => {
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole('button', { name: '登入', exact: true }).click();
  };

  try {
    // A: no session defaults to a usable Local Mode; Cloud mode is unavailable.
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '小河馬訂購紀錄表' }).waitFor();
    await waitMode('local');
    await page.getByText('本地模式｜資料不會同步雲端', { exact: false }).first().waitFor();
    await expectSentinels();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('auth-dashboard').waitFor();
    await page.getByTestId('auth-user').getByText('none').waitFor();
    await waitMode('local');
    await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'cloud'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitMode('local');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });

    // Login errors are distinguishable.
    await fillLogin('wrong@staging.invalid', 'wrong');
    await page.getByText('Email 或密碼錯誤，請重新確認。', { exact: true }).waitFor();
    await fillLogin('network@staging.invalid', 'ValidPassword123!');
    await page.getByText('目前無法連線到登入服務，請確認網路後再試。', { exact: true }).waitFor();

    // Forgot Password must target the dedicated recovery callback.
    await page.getByText('忘記密碼？', { exact: true }).click();
    await page.locator('input[type="email"]').fill('p0-5-editor@staging.invalid');
    await page.getByRole('button', { name: '傳送重設信件' }).click();
    await page.getByText('密碼重設信件已寄出，請檢查您的電子信箱。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__P0_5_AUTH_HARNESS__.resetRedirect), `${BASE_URL}/auth/recovery`);
    await page.getByText('返回登入', { exact: true }).click();

    // B: normal login automatically enters Cloud and resolves an editor profile.
    await fillLogin('p0-5-editor@staging.invalid', 'ValidPassword123!');
    await page.waitForURL(url => url.pathname === '/');
    await waitMode('cloud');
    await page.getByTestId('auth-user').getByText('p0-5-editor@staging.invalid').waitFor();
    await page.getByTestId('auth-role').getByText('owner').waitFor();
    await page.getByTestId('editor-check').getByText('true').waitFor();
    await page.getByText('STAGING / 測試雲端', { exact: true }).first().waitFor();
    await expectSentinels();

    // E: real reload restores the session and Cloud Mode.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('auth-dashboard').waitFor();
    await waitMode('cloud');
    await page.getByTestId('auth-role').getByText('owner').waitFor();
    await page.getByTestId('editor-check').getByText('true').waitFor();

    // C/D: authenticated manual Local survives its transition reload once; a later F5 restores Cloud.
    await page.getByRole('button', { name: '測試切到本地' }).click();
    await waitMode('local');
    await page.getByText('本地模式｜資料不會同步雲端', { exact: true }).first().waitFor();
    await expectSentinels();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitMode('local');
    await expectSentinels();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitMode('cloud');
    await expectSentinels();

    // F: an expired session is never presented as Cloud-authenticated; Local remains available.
    await page.getByRole('button', { name: '模擬 Session 過期' }).click();
    await page.waitForURL(/\/login\?reason=session_expired/u);
    await waitMode('local');
    await page.getByText('登入狀態已過期，請重新登入；本地模式仍可正常使用。', { exact: true }).waitFor();
    await expectSentinels();

    // G/H: recovery callback, validation, password update, login with the new password.
    await page.goto(`${BASE_URL}/auth/recovery?fixture=recovery`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '設定新密碼' }).waitFor();
    await page.getByLabel('新密碼').fill('NewPassword123!');
    await page.getByLabel('再次確認').fill('different');
    await page.getByRole('button', { name: '設定新密碼' }).click();
    await page.getByText('兩次輸入的密碼不一致。', { exact: true }).waitFor();
    await page.getByLabel('新密碼').fill('short');
    await page.getByLabel('再次確認').fill('short');
    await page.getByRole('button', { name: '設定新密碼' }).click();
    await page.getByText('新密碼不符合安全要求，請調整後再試。', { exact: true }).waitFor();
    await page.getByLabel('新密碼').fill('NewPassword123!');
    await page.getByLabel('再次確認').fill('NewPassword123!');
    await page.getByRole('button', { name: '設定新密碼' }).click();
    await page.waitForURL(/\/login\?reason=password_updated/u);
    await page.getByText('密碼已更新，請使用新密碼登入。', { exact: true }).waitFor();
    await fillLogin('p0-5-editor@staging.invalid', 'NewPassword123!');
    await page.waitForURL(url => url.pathname === '/');
    await waitMode('cloud');
    await page.getByTestId('auth-role').getByText('owner').waitFor();
    await page.getByTestId('editor-check').getByText('true').waitFor();

    // J: logout stops the authenticated Cloud state without touching Local data.
    await page.getByRole('button', { name: '測試登出' }).click();
    await waitMode('local');
    await page.getByTestId('auth-user').getByText('none').waitFor();
    await expectSentinels();

    // I: invalid/expired recovery links show a dedicated error and do not establish a session.
    await page.goto(`${BASE_URL}/auth/recovery?fixture=invalid`, { waitUntil: 'domcontentloaded' });
    await page.getByText('密碼重設連結已失效或無效，請回登入頁重新申請。', { exact: true }).waitFor();
    await waitMode('local');
    assert.equal((await page.evaluate(() => window.__P0_5_AUTH_HARNESS__.snapshot())).session, null);

    // Environment labels are deterministic for both deployment roles.
    const labels = await page.evaluate(async () => {
      const module = await import('/src/lib/environmentModeLabel.ts');
      return {
        production: module.getEnvironmentModeLabel('cloud', 'production'),
        staging: module.getEnvironmentModeLabel('cloud', 'staging'),
        local: module.getEnvironmentModeLabel('local', 'staging'),
      };
    });
    assert.deepEqual(labels, {
      production: '雲端正式',
      staging: 'STAGING / 測試雲端',
      local: '本地模式｜資料不會同步雲端',
    });

    const authSource = [
      'src/auth/AuthProvider.tsx',
      'src/pages/Login.tsx',
      'src/pages/PasswordRecovery.tsx',
    ].map(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
    assert.doesNotMatch(authSource, /service_role|atob\s*\(|jwt[-_]?decode/iu, 'Auth UI must not embed service role or decode JWT for authorization');
    assert.doesNotMatch(authSource, /console\.(?:log|debug|info)\([^\n]*(?:access_token|refresh_token)/iu, 'Auth UI must not log tokens');

    assert.deepEqual(cloudRequests, [], 'P0-5 React fixture must not contact any Cloud project');
    assert.deepEqual(pageErrors, [], 'P0-5 React fixture must not have uncaught page errors');
    console.log('PASS unauthenticated Local Mode and Local data retention');
    console.log('PASS login -> automatic Cloud Mode and authenticated owner/editor profile');
    console.log('PASS real reload session restore and expired-session fallback');
    console.log('PASS Local/Cloud switch isolation and environment labels');
    console.log('PASS Forgot Password -> dedicated recovery callback');
    console.log('PASS recovery validation -> set password -> login with new password');
    console.log('PASS invalid recovery link and logout semantics');
    console.log('PASS Cloud requests = 0; credentials/tokens exposed = 0');
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
