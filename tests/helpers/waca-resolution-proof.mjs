// Independent, exhaustive test oracle. It never calls the resolver or its indexes.
// Production indexes remain O(Catalog + rows); this slower audit is fixture-only.
export function catalogProofOracle(master, names, normalize, rows = []) {
  const active = master.filter(v => v.active && v.variantId && v.productGroupId);
  const unique = values => [...new Map(values.map(v => [v.variantId, v])).values()];
  const groups = values => [...new Set(values.map(v => v.productGroupId))];
  const specMatches = (row, v) => names.wacaSourceSpecKeys(row.spec1, row.spec2)
    .some(key => [v.variantTitle, ...(v.variantTitles ?? [])].some(s => names.wacaSpecKey(s) === key));
  const within = (row, values, oneGroup) => {
    const parentIds = groups(values), withSpec = names.wacaSourceSpecKeys(row.spec1, row.spec2).length > 0;
    const candidates = unique(withSpec ? values.filter(v => specMatches(row, v)) : values);
    const permitted = (!oneGroup || parentIds.length === 1) && candidates.length === 1
      && (withSpec || (parentIds.length === 1 && unique(active.filter(v => v.productGroupId === parentIds[0])).length === 1));
    return { permitted, candidates, parents: parentIds };
  };
  const independent = row => {
    const sku = normalize(row.specCode);
    if (sku) { const candidates = unique(active.filter(v => normalize(v.childCode) === sku));
      return { permitted: candidates.length === 1, candidates, parents: groups(candidates), path: 'SKU' }; }
    if (!normalize(row.productCode) || !names.wacaProductKey(row.productTitle)) return { permitted: false, candidates: [], parents: [] };
    for (const [key, oneGroup, path] of [[names.wacaProductKey, false, 'PRODUCT'], [names.wacaAliasKey, true, 'ALIAS'], [names.wacaProductTokens, true, 'TOKENS']]) {
      const bucket = active.filter(v => key(v.productTitle) === key(row.productTitle));
      if (bucket.length) return { ...within(row, bucket, oneGroup), path };
    }
    return { permitted: false, candidates: [], parents: [] };
  };
  const learned = new Map();
  for (const row of rows) {
    const proof = independent(row);
    if (proof.permitted && proof.parents.length === 1) {
      const set = learned.get(normalize(row.productCode)) ?? new Set();
      set.add(proof.parents[0]); learned.set(normalize(row.productCode), set);
    }
  }
  return row => {
    if (normalize(row.specCode)) return independent(row);
    const strong = learned.get(normalize(row.productCode)) ?? new Set();
    const anchors = active.filter(v => normalize(v.mainCode) === normalize(row.productCode)
      || normalize(v.childCode) === normalize(row.productCode));
    const parentIds = [...new Set([...groups(anchors), ...strong])];
    if (!parentIds.length) return independent(row);
    if (parentIds.length !== 1) return { permitted: false, candidates: [], parents: parentIds, path: 'CONFLICT' };
    const parent = active.filter(v => v.productGroupId === parentIds[0]);
    const knownNames = active.filter(v => names.wacaProductKey(v.productTitle) === names.wacaProductKey(row.productTitle));
    if (strong.size && knownNames.length && !groups(knownNames).includes(parentIds[0]))
      return { permitted: false, candidates: [], parents: parentIds, path: 'CONFLICT' };
    const text = value => normalize(value).replace(/[\s、,，。・·]+/gu, '');
    const consistent = parent.some(v => text(v.productTitle).includes(text(row.productTitle)) || text(row.productTitle).includes(text(v.productTitle)));
    const global = independent(row);
    const noKnownName = !knownNames.length && !active.some(v => names.wacaAliasKey(v.productTitle) === names.wacaAliasKey(row.productTitle));
    if (!consistent && !(strong.size && noKnownName)) return global;
    return { ...within(row, parent, true), path: 'PARENT' };
  };
}
