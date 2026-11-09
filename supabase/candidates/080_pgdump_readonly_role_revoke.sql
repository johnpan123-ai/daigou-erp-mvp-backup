-- Revoke/drop for 080_pgdump_readonly_role_candidate.sql. Leaves no grant, setting or role behind.
begin;
select pg_terminate_backend(pid) from pg_stat_activity where usename = 'erp2_backup_reader';
alter role erp2_backup_reader nologin;
revoke select on all sequences in schema public from erp2_backup_reader;
revoke select on all tables in schema public from erp2_backup_reader;
revoke usage on schema public from erp2_backup_reader;
drop owned by erp2_backup_reader;   -- owns nothing; also clears any residual privilege in this database
drop role erp2_backup_reader;
commit;
