import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const DEFAULT_CORE_TEST_PORT = 4187;
export const CORE_TEST_HOST = '127.0.0.1';
export const CORE_TEST_IDENTITY_PROTOCOL = 'hippo-core-regression-v1';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function resolveCoreTestPort(value = process.env.CORE_TEST_PORT) {
  const raw = value === undefined ? String(DEFAULT_CORE_TEST_PORT) : String(value).trim();
  if (!/^\d+$/u.test(raw)) {
    throw new Error('CORE_TEST_PORT 必須是 1024 到 65535 的十進位整數。');
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CORE_TEST_PORT 必須是 1024 到 65535 的十進位整數。');
  }
  return port;
}

export function buildCoreTestUrls(port) {
  const resolvedPort = resolveCoreTestPort(port);
  const baseUrl = `http://${CORE_TEST_HOST}:${resolvedPort}`;
  return Object.freeze({
    baseUrl,
    identityUrl: `${baseUrl}/__core_test_identity`,
  });
}

export function createCoreTestRunId() {
  return randomUUID();
}

export function assertCoreTestIdentity(value, expectedRunId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.protocol !== CORE_TEST_IDENTITY_PROTOCOL
    || value.runId !== expectedRunId
    || value.entry !== '/src/main.tsx'
    || value.mode !== 'test') {
    throw new Error('CORE_TEST_SERVER_IDENTITY_MISMATCH：拒絕接用既有或錯誤的測試 Server。');
  }
  return value;
}

export function spawnOwnedCoreTestServer({ rootPath, vitePath, configPath, port, runId }) {
  const resolvedPort = resolveCoreTestPort(port);
  return spawn(process.execPath, [
    vitePath,
    '--config', configPath,
    '--mode', 'test',
    '--host', CORE_TEST_HOST,
    '--port', String(resolvedPort),
    '--strictPort',
  ], {
    cwd: rootPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      CORE_TEST_RUN_ID: runId,
      VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'core-test-isolated-public-fixture-key',
      VITE_DEPLOYMENT_ENV: '',
      VITE_SANDBOX_ENV: 'test',
      VITE_CLOUD_REALTIME_PREVIEW: 'false',
    },
  });
}

export async function waitForOwnedCoreTestServer({ child, identityUrl, runId, output }) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Vite 提前結束：\n${output()}`);
    }
    try {
      const response = await fetch(identityUrl, { cache: 'no-store' });
      if (response.ok) {
        const identity = await response.json();
        return assertCoreTestIdentity(identity, runId);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CORE_TEST_SERVER_IDENTITY_MISMATCH')) throw error;
      // The owned server is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite 啟動逾時：\n${output()}`);
}

export async function stopOwnedCoreTestServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, sleep(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('本輪 Core Test Vite child process 未能在安全期限內結束。');
  }
}
