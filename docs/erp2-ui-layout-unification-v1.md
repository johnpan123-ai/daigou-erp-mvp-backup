# ERP 2.0 UI layout unification v1

## Baseline and recovery

- Latest remote-proven accepted baseline: `e565d067f49c95cf71dd6c95c5fab5b4749558f8`.
- Recovery tag: `backup-20260927-before-erp2-ui-layout-unification-v1`, remotely verified at that accepted SHA before source edits.
- Live runtime: `68269ad9e80762c07d64fde38194a56e3db69e1f`, deployment `ce6b0083-d0d7-412c-85dc-32d5be4b8ebb`. Its clipboard live readback acceptance remains incomplete; this task does not promote its acceptance status.
- Implementation parent: `151fe2fd1fd07ec168affa72c7a27ee785c38fb6`, preserving the Quick Wins runtime and the subsequent accepted-lineage deployment guard.

## Layout inventory

The application adds 32px horizontal padding, while several pages add another 16–32px. Page limits differ: Dashboard 1420px, Recent Purchases 1500px, Japan Packages 1800px, Outbound 900px, Duplicate Variants 1100px. Purchasing has a full-width outer container but a 760px inner list. Inventory and Unlisted Items already allow full width. Japan's empty state uses a centered 540px panel and 40px outer margin. These are presentation constraints, independent of data and workflow state.

The shared layout will own page padding once, with full-width content, reusable header/toolbar/stats/content shells, and bounded empty-state spacing. Existing data selectors, handlers, providers and request contracts stay intact.
