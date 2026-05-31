# ERP Cloud Schema Plan (Phase 3-A)

This document details the database migration and synchronization strategy for moving the "小河馬採購工作台" from local storage (IndexedDB/LocalStorage) to a relational database hosted on Supabase (PostgreSQL), while retaining full compatibility with the offline local mode.

---

## 1. Local IndexedDB to Cloud Tables Mapping

We will map the existing document/item models from `src/lib/db.ts` to normalized PostgreSQL tables in Supabase under the `public` schema.

| Local IDB Model | Cloud Table Name | Relationship | Description |
| :--- | :--- | :--- | :--- |
| `InventoryItem` | `public.inventory` | 1-to-Many with `sales_order_items` | SKU master list imported from MyACG inventory XLS. |
| `ProductGroup` | `public.product_groups` | 1-to-Many with categories and variants | Campaign header grouping multiple SKUs. |
| `ProductCategory` | `public.product_categories`| Many-to-1 with `product_groups` | Tab categories inside a product group. |
| `ProductVariant` | `public.product_variants` | Many-to-1 with groups and categories | Individual variant lines linked to inventory items. |
| `PurchaseBatch` | `public.purchase_batches` | 1-to-Many with batch items | A single purchase log transaction header. |
| `PurchaseBatchItem` | `public.purchase_batch_items` | Many-to-1 with batch and variants | Cost and quantity lines for purchased variants. |
| `PrivateOrder` | `public.private_orders` | 1-to-Many with order items | Customer private order reservation header. |
| `PrivateOrderItem` | `public.private_order_items` | Many-to-1 with order and variants | Quantity and price lines for customer reservations. |
| `SalesOrder` | `public.sales_orders` | 1-to-Many with sales order items | Imported order header from platform CSV. |
| `SalesOrderItem` | `public.sales_order_items` | Many-to-1 with sales orders | Customer demand items mapping to inventory. |
| `ImportBatch` | `public.import_batches` | 1-to-Many with order/inventory items | Audit log of import batches (CSV/XLS file logs). |

---

## 2. Table Column Schemas (DDL Design)

To support robust auditing, synchronization, soft deletions, and optimistic concurrency control, **every table** will inherit the following system metadata columns:

| Column Name | Data Type | Default / Constraint | Purpose |
| :--- | :--- | :--- | :--- |
| `id` | `uuid` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique Cloud ID (always UUID). |
| `local_id` | `text` | `NULL` | Stores the client-side ID to map local databases. |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Row creation timestamp. |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Row modification timestamp. |
| `updated_by` | `uuid` | `REFERENCES auth.users(id)` | Audit trail of who changed the row. |
| `deleted_at` | `timestamptz` | `NULL` | Soft deletion marker. |
| `version` | `integer` | `NOT NULL DEFAULT 1` | Optimistic locking token for concurrency. |
| `sync_status` | `text` | `DEFAULT 'synced'` | Sync state: `'synced' \| 'pending_upload' \| 'conflict'`. |

---

### Core Data Tables Schema Outlines

#### A. `public.inventory`
* `myacg_item_code` (`text` PRIMARY KEY) - Natural PK from MyACG system.
* `product_id` (`text` NULL)
* `product_title` (`text` NOT NULL)
* `normalized_product_title` (`text` NULL)
* `raw_variant_name` (`text` NOT NULL)
* `listing_type` (`text` NOT NULL)
* `final_price` (`numeric(12, 2)` NOT NULL DEFAULT 0)
* `myacg_available_quantity` (`integer` NOT NULL DEFAULT 0)
* `myacg_sold_quantity` (`integer` NOT NULL DEFAULT 0)
* `myacg_demand_quantity` (`integer` NULL)
* `myacg_listed_at` (`timestamptz` NULL)

#### B. `public.product_groups`
* `id` (`uuid` PRIMARY KEY DEFAULT gen_random_uuid())
* `title` (`text` NOT NULL)
* `normalized_title` (`text` NULL)
* `listing_type` (`text` NULL)
* `priority` (`text` NOT NULL DEFAULT 'Medium')
* `purchase_date` (`date` NULL)
* `closing_date` (`date` NULL)
* `release_month` (`text` NULL)
* `has_official_site` (`boolean` NOT NULL DEFAULT false)
* `product_url` (`text` NULL)

#### C. `public.product_categories`
* `id` (`uuid` PRIMARY KEY DEFAULT gen_random_uuid())
* `product_group_id` (`uuid` NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE)
* `title` (`text` NOT NULL)
* `sort_order` (`integer` NOT NULL DEFAULT 0)

#### D. `public.product_variants`
* `id` (`uuid` PRIMARY KEY DEFAULT gen_random_uuid())
* `product_group_id` (`uuid` NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE)
* `product_category_id` (`uuid` NULL REFERENCES product_categories(id) ON DELETE SET NULL)
* `myacg_item_code` (`text` NOT NULL REFERENCES inventory(myacg_item_code) ON DELETE RESTRICT)
* `product_title` (`text` NOT NULL)
* `variant_name` (`text` NOT NULL)
* `raw_variant_name` (`text` NULL)
* `myacg_auto_quantity` (`integer` NOT NULL DEFAULT 0)
* `effective_myacg_quantity` (`integer` NOT NULL DEFAULT 0)
* `waca_auto_quantity` (`integer` NOT NULL DEFAULT 0)
* `note` (`text` NOT NULL DEFAULT '')
* `sort_order` (`integer` NOT NULL DEFAULT 0)
* `catalog_missing` (`boolean` NOT NULL DEFAULT false)

*(Note: Similar FK mapping rules will apply to `purchase_batches`, `purchase_batch_items`, `private_orders`, `private_order_items`, `sales_orders`, and `sales_order_items`).*

---

## 3. Local Sync & Backup Strategy

To keep the Local Mode independent and prevent synchronization conflicts when online, we design the following mechanism:

```
[Local Offline Edit] ──► Writes to local IDB (marked 'pending_upload')
                                 │
                        [Network Restored]
                                 ▼
                     Checks Remote updated_at
                      /                    \
  (Remote is older)  /                      \  (Remote is newer)
                    ▼                        ▼
           Perform Bulk Upsert       Trigger Conflict Alert
         Update sync_status='synced'  Field-Level Merge / User Select
```

* **ID Synchronization (`local_id` vs `id`)**:
  - In local offline mode, the client generates client-side UUIDs (`crypto.randomUUID()`).
  - When syncing to the cloud, the record is stored using a generated Cloud ID (`id`), while saving the client-side UUID in `local_id`.
  - When fetching cloud updates, the client matches local data using `local_id` to prevent row duplication.
* **Sync Overwrite Mitigation**:
  - The client compares local modified timestamps with cloud `updated_at` timestamps.
  - If the cloud's timestamp is more recent, the client enters a merge state instead of forcing an overwrite.
* **Caching back to IndexedDB**:
  - Incremental query:
    `SELECT * FROM table WHERE updated_at > :last_sync_time OR deleted_at IS NOT NULL`
  - Allows syncing deletions (soft deleted rows) and merges fresh updates locally without full-database reload.

---

## 4. Bulk Import Strategy for High Volume Data

When importing XLS files containing thousands of item rows or CSV files with order histories, individual `INSERT` requests cause massive network overhead and timeouts.

### Proposed Architecture

1. **Supabase Bulk JSON Upload**:
   Utilize PostgreSQL JSONB batch inserts. We send a single post payload to Supabase and execute a native PostgreSQL upsert query:
   ```javascript
   const { data, error } = await supabase
     .from('inventory')
     .upsert(itemsJsonArray, { onConflict: 'myacg_item_code' });
   ```
2. **Database Stored Procedures (RPC)**:
   For complex imports that require simultaneous updates of multiple tables (e.g., order CSV imports which affect both `sales_orders` and `sales_order_items`), we will write a PostgreSQL function:
   ```sql
   CREATE OR REPLACE FUNCTION public.import_sales_csv_payload(orders_json jsonb, items_json jsonb) ...
   ```
   This processes the transaction strictly inside the database server, executing in milliseconds instead of making dozens of API trips.

---

## 5. Multi-User Collaboration Risks & Mitigations

| Risk | Consequence | Mitigation Strategy |
| :--- | :--- | :--- |
| **全表 save 覆蓋 (Full-Table Overwrite)** | User A saves groups `[1, 2, 3]`. User B adds `[4]`. User A's subsequent save overwrites B's work, deleting `[4]`. | **Abolish Full-Table Overwriting**: Re-engineer all `save` calls in `dataProvider` to run patch upserts (`upsert`) and soft deletions instead of array replacements. |
| **同時編輯衝突 (Concurrent Overwrite)** | Two users update the priority of the same product group. | **Optimistic Concurrency Control (OCC)**: Check `version` token. Every update runs `WHERE id = :id AND version = :expected_version` and sets `version = version + 1`. If affected rows = 0, trigger a merge conflict. |
| **實體物理刪除 (Hard Delete)** | One user deletes a variant, causing foreign key failures in other tables. | **Soft Deletion (`deleted_at`)**: All deletes simply set `deleted_at = now()`. The client-side queries ignore rows where `deleted_at` is set. |

---

## 6. Recommendations & Post-Phase 3 Timeline

To execute this migration without impacting operations, we recommend the following chronological phases:

* **Phase 3-B: Write ERP Table SQL Draft**
  - Translate this DDL plan into PostgreSQL scripts containing triggers, constraints, index optimizations, and RLS rules.
* **Phase 3-C: Review SQL Schema**
  - Verify index coverage, foreign key cascades, and check constraints to prevent integrity leaks.
* **Phase 3-D: Deploy Database on Supabase**
  - Create the tables on the production Supabase instance.
* **Phase 3-E: Read-Only Sync & Caching Tests**
  - Implement read-only data fetching from Supabase to IndexedDB cache to verify incremental query logic without write risks.
* **Phase 3-F: Single Write/Differential Upsert Tests**
  - Introduce single-entity CRUD tests to verify optimistic lock performance and trigger executions.
* **Phase 3-G: Large-Scale Bulk Import & Migration**
  - Execute full data imports using the RPC bulk transaction strategy.
