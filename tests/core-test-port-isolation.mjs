import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  assertCoreTestIdentity,
  buildCoreTestUrls,
  CORE_TEST_IDENTITY_PROTOCOL,
  DEFAULT_CORE_TEST_PORT,
  resolveCoreTestPort,
} from './helpers/core-test-server.mjs';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const RUNNER_PATH = fileURLToPath(new URL('./core-regression.mjs', import.meta.url));

assert.equal(resolveCoreTestPort(undefined), DEFAULT_CORE_TEST_PORT);
assert.equal(resolveCoreTestPort('4317'), 4317);
assert.equal(buildCoreTestUrls(4317).baseUrl, 'http://127.0.0.1:4317');
for (const invalid of ['', '0', '1023', '65536', '12.5', 'abc', '  ']) {
  assert.throws(() => resolveCoreTestPort(invalid), /CORE_TEST_PORT/u);
}

const expectedRunId = '00000000-0000-4000-8000-000000000001';
assert.throws(() => assertCoreTestIdentity({
  protocol: CORE_TEST_IDENTITY_PROTOCOL,
  runId: '00000000-0000-4000-8000-000000000002',
  entry: '/src/main.tsx',
  mode: 'test',
}, expectedRunId), /CORE_TEST_SERVER_IDENTITY_MISMATCH/u);

const foreignRequests = [];
const foreignServer = createServer((request, response) => {
  foreignRequests.push(request.url);
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({
    protocol: CORE_TEST_IDENTITY_PROTOCOL,
    runId: '00000000-0000-4000-8000-000000000003',
    entry: '/wrong-worktree.ts',
    mode: 'test',
  }));
});
await new Promise((resolve, reject) => {
  foreignServer.once('error', reject);
  foreignServer.listen(0, '127.0.0.1', resolve);
});

try {
  const address = foreignServer.address();
  assert(address && typeof address === 'object');
  const runner = spawn(process.execPath, [RUNNER_PATH], {
    cwd: ROOT_PATH,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CORE_TEST_PORT: String(address.port) },
  });
  let output = '';
  runner.stdout.on('data', chunk => { output += String(chunk); });
  runner.stderr.on('data', chunk => { output += String(chunk); });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Occupied-port negative test timed out')), 20_000);
    runner.once('error', reject);
    runner.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.notEqual(exitCode, 0, 'Occupied port must fail instead of attaching to the existing listener');
  assert.match(output, /CORE_TEST_SERVER_IDENTITY_MISMATCH|Vite 提前結束|port is already in use/iu);

  const stillOwned = await fetch(`http://127.0.0.1:${address.port}/__core_test_identity`).then(response => response.json());
  assert.equal(stillOwned.entry, '/wrong-worktree.ts', 'Core runner must not terminate the pre-existing listener');
  assert(foreignRequests.length > 0, 'Negative test must actually observe the occupied listener');
} finally {
  await new Promise(resolve => foreignServer.close(resolve));
}

console.log('PASS configurable loopback port validation and shared Server/Client URL');
console.log('PASS wrong fixture identity and occupied port fail closed');
console.log('PASS occupied listener remains owned by and is cleaned up only by this negative test');
