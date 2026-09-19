# ERP Release Candidate Migration Artifacts

本清單只描述未套用候選，不構成 SQL apply 授權。套用前必須重新計算 blob/SHA，與本清單完全一致。

## Apply order

1. `031_japan_package_receiving_atomic_transaction.sql`
2. `032_outbound_shipment_atomic_delete.sql`

兩者都依賴已驗收的 020 field CAS 與 021 idempotency store。031/032 不得先於相依 migration。

## 031 Japan Package / Receiving

- File：`supabase/sql/031_japan_package_receiving_atomic_transaction.sql`
- Purpose：A1 create Package、A2 attach Purchase Item、B receiving/status 的單一 Server transaction。
- RPC：`public.erp_apply_japan_package_transaction(uuid, jsonb) returns jsonb`
- Git blob：`2dad904ed5dcdee769d80e2f8a82dc0bf76099de`
- SHA-256：`8DFAEE952933FE9A6DD79B5942D52820BB82AA7C9BD30E9CD42C070B32CC46A4`
- Portability：client 傳 active project ref，Server 以 request host 驗證；artifact 不硬編碼 Staging/Production ref。
- ACL：SECURITY DEFINER、空 search_path；PUBLIC/anon REVOKE，authenticated EXECUTE。
- Recovery：整份 `BEGIN/COMMIT`；apply/postflight 失敗即 transaction rollback。成功 apply 後的移除/替換需另行 review，不以重套舊 SHA 回退。
- Postflight：signature、identity args、return type、owner、security definer、search_path、ACL 與 collision fail-closed。

## 032 Outbound atomic delete

- File：`supabase/sql/032_outbound_shipment_atomic_delete.sql`
- Purpose：以 exact active child scope 原子 soft-delete Outbound Shipment header 與全部 Items，關閉兩次 client save 的 partial commit。
- RPC：`public.erp_apply_outbound_shipment_transaction(uuid, jsonb) returns jsonb`
- Git blob：`f9e3173d64aab340c2fb413126a88a48fc099d2e`
- SHA-256：`110BFAD231F36A33EA42062AC7E92BB55A488770B527BDA0CDB2C8C096ED1C39`
- Portability：同 031，以 request host 綁定 target；不硬編碼環境 ref。
- ACL：SECURITY DEFINER、空 search_path、15 秒 statement timeout；PUBLIC/anon REVOKE，authenticated EXECUTE。
- Recovery：item CAS delete 與 header CAS delete 位於同一 PostgreSQL subtransaction；任何 scope/CAS/constraint failure rollback idempotency claim 與全部 mutation。成功 apply 後不得以直接 hard delete 或停用 FK 回復。
- Postflight：function collision、dependency、signature/return/owner/security/config、ACL。Staging apply 後另驗 exact-child-scope、replay、payload mismatch、constraint rollback 與 canonical result。

## Apply gate

每份 artifact：核對 hash → 確認正確 Staging project → 單次 apply → 完整 postflight → catalog/ACL SELECT-only → provider deployment → authenticated human acceptance。任一結果不明不得重套。
