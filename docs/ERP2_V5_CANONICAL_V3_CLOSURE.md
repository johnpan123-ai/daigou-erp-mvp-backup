# ERP2 v5 canonical reconciliation

The active schema contract is `ERP2_SEMANTIC_SCHEMA_V3`, algorithm
`POSTGRESQL_LEXICAL_V3`. Its source-generated target fingerprint is
`ec63a2eb2c69cd7984ca9c61584e9f092ee22bcabb70c051e8ca7aad5f66bf4c`.
It is produced by the canonical fresh-install chain, not copied from Live.

## Cause and scope

The frozen v2 scanner treated an apostrophe in a SQL comment as the beginning
of a string. Live and canonical WACA definitions therefore hashed differently
despite having identical code. The generic v3 lexer understands nested comments,
quoted identifiers, literal strings and dollar-quoted function bodies. It never
ignores a function by name. Full Live/catalog comparison also identified dynamic
SQL template formatting: templates are normalized only when a closed variable
def/use proof limits every consumption to EXECUTE; returned/logged strings retain
their original bytes. Extension qualification needs catalog ownership and
search-path resolution proof; shadowing blocks normalization.

Ordinary literals, predicates, calls, table/column/write targets, return/locking
statements, signatures, strictness, parallel/leakproof flags, search_path,
RLS and ACL remain fingerprint-sensitive. Malformed quoting fails closed.

## History and promotion

`fingerprintStructuralSnapshotV2` preserves v4/v5 historical computations;
v4 baseline records must not be rewritten. Migration sources 049/050/051 are
unchanged. No 052 is needed when the full fresh v3 comparison has zero semantic
differences. A zero-delta migration-effect plan with a full-schema mismatch is
now blocked, preventing conflicting fingerprint/reconciliation decisions.

Fingerprint, comparator, planner, baseline builder and guard share the same
engine. Fresh schema evidence and the new artifact explicitly identify the
algorithm/version. Build and deploy must use a clean fixed Git HEAD/checkpoint.

## Reproduce

- `node tests/schema-canonical-v3.mjs` (positive/negative lexical contracts)
- Add `--source <canonical-raw.json> --live <fresh-live-raw.json>` for the full
  actual catalog golden pair, including frozen v2 hash verification.
- `node tools/schema-reconciliation/function-equivalence-cli.mjs --source
  <canonical-raw.json> --live <fresh-live-raw.json> --output <ignored-report.json>`
  retains raw evidence references and compares full function tokens/metadata.
- `node tests/schema-reconciliation-pglite.mjs` verifies fresh/upgrade/replay,
  migration effects and frozen v4 history.
- `node tests/schema-canonical-native-v3.mjs` requires the guarded disposable
  loopback PostgreSQL target; never point it at Cloud.

Business snapshots and raw Live evidence stay in ignored local recovery paths,
never in Git or chat. Deploy is permitted only after fresh Luna schema,
recovery/isolated restore, v5 adoption and POST_ADOPTION guard all pass.
