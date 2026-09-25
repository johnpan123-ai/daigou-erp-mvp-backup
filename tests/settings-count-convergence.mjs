import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const settings = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');

assert.match(settings, /SettingsCountLoadGate/u, 'Settings must use the latest-request-wins count loader');
assert.match(settings, /void loadCounts\(\)/u, 'Settings must load counts on mount');
assert.match(settings, /countLoadGate\.invalidate\(\)/u, 'Settings must invalidate late reads on unmount');

const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  const { SettingsCountLoadGate } = await vite.ssrLoadModule('/src/pages/settingsCountLoadGate.ts');
  const gate = new SettingsCountLoadGate();
  let releaseOld;
  const committed = [];
  const old = gate.run(
    () => new Promise(resolve => { releaseOld = () => resolve('old'); }),
    value => committed.push(value),
  );
  const fresh = gate.run(async () => 'fresh', value => committed.push(value));
  assert.equal(await fresh, true);
  releaseOld();
  assert.equal(await old, false);
  assert.deepEqual(committed, ['fresh'], 'A late stale count read must not overwrite the newer Settings result');

  let releaseUnmounted;
  const unmounted = gate.run(
    () => new Promise(resolve => { releaseUnmounted = () => resolve('unmounted'); }),
    value => committed.push(value),
  );
  gate.invalidate();
  releaseUnmounted();
  assert.equal(await unmounted, false);
  assert.deepEqual(committed, ['fresh'], 'An unmounted Settings page must not accept a late count read');
} finally {
  await vite.close();
}

console.log('PASS Settings count convergence uses latest-request-wins without Restore runtime dependencies');
