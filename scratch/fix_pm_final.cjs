const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'src', 'pages', 'PurchaseManagement.tsx');
if (!fs.existsSync(targetFile)) {
  console.error("File not found: " + targetFile);
  process.exit(1);
}

let content = fs.readFileSync(targetFile, 'utf8');

// Normalize line endings to LF to avoid CRLF mismatch in Windows
content = content.replace(/\r\n/g, '\n');

// 1. Insert State & Update handler
const stateInsertionMarker = "const [categoryMap, setCategoryMap] = useState<Map<string, ProductCategory>>(new Map());";
const stateCode = `

  const [variantDefaultJpyCosts, setVariantDefaultJpyCosts] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem('variant_default_jpy_costs');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  });

  const handleUpdateDefaultJpyCost = (variantId: string, valStr: string) => {
    const val = valStr === '' ? null : parseInt(valStr);
    const updated = { ...variantDefaultJpyCosts };
    if (val === null || isNaN(val) || val <= 0) {
      delete updated[variantId];
    } else {
      updated[variantId] = val;
    }
    setVariantDefaultJpyCosts(updated);
    localStorage.setItem('variant_default_jpy_costs', JSON.stringify(updated));
  };`;

if (!content.includes(stateInsertionMarker)) {
  console.error("Could not find categories map state marker for insertion.");
  process.exit(1);
}

content = content.replace(stateInsertionMarker, stateInsertionMarker + stateCode);

// 2. Modify JPY top card formula (activeCost logic)
const oldKpiLogic = `    const latestCost = getLatestJpyCost(v.id);
    jpyNeedToBuy += needToBuy * (latestCost || 0);`;

const newKpiLogic = `    const defaultCost = variantDefaultJpyCosts[v.id];
    const latestCost = getLatestJpyCost(v.id);
    const activeCost = (defaultCost !== undefined && defaultCost !== null) ? defaultCost : (latestCost || 0);
    jpyNeedToBuy += needToBuy * activeCost;`;

if (!content.includes(oldKpiLogic)) {
  console.error("Could not find old KPI active JPY cost calculation.");
  process.exit(1);
}
content = content.replace(oldKpiLogic, newKpiLogic);

// 3. Modify openBatchModal cost prefill
const oldModalPrefill = `    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
    setBatchLines(variants.map(v => ({ variant_id: v.id, quantity: 0, cost: 0, note: '' })));`;

const newModalPrefill = `    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
    setBatchLines(variants.map(v => {
      const defCost = variantDefaultJpyCosts[v.id];
      const latCost = getLatestJpyCost(v.id);
      const initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);
      return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };
    }));`;

if (!content.includes(oldModalPrefill)) {
  console.error("Could not find old openBatchModal prefill lines.");
  process.exit(1);
}
content = content.replace(oldModalPrefill, newModalPrefill);

// 4. Modify Single Item price rendering in Edit Mode and Locked Mode
const oldSinglePriceRender = `<td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                            {getLatestJpyCost(v.id) !== null ? \`¥ \${getLatestJpyCost(v.id)}\` : '-'}
                          </td>`;

const newSinglePriceRender = `<td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                            {editMode ? (
                              <input
                                type="number"
                                min="0"
                                placeholder="-"
                                style={{
                                  width: '80px',
                                  height: '28px',
                                  textAlign: 'right',
                                  border: '1px solid #cbd5e1',
                                  borderRadius: '4px',
                                  fontSize: '14px',
                                  fontWeight: 600,
                                  color: '#1E293B',
                                  backgroundColor: '#ffffff',
                                  padding: '0 8px',
                                  margin: '0 0 0 auto',
                                  display: 'block'
                                }}
                                value={variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : ''}
                                onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}
                              />
                            ) : (
                              (() => {
                                const defCost = variantDefaultJpyCosts[v.id];
                                if (defCost !== undefined && defCost !== null) {
                                  return \`¥ \${defCost}\`;
                                }
                                const latCost = getLatestJpyCost(v.id);
                                if (latCost !== null) {
                                  return \`¥ \${latCost}\`;
                                }
                                return '-';
                              })()
                            )}
                          </td>`;

if (!content.includes(oldSinglePriceRender)) {
  console.error("Could not find old Single Item price rendering.");
  process.exit(1);
}
content = content.replace(oldSinglePriceRender, newSinglePriceRender);

// 5. Modify Category Card rows price rendering in Edit Mode and Locked Mode
const oldCatRowPriceRender = `<td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                    {getLatestJpyCost(v.id) !== null ? \`¥ \${getLatestJpyCost(v.id)}\` : '-'}
                                  </td>`;

const newCatRowPriceRender = `<td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                    {editMode ? (
                                      <input
                                        type="number"
                                        min="0"
                                        placeholder="-"
                                        style={{
                                          width: '80px',
                                          height: '28px',
                                          textAlign: 'right',
                                          border: '1px solid #cbd5e1',
                                          borderRadius: '4px',
                                          fontSize: '14px',
                                          fontWeight: 600,
                                          color: '#1E293B',
                                          backgroundColor: '#ffffff',
                                          padding: '0 8px',
                                          margin: '0 0 0 auto',
                                          display: 'block'
                                        }}
                                        value={variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : ''}
                                        onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}
                                      />
                                    ) : (
                                      (() => {
                                        const defCost = variantDefaultJpyCosts[v.id];
                                        if (defCost !== undefined && defCost !== null) {
                                          return \`¥ \${defCost}\`;
                                        }
                                        const latCost = getLatestJpyCost(v.id);
                                        if (latCost !== null) {
                                          return \`¥ \${latCost}\`;
                                        }
                                        return '-';
                                      })()
                                    )}
                                  </td>`;

if (!content.includes(oldCatRowPriceRender)) {
  console.error("Could not find old Category Card row price rendering.");
  process.exit(1);
}
content = content.replace(oldCatRowPriceRender, newCatRowPriceRender);

fs.writeFileSync(targetFile, content, 'utf8');
console.log("PurchaseManagement.tsx was successfully modified and default JPY prices features are applied.");
