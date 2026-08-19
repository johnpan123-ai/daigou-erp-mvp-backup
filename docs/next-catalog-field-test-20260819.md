# Next Catalog Closing-Date Field Test

## Status

**Implementation Passed / Awaiting Large-scale Manual Field Test**

This is a Next Sandbox-only validation node. It is not Production Ready and is not a Production deployment candidate yet.

Integrated behavior:

- Product Identity Matching v1: Product Type is retained as metadata and conflicting types fail closed.
- Identity matching is based on core identity tokens; missing series text does not reject an otherwise safe match.
- Size tokens such as `L Size`, `M Size`, and `XL Size` remain metadata and are not used as the identity by themselves.
- Identity ambiguity keeps the existing 5% guard and performs zero writes.
- Same-product supplier listings are selected separately from product identity; the current default proxy priority is Wanrong.
- Raw catalog deadline is shown separately from the final ERP closing date. The existing proxy `-2 days` rule remains unchanged.
- Catalog API failures fail closed before any closing-date write.

## Manual test entry

1. Open `http://127.0.0.1:4192/` and enter Purchase Records.
2. Switch to edit mode if the auto-lookup action is hidden.
3. Select only the products under test.
4. Click `🔍 自動查詢結單日`.
5. Review the `最近一次結單日查詢診斷` panel before starting the next sample.
6. Confirm the ERP title, decision, Product Type, identity, series, size, manufacturer, selected catalog title, supplier, raw deadline, and final ERP closing date.

The panel is React state only. It does not create fields, modify catalog data, or replace the existing save path.

## Golden samples

| Sample | Expected decision | Expected supplier | Raw deadline | Expected ERP date | Negative condition |
| --- | --- | --- | --- | --- | --- |
| `代理版 figma 地獄征服者 Helltaker 路西法` → `figma 路西法` | MATCH | source listing | `2026-09-18` | `2026-09-16` | Do not match a different Product Type |
| `代理版 GSC POP UP PARADE 魔法少女的魔女審判 橘雪莉 L Size` → `POP UP PARADE 橘雪莉 L Size` | MATCH | source listing | `2026-09-18` | `2026-09-16` | Different PUP characters must not score as the identity |
| `代理版 GSC 黏土人 3121 BanG Dream! 夢限大MewType 峰月律` | MATCH | `wanrong` | `2026-09-07` | `2026-09-05` | Same identity Dreamlink listing must not win over Wanrong |
| GSC NENDOROID vs a `1/7` candidate | REJECT / NOT_FOUND | — | — | no write | Product Type conflict |
| PUP vs NENDOROID | REJECT / NOT_FOUND | — | — | no write | Product Type conflict |
| Same type, different character | NOT_FOUND / no safe match | — | — | no write | Identity conflict |

## Regression log protocol

For every real-world sample, record:

- test time (Asia/Taipei)
- group id and original ERP title
- source (`proxy`, `hololive`, or `vspo`)
- decision (`MATCH`, `AMBIGUOUS`, `NOT_FOUND`, or `SERVICE_ERROR`)
- selected catalog title and URL if shown
- Product Type, identity, series, size, manufacturer
- supplier and raw deadline
- final ERP closing date
- whether the group was actually changed
- whether F5 preserved the result
- whether the result was correct, false positive, false negative, or business-rule review

Do not add a character-specific workaround. Promote a sample to a shared regression test only after its general matching rule is understood.

## Safety gates

- Test Sandbox / Next DB only.
- Production Supabase request must remain 0 during the field test.
- No batch closing-date recalculation is allowed during diagnosis.
- `AMBIGUOUS`, `NOT_FOUND`, `SERVICE_ERROR`, and hard identity conflicts must not write a closing date.
- `Production Ready` must not be marked from this document; manual field evidence is still pending.

