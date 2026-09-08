import { useMemo, useState } from 'react';
import { useAuth } from '../auth/authContext';
import { supabase, supabaseEnvironment } from '../providers/cloud/supabaseClient';
import {
  P0_4_HARNESS_SCENARIOS,
  StagingP04AuthenticatedHarness as HarnessController,
  assertP04HarnessBoundary,
  type P04HarnessRpcInvoker,
  type P04HarnessScenario,
} from '../lib/stagingP04AuthenticatedHarness';

const boundaryInput = {
  projectRef: supabaseEnvironment.projectRef,
  runtimeRole: supabaseEnvironment.role,
  viteMode: import.meta.env.MODE,
  deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENV,
};

const rpcInvoker: P04HarnessRpcInvoker = async (functionName, args) => {
  const response = await supabase.rpc(functionName, args);
  return {
    data: response.data,
    error: response.error ? { message: response.error.message, code: response.error.code } : null,
  };
};

export default function StagingP04AuthenticatedHarness() {
  const { user, profile, loading, profileLoading } = useAuth();
  const [selected, setSelected] = useState<P04HarnessScenario>('normal-create');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [cleanup, setCleanup] = useState<unknown>(null);
  const harness = useMemo(() => {
    try {
      return new HarnessController(boundaryInput, rpcInvoker);
    } catch {
      return null;
    }
  }, []);

  let boundaryError: string | null = null;
  try {
    assertP04HarnessBoundary(boundaryInput);
  } catch (error) {
    boundaryError = error instanceof Error ? error.message : 'P0_4_STAGING_TEST_HARNESS_DISABLED';
  }

  const editorEligible = Boolean(user && profile && ['owner', 'staff', 'helper'].includes(profile.role));
  const run = async () => {
    if (!harness) return;
    setBusy(true);
    setResult(null);
    try {
      const status = await harness.loadStatus();
      const scenarioResult = await harness.run(selected);
      setResult({ status, scenarioResult });
    } catch (error) {
      setResult({ passed: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const clean = async () => {
    if (!harness) return;
    setBusy(true);
    try {
      setCleanup(await harness.cleanup());
    } catch (error) {
      setCleanup({ passed: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (boundaryError) {
    return (
      <main data-testid="p0-4-harness-blocked" style={{ maxWidth: 900, margin: '40px auto', padding: 24 }}>
        <h1>Not available</h1>
        <p>此測試入口只允許隔離的 Staging runtime。</p>
        <code>{boundaryError}</code>
      </main>
    );
  }

  return (
    <main data-testid="p0-4-auth-harness" style={{ maxWidth: 980, margin: '32px auto', padding: 24 }}>
      <div style={{ border: '3px solid #b91c1c', borderRadius: 12, padding: 20, background: '#fff7ed' }}>
        <h1 style={{ color: '#991b1b', marginTop: 0 }}>STAGING TEST ONLY</h1>
        <p>只建立名稱以 <strong>P0-4-IDEMPOTENCY-TEST-*</strong> 開頭的隔離採購測試資料。</p>
        <dl style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8 }}>
          <dt>Staging project</dt><dd data-testid="harness-project-ref">{supabaseEnvironment.projectRef}</dd>
          <dt>Authenticated user</dt><dd data-testid="harness-authenticated">{loading ? 'checking' : user ? 'present' : 'absent'}</dd>
          <dt>Profile role</dt><dd data-testid="harness-role">{profileLoading ? 'checking' : profile?.role ?? 'none'}</dd>
          <dt>Editor eligibility</dt><dd data-testid="harness-editor">{editorEligible ? 'true' : 'false'}</dd>
          <dt>Device/client credentials</dt><dd>App session only；token exposure = 0</dd>
          <dt>Fixture marker</dt><dd data-testid="harness-marker">{harness?.marker ?? 'disabled'}</dd>
        </dl>

        <label htmlFor="p0-4-case" style={{ display: 'block', marginTop: 20, fontWeight: 700 }}>Test case</label>
        <select id="p0-4-case" value={selected} onChange={event => setSelected(event.target.value as P04HarnessScenario)} disabled={busy}>
          {P0_4_HARNESS_SCENARIOS.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button type="button" onClick={run} disabled={busy || !editorEligible || !harness}>Run selected test</button>
          <button type="button" onClick={clean} disabled={busy || !editorEligible || !harness}>Cleanup this run</button>
        </div>

        <h2>Result</h2>
        <pre data-testid="harness-result" style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 12 }}>{result ? JSON.stringify(result, null, 2) : 'Not run'}</pre>
        <h2>Cleanup result</h2>
        <pre data-testid="harness-cleanup" style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 12 }}>{cleanup ? JSON.stringify(cleanup, null, 2) : 'Not run'}</pre>
      </div>
    </main>
  );
}
