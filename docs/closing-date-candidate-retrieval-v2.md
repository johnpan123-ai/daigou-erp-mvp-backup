# Closing Date Workbench Candidate Retrieval v2

Status: **Candidate Retrieval v2 Implemented + Runtime Tested / Awaiting Manual Acceptance**

- Base implementation commit: `5e70bff`
- Runtime refinement commit: `0807d1390e67ecc07a82e65453bd8ef39ca943dd`
- Checkpoint: `checkpoint-20260822-1106-closing-date-candidate-retrieval-v2-runtime-awaiting-manual`

本階段只調整 Next-only Closing Date Workbench 的候選取得、明確衝突排除與排序證據。Parser 實作、Matcher scoring、90% threshold、5% ambiguity guard、Wanrong priority、closing-date 規則、Provider、ERP Schema 與 Production 均未修改。

## Runtime flow

```text
Parser v2.1 structured metadata
→ 最多 4 個高資訊 query
→ Catalog 原生 /api/search?limit=5
→ 保存 query priority + native rank
→ supplier + source product id 去重
→ 足夠 Top 3 時停止後續 query
→ Workbench Matcher 僅提供安全 recommendation / reject
→ Sidecar Result + Candidate evidence
```

Analysis 階段不寫 `ProductGroup.closing_date`。所有候選、查詢證據與分析結果只寫既有 Next Sidecar Storage。

## Implemented contracts

- Catalog 查詢參數由不受 API 支援的 `pageSize` 改為 `limit=5`。
- Query Planner 上限為 4，依序只產生：
  1. Product Line + Subject
  2. Series + Subject
  3. Subject + Version/Form
  4. Subject
- 禁止 bare `PLA`、`無比例`、`魂商店 &`、`&`、Qualifier 或完整 ERP title fallback。
- 每個命中保存 query text、priority、kind、Catalog native rank、source supplier 與 source product id。
- 相同 `source_supplier + source_product_id` 合併，但保留所有 query hit evidence。
- 同一個高資訊 query 已取得至少 3 筆「未被 v2.1 結構化 metadata 證明衝突」的候選時，才停止後續較低優先 query；三筆 raw 垃圾候選不會誤觸 progressive stop。
- Matcher 在 retrieval 階段只排除可明確證明的 Subject、Product Line、Product Type、Version、Form、Scale、Model Code 或 Compound Set 衝突；metadata 缺失仍保留為 YELLOW 人工候選，不增加 confidence。
- Top 3 先依 trusted exact evidence（若有），再依 query priority、原生 rank、多 query support 與 first-seen order。Confidence 只作最後 tie-break。
- 低分／0 分候選不再以 source UUID 字典序重排。
- Matcher recommendation 與人工 selected candidate 分開；YELLOW 不會因 recommendation 被當成使用者已選取。

## Four-case regression

| Case | Before queries / pool | Retrieval v2 queries / fixture pool | Gate |
| --- | --- | --- | --- |
| KDcolle 露易絲 | 9 / 16 | 4 / 1 | 真實 Catalog Top 3 只有 `露易絲 20th Anniversary non scale model`；赫蘿／金剛／3式機龍均未進池 |
| 索菲亞 F 希琳 | 6 / 3 | 3 / raw 3、safe 2 | 原生 1/6 #1 因 Scale conflict 排除；保留 1/9 Wanrong #2 → 1/9 Dreamlink #3 的 native-rank evidence |
| Omaneko | 8 / bare `PLA` 曾灌入 24 筆無關商品 | 2 / 0 | 永不執行 bare `PLA` |
| SMP | 7 / `魂商店 &` 曾取得 5 筆 S.H.F／S.H.MonsterArts | 2 / 0 | 永不執行 `魂商店 &` 或 `&` |

專用 deterministic runtime test 另外驗證：同一商品由兩個高資訊 query 命中時仍只產生一筆 Candidate，且兩筆 query evidence 均完整 round-trip 到 Sidecar。

固定四案例的預期 Top 3／安全空集合結果為 4 / 4 通過；這是 regression correctness，不是對整個 Catalog 的全域準確率宣稱。

## Controlled 10 / 50 / 100 benchmark

方法與 Migration 3 相同：Chromium 內執行真實 Gateway、polling、query cache、single-flight 與 Sidecar repository，使用固定 15 ms read-only Catalog fixture。此數據量測架構行為，不代表公開 Catalog Worker 的 Internet SLA。

設定：upstream concurrency 6、item concurrency 8、每個 native query `limit=5`。

| Items | Version | Cache | Total ms | Item p50 ms | Item p95 ms | Logical queries | Upstream | Dedupe | Cache hit |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | Migration 3 | cold | 144.9 | 94.6 | 110.8 | 55 | 33 | 40% | 11% |
| 10 | Retrieval v2 | cold | 159.3 | 82.4 | 96.9 | 40 | 40 | 0% | 0% |
| 10 | Retrieval v2 | warm | 8.5 | 3.3 | 3.7 | 40 | 0 | 100% | 100% |
| 50 | Migration 3 | cold | 289.8 | 30.5 | 96.5 | 275 | 93 | 66% | 60% |
| 50 | Retrieval v2 | cold | 160.3 | 0.5 | 81.2 | 200 | 40 | 80% | 69% |
| 50 | Retrieval v2 | warm | 41.2 | 0.5 | 2.8 | 200 | 0 | 100% | 100% |
| 100 | Migration 3 | cold | 478.7 | 30.4 | 95.6 | 550 | 168 | 69% | 67% |
| 100 | Retrieval v2 | cold | 200.8 | 0.5 | 79.7 | 400 | 40 | 90% | 85% |
| 100 | Retrieval v2 | warm | 80.7 | 0.5 | 2.0 | 400 | 0 | 100% | 100% |

10-item cold fixture 故意使用 10 個完全不同商品，因此沒有跨商品 query dedupe；雖然 logical query 從 55 降到 40，unique upstream 為 40。50／100 筆則能清楚量到 shared-query dedupe。所有 warm batch 均為 0 upstream request。

## Live Catalog and true 4192 Runtime evidence

本階段使用隔離的 Catalog Hotfix Preview（Preview DB + Catalog R2）作唯讀來源，真正 4192 Runtime 已取得：

- `露易絲`：HTTP 200，唯一結果為 `露易絲 20th Anniversary non scale model`。
- `希琳`：HTTP 200，原生前三筆依序為 1/6 特別版 #1、1/9 Wanrong #2、1/9 Dreamlink #3；Workbench 排除 Scale conflict 後保留 #2、#3，沒有改寫 native rank。
- bare `PLA`：會回傳多筆無關商品。
- `魂商店 &`：會回傳 S.H.F／S.H.MonsterArts 等無關商品。

`npm run benchmark:closing-date-candidate-retrieval-v2-live` 已通過，Production Supabase request 為 0。接著在真正 `http://127.0.0.1:4192/purchase-records` 勾選四筆既有 Next 商品並完成一次 Analysis：露易絲、索菲亞為 YELLOW 且候選／native rank 如上；Omaneko、SMP 為 RED／NO_CANDIDATE。沒有選擇或套用結果，ProductGroup write 為 0；只新增既有 Sidecar analysis rows。

## Data safety

- Next ERP collections：專用 regression／benchmark 前後 checksum 相同。
- Production IndexedDB：未變。
- Production Supabase request：0。
- Next nightly baseline：559 Groups、2438 Variants、467 Purchase Batches、1407 Purchase Batch Items；全部 collection hash 相同。
- Golden VSPO WACA、已採購與所有 orphan counts：不變。
- ERP closing-date write：0。
- Sidecar Schema／ERP Schema／Supabase Schema migration：0。
- Push：NO；Deploy：NO。

## Automated gates

- `npm run build:next`
- `npm run test:closing-date-candidate-retrieval-v2`
- `npm run benchmark:closing-date-candidate-retrieval-v2`
- `npm run benchmark:closing-date-candidate-retrieval-v2-live`
- `npm run test:closing-date-domain`
- `npm run test:closing-date-sidecar-storage`
- `npm run test:closing-date-batch-gateway`
- `npm run test:closing-date-workbench-ui`
- `npm run test:proxy-product-identity`
- `npm run test:proxy-product-identity-v21`
- `npm run test:proxy-product-identity-query-v2`
- `npm run test:proxy-product-identity-pilot`
- `npm run test:core`
- `npm run test:sandbox-guard`
- `npm run test:sandbox-architecture`
- `npm run test:next-nightly-integrity`
- `git diff --check`

本節點不得標記 Manual Accepted 或 Production Ready；真正 4192 Workbench 已保持在四案例 Review 畫面，等待人工確認 Top 3。
