import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectSafeDescendant } from './post-adoption-descendant.mjs';
import { regressionScripts, sourceHash, impactHash, sealImpactEvidence, verifyImpactEvidence } from './reviewed-change-impact.mjs';
import { runGitAt, verifyLocalCandidate, verifyRemoteCandidate } from './promotion-safety.mjs';
import { buildSchemaEvidenceIdentity } from '../tools/schema-reconciliation/evidenceContract.mjs';

export async function runChangeImpact(argv = process.argv.slice(2)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!['--checkpoint-tag', '--schema-evidence', '--mode', '--output'].includes(key) || !value || value.startsWith('--') || args.has(key)) throw new Error('Invalid change-impact argument');
    args.set(key, value);
  }
  const mode = args.get('--mode') || 'regressions';
  if (!['inspect', 'regressions'].includes(mode)) throw new Error('Unknown mode');
  const contract = JSON.parse(await readFile(new URL('../config/erp-environment-identity.json', import.meta.url), 'utf8'));
  const git = runGitAt(root);
  const checkpointTag = args.get('--checkpoint-tag');
  if (!checkpointTag) throw new Error('Missing checkpoint');
  const candidate = verifyLocalCandidate({ contract, git, checkpointTag });
  const remote = verifyRemoteCandidate({ contract, git, checkpointTag });
  if (candidate.head !== remote.remoteBranchHead) throw new Error('Candidate remote mismatch');
  if (!args.get('--schema-evidence')) throw new Error('Missing --schema-evidence containing the immutable adopted baseline');
  const schemaEvidence = JSON.parse(await readFile(resolve(root, args.get('--schema-evidence')), 'utf8'));
  const baselineRecord = schemaEvidence.baselineRecord;
  // This step consumes historical adoption evidence for Git ancestry only.
  // It does NOT replace the later fresh Live fingerprint/deployment guard.
  if (schemaEvidence.schemaEvidenceIdentity !== buildSchemaEvidenceIdentity(schemaEvidence)
    || baselineRecord?.eventType !== 'BASELINE_ADOPTED' || baselineRecord.result !== 'PASS'
    || baselineRecord.supabaseProjectRef !== contract.environments.erp2.supabaseProject
    || baselineRecord.schemaFingerprintAfter !== contract.schemaBaseline.canonicalFingerprint
    || baselineRecord.metadata?.historicalMigrationExecutionClaimed !== false) throw new Error('Invalid adopted schema baseline evidence');
  const inspection = inspectSafeDescendant({ git, candidate, baselineRecord });
  if (mode === 'inspect') return inspection;
  const output = resolve(root, args.get('--output') || 'scratch/erp2-release-evidence/change-impact.json');
  const scope = relative(resolve(root, 'scratch/erp2-release-evidence'), output);
  if (!scope || scope.startsWith('..') || isAbsolute(scope) || !scope.endsWith('.json')) throw new Error('Evidence output must be a JSON under scratch/erp2-release-evidence');
  await mkdir(resolve(root, 'scratch/erp2-release-evidence'), { recursive: true });
  const regressions = [];
  for (const id of inspection.requiredRegressions) {
    const script = regressionScripts[id];
    if (!script) throw new Error(`Unknown regression:${id}`);
    const started = Date.now(); let log = '';
    const exitCode = await new Promise((resolveCode, reject) => {
      const child = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      child.stdout.on('data', bytes => { log += String(bytes); });
      child.stderr.on('data', bytes => { log += String(bytes); });
      child.once('error', reject); child.once('close', code => resolveCode(code));
    });
    await writeFile(resolve(root, `scratch/erp2-release-evidence/${id}.log`), log);
    const row = { id, script, scriptChecksum: sourceHash(git(['show', `${candidate.head}:${script}`])),
      outputChecksum: impactHash(log), exitCode, elapsedMs: Date.now() - started, result: exitCode === 0 ? 'PASS' : 'FAIL' };
    regressions.push(row);
    console.log(`${row.result} ${id} (${row.elapsedMs} ms)`);
    if (exitCode !== 0) throw new Error(`Regression failed:${id}; see local evidence log`);
    if (git(['rev-parse', 'HEAD']).trim() !== candidate.head || git(['status', '--porcelain']).trim()) throw new Error('Source changed during evidence run');
  }
  const evidence = sealImpactEvidence({ schemaVersion: 1, kind: 'ERP2_REVIEWED_CHANGE_IMPACT', completedAt: new Date().toISOString(), inspection, regressions });
  verifyImpactEvidence({ evidence, inspection, git });
  await writeFile(output, JSON.stringify(evidence, null, 2));
  return { result: 'PASS', sourceHead: candidate.head, checkpoint: candidate.checkpointTag,
    evidenceIdentity: evidence.identity, output, regressions: regressions.length, liveWrite: 0, deployment: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runChangeImpact(), null, 2));
}
