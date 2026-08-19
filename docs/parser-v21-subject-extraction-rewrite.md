# Parser v2.1 Subject Extraction Rewrite

Status: **Implemented + Automated Tested / Awaiting Manual Acceptance**

Scope: **Next Sandbox only, Shadow diagnostic only**

## Safety boundary

Parser v2.1 does not participate in Matching, query planning, scoring,
candidate selection, supplier selection, deadline resolution, or
`closing_date` writes. The existing v1/v2 runtime behavior remains frozen.

The v2.1 Subject extractor has no generic final-token or final-CJK-token
fallback. A Subject is emitted only when one of these explicit evidence paths
applies:

- known product-line title grammar;
- role-delimited Subject;
- supported multi-token personal-name shape;
- complete compound-subject set.

If none applies, the result is:

```text
subjects=[]
subjectResolution=UNRESOLVED_SUBJECT
```

Residual text remains diagnostic evidence only and cannot become Subject.

## Golden cases

| Case | Expected v2.1 Subject | Other required metadata |
| --- | --- | --- |
| 核金重構 索菲亞 F 希琳 碧藍兔子 | 索菲亞 F 希琳 | 碧藍兔子 remains Form; 包膠可動 is ACTION_FIGURE |
| KDcolle 零之使魔 露易絲 20th 20週年紀念版 約23公分 | 露易絲 | Series=零之使魔; Version=20th/20週年紀念版; Dimension=約23公分 |
| KDcolle 灼眼的夏娜 夏娜 原作版 | 夏娜 | Series=灼眼的夏娜; Version=原作版 |
| KDcolle／KADOKAWA PLASTIC MODEL 狼與辛香料 赫蘿 | 赫蘿 | Product line, series, and version remain separate |
| PLAMATEA 瑪修·基利艾拉特（奧特瑙斯）Black Barrel Ver. | 瑪修·基利艾拉特 | Form=奧特瑙斯; Version=Black Barrel Ver. |

Unknown title structures must return `UNRESOLVED_SUBJECT`; guessing a final
token is explicitly forbidden.

## Non-goals

- no Alias or Identifier Registry;
- no character-specific hardcode;
- no Matching rule, threshold, ambiguity-guard, or Supplier Priority change;
- no Query Planner or candidate-pool change;
- no schema, Provider, or database change;
- no Production integration.

Legacy Parser v2 remains frozen only because the current Matcher still depends
on it. Replacing that runtime input requires a separately approved integration
and manual field-test stage.

## Automated gates

- dedicated Parser v2.1 Golden and unresolved-subject regression;
- existing Parser v2, Shadow, Query, and Matching Pilot regressions;
- 44-case closing-date decision invariance;
- Next build, core, Sandbox guard, and Sandbox architecture;
- Production Supabase request 0 and unexpected ERP write 0 in parser tests.
