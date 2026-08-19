# Next Sandbox — Retrieval v2 + Identity Parsing Foundation

狀態：**Retrieval v2 Implemented + Automated Tested / Awaiting Evaluation Review**

範圍只包含代理版商品的 Catalog Retrieval 與 Identity Parsing 基礎。沒有開始完整 Matching v2，沒有調整 90% threshold、5% ambiguity guard、Wanrong Supplier Priority 或代理版提前 2 天規則。

## Before / After Retrieval

比較範圍為 44-case Dataset 中的 36 筆 `OBSERVE` 真實代理商品。

| 指標 | Before | After | 差異 |
| --- | ---: | ---: | ---: |
| Runtime zero-candidate | 9 | 8 | -1 |
| Candidate available | 27 | 28 | +1 |
| Safe MATCH | 10 | 22 | +12 |
| Safe reject | 17 | 6 | -11 |
| 平均 query / case | 3.00 | 2.92 | -0.08 |

After 共執行 105 個 query。Progressive Query 在取得有 deadline 的安全 Match 後立即停止；相同 query 由本次操作內的 cache 共用。Capture 全 41 筆線上案例共 114 個執行 query、111 個實際 network request、3 次 cache hit，Production Supabase request 為 0。

仍為 zero-candidate 的 8 筆：

- `nendoroid-kachina`
- `popup-parade-aura`
- `prize-relax-time-raden`
- `chocopuni-hoshino`
- `chocopuni-maple`
- `chocopuni-nagisa`
- `bandai-robot-dam-bine`
- `phat-shiroko`

以上保持 fail-closed，未以降低 threshold 或猜 alias 方式強制配對。

## Identity Parsing Foundation

- Identity 由單一「最後 token」改為 `identityCandidates`／`identityAliases` 架構。
- `再版`、`再販`、`預購`、`附特典`、`特典`、`PVC`、`完成品`、`公仔`、`模型`、`景品`、日期碼與 Scale 不再成為 Identity。
- Version／服裝資訊保留為 qualifier metadata。
- 單字 CJK Identity（例如 `楓`）不再因長度規則被丟棄。
- Product Type 與 Product Line 分離。
- 新增 Product Line：YUMEMIRIZE、RELAX_TIME、HIKKAKE、CHOCOPUNI、MOCHIPICO、SMP、SHF、PLAMATEA。
- 新增 Manufacturer metadata 基礎：GSC、SEGA、BANDAI、FURYU、TAITO。
- Alias 只取自同一個 ERP title 內的可靠形式；沒有建立角色猜測字典。

## Query Planner

Runtime 與 Capture 現在都直接呼叫同一個 `buildProxyCatalogQueries()`：

1. Product Line + primary Identity
2. Product Type + primary Identity
3. Series + Identity + qualifier（有可靠 qualifier 時）
4. Source title 內的可靠 alias
5. Identity-only fallback

每個商品最多 8 個 query。Character-only fallback 不會被 query 上限擠掉。

單一 query 若回 HTTP error，會記錄／跳過並嘗試下一個 fallback；只有所有 query 都失敗時才回報 Catalog service error。這個路徑不會寫入 `closing_date`。

## 44-case Evaluation

| 結果 | 數量 |
| --- | ---: |
| Explicit Golden PASS | 6 |
| Fixed Known Failure | 2 |
| OBSERVE MATCH | 22 |
| OBSERVE AMBIGUOUS | 1 |
| OBSERVE NOT_FOUND | 13 |
| Labeled regression | 0 |

3 筆明確 Negative Golden（Nendoroid vs Scale、PUP vs Nendoroid、同類型不同角色）全部維持安全拒絕。兩筆 Yumemirize Known Failure 已取得安全 Match，但仍需 Evaluation Review，不自動提升為 Production Ready。

「New false-positive regression = 0」只適用於已有明確 expected outcome 的 Golden cases。22 筆 `OBSERVE MATCH` 仍需人工檢視，不能把自動 score 當作人工 Field Accepted。

## Golden Regression

- `Bandai SHF 孫悟飯 再版` → Product Line `SHF`、Identity `孫悟飯`、Qualifier `再版`。
- `流螢 ... 0907` → Identity `流螢`，`0907` 為 ignored metadata。
- `Luminous Box CheLA77 ... 1/6` → Identity `兔女郎警官02`，Scale `1/6`。
- `SEGA Yumemirize ... 若葉睦` → `Yumemirize 若葉睦` 與 `若葉睦` query。
- `Hikkake 櫻巫女 再版` → Product Line `HIKKAKE`、Identity `櫻巫女`、Qualifier `再版`。
- 不同 Product Line 的同角色候選會被拒絕。

## Build / Tests / Data Safety

- `npm run build:next` — PASS，TypeScript 0 error。
- `npm run test:core` — PASS。
- `npm run test:proxy-product-identity` — PASS。
- `npm run test:closing-date-evaluation` — PASS。
- `npm run test:sandbox-guard` — PASS。
- `npm run test:sandbox-architecture` — PASS。
- `npm run test:next-nightly-integrity` — PASS。
- `git diff --check` — PASS。

Next raw collection counts、collection hashes、Golden VSPO、Variant IDs 與 orphan counts 全部維持既有基準。Production IndexedDB unchanged，Production Supabase request = 0。沒有執行批次 closing date 更新。

## Stop Point

本輪停在 Evaluation Review 前：

> Retrieval v2 Implemented + Automated Tested / Awaiting Evaluation Review

不開始 Matching v2，不 Push，不 Deploy，不碰 Production。
