# Closing Date Lookup v2 Development

Status: **Closing Date Lookup v2 Development / Confirmed Version False Positive Blocker**

## Field-test correction: P21-11

The earlier fixed-set probe was not broad enough to establish zero false
positives. Real Field Test later confirmed that v1 treated the PLAMATEA standard
product as the same identity as `Black Barrel Edition`, then returned before v2
could inspect the explicit candidate-only version. That path could write the
wrong deadline.

The current Next-only mitigation lets Parser v2 veto a v1 MATCH only when all of
the following are true:

- both titles have the same explicit Product Line;
- Product Type and Form do not conflict when both are known;
- the parsed subject family has an exact overlap; and
- exactly one side carries an identity-bearing version such as Black Barrel or
  DX (default/standard and re-release labels do not trigger this veto).

The veto cannot create a MATCH, change the 90% threshold, change the 5%
ambiguity guard, or override Supplier Priority. The status remains a blocker
until the visible Next flow is manually accepted.

Scope is Next Sandbox only. Production, Production Supabase, schema, the 90%
threshold, 5% ambiguity guard, Wanrong priority, and the existing two-day closing
date offset were not changed.

## Before / After

The historical fixed real-runtime set contains nine cases: five safely
decidable cases and four intentionally unresolved cases. P21-11 was outside
that set and supersedes its earlier global zero-false-positive assumption.

| Metric | Before | After |
| --- | ---: | ---: |
| Confirmed correct automatic matches | 5 at the existing `b852f42` Pilot path | 5, now covered by a repeatable real-4192 probe |
| Confirmed false positives | 0 | 0 |
| Safe reject / unresolved | 4 | 4 |
| NOT_FOUND / safe no-match | 4 | 4 |
| AMBIGUOUS | 0 | 0 |

The historical 44-case offline evaluation remains unchanged: six fixed Golden
PASS, two known failures already fixed, 22 OBSERVE MATCH, one OBSERVE AMBIGUOUS,
13 OBSERVE NOT_FOUND, and zero regressions.

The five Golden decisions were already achievable through the Pilot plus broad
v1 retrieval queries. This change does not claim an artificial match-rate gain;
it adds the missing bounded v2-owned retrieval path, records the exact runtime
queries, and turns the real 4192 checks into a repeatable safety gate. In this
fixed set, only unresolved cases needed an additional v2 query.

## Real 4192 Results

| ERP | Runtime query that supplied the usable pool | Selected Catalog | Decision | Raw deadline | ERP closing date |
| --- | --- | --- | --- | --- | --- |
| KDcolle 狼與辛香料 原作版 赫蘿 | `赫蘿` fallback was present in the progressive pool | 《狼與辛香料》赫蘿 原作版 無比例模型 | `V2_PILOT` / Wanrong | 2026-09-18 | 2026-09-16 |
| KDcolle 灼眼的夏娜 夏娜 原作版 | `夏娜` subject fallback | 《灼眼的夏娜》夏娜 原作版 無比例模型 | `V2_PILOT` / Wanrong | 2026-09-18 | 2026-09-16 |
| KADOKAWA PLASTIC MODEL 赫蘿 DX | `赫蘿` subject fallback | KADOKAWA PLASTIC MODEL SERIES《狼與辛香料》赫蘿 DX Ver. | `V2_PILOT` / Wanrong | 2026-09-07 | 2026-09-05 |
| APEX 1/7 絕區零 儀玄 獨步滄溟 Ver. | `絕區零 儀玄` / `儀玄` candidate pool | 1/7 PVC 絕區零 儀玄·獨步滄溟 Ver. | `V2_PILOT` / Dreamlink | 2026-10-11 | 2026-10-09 |
| 超像可動 空條承太郎 Ver. 2 | `空條承太郎` subject fallback | 超像可動《JOJO 星塵遠征軍》空條承太郎ver.2 | `V2_PILOT` / Dreamlink | 2026-09-20 | 2026-09-18 |

## Deliberate Safe Rejects

- Star Platinum: ERP has no `3rd`, while Catalog listings carry a version. The
  candidate-only version is not silently accepted.
- TAKARATOMY 大福箱27: `戰鬥鳳凰號豪華套組` and `大福箱27` still lack verified
  identity-equivalence evidence.
- Special SMP set: the ERP and Catalog compound-member sets differ; no product-set
  alias is inferred.
- Omaneko: retrieval can return candidates, but current evidence does not prove
  the same product identity.

## Request Bound

The nine-case real probe executed 43 unique v1 requests and 53 unique requests
with the bounded v2 fallback: +10 requests, all confined to unresolved paths.
The v2 plan is deduplicated and capped at five; matching stops earlier when a
safe v1 result or a preferred Wanrong v2 result is available. No additional
Catalog request is made for Parser v2 shadow parsing itself.

## Regression and Safety

- `build:next`: PASS, TypeScript 0 errors.
- Parser v1/v2, v2 Query Planner, v2 Pilot, 44-case evaluation: PASS.
- Core regression: PASS; Golden business totals unchanged.
- Sandbox guard and architecture: PASS.
- Product Type conflicts, Product Line conflicts, subject conflicts, version
  conflicts, and different compound sets remain rejected.
- Production Supabase requests: 0.
- Production writes: 0.
- Unexpected Next DB writes: 0; the runtime probe was Catalog-read-only.

Human acceptance must still verify the same products from the visible Next UI.
