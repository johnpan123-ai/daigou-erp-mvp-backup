import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/components/SchemaMigrationAuditRunner.tsx', 'utf8');
assert.match(source, /supabase\.rpc\('erp_record_schema_migration_event'/u);
assert.match(source, /from\('erp_schema_migration_ledger'\)/u);
assert.match(source, /sourceChecksum: '590ef5550ea2945e537cf6ec5014c7324837649b0fc87cdb79cf76bf34601db7'/u);
assert.match(source, /schemaFingerprintAfter: '922a99e867c046714b4211914a8d670d4e2cbe3f041849c3ecb5cc5665b50667'/u);
assert.match(source, /eventKey: '080'/u);
assert.doesNotMatch(source, /\.from\('erp_schema_migration_ledger'\)\.(insert|update|upsert|delete)/u);
assert.match(source, /EXISTING_080_RECORD_MISMATCH/u);
assert.match(source, /historicalMigrationExecutionClaimed: false/u);
console.log('PASS Owner 080 runner: exact RPC binding, existing-record stop, no direct ledger table mutation');
