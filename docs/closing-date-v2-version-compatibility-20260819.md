# Closing Date v2 Version Compatibility

Status: **Fixed + Automated Tested / Awaiting Human Field Test**

Implementation commit: `510b24dc8f57730724ea194a94018bf1f1996c21`

## Scope

Matching v2 Pilot now treats the source default-version labels `一般版`, `普通版`,
`通常版`, `Standard`, and `Standard Ver.` as compatible with a candidate that
omits its version only when all safety evidence is present:

- exact subject;
- no product-type or product-line conflict;
- exact product type or exact product line;
- reliable series overlap.

The compatibility evidence is recorded as `VERSION_DEFAULT_COMPATIBLE` and adds
only 5% confidence. It cannot independently make a candidate cross the existing
90% threshold. Explicit versions such as `DX Ver.`, numbered versions, original
versions, and limited editions are not covered by this compatibility rule.

## Runtime result

The production-equivalent 4192 read-only Catalog probe resolved:

- ERP: `代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 一般版`
- Catalog: `KADOKAWA PLASTIC MODEL SERIES《狼與辛香料 MERCHANT MEETS THE WISE WOLF》赫蘿`
- Decision source: `V2_PILOT`
- Supplier: `wanrong`
- Confidence: `90%`
- Raw deadline: `2026-09-07`
- Suggested ERP closing date: `2026-09-05`

No ERP record was written by the probe.

## Safety regression

- default version vs explicit DX: rejected;
- DX source vs candidate missing version: rejected;
- different subject with the same default label: rejected;
- 44-case v1 decisions unchanged;
- Wanrong priority, 90% threshold, 5% ambiguity guard, and the existing two-day
  rule unchanged;
- real 4192 probe false positives: 0;
- Production Supabase request: 0;
- DB write operation during runtime probe: 0.

## Diagnostics

Next runtime diagnostics now distinguish `V1`, `V2_PILOT`,
`NO_MATCH_V1_ONLY`, and `NO_MATCH_AFTER_V2`. When v2 runs but rejects all
candidates, the panel reports `V2 attempted: YES` and the strongest rejection
reason.

