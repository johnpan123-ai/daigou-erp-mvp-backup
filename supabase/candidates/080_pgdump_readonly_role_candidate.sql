-- 080-companion CANDIDATE ONLY (NOT applied; never on ERP1). Least-privilege role for ONE consistent
-- read-only pg_dump of ERP2 schema `public` (data + schema + ACL). Owner approval required to run.
-- Preferred alternative needing NO permission change: run pg_dump as the existing `postgres` role with
--   PGOPTIONS='-c default_transaction_read_only=on'  (see 080_PRE_APPLY_RECOVERY_PROCEDURE.md, Step 2B).
-- Blocker it solves: a role without SELECT cannot take pg_dump's ACCESS SHARE lock
--   ("permission denied for table profiles" / LOCK TABLE); without BYPASSRLS, RLS tables dump incomplete
--   (pg_dump aborts unless --enable-row-security, which silently filters rows -> rejected).
-- Grants: SELECT only (tables, views, sequences) + USAGE on schema public. No INSERT/UPDATE/DELETE/TRUNCATE,
-- no function EXECUTE, no auth/storage schema, no default privileges, no role membership.
-- Role is created NOLOGIN; activation is a separate Owner step (time-boxed), revoke = 080_pgdump_readonly_role_revoke.sql.
begin;
create role erp2_backup_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls connection limit 1;
alter role erp2_backup_reader set default_transaction_read_only = on;
alter role erp2_backup_reader set statement_timeout = '15min';
alter role erp2_backup_reader set idle_in_transaction_session_timeout = '15min';
grant usage on schema public to erp2_backup_reader;
grant select on all tables in schema public to erp2_backup_reader;      -- includes views / matviews
grant select on all sequences in schema public to erp2_backup_reader;
commit;
-- Activation (Owner, psql, same day):   alter role erp2_backup_reader login valid until '<today 23:59 UTC>';
--                                       \password erp2_backup_reader
-- Dump (Owner machine, direct connection, one snapshot):
--   PGOPTIONS='-c default_transaction_read_only=on' pg_dump --format=custom --schema=public --no-owner \
--     --serializable-deferrable -f erp2-pre080.dump "postgresql://erp2_backup_reader@<direct host of rhfdjsklfrgpoqsaqpkn>:5432/postgres"
-- Then immediately run 080_pgdump_readonly_role_revoke.sql.
-- NOTE: on PostgreSQL < 16 only a superuser may create a BYPASSRLS role; on 16+ the creator must itself
-- have BYPASSRLS (Supabase `postgres` - verify). If refused: do NOT work around; use the postgres read-only
-- session alternative or the platform recovery point.
-- Restore note (verified in isolation): the dump carries this role's SELECT grants inside each table ACL
-- (62/62 tables). Before pg_restore, create `erp2_backup_reader` NOLOGIN on the target, restore, then run the
-- revoke script there too. The postgres read-only alternative has no such side effect.
