export const LIVE_SCHEMA_CLASSIFICATIONS = Object.freeze({
  A: 'LIVE_VALID_CANONICAL_MISSING',
  B: 'ENVIRONMENT_LOCAL',
  C: 'TRUE_SCHEMA_DRIFT',
  D: 'LEGACY_UNUSED',
  E: 'UNKNOWN',
});

const rule = (id, classification, pathPattern, metadata) => Object.freeze({
  id,
  classification,
  pathPattern,
  ...metadata,
});

// Rules are ordered from the narrowest exception to the broadest family.
// Every observed difference is emitted as an individual classified record;
// an unmatched path is always UNKNOWN and therefore blocks promotion.
export const LIVE_SCHEMA_RECONCILIATION_RULES = Object.freeze([
  rule('unsafe-table-acl-drift', LIVE_SCHEMA_CLASSIFICATIONS.C,
    '^tables\\.public\\.(bundle_components|dashboard_category_images|erp_cloud_restore_epoch|japan_package_items|japan_packages|outbound_shipment_items|outbound_shipments|private_order_items|private_orders|product_categories|product_groups|product_variants|profiles|purchase_batch_items|purchase_batches|sales_order_items|sales_orders)\\.grants\\.(anon|authenticated)$', {
      evidence: 'Live Supabase default grants include MAINTAIN/REFERENCES/TRIGGER/TRUNCATE; TRUNCATE bypasses RLS.',
      currentCallerWriter: 'Authenticated ERP Data API clients; owner/service roles remain outside this rule.',
      migrationOrigin: 'Supabase project default table privileges predating explicit-grant closure.',
      portabilityClass: 'PORTABLE_SECURITY_CONTRACT',
      securityImpact: 'P1_UNSAFE_NON_PRODUCT_PRIVILEGES',
      resolution: '048 explicitly removes only non-product privileges and preserves required CRUD/SELECT.',
    }),
  rule('sales-helper-policy-drift', LIVE_SCHEMA_CLASSIFICATIONS.C,
    '^tables\\.public\\.(sales_orders|sales_order_items)\\.policies\\.(delete_policy|insert_policy|update_policy)\\.(using|withCheck)$', {
      evidence: 'UI/provider role contract treats owner, staff and helper as editors; Live owner/staff policy excludes helper.',
      currentCallerWriter: 'Cloud provider sales order upsert/update paths and helper editor workflow.',
      migrationOrigin: '005 owner/staff policy survived while 004 helper-aware policy was not effective on Live.',
      portabilityClass: 'PORTABLE_PRODUCT_SECURITY_CONTRACT',
      securityImpact: 'P1_AUTHORIZED_HELPER_WRITE_DENIED',
      resolution: '048 recreates only the three sales write policies per table with is_editor(auth.uid()).',
    }),
  rule('legacy-dashboard-contract', LIVE_SCHEMA_CLASSIFICATIONS.D,
    '^tables\\.public\\.dashboard_category_images\\.(columns\\.(local_id|version)|indexes\\.public\\.idx_dashboard_category_images_deleted_at|constraints|policies\\.(?!staging_refresh_))', {
      evidence: 'Current Dashboard has no image feature or Storage-object dependency; table remains in legacy backup compatibility.',
      currentCallerWriter: 'No current formal UI caller/writer; compatibility provider reads remain non-user-facing legacy paths.',
      migrationOrigin: '006/009 legacy dashboard image feature and historical Live schema.',
      portabilityClass: 'LEGACY_DURABLE_COMPATIBILITY_ONLY',
      securityImpact: 'NONE_AFTER_ACL_REPAIR',
      resolution: 'Preserve Live and source shapes; exclude only enumerated legacy fields/policy attributes from business fingerprint.',
    }),
  rule('live-product-columns', LIVE_SCHEMA_CLASSIFICATIONS.A,
    '^tables\\.public\\.product_groups\\.columns\\.(proxy_agent|show_in_purchase_list|purchase_date)', {
      evidence: 'Current ProductGroup readers/writers persist proxy agent, purchasing visibility and ISO purchase date.',
      currentCallerWriter: 'Purchase Records, Recent Purchases, Purchasing and cloud field CAS.',
      migrationOrigin: 'Historical Live product evolution plus staging schema parity closure.',
      portabilityClass: 'PORTABLE_PRODUCT_CONTRACT',
      securityImpact: 'NONE',
      resolution: '048 adds missing columns and converges purchase_date to date with validated ISO conversion.',
    }),
  rule('live-purchase-date', LIVE_SCHEMA_CLASSIFICATIONS.A,
    '^tables\\.public\\.purchase_batches\\.columns\\.date\\.dataType$', {
      evidence: 'Live and current transaction payload use ISO dates; staging parity established PostgreSQL date as target.',
      currentCallerWriter: 'Purchase batch transaction RPC and purchase management UI.',
      migrationOrigin: 'Historical Live product evolution plus staging schema parity closure.',
      portabilityClass: 'PORTABLE_PRODUCT_CONTRACT',
      securityImpact: 'NONE',
      resolution: '048 performs fail-closed ISO validation before text-to-date conversion.',
    }),
  rule('live-manual-adjustment-nullability', LIVE_SCHEMA_CLASSIFICATIONS.A,
    '^tables\\.public\\.product_variants\\.columns\\.(private_manual_adjustment|purchased_manual_adjustment)\\.(nullable|default)$', {
      evidence: 'Cloud payload/domain models intentionally preserve null as distinct from an entered zero.',
      currentCallerWriter: 'Purchase Records, Purchase Management, duplicate management and cloud provider payloads.',
      migrationOrigin: 'Historical Live product evolution plus staging schema parity closure.',
      portabilityClass: 'PORTABLE_PRODUCT_CONTRACT',
      securityImpact: 'NONE',
      resolution: '048 drops NOT NULL/default without rewriting existing values.',
    }),
  rule('live-owned-header-cascade', LIVE_SCHEMA_CLASSIFICATIONS.A,
    '^tables\\.public\\.(private_orders|purchase_batches)\\.constraints$', {
      evidence: 'Live relationship contract uses CASCADE for group-owned headers; restore relationship graph already follows it.',
      currentCallerWriter: 'Private order and purchase batch provider/restore flows.',
      migrationOrigin: 'Historical Live product evolution plus staging schema parity closure.',
      portabilityClass: 'PORTABLE_RELATIONSHIP_CONTRACT',
      securityImpact: 'DATA_RELATIONSHIP_SEMANTICS',
      resolution: '048 state-guards RESTRICT/CASCADE and converges only the two named FKs.',
    }),
  rule('authenticated-read-policy', LIVE_SCHEMA_CLASSIFICATIONS.A,
    '^tables\\.public\\.(inventory_items|private_order_items|product_categories|product_groups|product_variants|purchase_batch_items|purchase_batches)\\.policies\\.select_policy\\.roles$', {
      evidence: 'Formal ERP routes require authenticated sessions; Live correctly restricts business reads to authenticated.',
      currentCallerWriter: 'Authenticated Cloud provider bootstrap and targeted refresh.',
      migrationOrigin: 'Live security hardening after legacy public-read policies 009/012.',
      portabilityClass: 'PORTABLE_PRODUCT_SECURITY_CONTRACT',
      securityImpact: 'P1_IF_REGRESSED_TO_ANON_READ',
      resolution: '048 recreates the seven select policies for authenticated only.',
    }),
  rule('staging-refresh-policy', LIVE_SCHEMA_CLASSIFICATIONS.B,
    '^tables\\.public\\.[^.]+\\.policies\\.staging_refresh_', {
      evidence: 'Dedicated refresh reader/writer roles are tied to one Supabase environment and operator flow.',
      currentCallerWriter: 'tools/staging-refresh operator tooling only.',
      migrationOrigin: 'Environment-local Production-to-Staging refresh provisioning.',
      portabilityClass: 'ENVIRONMENT_LOCAL_OPS_SECURITY',
      securityImpact: 'REVIEWED_ENVIRONMENT_ROLE_ONLY',
      resolution: 'Keep and audit on Live; omit from portable canonical fingerprint.',
    }),
  rule('staging-test-functions', LIVE_SCHEMA_CLASSIFICATIONS.B,
    '^functions\\.public\\.erp_p0_4_', {
      evidence: 'Callers are gated to rhfd staging/test runtime and cannot run in Production role.',
      currentCallerWriter: 'StagingP04AuthenticatedHarness only.',
      migrationOrigin: 'Environment-local authenticated P0-4 test harness.',
      portabilityClass: 'ENVIRONMENT_LOCAL_TEST_CONTROL',
      securityImpact: 'GATED_TEST_RPC',
      resolution: 'Keep on rhfd; omit from portable canonical fingerprint.',
    }),
  rule('platform-rls-auto-enable', LIVE_SCHEMA_CLASSIFICATIONS.B,
    '^functions\\.public\\.rls_auto_enable\\(\\)$', {
      evidence: 'Platform-installed project helper has no application caller and is not portable product schema.',
      currentCallerWriter: 'Supabase platform/event-trigger infrastructure.',
      migrationOrigin: 'Supabase project provisioning.',
      portabilityClass: 'ENVIRONMENT_LOCAL_PLATFORM',
      securityImpact: 'PLATFORM_CONTROLLED',
      resolution: 'Keep on Live; omit from portable canonical fingerprint.',
    }),
  rule('preview-user-provisioning', LIVE_SCHEMA_CLASSIFICATIONS.B,
    '^functions\\.public\\.handle_new_user\\(\\)\\.definition$', {
      evidence: 'Live function provisions Preview Client/staff accounts and differs intentionally from portable viewer default.',
      currentCallerWriter: 'auth.users environment-local trigger.',
      migrationOrigin: 'Preview/Staging account provisioning hotfix.',
      portabilityClass: 'ENVIRONMENT_LOCAL_AUTH_BOOTSTRAP',
      securityImpact: 'ENVIRONMENT_ROLE_SENSITIVE',
      resolution: 'Keep Live implementation; exclude only its function body from portable fingerprint.',
    }),
  rule('catalog-constraint-representation', LIVE_SCHEMA_CLASSIFICATIONS.B,
    '^tables\\.public\\.[^.]+\\.constraints$', {
      evidence: 'PGlite/PostgreSQL version differences expose NOT NULL constraints differently; column nullability is already canonical.',
      currentCallerWriter: 'Schema snapshot tooling only.',
      migrationOrigin: 'PGlite PostgreSQL 18 versus Supabase PostgreSQL catalog rendering.',
      portabilityClass: 'CATALOG_ENGINE_REPRESENTATION',
      securityImpact: 'NONE',
      resolution: 'Filter duplicate NOT NULL constraint records and compare constraints by semantic body, not name.',
    }),
]);

const matches = (pattern, path) => new RegExp(pattern, 'u').test(path);

export function classifyLiveSchemaDifference(difference) {
  const ruleMatch = LIVE_SCHEMA_RECONCILIATION_RULES.find(candidate => matches(candidate.pathPattern, difference.path));
  const selected = ruleMatch ?? {
    id: 'unclassified', classification: LIVE_SCHEMA_CLASSIFICATIONS.E,
    evidence: 'No reviewed reconciliation rule.', currentCallerWriter: 'UNKNOWN', migrationOrigin: 'UNKNOWN',
    portabilityClass: 'UNKNOWN', securityImpact: 'UNKNOWN', resolution: 'BLOCK_RELEASE_AND_INVESTIGATE',
  };
  return Object.freeze({
    object: difference.path,
    liveState: difference.after,
    sourceState: difference.before,
    category: difference.category,
    classification: selected.classification,
    ruleId: selected.id,
    evidence: selected.evidence,
    currentCallerWriter: selected.currentCallerWriter,
    migrationOrigin: selected.migrationOrigin,
    portabilityClass: selected.portabilityClass,
    securityImpact: selected.securityImpact,
    resolution: selected.resolution,
  });
}

export function classifyLiveSchemaDifferences(differences, { canonicalDifferencePaths = [], normalizationProofPaths = [] } = {}) {
  const canonicalPaths = new Set(canonicalDifferencePaths);
  const normalizationPaths = new Set(normalizationProofPaths);
  const items = differences.map(difference => {
    const classified = classifyLiveSchemaDifference(difference);
    if (normalizationPaths.has(difference.path) && !canonicalPaths.has(difference.path)) return Object.freeze({
      ...classified, classification: LIVE_SCHEMA_CLASSIFICATIONS.B, ruleId: 'canonical-engine-proven-rendering',
      evidence: 'Both raw values produce identical canonical SQL tokens under the same algorithm.',
      portabilityClass: 'SQL_RENDERING_ONLY', securityImpact: 'NONE', resolution: 'NO_SCHEMA_CHANGE',
    });
    if (classified.classification !== LIVE_SCHEMA_CLASSIFICATIONS.B
      || !canonicalPaths.has(classified.object)) return classified;
    return Object.freeze({
      ...classified,
      classification: LIVE_SCHEMA_CLASSIFICATIONS.E,
      ruleId: 'normalization-claim-not-proven',
      evidence: 'The difference survived the canonical projection and therefore is not normalization-only.',
      portabilityClass: 'UNKNOWN',
      securityImpact: 'UNKNOWN',
      resolution: 'BLOCK_RELEASE_AND_INVESTIGATE',
    });
  });
  const counts = Object.fromEntries(Object.values(LIVE_SCHEMA_CLASSIFICATIONS).map(value => [value, 0]));
  for (const item of items) counts[item.classification] += 1;
  return Object.freeze({
    result: counts[LIVE_SCHEMA_CLASSIFICATIONS.E] === 0 ? 'PASS' : 'BLOCKED',
    total: items.length,
    counts: Object.freeze(counts),
    items: Object.freeze(items),
  });
}

export const isEnvironmentLocalFunction = signature => /^public\.erp_p0_4_/u.test(signature)
  || signature === 'public.rls_auto_enable()';

export const isEnvironmentLocalPolicy = name => name.startsWith('staging_refresh_');
