# BuyAnime committed readback and resume closure

Base: `535d9a67f044ac2bb237165313edc29ae477bb6e`.

## Incident and boundaries

The 1,505-row Inventory field-CAS transaction committed. Its old single acknowledgement GET was 58,778 bytes and failed with HTTP 400. Catalog and WACA evidence had not started. A read failure is not a failed/partial Inventory transaction and never authorizes a resend.

No migration, table, column, RPC signature, ACL, RLS, canonical fingerprint, serializer, durable-resource registry or existing business planner changes. Live business writes and live restore remain prohibited during release validation. Deployment is conditional on fresh schema/ledger/baseline and the exact SAFE_DESCENDANT guard.

## Shared read transport

`cloudBulkRead` uses a configurable transport policy: 150 UUIDs, 7,000 encoded URL bytes, concurrency 3, two bounded transient retries. Only failed chunks retry. Results must contain every expected identity exactly once, no unexpected identities, and match supplied field proofs. Input identity order is restored; partial results never merge into cache. Explicit Realtime DELETE is the sole missing-row exception. Abort, generation, draft/CAS and protected-cache behavior are preserved.

Callers: mutation acknowledgement/Realtime targeted cache, BuyAnime committed Inventory/Catalog proof, and private-order parent validation. Remaining `.in` in the raw cache adapter receives already bounded chunks; restore-attempt status `.in` has two fixed values, not unbounded IDs. No remaining same-pattern unbounded UUID GET callers.

Isolated measurements (not live load tests): 1,505 UUIDs -> 11 SELECT requests, real loopback PostgREST max URL 5,914 bytes, total verification 423 ms, largest chunk 100 ms on the recorded run. Mock encoded canonical-host bound: max 5,923 bytes. 5,000 -> 34 chunks; 10,000 -> 67. Timing varies by machine/run.

## Durable, explicitly triggered resume

The existing `import_batches.details` JSON holds an optional `buyAnimeImport` operational subtype. Legacy rows/backups need not contain it. Existing details arrays remain valid. No new durable resource or required SQL field is introduced. Its deterministic batch journal ID and optimistic version predicate prevent stale progress overwrites; existing owner/staff/viewer/anon RLS remains unchanged.

Intent/progress contains canonical UUID/key/full-business-field hashes, original batch/time, stage, and the exact Catalog request plus fixed idempotency key. Intent is stored before mutation. Successful Inventory commits store readback-pending progress before reading. A network outage cannot cause a second Inventory commit or bypass offline/CAS guards just to write progress. Unknown response outcomes retain committed/committing evidence and require a read proof.

F5, route entry and login perform only discovery and field-hash verification. Existing pre-journal batches are identified by coherent persisted Inventory import metadata; downstream completion stays unconfirmed. Legacy adoption happens only when the user explicitly resumes. Resume never calls Inventory planning/commit. Catalog response loss reuses the saved exact payload/key; only a proven rollback permits replanning. WACA evidence response loss reads and compares existing durable evidence before another CAS. Final COMPLETE remains complete if a later UI read fails.

Pending batches block another XLS import. UI actions are `重新核對雲端資料` and, after proof, `繼續商品／規格同步`. Global authoritative freshness and batch completion are separate states. Refresh uses the established draft/generation-safe coordinator, never a raw cache overwrite. Diagnostics omit business rows, SQL DETAIL and secrets. NEXT retains its existing local import/provider path and never resumes Cloud journals.

## Evidence and regression

- Exact private `399375_2026-10-03.xls` plus reconstructed authoritative state (NOT a claim of the unavailable exact automatic pre-import backup).
- 1,505 full-field/UUID/key proofs; Inventory commit exactly once; existing legacy batch SELECT-only discovery; no journal writes before user action; F5/close/relogin; Catalog exact replay; WACA response-loss deduplication; COMPLETE; PostgREST viewer/anon/CAS protection.
- Canonical identity previous fix: 1,491 existing UUIDs reused, 14 legitimate creates, three repeated imports, zero churn; native/PostgREST rollback and restore/reimport.
- 24-resource Cloud Backup -> isolated NEXT restore retains optional journal JSON, legacy import details, WACA and Deadline; NEXT recovery is null and Supabase requests zero. Corruption/relationship/mid-restore failure remains atomic.
- WACA domain, legacy 8->11, modern backup, registry, Cloud UI, sync late success/failure/manual recovery, Realtime/draft/CAS and small EXECUTE envelope regressions.
- TypeScript and new-file lint pass; touched-line lint has zero new findings over the base. Existing 98 errors/1 warning remain inherited, not a repo-wide lint PASS.

Exact immutable review hashes, migration/canonical/backup contract parity, required regression checksums and fresh Live evidence are mandatory for deployment. No path-wide provider exception. Future/unreviewed durable, RPC, SQL, registry, canonical or provider hunks fail closed.

## User handoff

After an approved deployment and read-only postflight, do not automatically repair the live batch. The user must press `繼續商品／規格同步`; do not upload the same Excel again.
