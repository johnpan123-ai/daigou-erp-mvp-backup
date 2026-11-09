import { useCallback, useState } from 'react';
import { supabase, supabaseEnvironment } from '../providers/cloud/supabaseClient';

const MIGRATION_EVENT = Object.freeze({
  eventType: 'MIGRATION_APPLIED',
  eventKey: '080',
  sourceChecksum: '590ef5550ea2945e537cf6ec5014c7324837649b0fc87cdb79cf76bf34601db7',
  sourceHead: '9e5ce2e0a0dc856b50057e48766313b0af1019f1',
  checkpoint: 'checkpoint-20261110-erp2-v33-080-apply-audit-v1',
  schemaFingerprintBefore: '9bb81937fa2c58b58ddb87c7a36cdfa8e1048b971974ec21804e508602d617d8',
  schemaFingerprintAfter: '922a99e867c046714b4211914a8d670d4e2cbe3f041849c3ecb5cc5665b50667',
  environmentRole: 'PRODUCTION',
  projectRef: 'rhfdjsklfrgpoqsaqpkn',
});

type RunnerState = 'idle' | 'reading' | 'recording' | 'success' | 'already-recorded' | 'error';

const errorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === 'string') return value.code;
  if (typeof value.message === 'string' && /^[A-Z0-9_]+$/u.test(value.message)) return value.message;
  return 'UNKNOWN';
};

/**
 * One-shot, Owner-only ledger recorder for the already-applied 080 repair.
 * It is deliberately bound to one checksum, one source identity and one schema
 * transition; it never writes the ledger table directly and never claims adoption.
 */
export default function SchemaMigrationAuditRunner() {
  const [state, setState] = useState<RunnerState>('idle');
  const [message, setMessage] = useState('');

  const record = useCallback(async () => {
    if (state === 'reading' || state === 'recording' || state === 'success' || state === 'already-recorded') return;
    if (supabaseEnvironment.projectRef !== MIGRATION_EVENT.projectRef) {
      setState('error'); setMessage('PROJECT_ID_MISMATCH'); return;
    }
    setState('reading'); setMessage('');
    const existing = await supabase
      .from('erp_schema_migration_ledger')
      .select('id,event_type,event_key,source_checksum,schema_fingerprint_after,result,recorded_at')
      .eq('event_type', MIGRATION_EVENT.eventType)
      .eq('event_key', MIGRATION_EVENT.eventKey)
      .eq('source_checksum', MIGRATION_EVENT.sourceChecksum)
      .maybeSingle();
    if (existing.error) {
      setState('error'); setMessage(errorCode(existing.error)); return;
    }
    if (existing.data) {
      const matches = existing.data.result === 'PASS'
        && existing.data.schema_fingerprint_after === MIGRATION_EVENT.schemaFingerprintAfter;
      setState(matches ? 'already-recorded' : 'error');
      setMessage(matches ? `080 已稽核：${existing.data.recorded_at}` : 'EXISTING_080_RECORD_MISMATCH');
      return;
    }

    setState('recording');
    const { data, error } = await supabase.rpc('erp_record_schema_migration_event', {
      p_event_type: MIGRATION_EVENT.eventType,
      p_event_key: MIGRATION_EVENT.eventKey,
      p_source_checksum: MIGRATION_EVENT.sourceChecksum,
      p_source_head: MIGRATION_EVENT.sourceHead,
      p_checkpoint: MIGRATION_EVENT.checkpoint,
      p_schema_fingerprint_before: MIGRATION_EVENT.schemaFingerprintBefore,
      p_schema_fingerprint_after: MIGRATION_EVENT.schemaFingerprintAfter,
      p_environment_role: MIGRATION_EVENT.environmentRole,
      p_supabase_project_ref: MIGRATION_EVENT.projectRef,
      p_result: 'PASS',
      p_metadata: {
        migrationId: MIGRATION_EVENT.eventKey,
        scope: 'AUTHORITATIVE_BACKUP_RPC_ONLY',
        sqlSha256: MIGRATION_EVENT.sourceChecksum,
        appliedAtObservedUtc: '2026-11-09T16:22:52.5007789Z',
        recordingChannel: 'OWNER_AUTHENTICATED_UI_ONCE',
        schemaFingerprintContractVersion: 3,
        authoritativeBackup: { resourceCount: 24, totalRows: 30946, orphanCount: 0, duplicateCount: 0 },
        businessMutation: 0,
        historicalMigrationExecutionClaimed: false,
        rollback: 'supabase/candidates/080_rollback.sql',
      },
    });
    if (error) {
      setState('error'); setMessage(errorCode(error)); return;
    }
    setState('success');
    setMessage(`080 稽核完成：${(data as { recordedAt?: string } | null)?.recordedAt ?? '已記錄'}`);
  }, [state]);

  return (
    <section data-testid="schema-migration-audit-runner" style={{ marginTop: 18 }}>
      <h3>080 Migration 稽核（一次性）</h3>
      <p>僅 Owner 可執行；只呼叫既有稽核 RPC，不直接寫入 Ledger。已存在紀錄時不會重複提交。</p>
      <button type="button" className="btn btn-outline" onClick={() => void record()}
        disabled={state === 'reading' || state === 'recording' || state === 'success' || state === 'already-recorded'}>
        {state === 'reading' ? '讀取既有紀錄…' : state === 'recording' ? '寫入稽核紀錄…' : '完成 080 稽核'}
      </button>
      {message && <p role={state === 'error' ? 'alert' : 'status'}>{message}</p>}
    </section>
  );
}
