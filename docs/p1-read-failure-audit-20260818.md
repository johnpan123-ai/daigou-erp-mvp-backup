# P1 Read-Failure Audit — Next Sandbox

建立時間：2026-08-18（Asia/Taipei）  
範圍：`codex/next-sandbox`；只分析，不修改業務資料與核心同步契約。

## 分級原則

- **P0**：讀取失敗可能直接導致破壞性寫入、關聯遺失或正式資料污染。
- **P1**：讀取失敗會讓畫面／ViewModel 進入錯誤狀態，或後續操作可能使用不完整資料。
- **P2**：只影響提示、備份程式或低風險 UX。

## 發現

| 等級 | 位置 | 目前行為 | 風險 | 建議最小修法 | 本輪處理 |
| --- | --- | --- | --- | --- | --- |
| P0（既有、已止血） | `src/lib/db.ts` `get()` 與 `syncProductGroupsWithInventory()` | IndexedDB 讀取錯誤可能 fallback 成 localStorage／空陣列；P0-G guard 已在 sync 前做嚴格 readonly probe | 已證實曾可造成 Variant 重建、WACA／FK 風險 | 所有會進入破壞性 sync 的 Variant source 都採 Read Failure／Verified Empty 分流；保留 sanity gate | P0-G Accepted；未再擴大修正 |
| P1 | `src/pages/Purchasing.tsx:309-317` | 多個 read promise 使用 `.catch(() => [])`，仍寫入 state 並顯示結果 | 讀取失敗會偽裝成沒有需求／沒有採購，後續操作可能建立錯誤判斷 | 回傳 typed load error；保留上一份資料；Loading／Empty／Error 分離 | 只分析 |
| P1 | `src/pages/JapanPackageDetail.tsx:477-482` | 群組、Variant、批次、套組讀取失敗變成空集合 | 套組候選、包裹匯入或顯示可能不完整；若使用者接著儲存，風險高於單純 UI | 任一必要集合失敗即進 Error state；不以空陣列繼續可寫流程 | 只分析 |
| P1 | `src/pages/PurchaseManagement.tsx:1139` | Bundle component read failure fallback `[]` | 套組顯示／設定可能被誤認為沒有內容 | 明確顯示讀取錯誤並停用相依操作 | 只分析 |
| P1 | `src/pages/PurchaseRecords.tsx` fresh load effect | fresh load rejection 未在 effect 邊界統一捕捉；可能保留舊畫面但沒有 Error state | 使用者看不到刷新失敗，可能在 stale data 上繼續操作 | effect boundary catch + retry + stale badge；保留現有數值與公式 | 只分析 |
| P1 | `src/lib/db.ts:2195-2240` | read error fallback 到 localStorage／default；write error fallback 到 localStorage | IndexedDB 與 localStorage 可能分裂，錯誤被當成空資料 | 先建立 typed storage failure；禁止破壞性流程消費 fallback 空值 | 只分析，需另開 db.ts stage |
| P1 | `src/providers/cloud/supabaseProvider.ts:2246` 後續 `getProductVariants({ recalc: true })` | sync 成功後的後續 read 仍使用一般讀取契約 | 若後續 read failure 被 fallback，可能把不完整 Variant 集合送回 Cloud | Cloud provider 另做 read-failure fail-closed audit；不得以本輪 UI 修補 | 只分析 |
| P2 | `src/pages/Dashboard_backup.tsx:28-34` | legacy/backup route 的 read fallback | 非 active route；維護者可能誤用 | 移除或標示 legacy，不混入資料安全修正 | 只分析 |
| P2 | Dashboard image fire-and-forget | `void save...catch(...)` 有 rejection handler，失敗保留舊圖 | 主要是可觀測性，不是已證實資料破壞 | 顯示非阻塞 warning／retry | 只分析 |

## 結論

本輪沒有對上述風險做自動修正。P0-G 已由 strict probe 與 fault injection 止血；其餘 P1 仍需逐項設計與人工驗收，尤其不得把 `[]` fallback 直接改成會改變既有業務公式的替代值。
