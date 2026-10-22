// Official closing date input rule (Purchase Records level 1 / level 2): no hard-coded year, nonexistent dates rejected.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const date = await vite.ssrLoadModule('/src/lib/closingDateInput.ts');
  const hook = await vite.ssrLoadModule('/src/hooks/useProductGroupBasicInfoDrafts.ts');
  const at = iso => new Date(iso);
  const oct2026 = at('2026-10-22T04:00:00Z');
  const n = (v, now = oct2026) => date.normalizeDateInput(v, now);

  // Owner vectors: next valid date on or after today, in Asia/Taipei.
  for (const [input, expected] of Object.entries({ '10/25':'2026-10-25', '11/15':'2026-11-15', '1/15':'2027-01-15', '3/5':'2027-03-05', '10/22':'2026-10-22', '2/29':'2028-02-29', '2026/03/05':'2026-03-05' })) assert.equal(n(input), expected, input);
  assert.equal(n('0115'), '2027-01-15');
  assert.equal(n('1/15', at('2027-03-01T00:00:00Z')), '2028-01-15');
  assert.equal(n('12/24', at('2028-05-01T00:00:00Z')), '2028-12-24');
  // Year boundary is judged in Taiwan time: 2026-12-31T16:30Z is already 2027-01-01 in Taipei.
  assert.equal(date.currentTaipeiYear(at('2026-12-31T15:59:00Z')), 2026);
  assert.equal(date.currentTaipeiYear(at('2026-12-31T16:30:00Z')), 2027);
  assert.equal(n('1/5', at('2026-12-31T16:30:00Z')), '2027-01-05');
  assert.equal(n('10/22', at('2026-10-22T15:59:59Z')), '2026-10-22');
  assert.equal(n('10/22', at('2026-10-22T16:00:00Z')), '2027-10-22');
  assert.equal(n('2/29', at('2096-03-01T00:00:00Z')), '2104-02-29', 'skip the non-leap century');
  assert.equal(n('10/21'), '2027-10-21');
  assert.equal(n('2025/10/21'), '2025-10-21', 'explicit past year stays unchanged');
  assert.equal(date.normalizePurchaseDateInput('3/5', oct2026), '2026-03-05', 'purchase dates must not inherit closing-date roll-forward');
  assert.equal(date.normalizePurchaseDateInput('0305', oct2026), '2026-03-05');
  assert.equal(date.normalizePurchaseDateInput('2025/03/05', oct2026), '2025-03-05');
  assert.equal(date.normalizePurchaseDateInput('2/31', oct2026), null);
  assert.deepEqual(date.parseDateInput('1/15', oct2026), { kind: 'valid', value: '2027-01-15', usedDefaultYear: true });
  assert.deepEqual(date.parseDateInput('2027/1/5', oct2026), { kind: 'valid', value: '2027-01-05', usedDefaultYear: false });

  // Dates that do not exist are rejected, not converted.
  for (const v of ['2/31', '0231', '4/31', '2026/02/30', '2027/02/29', '20270229', '2026-11-31', '2026/04/31']) {
    assert.equal(n(v), null, `${v} must be rejected`);
    assert.equal(date.parseDateInput(v, oct2026).kind, 'nonexistent', `${v} is reported as nonexistent`);
  }
  // Leap years.
  assert.equal(n('2028/02/29'), '2028-02-29');
  assert.equal(n('20280229'), '2028-02-29');
  assert.equal(n('2/29', at('2028-01-10T00:00:00Z')), '2028-02-29');
  assert.equal(n('2/29', oct2026), '2028-02-29');
  assert.equal(n('2000/02/29'), '2000-02-29');
  assert.equal(n('2100/02/29'), null);
  // Unrecognised / unfinished input.
  for (const v of ['2027/0', '13/01', '2026/13/01', '0/5', 'abc', '2027', '']) assert.equal(n(v), null, `${JSON.stringify(v)} is not a date`);
  assert.equal(date.parseDateInput('2026/13/01', oct2026).kind, 'nonexistent');
  assert.equal(date.parseDateInput('2027/0', oct2026).kind, 'unrecognized');

  // Level 1 / level 2 share the same save rule through the hook helpers.
  assert.equal(hook.normalizeBasicInfoInput('closing_date', '2026/1/5'), '2026/01/05');
  assert.equal(hook.normalizeBasicInfoInput('closing_date', '2/31'), null);
  assert.equal(hook.normalizeBasicInfoInput('closing_date', ''), '', 'clearing the field is allowed');
  assert.equal(hook.basicInfoInputProblem('closing_date', '2/31'), 'nonexistent');
  assert.equal(hook.basicInfoInputProblem('closing_date', '2027/0'), 'incomplete');
  assert.equal(hook.basicInfoInputProblem('closing_date', '2026/12/24'), null);
  assert.ok(/^\d{4}\/01\/15$/u.test(hook.basicInfoSavePreview('closing_date', '1/15')), 'shorthand shows the full date before saving');
  assert.equal(hook.basicInfoSavePreview('closing_date', '2026/12/24'), null, 'a full date needs no preview');
  // 發售月份 stays free text (Owner decision): no date validation is applied to it.
  assert.equal(hook.normalizeBasicInfoInput('release_month', '明年春天'), '明年春天');
  assert.equal(hook.basicInfoInputProblem('release_month', '2/31'), null);
  console.log('PASS closing-date-input-validation: shorthand year, Taipei year boundary, nonexistent dates, leap years, shared L1/L2 rule, release month free text');
} finally { await vite.close(); }
