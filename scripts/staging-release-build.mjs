import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const EXPECTED_PROJECT_REF = 'rhfdjsklfrgpoqsaqpkn';
const EXPECTED_PUBLIC_KEY_FINGERPRINT = 'D9EA6B7BB6524517';
const OUTPUT_ROOT = resolve('staging-release-artifacts');
const DIST_DIR = resolve(OUTPUT_ROOT, 'dist');
const MANIFEST_PATH = resolve(OUTPUT_ROOT, 'frontend-manifest.json');

const sha256 = value => createHash('sha256').update(value).digest('hex').toUpperCase();

const requireStagingConfig = () => {
  const deploymentEnvironment = process.env.VITE_DEPLOYMENT_ENV?.trim();
  if (deploymentEnvironment !== 'staging') {
    throw new Error('INVALID_STAGING_BUILD_CONFIG: VITE_DEPLOYMENT_ENV must be staging.');
  }

  let url;
  try {
    url = new URL(process.env.VITE_SUPABASE_URL ?? '');
  } catch {
    throw new Error('INVALID_STAGING_BUILD_CONFIG: invalid Supabase URL.');
  }
  if (url.protocol !== 'https:'
    || url.hostname !== `${EXPECTED_PROJECT_REF}.supabase.co`
    || url.pathname !== '/') {
    throw new Error('INVALID_STAGING_BUILD_CONFIG: unexpected Supabase project target.');
  }

  const publicKey = process.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
  const fingerprint = sha256(publicKey).slice(0, 16);
  if (!publicKey || fingerprint !== EXPECTED_PUBLIC_KEY_FINGERPRINT) {
    throw new Error('INVALID_STAGING_BUILD_CONFIG: unapproved public-key fingerprint.');
  }
  return {
    deploymentEnvironment,
    projectRef: EXPECTED_PROJECT_REF,
    publicKeyFingerprint: fingerprint,
    supabaseOrigin: url.origin,
  };
};

const run = (file, args) => {
  const result = spawnSync(file, args, { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} exited with status ${result.status}`);
};

const listFiles = async directory => {
  const files = [];
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
};

const publicConfig = requireStagingConfig();
if (process.argv.includes('--verify-only')) {
  console.log(`Staging public config verified: target=${publicConfig.projectRef} fingerprint=${publicConfig.publicKeyFingerprint}`);
  process.exit(0);
}

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(OUTPUT_ROOT, { recursive: true });
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
run(process.execPath, [
  'node_modules/vite/bin/vite.js',
  'build',
  '--mode', 'staging',
  '--outDir', DIST_DIR,
  '--emptyOutDir',
]);

const files = await Promise.all((await listFiles(DIST_DIR)).map(async path => ({
  file: relative(DIST_DIR, path).replaceAll('\\', '/'),
  bytes: (await stat(path)).size,
  sha256: sha256(await readFile(path)),
})));
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
const packageLockBytes = await readFile('package-lock.json');
const packageLockSha256 = sha256(packageLockBytes);
const packageLock = JSON.parse(packageLockBytes.toString('utf8'));
const wranglerConfigBytes = await readFile('wrangler.jsonc');
const wranglerConfig = JSON.parse(wranglerConfigBytes.toString('utf8'));
const evidence = {
  schemaVersion: 1,
  sourceHead,
  sourceClean: sourceStatus.length === 0,
  buildMode: 'staging',
  outputDirectory: 'staging-release-artifacts/dist',
  publicConfig,
  toolchain: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    packageManager: process.env.npm_config_user_agent?.split(' ')[0] ?? 'npm-unavailable',
    lockfileVersion: packageLock.lockfileVersion,
    packageLockSha256,
  },
  runtimeConfig: {
    sha256: sha256(wranglerConfigBytes),
    compatibilityDate: wranglerConfig.compatibility_date,
    compatibilityFlags: wranglerConfig.compatibility_flags,
  },
  files,
};
const manifest = { ...evidence, identity: sha256(JSON.stringify(evidence)) };
await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Staging release build ready: files=${files.length} manifest=${manifest.identity}`);
console.log(`Target=${publicConfig.projectRef} publicFingerprint=${publicConfig.publicKeyFingerprint}`);
