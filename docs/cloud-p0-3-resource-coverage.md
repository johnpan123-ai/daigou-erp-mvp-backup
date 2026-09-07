# Cloud P0-3 resource coverage

This matrix is the executable P0-3 mutation boundary, not an inference from a shared provider.
Every `PASS` entity is present in both the client whitelist and the SQL whitelist and is asserted by
`tests/cloud-field-cas.mjs`.

| Entity | Create | Patch | Delete | Reorder / bulk | Field-aware CAS | Structured conflict |
|---|---|---|---|---|---|---|
| product_groups | PASS | PASS | PASS | PASS (atomic group-tree delete) | PASS | PASS |
| product_categories | PASS | PASS | PASS | PASS (whole reorder) | PASS | PASS |
| product_variants | PASS | PASS | PASS | PASS (whole reorder / batch patch) | PASS | PASS |
| inventory_items | PASS | PASS | PASS | PASS (atomic collection mutation) | PASS | PASS |
| purchase_batches | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| purchase_batch_items | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| private_orders | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| private_order_items | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| japan_packages | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| japan_package_items | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| outbound_shipments | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| outbound_shipment_items | PASS | PASS | PASS | PASS (batch field patches) | PASS | PASS |
| sales_orders | PASS | PASS | N/A (no current public delete workflow) | PASS (batch field patches) | PASS | PASS |
| sales_order_items | PASS | PASS | N/A (no current public delete workflow) | PASS (batch field patches) | PASS | PASS |
| bundle_components | PASS | N/A (identity-only relation) | PASS | PASS (atomic replace) | PASS | PASS |

Important limits:

- P0-3 does not add purchase Batch + Items transaction/idempotency. That remains P0-4.
- `dashboard_category_images` is storage presentation metadata, not one of the ERP row entities above.
- The SQL is an Experimental/Staging review artifact only and must not be applied without separate approval.
