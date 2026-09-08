# P0-4 authenticated Staging test harness

This harness is deliberately outside the normal Production migration path.

- UI route: `/__staging/p0-4-auth-harness`
- Staging project: `rhfdjsklfrgpoqsaqpkn`
- SQL artifact: `sql/staging_p0_4_authenticated_test_harness.sql`
- Fixture prefix: `P0-4-IDEMPOTENCY-TEST-`

The UI reuses the App's existing Supabase session and never reads or renders its
access token, refresh token, password, or JWT. Both the UI and the SQL helper
functions fail closed outside the exact Staging project. The SQL grants only the
three dedicated status/residual/cleanup RPCs to `authenticated`; it does not
change the accepted transaction RPC, business-table RLS policies, or grants.

Do not deploy or apply this artifact until Luna accepts the harness. After a
test run, use **Cleanup this run** and require every residual count to be zero.
