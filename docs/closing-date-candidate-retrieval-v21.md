# Closing Date Workbench Candidate Retrieval v2.1

Status: **Candidate Retrieval v2.1 Implemented + Runtime Tested / Awaiting Manual Acceptance**

- Base checkpoint: `checkpoint-20260822-1106-closing-date-candidate-retrieval-v2-runtime-awaiting-manual`
- Implementation: `a2435c2bf2de9469d259d0dc88d17558d12e2685`
- Awaiting-manual checkpoint: `checkpoint-20260822-1147-closing-date-candidate-retrieval-v21-awaiting-manual`

本階段只擴充 Next-only Workbench Candidate Retrieval。Parser、90% threshold、5% ambiguity guard、Wanrong priority、ERP Provider／Schema、Catalog Production 與 Production 均未修改。

## Retrieval sequence

```text
Primary high-information queries (limit=5)
→ 全部 raw 0
→ Compound Member queries (每 member limit=5)
→ 任一 raw hit 即停止 fallback
→ 仍全部 raw 0
→ 單次 Family Stem fallback (limit=12)
```

- Member 與 Family 查詢只從 Parser v2.1 的 explicit `COMPOUND_SUBJECT` 產生。
- Family stem 必須由至少兩個 member 的共同 CJK prefix 產生，至少 2 字，且每商品最多一次。
- `PLA`、`PVC`、`無比例`、`限定`、`組裝模型`、`&` 等泛用詞永遠不能成為 Family query。
- Member／Family 取得的候選只作 YELLOW 人工 Review；只有原有 Verified Mapping／Exact JAN／Exact Source ID／Exact Model Code／Import Direct Binding 能成為 GREEN。
- Product Line、Product Type、Version、Scale、Model Code 與 Compound Set safety conflict 仍會 fail-closed。
- `NO_CANDIDATE` 表示所有允許的 raw query 都是 0；`RETRIEVED_BUT_REJECTED` 表示 Catalog 有回傳候選，但全部被安全規則排除。UI 已分別顯示原因。

## SMP runtime evidence

來源：`代理版 魂商店 限定 萬代 盒玩 百獸戰隊 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王`

| Stage | Query | Limit | Raw result |
| --- | --- | ---: | --- |
| Primary | `SMP 牙吠孔雀王 牙吠眼鏡蛇王` | 5 | 0 |
| Primary | `牙吠孔雀王 牙吠眼鏡蛇王` | 5 | 0 |
| Member | `牙吠孔雀` | 5 | 正確商品 Native #1 |
| Member | `牙吠眼鏡蛇` | 5 | 同一正確商品 Native #1 |
| Family | `牙吠` | 12 | **未執行** |

去重後 Top 3 只有：`SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠孔雀＆牙吠眼鏡蛇`，Supplier `wanrong`，JAN `4570117926228`，raw deadline `2026-09-07T08:00:00.000Z`，建議 ERP date `2026-09-05`。4192 顯示 YELLOW／UNVERIFIED，未自動選取、未 Apply。

另外驗證：

- `牙吠袋鼠` 原生搜尋正確商品 Native #1。
- 模擬兩個 member 均 0 時，才執行 `牙吠&limit=12`；正確 Native #11 仍可進人工 Candidate，不相關 Native #3 被 Safety Filter 排除。
- Omaneko 不產生 Member／Family 垃圾候選，維持 RED／NO_CANDIDATE。

## Performance and safety

固定 fixture、不是 Catalog Production 壓測：

| Items | Cold total | Cold upstream | Warm total | Warm upstream |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 159.6 ms | 40 | 10.2 ms | 0 |
| 50 | 165.3 ms | 40 | 62.8 ms | 0 |
| 100 | 221.2 ms | 40 | 105.5 ms | 0 |

- 隔離 Catalog Hotfix Preview correctness probe：PASS。
- 真正 `http://127.0.0.1:4192/purchase-records` Runtime Review：PASS；SMP 從 RED／NO_CANDIDATE 變為 YELLOW，Omaneko 仍 RED。
- Analysis ProductGroup write：0；只新增既有 Next Sidecar analysis rows。
- Production Supabase request：0；Production IndexedDB 未變。
- Next integrity：559 Groups、2438 Variants、全部 collection hash、Golden VSPO 與 orphan counts 不變。
- Push：NO；Deploy：NO。

## Automated gates

- `npm run build:next`
- `npm run test:closing-date-candidate-retrieval-v2`
- `npm run benchmark:closing-date-candidate-retrieval-v2-live`
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

本節點尚未 Manual Accepted，也不是 Production Candidate／Production Ready。
