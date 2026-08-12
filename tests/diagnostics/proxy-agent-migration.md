# 舊代理商 migration 唯讀診斷

## 啟動時是否仍會讀取

會。`PurchaseRecords.loadFreshData()` 每次載入 fresh groups 後仍讀取：

```ts
localStorage.getItem('erp_proxy_agent_map')
```

## 寫回條件

同時符合以下條件時會寫回：

1. `erp_proxy_agent_map` 存在且是可解析 JSON。
2. map 內有目前 `group.id` 對應的代理商。
3. local map 的代理商和 fresh group 的 `proxy_agent` 不同。
4. `checkIsStaleLive()` 沒有判定本分頁資料過期。

寫回動作是：

```ts
await dataProvider.saveProductGroups(nextGroups)
```

成功後才會移除 `erp_proxy_agent_map`。

## 是否可能覆蓋 Supabase 最新值

會。流程先取得 fresh cloud groups，再以 localStorage 舊值建立 `nextGroups`。在 Cloud Mode，`saveProductGroups(nextGroups)` 會把這批舊代理商值重新寫回雲端。

跨分頁 stale guard 只能攔截「另一分頁剛寫過」的情境；它無法判斷 local map 的內容是否比 Supabase 舊。因此只要沒有 stale 旗標，舊 map 仍能覆蓋 fresh cloud 值。

## 隔離 Local 重現

固定 fixture 原值：

```text
g-proxy.proxy_agent = 鉅霖
```

測試預先放入：

```json
{"g-proxy":"萬榮"}
```

載入 PurchaseRecords 後結果：

- `item.id`／`group.id` 未變。
- `proxy_agent` 由鉅霖變成萬榮。
- migration key 在寫入成功後被刪除。
- 測試全程攔截 Supabase，沒有正式雲端寫入。
- 診斷結束後 fixture 完整還原。

結論：萬榮／鉅霖「跳回」的根因可穩定重現，並非使用者錯覺。
