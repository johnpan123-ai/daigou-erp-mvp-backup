import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const ACCEPTED_NEXT_BASELINE = process.env.P0_ESLINT_BASELINE
  || 'e1addbe696e495c64b540280c2507d6e3ffc47f2';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const changedFiles = git(
  'diff', '--name-only', ACCEPTED_NEXT_BASELINE, '--', '*.ts', '*.tsx', '*.js', '*.mjs',
).split(/\r?\n/u).filter(Boolean);

assert.ok(changedFiles.length > 0, 'Expected P0-1 lint scope to contain changed source/test files.');

const eslint = new ESLint({ cwd: process.cwd() });
const currentResults = await eslint.lintFiles(changedFiles);
const baselineResults = [];

for (const file of changedFiles) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ACCEPTED_NEXT_BASELINE}:${file}`], { stdio: 'ignore' });
  } catch {
    continue;
  }
  const source = execFileSync('git', ['show', `${ACCEPTED_NEXT_BASELINE}:${file}`], { encoding: 'utf8' });
  baselineResults.push(...await eslint.lintText(source, { filePath: resolve(file) }));
}

const totals = results => results.reduce((sum, result) => ({
  errors: sum.errors + result.errorCount,
  warnings: sum.warnings + result.warningCount,
}), { errors: 0, warnings: 0 });

const addedLinesByFile = new Map();
for (const file of changedFiles) {
  const diff = execFileSync(
    'git', ['diff', '--unified=0', ACCEPTED_NEXT_BASELINE, '--', file], { encoding: 'utf8' },
  );
  const addedLines = new Set();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) addedLines.add(line);
  }
  addedLinesByFile.set(resolve(file).toLowerCase(), addedLines);
}

const rawChangedLineFindings = currentResults.flatMap(result => {
  const addedLines = addedLinesByFile.get(resolve(result.filePath).toLowerCase()) || new Set();
  return result.messages.filter(message => message.line && addedLines.has(message.line))
    .map(message => ({ ...message, filePath: result.filePath }));
});
const findingKey = message =>
  `${resolve(message.filePath).toLowerCase()}::${message.ruleId}::${message.message}`;
const inheritedCounts = new Map();
for (const result of baselineResults) {
  for (const message of result.messages) {
    const key = findingKey({ ...message, filePath: result.filePath });
    inheritedCounts.set(key, (inheritedCounts.get(key) || 0) + 1);
  }
}
// A reconciled hunk can move an existing hook warning to a new line without
// introducing a new lint defect. Compare finding identity, not old line number.
const changedLineFindings = rawChangedLineFindings.filter(message => {
  const key = findingKey(message);
  const inherited = inheritedCounts.get(key) || 0;
  if (inherited === 0) return true;
  inheritedCounts.set(key, inherited - 1);
  return false;
});

const baseline = totals(baselineResults);
const current = totals(currentResults);
const newErrorDelta = Math.max(0, current.errors - baseline.errors);
const newWarningDelta = Math.max(0, current.warnings - baseline.warnings);

if (changedLineFindings.length > 0) {
  console.error(JSON.stringify(changedLineFindings.map(({ filePath, line, ruleId, message }) =>
    ({ filePath, line, ruleId, message })), null, 2));
}

assert.equal(newErrorDelta, 0, 'P0-1 introduced new ESLint errors over the Accepted NEXT baseline.');
assert.equal(newWarningDelta, 0, 'P0-1 introduced new ESLint warnings over the Accepted NEXT baseline.');
assert.equal(changedLineFindings.length, 0, 'P0-1 added lines contain ESLint findings.');

console.log(JSON.stringify({
  status: 'NO_NEW_ESLINT_REGRESSION',
  acceptedNextBaseline: ACCEPTED_NEXT_BASELINE,
  baseline,
  current,
  newErrorDelta,
  newWarningDelta,
  changedLineFindings: changedLineFindings.length,
}, null, 2));
