import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManifestIdentity, sha256, verifyArtifactIdentity, DeploymentGuardError } from './promotion-safety.mjs';

const fail = message => { throw new DeploymentGuardError(message); };
export async function recoverHistoricalArtifact({ root, output, release, contract, fetchBytes = async url => {
  const original = new URL(url);
  let current = original;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if ([301, 302, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), current);
      if (next.origin !== original.origin) fail('historical asset redirected outside immutable deployment');
      current = next;
      continue;
    }
    if (!response.ok) fail(`historical asset request failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  fail('historical asset redirect limit exceeded');
} }) {
  const manifestBytes = await fetchBytes(`${release.deploymentUrl}/erp-build-identity.json`);
  const manifest = JSON.parse(manifestBytes);
  const { identity, ...payload } = manifest;
  if (identity !== release.artifactIdentity || buildManifestIdentity(payload) !== identity
    || manifest.source?.head !== release.head || manifest.source?.checkpointTag !== release.checkpoint
    || manifest.files?.length !== release.artifactFiles) fail('unknown historical artifact manifest');
  const seen = new Set();
  const recovered = [];
  // Output must be newly allocated; never overwrite another release artifact.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  for (const item of manifest.files) {
    const file = item.file;
    const path = resolve(output, file);
    const rel = relative(output, path);
    if (typeof file !== 'string' || !/^[a-zA-Z0-9_./-]+$/u.test(file) || file.split('/').includes('..')
      || isAbsolute(file) || rel.startsWith('..') || seen.has(file) || file === 'erp-build-identity.json') {
      fail('unsafe or duplicate historical artifact path');
    }
    seen.add(file);
    let bytes;
    let origin = 'IMMUTABLE_DEPLOYMENT';
    if (file === '_redirects' || file === '_headers') {
      // Pages consumes control files; recover their original Git blob, not SPA
      // fallback HTML or a newly generated replacement. Hash must prove bytes.
      bytes = execFileSync('git', ['--no-replace-objects', 'show', `${release.head}:public/${file}`],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      origin = 'IMMUTABLE_SOURCE_BLOB';
      if (sha256(bytes) !== item.sha256) {
        // Original Windows Vite build copied the checked-out CRLF control
        // file. Recover that checkout representation only when the immutable
        // published inventory proves its exact bytes/hash; never edit content.
        const checkout = Buffer.from(bytes.toString('utf8').replace(/\r?\n/gu, '\r\n'));
        if (checkout.length !== item.bytes || sha256(checkout) !== item.sha256) fail(`historical control file mismatch: ${file}`);
        bytes = checkout;
        origin = 'IMMUTABLE_SOURCE_CHECKOUT_CRLF';
      }
    } else bytes = await fetchBytes(`${release.deploymentUrl}/${file}`);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) fail(`historical artifact bytes mismatch: ${file}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    recovered.push({ file, origin, bytes: bytes.length, sha256: item.sha256 });
  }
  await writeFile(resolve(output, 'erp-build-identity.json'), manifestBytes, { flag: 'wx' });
  const artifact = await verifyArtifactIdentity({ artifactRoot: output, proof: { candidate: {
    ...manifest.source, checkpointTag: release.checkpoint,
  } }, contract });
  return { result: 'PASS', artifact, recovered, rebuildPerformed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const [id, outputArg] = process.argv.slice(2);
  if (!id || !outputArg || process.argv.length !== 4) fail('use <registered-release-id> <new-output-directory>');
  const registry = JSON.parse(await readFile(resolve(root, 'config/erp2-historical-runtime-releases.json')));
  const release = registry.releases.find(row => row.id === id) ?? fail('unregistered historical release');
  const contract = JSON.parse(await readFile(resolve(root, 'config/erp-environment-identity.json')));
  const report = await recoverHistoricalArtifact({ root, output: resolve(outputArg), release, contract });
  await writeFile(`${resolve(outputArg)}-recovery-evidence.json`, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ result: report.result, artifact: report.artifact.identity, files: report.artifact.files,
    rebuilt: false, deploymentAssets: report.recovered.filter(row => row.origin === 'IMMUTABLE_DEPLOYMENT').length,
    sourceControlFiles: report.recovered.filter(row => row.origin.startsWith('IMMUTABLE_SOURCE_')).length }));
}
