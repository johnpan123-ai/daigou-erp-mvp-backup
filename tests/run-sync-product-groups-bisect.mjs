import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const stableRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = process.cwd();
const testFile = resolve(stableRoot, 'tests', 'sync-product-groups-regression.mjs');
const viteFile = resolve(stableRoot, 'node_modules', 'vite', 'bin', 'vite.js');

const result = spawnSync(process.execPath, [testFile], {
  cwd: targetRoot,
  env: {
    ...process.env,
    SYNC_REGRESSION_ROOT: targetRoot,
    SYNC_REGRESSION_VITE: viteFile,
    SYNC_REGRESSION_URL: 'http://127.0.0.1:4205',
    SYNC_REGRESSION_INJECT_EMPTY_VARIANTS: '1',
  },
  encoding: 'utf8',
});

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) {
  console.error(result.error);
  process.exit(125);
}
process.exit(result.status ?? 125);
