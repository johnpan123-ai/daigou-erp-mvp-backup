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
- Git blob：`58910f0cf4f50f0bb9340dc82be41039afe47ca2`
- SHA-256：`0522B3F91130CA9B4C6EC4C88E7A8E40BF9BE984897557FCAD837549E63AE22D`
- Superseded artifacts（不得套用）：blob `6e7741e98880bbd0c8b0cd410261c9faae6d0fc3`；SHA-256 `DA78C12E27972296A3378E997468DAC2A4E0892C557510E70514E7323A172C6C`。更早版本 blob `2dad904ed5dcdee769d80e2f8a82dc0bf76099de`；SHA-256 `8DFAEE952933FE9A6DD79B5942D52820BB82AA7C9BD30E9CD42C070B32CC46A4`。
- Portability：client 傳 active project ref，Server 以 request host 驗證；artifact 不硬編碼 Staging/Production ref。
- ACL：SECURITY DEFINER、空 search_path；PUBLIC/anon REVOKE，authenticated EXECUTE。
- Recovery：整份 `BEGIN/COMMIT`；apply/postflight 失敗即 transaction rollback。成功 apply 後的移除/替換需另行 review，不以重套舊 SHA 回退。
- Postflight：以 `to_regprocedure`、`pg_proc.pronargs/proargtypes/proargnames` 與 overload count 結構化驗證 signature；另驗 return type、owner、security definer、search_path、ACL 與 collision fail-closed，不依賴格式化 argument 字串。空 search path 依 Live catalog 的 `search_path=""` 語意驗證；每項契約使用獨立固定錯誤碼，仍於任一偏離時整筆 rollback。

## 032 Outbound atomic delete

- File：`supabase/sql/032_outbound_shipment_atomic_delete.sql`
- Purpose：以 exact active child scope 原子 soft-delete Outbound Shipment header 與全部 Items，關閉兩次 client save 的 partial commit。
- RPC：`public.erp_apply_outbound_shipment_transaction(uuid, jsonb) returns jsonb`
- Git blob：`36c0aa7165f5cae307e1acb565cfaf006bbabe86`
- SHA-256：`E7A1DE9B78D06A535989329D8F94E97A7C264BC0A74B89172A932030FDE0FC8E`
- Superseded artifacts（不得套用）：blob `9f0ec34633661b62791c16200617647370b94b45`；SHA-256 `C1F3FE4FADE6430E8FEE57DE89AB79A3A72D88DD052C06F133DDF14FEF03EC8B`。更早版本 blob `f9e3173d64aab340c2fb413126a88a48fc099d2e`；SHA-256 `110BFAD231F36A33EA42062AC7E92BB55A488770B527BDA0CDB2C8C096ED1C39`。
- Portability：同 031，以 request host 綁定 target；不硬編碼環境 ref。
- ACL：SECURITY DEFINER、空 search_path、15 秒 statement timeout；PUBLIC/anon REVOKE，authenticated EXECUTE。
- Recovery：item CAS delete 與 header CAS delete 位於同一 PostgreSQL subtransaction；任何 scope/CAS/constraint failure rollback idempotency claim 與全部 mutation。成功 apply 後不得以直接 hard delete 或停用 FK 回復。
- Postflight：function collision、dependency、以 `pg_proc` 結構欄位驗證 signature/parameter names/overload、return/owner/security/config、ACL。空 search path 與 15 秒 timeout 分別做語意驗證，並以獨立固定錯誤碼 fail closed。Staging apply 後另驗 exact-child-scope、replay、payload mismatch、constraint rollback 與 canonical result。

## Apply gate

每份 artifact：核對 hash → 確認正確 Staging project → 單次 apply → 完整 postflight → catalog/ACL SELECT-only → provider deployment → authenticated human acceptance。任一結果不明不得重套。
