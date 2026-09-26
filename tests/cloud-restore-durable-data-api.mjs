import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import pg from 'pg';

// Run only against the synthetic local fixture created by the PG test.
const connectionString = process.env.RESTORE_FAILURE_LOCAL_PG;
assert(connectionString, 'Set explicit isolated loopback fixture URL');
const url = new URL(connectionString);
assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55491');
assert.match(url.pathname,/^\/restore_failure_fixture(?:_\d+)?$/u);
const db = new pg.Client({ connectionString }); await db.connect();
const owner='11111111-1111-4111-8111-111111111111';
const api='http://127.0.0.1:55492';
const token = sub => {
  const parts = [ {alg:'HS256',typ:'JWT'}, {role:'authenticated',sub,exp:Math.floor(Date.now()/1000)+300} ]
    .map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return parts+'.'+createHmac('sha256','fixture-only-signing-key-with-no-live-authority').update(parts).digest('base64url');
};
const request = (path,sub,options={}) => fetch(api+path,{...options,headers:{
  ...(sub ? {Authorization:`Bearer ${token(sub)}`} : {}),'Content-Type':'application/json',...options.headers,
}});
try {
  // Supabase-compatible auth.uid projection for this isolated PostgREST fixture.
  await db.query(`create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
      nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$`);
  const before = (await db.query('select * from public.fixture_business order by id')).rows;
  const response = await request('/erp_cloud_restore_failures?select=attempt_id,trace_id,category,code,evidence',owner);
  assert.equal(response.status,200);
  const rows=await response.json(); assert(rows.length>=9);
  assert.equal((await request('/erp_cloud_restore_failures',null)).status,401);
  const nonowner=await request('/erp_cloud_restore_failures','22222222-2222-4222-8222-222222222222');
  assert.equal(nonowner.status,200); assert.deepEqual(await nonowner.json(),[]);
  const denied=await request('/erp_cloud_restore_failures',owner,{method:'POST',body:JSON.stringify({attempt_id:rows[0].attempt_id})});
  assert.equal(denied.status,403);
  const reconciled=await request('/rpc/erp_reconcile_cloud_restore_attempt',owner,{method:'POST',body:JSON.stringify({
    p_attempt_id:rows[0].attempt_id,p_trace_id:rows[0].trace_id,
  })});
  assert.equal(reconciled.status,200); const result=await reconciled.json();
  assert.equal(result.ok,false); assert.equal(result.status,'not_committed'); assert.equal(result.failure.code,rows[0].code);
  assert.deepEqual((await db.query('select * from public.fixture_business order by id')).rows,before);
  console.log('PASS real PostgREST HTTP: OWNER SELECT/RPC, non-owner RLS empty, anon denied, direct INSERT denied; safe failure envelope; business unchanged');
} finally { await db.end(); }
