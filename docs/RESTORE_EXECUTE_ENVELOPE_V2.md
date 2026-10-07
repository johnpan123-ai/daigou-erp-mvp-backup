# Atomic Restore execution envelope v2

Migration 058 preserves 057 and the 24-resource business backup format. This is
a schema-changing Restore infrastructure release, not a SAFE_DESCENDANT UI release.

Migration 059 only makes the private dashboard staging shape deterministic when
Live lacks its two legacy-compatible optional business columns. It does not add
columns to the business dashboard table or change the public Backup format.

## Evidence and decision

The previous live Execute measured 21.863 seconds, including 12.107 seconds
aggregating a complete before snapshot. PostgreSQL interruption was observed,
but the platform did not expose enough evidence to prove OOM or its exact cause.
The before snapshot was an additional recovery/audit artifact, not the mechanism
providing atomic rollback. PostgreSQL's transaction provides that guarantee.

Full recovery artifacts remain outside Execute. Execute records an explicitly
typed source-generation receipt, not a fabricated full rollback backup.

## Prepare

Owner-authorized bounded uploads stage 512-row chunks, at most four in flight.
Finalize assembles and validates the target outside the business replacement
transaction. The unchanged semantic proof and 24-resource integrity checks run
before decoding into private typed staging tables. Prepare captures the source
business generation and Restore epoch. Missing/changed chunks fail closed.

The public Backup format is unchanged. Current snapshots must explicitly supply
outbound status_changed_at; NULL is a valid supplied value, absence is not.
The ERP1 adapter retains its existing missing-timestamp portability policy.

## Execute

The short 269-byte proof-backed request acquires the maintenance lock, checks
request identity, generation and epoch, then replaces all business resources in
one transaction. Typed staging removes transaction-time JSON decoding and full
before-snapshot aggregation. Set-based WACA validation replaces the additional
live JSON aggregation. Count, identity, relationship, outbound timestamp and
WACA quantity proofs remain. Only successful completion advances Restore epoch.

Business statement triggers advance the generation transactionally. Changed
source state after Prepare produces STALE_RESTORE_PREPARE with no mutation.
Response loss uses the existing receipt/epoch reconciliation, never replay.

## Security and lifecycle

Typed staging, upload requests/chunks and business generation are OPS/EPHEMERAL,
not Business Backup resources. They use forced RLS and deny direct anon and
authenticated access. Public upload RPCs require the Restore owner and exact
ERP2 host. Request/proof owner scope, immutable chunks, expiry and cascade
cleanup are retained. Internal helpers have no public EXECUTE grants.

Same-environment updated_by is preserved only after a bounded owner-authorized
boolean compatibility check; no auth rows or credentials are returned. ERP1 and
unportable audit identities retain the existing cross-environment policy.

## Verification

Required gates include exact full-size B-to-A repeated Restore, true-live-state
057-to-058 isolated Apply with zero business mutation, source CAS, forced rollback,
response loss, double Execute, raw ERP1 v1 compatibility, 37 outbound timestamps,
Local/Client/Server validator parity, 041/042/043 and the short Execute boundary.
Live acceptance and final Baseline A parity must be recorded separately; isolated
timings must never be presented as live production timings.
