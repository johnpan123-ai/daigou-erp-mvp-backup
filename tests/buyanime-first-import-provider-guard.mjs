import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  assertReviewedProviderContract,
  restoreReviewedBuyAnimeFirstImportProviderPatch,
} from '../scripts/post-adoption-descendant.mjs';

const BASE = '84afcac7eb05140813eb47446d9916083ad9e0b5';
const files = [
  'src/providers/cloud/buyAnimeImportCoordinator.ts',
  'src/providers/cloud/cloudConnectivity.ts',
  'src/providers/cloud/buyAnimeImportJournal.ts',
  'src/providers/cloud/supabaseProvider.ts',
];
const before = file => execFileSync('git', ['show', `${BASE}:${file}`], { encoding: 'utf8' }).replace(/\r\n?/gu, '\n');
const after = file => readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n');

for (const file of files) {
  const oldSource = before(file), reviewed = after(file);
  assert.equal(restoreReviewedBuyAnimeFirstImportProviderPatch(file, reviewed), oldSource, `${file} exact restoration`);
  assert.doesNotThrow(() => assertReviewedProviderContract(file, oldSource, reviewed), `${file} exact patch accepted`);
  assert.throws(() => assertReviewedProviderContract(file, oldSource, reviewed.replace(/\n/u, '\n ')), /FAILED_CLOSED/u,
    `${file} arbitrary one-byte drift rejected`);
}

const provider = files[3], providerBefore = before(provider), providerAfter = after(provider);
assert.throws(() => assertReviewedProviderContract(provider, providerBefore,
  providerAfter.replace('const BUYANIME_SYNC_WAIT_MS = 30_000;', 'const BUYANIME_SYNC_WAIT_MS = 1;')), /FAILED_CLOSED/u);
assert.throws(() => assertReviewedProviderContract(provider, providerBefore,
  providerAfter.replace('await this.requireCloudWritePermission();', 'void 0;')), /FAILED_CLOSED/u);

const connectivity = files[1];
assert.throws(() => assertReviewedProviderContract(connectivity, before(connectivity),
  after(connectivity).replace('if (snapshot.status === \'offline\') { resolve(false); return; }', 'resolve(true);')), /FAILED_CLOSED/u);

const journal = files[2];
assert.throws(() => assertReviewedProviderContract(journal, before(journal),
  after(journal).replace('updated_by: writer', 'updated_by: undefined')), /FAILED_CLOSED/u);

console.log('PASS BuyAnime first-import exact Provider overlay accepted; wrong patch, shortened wait, removed permission guard and relaxed offline result rejected');
