# Closing Date Workbench Candidate Retrieval v2

Status: **Candidate Retrieval v2 Implemented + Runtime Tested / Awaiting Manual Acceptance**

- Implementation commit: `5e70bff`
- Checkpoint: `checkpoint-20260821-1019-closing-date-candidate-retrieval-v2-awaiting-manual`

本階段只調整 Next-only Closing Date Workbench 的候選取得與排序證據。Parser、Matcher、90% threshold、5% ambiguity guard、Wanrong priority、closing-date 規則、Provider、ERP Schema 與 Production 均未修改。

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
- 同一個高資訊 query 已取得 3 筆有效原生候選時停止後續較低優先 query。
- Top 3 先依 trusted exact evidence（若有），再依 query priority、原生 rank、多 query support 與 first-seen order。Confidence 只作最後 tie-break。
- 低分／0 分候選不再以 source UUID 字典序重排。
- Matcher recommendation 與人工 selected candidate 分開；YELLOW 不會因 recommendation 被當成使用者已選取。

## Four-case regression

| Case | Before queries / pool | Retrieval v2 queries / fixture pool | Gate |
| --- | --- | --- | --- |
| KDcolle 露易絲 | 9 / live dedup pool 待服務恢復重測 | 4 / 1 | Top 3 只有 `露易絲 20th Anniversary non scale model`，不得出現赫蘿／金剛／3式機龍 |
| 索菲亞 F 希琳 | 6 / live dedup pool 待服務恢復重測 | 3 / 3 | 原生順序保存為 1/6 特別版 → 1/9 Wanrong → 1/9 Dreamlink；rank evidence 必須是 1 / 2 / 3，不得變 1 / 3 / 2 |
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
| 10 | Retrieval v2 | cold | 156.5 | 79.9 | 94.1 | 40 | 40 | 0% | 0% |
| 10 | Retrieval v2 | warm | 8.6 | 3.3 | 3.8 | 40 | 0 | 100% | 100% |
| 50 | Migration 3 | cold | 289.8 | 30.5 | 96.5 | 275 | 93 | 66% | 60% |
| 50 | Retrieval v2 | cold | 160.7 | 0.5 | 81.6 | 200 | 40 | 80% | 69% |
| 50 | Retrieval v2 | warm | 34.4 | 0.4 | 2.5 | 200 | 0 | 100% | 100% |
| 100 | Migration 3 | cold | 478.7 | 30.4 | 95.6 | 550 | 168 | 69% | 67% |
| 100 | Retrieval v2 | cold | 195.3 | 0.4 | 80.6 | 400 | 40 | 90% | 85% |
| 100 | Retrieval v2 | warm | 70.8 | 0.4 | 1.8 | 400 | 0 | 100% | 100% |

10-item cold fixture 故意使用 10 個完全不同商品，因此沒有跨商品 query dedupe；雖然 logical query 從 55 降到 40，unique upstream 為 40。50／100 筆則能清楚量到 shared-query dedupe。所有 warm batch 均為 0 upstream request。

## Live Catalog evidence and current service gate

本階段開始時，真正 4192 read-only probe 曾取得：

- `露易絲`：HTTP 200，唯一結果為 `露易絲 20th Anniversary non scale model`。
- `希琳`：HTTP 200，原生前三筆依序為 1/6 特別版、1/9 Wanrong、1/9 Dreamlink。
- bare `PLA`：會回傳多筆無關商品。
- `魂商店 &`：會回傳 S.H.F／S.H.MonsterArts 等無關商品。

完成修改後的最終公開服務重測目前被 Catalog Worker 自身 HTTP 500 阻擋；4192 proxy 與直接 Worker URL 同樣為 500，因此不是本地 Vite proxy、Sandbox Guard 或 Retrieval v2 造成。失敗維持 fail-closed，沒有寫入 ERP。公開服務恢復後，需再執行 `npm run benchmark:closing-date-candidate-retrieval-v2-live` 作最終人工前 live gate。

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

本節點不得標記 Manual Accepted 或 Production Ready；待公開 Catalog service 恢復後，仍需在真正 4192 Workbench 人工確認 Top 3。
