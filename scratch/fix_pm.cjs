const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/pages/PurchaseManagement.tsx');
if (!fs.existsSync(filePath)) {
  console.error("Error: PurchaseManagement.tsx not found at", filePath);
  process.exit(1);
}

let content = fs.readFileSync(filePath, 'utf-8');

// Normalize line endings to \n for consistent replacement
const originalLineEndings = content.includes('\r\n') ? '\r\n' : '\n';
content = content.split('\r\n').join('\n');

function logReplace(desc, target, replacement) {
  if (content.includes(target)) {
    content = content.split(target).join(replacement);
    console.log("SUCCESS: " + desc);
  } else {
    console.warn("WARNING: Target not found for: " + desc);
  }
}

// 0. Define getDailiVariantModalName function in component
logReplace(
  "Define getDailiVariantModalName",
  "  const formatVariantOption = (v: ProductVariant) => {",
  "  const getDailiVariantModalName = (v: ProductVariant) => {\n" +
  "    let name = (v.variant_name || '').trim();\n" +
  "    if (!name || name === '單品' || name === '一箱') {\n" +
  "      name = cleanDailiTitle(group?.normalized_title || group?.title || '');\n" +
  "    }\n" +
  "    if (!name) {\n" +
  "      name = v.myacg_item_code || '';\n" +
  "    }\n" +
  "    return name;\n" +
  "  };\n\n" +
  "  const formatVariantOption = (v: ProductVariant) => {"
);

// 1. Refactor table layout in SINGLE ITEM RENDERING block
const oldSingleTable = "                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>\n" +
"                      <colgroup>\n" +
"                        <col style={{ width: '30%' }} />\n" +
"                        <col style={{ width: '11%' }} />\n" +
"                        <col style={{ width: '13%' }} />\n" +
"                        <col style={{ width: '11%' }} />\n" +
"                        <col style={{ width: '11%' }} />\n" +
"                        <col style={{ width: '12%' }} />\n" +
"                        <col style={{ width: '12%' }} />\n" +
"                      </colgroup>\n" +
"                      <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>\n" +
"                        <tr>\n" +
"                          <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>\n" +
"                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>{isDaili ? '成本' : '單價'}</th>\n" +
"                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>\n" +
"                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>\n" +
"                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>\n" +
"                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>\n" +
"                          <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>\n" +
"                        </tr>\n" +
"                      </thead>\n" +
"                      <tbody>\n" +
"                        <tr>\n" +
"                          <td style={{ padding: '10px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>\n" +
"                            <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={isDaili ? cleanDailiTitle(catTitle) : catTitle}>\n" +
"                              <HighlightText text={isDaili ? cleanDailiTitle(catTitle) : catTitle} highlight={searchTerm} />\n" +
"                            </div>\n" +
"                            <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>\n" +
"                              SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />\n" +
"                            </div>\n" +
"                          </td>\n" +
"                          <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>\n" +
"                            {editMode ? (\n" +
"                              <input\n" +
"                                type=\"number\"\n" +
"                                min=\"0\"\n" +
"                                placeholder=\"-\"\n" +
"                                style={{\n" +
"                                  width: '80px',\n" +
"                                  height: '28px',\n" +
"                                  textAlign: 'right',\n" +
"                                  border: '1px solid #cbd5e1',\n" +
"                                  borderRadius: '4px',\n" +
"                                  fontSize: '14px',\n" +
"                                  fontWeight: 600,\n" +
"                                  color: '#1E293B',\n" +
"                                  backgroundColor: '#ffffff',\n" +
"                                  padding: '0 8px',\n" +
"                                  margin: '0 0 0 auto',\n" +
"                                  display: 'block'\n" +
"                                }}\n" +
"                                value={\n" +
"                                  isDaili\n" +
"                                    ? (variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : '')\n" +
"                                    : (variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : '')\n" +
"                                }\n" +
"                                onChange={e => isDaili ? handleUpdateDefaultTwdCost(v.id, e.target.value) : handleUpdateDefaultJpyCost(v.id, e.target.value)}\n" +
"                              />\n" +
"                            ) : (\n" +
"                              (() => {\n" +
"                                if (isDaili) {\n" +
"                                  const defCost = variantDefaultTwdCosts[v.id];\n" +
"                                  if (defCost !== undefined && defCost !== null) {\n" +
"                                    return `NT$ ${defCost}`;\n" +
"                                  }\n" +
"                                  const latCost = getLatestJpyCost(v.id);\n" +
"                                  if (latCost !== null) {\n" +
"                                    return `NT$ ${latCost}`;\n" +
"                                  }\n" +
"                                  return '-';\n" +
"                                } else {\n" +
"                                  const defCost = variantDefaultJpyCosts[v.id];\n" +
"                                  if (defCost !== undefined && defCost !== null) {\n" +
"                                    return `¥ ${defCost}`;\n" +
"                                  }\n" +
"                                  const latCost = getLatestJpyCost(v.id);\n" +
"                                  if (latCost !== null) {\n" +
"                                    return `¥ ${latCost}`;\n" +
"                                  }\n" +
"                                  return '-';\n" +
"                                }\n" +
"                              })()\n" +
"                            )}\n" +
"                          </td>";

const newSingleTable = "                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>\n" +
"                      {isDaili ? (\n" +
"                        <>\n" +
"                          <colgroup>\n" +
"                            <col style={{ width: '28%' }} />\n" +
"                            <col style={{ width: '10%' }} />\n" +
"                            <col style={{ width: '10%' }} />\n" +
"                            <col style={{ width: '12%' }} />\n" +
"                            <col style={{ width: '10%' }} />\n" +
"                            <col style={{ width: '10%' }} />\n" +
"                            <col style={{ width: '10%' }} />\n" +
"                            <col style={{ width: '10%' }} />\n" +
"                          </colgroup>\n" +
"                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>\n" +
"                            <tr>\n" +
"                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>\n" +
"                            </tr>\n" +
"                          </thead>\n" +
"                        </>\n" +
"                      ) : (\n" +
"                        <>\n" +
"                          <colgroup>\n" +
"                            <col style={{ width: '30%' }} />\n" +
"                            <col style={{ width: '11%' }} />\n" +
"                            <col style={{ width: '13%' }} />\n" +
"                            <col style={{ width: '11%' }} />\n" +
"                            <col style={{ width: '11%' }} />\n" +
"                            <col style={{ width: '12%' }} />\n" +
"                            <col style={{ width: '12%' }} />\n" +
"                          </colgroup>\n" +
"                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>\n" +
"                            <tr>\n" +
"                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>\n" +
"                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>\n" +
"                            </tr>\n" +
"                          </thead>\n" +
"                        </>\n" +
"                      )}\n" +
"                      <tbody>\n" +
"                        <tr>\n" +
"                          <td style={{ padding: '10px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>\n" +
"                            <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={isDaili ? cleanDailiTitle(catTitle) : catTitle}>\n" +
"                              <HighlightText text={isDaili ? cleanDailiTitle(catTitle) : catTitle} highlight={searchTerm} />\n" +
"                            </div>\n" +
"                            <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>\n" +
"                              SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />\n" +
"                            </div>\n" +
"                          </td>\n" +
"                          {isDaili ? (\n" +
"                            <>\n" +
"                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#64748b' }}>\n" +
"                                NT$ {inventoryMap.get(v.myacg_item_code)?.final_price ?? '-'}\n" +
"                              </td>\n" +
"                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>\n" +
"                                {editMode ? (\n" +
"                                  <input\n" +
"                                    type=\"number\"\n" +
"                                    min=\"0\"\n" +
"                                    placeholder=\"-\"\n" +
"                                    style={{\n" +
"                                      width: '80px',\n" +
"                                      height: '28px',\n" +
"                                      textAlign: 'right',\n" +
"                                      border: '1px solid #cbd5e1',\n" +
"                                      borderRadius: '4px',\n" +
"                                      fontSize: '14px',\n" +
"                                      fontWeight: 600,\n" +
"                                      color: '#1E293B',\n" +
"                                      backgroundColor: '#ffffff',\n" +
"                                      padding: '0 8px',\n" +
"                                      margin: '0 0 0 auto',\n" +
"                                      display: 'block'\n" +
"                                    }}\n" +
"                                    value={variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : ''}\n" +
"                                    onChange={e => handleUpdateDefaultTwdCost(v.id, e.target.value)}\n" +
"                                  />\n" +
"                                ) : (\n" +
"                                  (() => {\n" +
"                                    const defCost = variantDefaultTwdCosts[v.id];\n" +
"                                    if (defCost !== undefined && defCost !== null) {\n" +
"                                      return \"NT$ \" + defCost;\n" +
"                                    }\n" +
"                                    const latCost = getLatestJpyCost(v.id);\n" +
"                                    if (latCost !== null) {\n" +
"                                      return \"NT$ \" + latCost;\n" +
"                                    }\n" +
"                                    return '-';\n" +
"                                  })()\n" +
"                                )}\n" +
"                              </td>\n" +
"                            </>\n" +
"                          ) : (\n" +
"                            <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>\n" +
"                              {editMode ? (\n" +
"                                <input\n" +
"                                  type=\"number\"\n" +
"                                  min=\"0\"\n" +
"                                  placeholder=\"-\"\n" +
"                                  style={{\n" +
"                                    width: '80px',\n" +
"                                    height: '28px',\n" +
"                                    textAlign: 'right',\n" +
"                                    border: '1px solid #cbd5e1',\n" +
"                                    borderRadius: '4px',\n" +
"                                    fontSize: '14px',\n" +
"                                    fontWeight: 600,\n" +
"                                    color: '#1E293B',\n" +
"                                    backgroundColor: '#ffffff',\n" +
"                                    padding: '0 8px',\n" +
"                                    margin: '0 0 0 auto',\n" +
"                                    display: 'block'\n" +
"                                  }}\n" +
"                                  value={variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : ''}\n" +
"                                  onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}\n" +
"                                />\n" +
"                              ) : (\n" +
"                                (() => {\n" +
"                                  const defCost = variantDefaultJpyCosts[v.id];\n" +
"                                  if (defCost !== undefined && defCost !== null) {\n" +
"                                    return \"¥ \" + defCost;\n" +
"                                  }\n" +
"                                  const latCost = getLatestJpyCost(v.id);\n" +
"                                  if (latCost !== null) {\n" +
"                                    return \"¥ \" + latCost;\n" +
"                                  }\n" +
"                                  return '-';\n" +
"                                })()\n" +
"                              )}\n" +
"                            </td>\n" +
"                          )}";

logReplace("Update single item worksheet table rendering", oldSingleTable, newSingleTable);


// 2. Refactor table layout in CATEGORY DETAIL rows block
const oldCategoryTable = "                  {/* Expanded SKU Table */}\n" +
"                  {isExpanded && (\n" +
"                    <div style={{ borderTop: '1px solid #f1f5f9' }}>\n" +
"                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>\n" +
"                        <colgroup>\n" +
"                          <col style={{ width: '30%' }} />\n" +
"                          <col style={{ width: '11%' }} />\n" +
"                          <col style={{ width: '13%' }} />\n" +
"                          <col style={{ width: '11%' }} />\n" +
"                          <col style={{ width: '11%' }} />\n" +
"                          <col style={{ width: '12%' }} />\n" +
"                          <col style={{ width: '12%' }} />\n" +
"                        </colgroup>\n" +
"                        <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>\n" +
"                          <tr>\n" +
"                            <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>\n" +
"                            <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>{isDaili ? '成本' : '單價'}</th>\n" +
"                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>\n" +
"                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>\n" +
"                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>\n" +
"                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>\n" +
"                            <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>\n" +
"                          </tr>\n" +
"                        </thead>\n" +
"                        <tbody>\n" +
"                          {(() => {\n" +
"                            const filteredList = groupItems.filter(v => {\n" +
"                              if (!searchTerm.trim()) return true;\n" +
"                              const lowerSearch = searchTerm.toLowerCase();\n" +
"                              return (\n" +
"                                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||\n" +
"                                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))\n" +
"                              );\n" +
"                            });\n" +
"                            \n" +
"                            return filteredList.map((v, i) => {\n" +
"                              \n" +
"                              \n" +
"                              \n" +
"                              const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);\n" +
"                              const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);\n" +
"                              \n" +
"                              const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);\n" +
"                              const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"          \n" +
"                              const totalDemand = myacgDemand + wacaDemand + privateDemand;\n" +
"      \n" +
"                              const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);\n" +
"                              const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"                              \n" +
"                              const needToBuy = Math.max(totalDemand - totalPurchased, 0);\n" +
"                              const excessBuy = Math.max(totalPurchased - totalDemand, 0);\n" +
"\n" +
"                              return (\n" +
"                                <tr key={v.id} style={{ borderBottom: i === filteredList.length - 1 ? 'none' : '1px solid #F1F5F9' }}>\n" +
"                                  <td style={{ padding: '12px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>\n" +
"                                    <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.variant_name}>\n" +
"                                      <HighlightText text={isDaili ? cleanDailiTitle(parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name) : (parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name)} highlight={searchTerm} />\n" +
"                                    </div>\n" +
"                                  <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>\n" +
"                                    SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />\n" +
"                                  </div>\n" +
"                                </td>\n" +
"                                <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>\n" +
"                                    {editMode ? (\n" +
"                                      <input\n" +
"                                        type=\"number\"\n" +
"                                        min=\"0\"\n" +
"                                        placeholder=\"-\"\n" +
"                                        style={{\n" +
"                                          width: '80px',\n" +
"                                          height: '28px',\n" +
"                                          textAlign: 'right',\n" +
"                                          border: '1px solid #cbd5e1',\n" +
"                                          borderRadius: '4px',\n" +
"                                          fontSize: '14px',\n" +
"                                          fontWeight: 600,\n" +
"                                          color: '#1E293B',\n" +
"                                          backgroundColor: '#ffffff',\n" +
"                                          padding: '0 8px',\n" +
"                                          margin: '0 0 0 auto',\n" +
"                                          display: 'block'\n" +
"                                        }}\n" +
"                                        value={\n" +
"                                          isDaili\n" +
"                                            ? (variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : '')\n" +
"                                            : (variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : '')\n" +
"                                        }\n" +
"                                        onChange={e => isDaili ? handleUpdateDefaultTwdCost(v.id, e.target.value) : handleUpdateDefaultJpyCost(v.id, e.target.value)}\n" +
"                                      />\n" +
"                                    ) : (\n" +
"                                      (() => {\n" +
"                                        if (isDaili) {\n" +
"                                          const defCost = variantDefaultTwdCosts[v.id];\n" +
"                                          if (defCost !== undefined && defCost !== null) {\n" +
"                                            return `NT$ ${defCost}`;\n" +
"                                          }\n" +
"                                          const latCost = getLatestJpyCost(v.id);\n" +
"                                          if (latCost !== null) {\n" +
"                                            return `NT$ ${latCost}`;\n" +
"                                          }\n" +
"                                          return '-';\n" +
"                                        } else {\n" +
"                                          const defCost = variantDefaultJpyCosts[v.id];\n" +
"                                          if (defCost !== undefined && defCost !== null) {\n" +
"                                            return `¥ ${defCost}`;\n" +
"                                          }\n" +
"                                          const latCost = getLatestJpyCost(v.id);\n" +
"                                          if (latCost !== null) {\n" +
"                                            return `¥ ${latCost}`;\n" +
"                                          }\n" +
"                                          return '-';\n" +
"                                        }\n" +
"                                      })()\n" +
"                                    )}\n" +
"                                  </td>";

const newCategoryTable = "                  {/* Expanded SKU Table */}\n" +
"                  {isExpanded && (\n" +
"                    <div style={{ borderTop: '1px solid #f1f5f9' }}>\n" +
"                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>\n" +
"                        {isDaili ? (\n" +
"                          <>\n" +
"                            <colgroup>\n" +
"                              <col style={{ width: '28%' }} />\n" +
"                              <col style={{ width: '10%' }} />\n" +
"                              <col style={{ width: '10%' }} />\n" +
"                              <col style={{ width: '12%' }} />\n" +
"                              <col style={{ width: '10%' }} />\n" +
"                              <col style={{ width: '10%' }} />\n" +
"                              <col style={{ width: '10%' }} />\n" +
"                              <col style={{ width: '10%' }} />\n" +
"                            </colgroup>\n" +
"                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>\n" +
"                              <tr>\n" +
"                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>\n" +
"                              </tr>\n" +
"                            </thead>\n" +
"                          </>\n" +
"                        ) : (\n" +
"                          <>\n" +
"                            <colgroup>\n" +
"                              <col style={{ width: '30%' }} />\n" +
"                              <col style={{ width: '11%' }} />\n" +
"                              <col style={{ width: '13%' }} />\n" +
"                              <col style={{ width: '11%' }} />\n" +
"                              <col style={{ width: '11%' }} />\n" +
"                              <col style={{ width: '12%' }} />\n" +
"                              <col style={{ width: '12%' }} />\n" +
"                            </colgroup>\n" +
"                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>\n" +
"                              <tr>\n" +
"                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>\n" +
"                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>\n" +
"                              </tr>\n" +
"                            </thead>\n" +
"                          </>\n" +
"                        )}\n" +
"                        <tbody>\n" +
"                          {(() => {\n" +
"                            const filteredList = groupItems.filter(v => {\n" +
"                              if (!searchTerm.trim()) return true;\n" +
"                              const lowerSearch = searchTerm.toLowerCase();\n" +
"                              return (\n" +
"                                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||\n" +
"                                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))\n" +
"                              );\n" +
"                            });\n" +
"                            \n" +
"                            return filteredList.map((v, i) => {\n" +
"                              const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);\n" +
"                              const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);\n" +
"                              \n" +
"                              const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);\n" +
"                              const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"          \n" +
"                              const totalDemand = myacgDemand + wacaDemand + privateDemand;\n" +
"      \n" +
"                              const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);\n" +
"                              const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"                              \n" +
"                              const needToBuy = Math.max(totalDemand - totalPurchased, 0);\n" +
"                              const excessBuy = Math.max(totalPurchased - totalDemand, 0);\n" +
"\n" +
"                              return (\n" +
"                                <tr key={v.id} style={{ borderBottom: i === filteredList.length - 1 ? 'none' : '1px solid #F1F5F9' }}>\n" +
"                                  <td style={{ padding: '12px 20px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>\n" +
"                                    <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.variant_name}>\n" +
"                                      <HighlightText text={isDaili ? cleanDailiTitle(parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name) : (parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name)} highlight={searchTerm} />\n" +
"                                    </div>\n" +
"                                    <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.myacg_item_code}>\n" +
"                                      SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />\n" +
"                                    </div>\n" +
"                                  </td>\n" +
"                                  {isDaili ? (\n" +
"                                    <>\n" +
"                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#64748b' }}>\n" +
"                                        NT$ {inventoryMap.get(v.myacg_item_code)?.final_price ?? '-'}\n" +
"                                      </td>\n" +
"                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>\n" +
"                                        {editMode ? (\n" +
"                                          <input\n" +
"                                            type=\"number\"\n" +
"                                            min=\"0\"\n" +
"                                            placeholder=\"-\"\n" +
"                                            style={{\n" +
"                                              width: '80px',\n" +
"                                              height: '28px',\n" +
"                                              textAlign: 'right',\n" +
"                                              border: '1px solid #cbd5e1',\n" +
"                                              borderRadius: '4px',\n" +
"                                              fontSize: '14px',\n" +
"                                              fontWeight: 600,\n" +
"                                              color: '#1E293B',\n" +
"                                              backgroundColor: '#ffffff',\n" +
"                                              padding: '0 8px',\n" +
"                                              margin: '0 0 0 auto',\n" +
"                                              display: 'block'\n" +
"                                            }}\n" +
"                                            value={variantDefaultTwdCosts[v.id] !== undefined ? variantDefaultTwdCosts[v.id] : ''}\n" +
"                                            onChange={e => handleUpdateDefaultTwdCost(v.id, e.target.value)}\n" +
"                                          />\n" +
"                                        ) : (\n" +
"                                          (() => {\n" +
"                                            const defCost = variantDefaultTwdCosts[v.id];\n" +
"                                            if (defCost !== undefined && defCost !== null) {\n" +
"                                              return \"NT$ \" + defCost;\n" +
"                                            }\n" +
"                                            const latCost = getLatestJpyCost(v.id);\n" +
"                                            if (latCost !== null) {\n" +
"                                              return \"NT$ \" + latCost;\n" +
"                                            }\n" +
"                                            return '-';\n" +
"                                          })()\n" +
"                                        )}\n" +
"                                      </td>\n" +
"                                    </>\n" +
"                                  ) : (\n" +
"                                    <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>\n" +
"                                      {editMode ? (\n" +
"                                        <input\n" +
"                                          type=\"number\"\n" +
"                                          min=\"0\"\n" +
"                                          placeholder=\"-\"\n" +
"                                          style={{\n" +
"                                            width: '80px',\n" +
"                                            height: '28px',\n" +
"                                            textAlign: 'right',\n" +
"                                            border: '1px solid #cbd5e1',\n" +
"                                            borderRadius: '4px',\n" +
"                                            fontSize: '14px',\n" +
"                                            fontWeight: 600,\n" +
"                                            color: '#1E293B',\n" +
"                                            backgroundColor: '#ffffff',\n" +
"                                            padding: '0 8px',\n" +
"                                            margin: '0 0 0 auto',\n" +
"                                            display: 'block'\n" +
"                                          }}\n" +
"                                          value={variantDefaultJpyCosts[v.id] !== undefined ? variantDefaultJpyCosts[v.id] : ''}\n" +
"                                          onChange={e => handleUpdateDefaultJpyCost(v.id, e.target.value)}\n" +
"                                        />\n" +
"                                      ) : (\n" +
"                                        (() => {\n" +
"                                          const defCost = variantDefaultJpyCosts[v.id];\n" +
"                                          if (defCost !== undefined && defCost !== null) {\n" +
"                                            return \"¥ \" + defCost;\n" +
"                                          }\n" +
"                                          const latCost = getLatestJpyCost(v.id);\n" +
"                                          if (latCost !== null) {\n" +
"                                            return \"¥ \" + latCost;\n" +
"                                          }\n" +
"                                          return '-';\n" +
"                                        })()\n" +
"                                      )}\n" +
"                                    </td>\n" +
"                                  )}";

logReplace("Update category items worksheet table rendering", oldCategoryTable, newCategoryTable);


// 3. Update openBatchModal initialCost logic
const oldBatchInitial = "    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });\n" +
"    setBatchLines(variants.map(v => {\n" +
"      let initialCost = 0;\n" +
"      if (isDaili) {\n" +
"        initialCost = variantDefaultTwdCosts[v.id] || 0;\n" +
"      } else {\n" +
"        const defCost = variantDefaultJpyCosts[v.id];\n" +
"        const latCost = getLatestJpyCost(v.id);\n" +
"        initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);\n" +
"      }\n" +
"      return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };\n" +
"    }));";

const newBatchInitial = "    setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });\n" +
"    setBatchLines(variants.map(v => {\n" +
"      let initialCost = 0;\n" +
"      if (isDaili) {\n" +
"        initialCost = variantDefaultTwdCosts[v.id] || getLatestJpyCost(v.id) || 0;\n" +
"      } else {\n" +
"        const defCost = variantDefaultJpyCosts[v.id];\n" +
"        const latCost = getLatestJpyCost(v.id);\n" +
"        initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);\n" +
"      }\n" +
"      return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };\n" +
"    }));";

logReplace("Update initialCost logic in openBatchModal", oldBatchInitial, newBatchInitial);


// 4. Update Batch Modal table rendering (columns layout, headers, fallbacks, and content)
const oldModalTable = "              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>\n" +
"                <thead>\n" +
"                  <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>\n" +
"                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>\n" +
"                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>\n" +
"                    <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '100px' }}>{isDaili ? '實支單價(台幣)' : '實支單價(日幣)'}</th>\n" +
"                  </tr>\n" +
"                </thead>\n" +
"                <tbody>\n" +
"                  {(() => {\n" +
"                    const rows: React.ReactNode[] = [];\n" +
"                    let hasAnyVisible = false;\n" +
"                    \n" +
"                    variants.forEach((v, idx) => {\n" +
"                      const shortage = getVariantShortageForModal(v);\n" +
"                      const isHidden = onlyShowShortage && shortage <= 0;\n" +
"                      if (isHidden) return;\n" +
"                      \n" +
"                      hasAnyVisible = true;\n" +
"                      rows.push(\n" +
"                        <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>\n" +
"                          <td style={{ padding: '8px' }}>\n" +
"                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '8px' }}>\n" +
"                              <span>{formatVariantOption(v)}</span>\n" +
"                              {shortage > 0 && (\n" +
"                                <span style={{\n" +
"                                  backgroundColor: '#FEE2E2',\n" +
"                                  color: '#DC2626',\n" +
"                                  border: '1px solid #fecaca',\n" +
"                                  padding: '2px 8px',\n" +
"                                  borderRadius: '4px',\n" +
"                                  fontSize: '12px',\n" +
"                                  fontWeight: 600,\n" +
"                                  whiteSpace: 'nowrap'\n" +
"                                }}>\n" +
"                                  缺 {shortage}\n" +
"                                </span>\n" +
"                              )}\n" +
"                              {shortage < 0 && (\n" +
"                                <span style={{\n" +
"                                  backgroundColor: '#EFF6FF',\n" +
"                                  color: '#2563EB',\n" +
"                                  border: '1px solid #bfdbfe',\n" +
"                                  padding: '2px 8px',\n" +
"                                  borderRadius: '4px',\n" +
"                                  fontSize: '12px',\n" +
"                                  fontWeight: 600,\n" +
"                                  whiteSpace: 'nowrap'\n" +
"                                }}>\n" +
"                                  多買 {Math.abs(shortage)}\n" +
"                                </span>\n" +
"                              )}\n" +
"                            </div>\n" +
"                          </td>\n" +
"                          <td style={{ padding: '8px', textAlign: 'center' }}>\n" +
"                            <input className=\"input\" type=\"number\" min=\"0\" value={batchLines[idx]?.quantity || ''} onChange={e => updateBatchLine(idx, 'quantity', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} />\n" +
"                          </td>\n" +
"                          <td style={{ padding: '8px', textAlign: 'right' }}>\n" +
"                            <input className=\"input\" type=\"number\" min=\"0\" value={batchLines[idx]?.cost || ''} onChange={e => updateBatchLine(idx, 'cost', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} />\n" +
"                          </td>\n" +
"                        </tr>\n" +
"                      );\n" +
"                    });";

const newModalTable = "              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>\n" +
"                <thead>\n" +
"                  <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>\n" +
"                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>\n" +
"                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>缺口</th>\n" +
"                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>\n" +
"                    <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '100px' }}>{isDaili ? '成本（台幣）' : '實支單價（日幣）'}</th>\n" +
"                  </tr>\n" +
"                </thead>\n" +
"                <tbody>\n" +
"                  {(() => {\n" +
"                    const rows = [];\n" +
"                    let hasAnyVisible = false;\n" +
"                    \n" +
"                    variants.forEach((v, idx) => {\n" +
"                      const shortage = getVariantShortageForModal(v);\n" +
"                      const isHidden = onlyShowShortage && shortage <= 0;\n" +
"                      if (isHidden) return;\n" +
"                      \n" +
"                      hasAnyVisible = true;\n" +
"                      rows.push(\n" +
"                        <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>\n" +
"                          <td style={{ padding: '8px' }}>\n" +
"                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>\n" +
"                              <div style={{ fontWeight: 600, color: '#1e293b' }}>\n" +
"                                {isDaili ? getDailiVariantModalName(v) : formatVariantOption(v)}\n" +
"                              </div>\n" +
"                              <div style={{ fontSize: '11px', color: '#94a3b8' }}>\n" +
"                                SKU: {v.myacg_item_code}\n" +
"                              </div>\n" +
"                            </div>\n" +
"                          </td>\n" +
"                          <td style={{ padding: '8px', textAlign: 'center' }}>\n" +
"                            {shortage > 0 && (\n" +
"                              <span style={{\n" +
"                                backgroundColor: '#FEE2E2',\n" +
"                                color: '#DC2626',\n" +
"                                border: '1px solid #fecaca',\n" +
"                                padding: '2px 8px',\n" +
"                                borderRadius: '4px',\n" +
"                                fontSize: '12px',\n" +
"                                fontWeight: 600,\n" +
"                                whiteSpace: 'nowrap'\n" +
"                              }}>\n" +
"                                缺 {shortage}\n" +
"                              </span>\n" +
"                            )}\n" +
"                            {shortage < 0 && (\n" +
"                              <span style={{\n" +
"                                backgroundColor: '#EFF6FF',\n" +
"                                color: '#2563EB',\n" +
"                                border: '1px solid #bfdbfe',\n" +
"                                padding: '2px 8px',\n" +
"                                borderRadius: '4px',\n" +
"                                fontSize: '12px',\n" +
"                                fontWeight: 600,\n" +
"                                whiteSpace: 'nowrap'\n" +
"                              }}>\n" +
"                                多買 {Math.abs(shortage)}\n" +
"                              </span>\n" +
"                            )}\n" +
"                            {shortage === 0 && (\n" +
"                              <span style={{ color: '#94a3b8', fontSize: '12px' }}>-</span>\n" +
"                            )}\n" +
"                          </td>\n" +
"                          <td style={{ padding: '8px', textAlign: 'center' }}>\n" +
"                            <input className=\"input\" type=\"number\" min=\"0\" value={batchLines[idx]?.quantity || ''} onChange={e => updateBatchLine(idx, 'quantity', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} />\n" +
"                          </td>\n" +
"                          <td style={{ padding: '8px', textAlign: 'right' }}>\n" +
"                            <input className=\"input\" type=\"number\" min=\"0\" value={batchLines[idx]?.cost || ''} onChange={e => updateBatchLine(idx, 'cost', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} />\n" +
"                          </td>\n" +
"                        </tr>\n" +
"                      );\n" +
"                    });";

logReplace("Replace batch modal table rendering completely", oldModalTable, newModalTable);


// 5. Rename getLatestJpyCost definition and calls to getLatestBatchCost
const oldKpiCalc = "  // KPI Calculations\n" +
"  let totalShortage = 0;\n" +
"  let totalExcess = 0;\n" +
"  let totalPurchased = 0;\n" +
"  let totalDemand = 0;\n" +
"  let jpyNeedToBuy = 0;\n" +
"  let jpyPurchased = 0;\n" +
"\n" +
"  const batchMap = new Map(purchaseBatches.map(b => [b.id, b]));\n" +
"\n" +
"  const getLatestJpyCost = (variantId: string): number | null => {\n" +
"    const items = purchaseBatchItems.filter(item => item.product_variant_id === variantId && item.cost > 0);\n" +
"    if (items.length === 0) return null;\n" +
"    \n" +
"    items.sort((a, b) => {\n" +
"      const batchA = batchMap.get(a.purchase_batch_id);\n" +
"      const batchB = batchMap.get(b.purchase_batch_id);\n" +
"      if (!batchA || !batchB) return 0;\n" +
"      const dateCompare = (batchA.date || '').localeCompare(batchB.date || '');\n" +
"      if (dateCompare !== 0) return dateCompare;\n" +
"      return (batchA.created_at || '').localeCompare(batchB.created_at || '');\n" +
"    });\n" +
"    \n" +
"    return items[items.length - 1].cost;\n" +
"  };\n" +
"\n" +
"  variants.forEach(v => {\n" +
"    const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);\n" +
"    const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);\n" +
"    \n" +
"    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);\n" +
"    const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"\n" +
"    const vTotalDemand = myacgDemand + wacaDemand + privateDemand;\n" +
"    totalDemand += vTotalDemand;\n" +
"\n" +
"    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);\n" +
"    const vPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"    totalPurchased += vPurchased;\n" +
"    \n" +
"    const needToBuy = Math.max(vTotalDemand - vPurchased, 0);\n" +
"    const excessBuy = Math.max(vPurchased - vTotalDemand, 0);\n" +
"\n" +
"    totalShortage += needToBuy;\n" +
"    totalExcess += excessBuy;\n" +
"\n" +
"    if (isDaili) {\n" +
"      const defaultTwdCost = variantDefaultTwdCosts[v.id];\n" +
"      const latestTwdCost = getLatestJpyCost(v.id);\n" +
"      const activeTwdCost = (defaultTwdCost !== undefined && defaultTwdCost !== null) ? defaultTwdCost : (latestTwdCost || 0);\n" +
"      jpyNeedToBuy += needToBuy * activeTwdCost;\n" +
"      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);\n" +
"    } else {\n" +
"      const defaultCost = variantDefaultJpyCosts[v.id];\n" +
"      const latestCost = getLatestJpyCost(v.id);\n" +
"      const activeCost = (defaultCost !== undefined && defaultCost !== null) ? defaultCost : (latestCost || 0);\n" +
"      jpyNeedToBuy += needToBuy * activeCost;\n" +
"      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);\n" +
"    }\n" +
"  });\n" +
"\n" +
"  const jpyTotalDemand = jpyNeedToBuy + jpyPurchased;\n" +
"  const estimatedTwd = isDaili ? jpyTotalDemand : (jpyTotalDemand * exchangeRate);";

const newKpiCalc = "  // KPI Calculations\n" +
"  let totalShortage = 0;\n" +
"  let totalExcess = 0;\n" +
"  let totalPurchased = 0;\n" +
"  let totalDemand = 0;\n" +
"  let jpyNeedToBuy = 0;\n" +
"  let jpyPurchased = 0;\n" +
"  let dailiTotalOrdersAmount = 0;\n" +
"\n" +
"  const batchMap = new Map(purchaseBatches.map(b => [b.id, b]));\n" +
"\n" +
"  const getLatestBatchCost = (variantId: string): number | null => {\n" +
"    const items = purchaseBatchItems.filter(item => item.product_variant_id === variantId && item.cost > 0);\n" +
"    if (items.length === 0) return null;\n" +
"    \n" +
"    items.sort((a, b) => {\n" +
"      const batchA = batchMap.get(a.purchase_batch_id);\n" +
"      const batchB = batchMap.get(b.purchase_batch_id);\n" +
"      if (!batchA || !batchB) return 0;\n" +
"      const dateCompare = (batchA.date || '').localeCompare(batchB.date || '');\n" +
"      if (dateCompare !== 0) return dateCompare;\n" +
"      return (batchA.created_at || '').localeCompare(batchB.created_at || '');\n" +
"    });\n" +
"    \n" +
"    return items[items.length - 1].cost;\n" +
"  };\n" +
"\n" +
"  variants.forEach(v => {\n" +
"    const myacgDemand = calculateFinalMyacgDemand(v.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems) + (v.myacg_manual_adjustment || 0);\n" +
"    const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);\n" +
"    \n" +
"    const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);\n" +
"    const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"\n" +
"    const vTotalDemand = myacgDemand + wacaDemand + privateDemand;\n" +
"    totalDemand += vTotalDemand;\n" +
"\n" +
"    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);\n" +
"    const vPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);\n" +
"    totalPurchased += vPurchased;\n" +
"    \n" +
"    const needToBuy = Math.max(vTotalDemand - vPurchased, 0);\n" +
"    const excessBuy = Math.max(vPurchased - vTotalDemand, 0);\n" +
"\n" +
"    totalShortage += needToBuy;\n" +
"    totalExcess += excessBuy;\n" +
"\n" +
"    const invItem = inventoryMap.get(v.myacg_item_code);\n" +
"    const finalPrice = invItem?.final_price || 0;\n" +
"    dailiTotalOrdersAmount += vTotalDemand * finalPrice;\n" +
"\n" +
"    if (isDaili) {\n" +
"      const defaultTwdCost = variantDefaultTwdCosts[v.id];\n" +
"      const latestTwdCost = getLatestBatchCost(v.id);\n" +
"      const activeTwdCost = (defaultTwdCost !== undefined && defaultTwdCost !== null) ? defaultTwdCost : (latestTwdCost || 0);\n" +
"      jpyNeedToBuy += needToBuy * activeTwdCost;\n" +
"      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);\n" +
"    } else {\n" +
"      const defaultCost = variantDefaultJpyCosts[v.id];\n" +
"      const latestCost = getLatestBatchCost(v.id);\n" +
"      const activeCost = (defaultCost !== undefined && defaultCost !== null) ? defaultCost : (latestCost || 0);\n" +
"      jpyNeedToBuy += needToBuy * activeCost;\n" +
"      jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);\n" +
"    }\n" +
"  });\n" +
"\n" +
"  const jpyTotalDemand = jpyNeedToBuy + jpyPurchased;\n" +
"  const estimatedTwd = isDaili ? jpyTotalDemand : (jpyTotalDemand * exchangeRate);\n" +
"  const dailiEstimatedProfit = dailiTotalOrdersAmount - jpyTotalDemand;";

logReplace("Update KPI Calculations block", oldKpiCalc, newKpiCalc);

// Globally rename remaining getLatestJpyCost references to getLatestBatchCost
content = content.split('getLatestJpyCost').join('getLatestBatchCost');


// 6. Update top KPI Cards conditional layout & values
const oldCard4 = "            {/* Total Amount (Orders NTD) */}\n" +
"            <div className=\"card\" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>\n" +
"              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>\n" +
"                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>訂單總金額</div>\n" +
"                <DollarSign size={20} color=\"#10b981\" />\n" +
"              </div>\n" +
"              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>\n" +
"                <span style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>{totalOrdersAmount.toLocaleString()}</span>\n" +
"                <span style={{ fontSize: '13px', color: '#64748b' }}>NTD</span>\n" +
"              </div>\n" +
"              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>訂單商品總額</div>\n" +
"            </div>";

const newCard4 = "            {/* Total Amount (Orders NTD) */}\n" +
"            <div className=\"card\" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>\n" +
"              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>\n" +
"                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>訂單總金額</div>\n" +
"                <DollarSign size={20} color=\"#10b981\" />\n" +
"              </div>\n" +
"              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>\n" +
"                <span style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>\n" +
"                  {isDaili ? dailiTotalOrdersAmount.toLocaleString() : totalOrdersAmount.toLocaleString()}\n" +
"                </span>\n" +
"                <span style={{ fontSize: '13px', color: '#64748b' }}>NTD</span>\n" +
"              </div>\n" +
"              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>訂單商品總額</div>\n" +
"            </div>";

logReplace("Update Card 4 total orders amount calculation", oldCard4, newCard4);

const oldCard7 = "            {/* 3. 總需求日幣/成本 */}\n" +
"            <div className=\"card\" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>\n" +
"              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>\n" +
"                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '總需求成本' : '總需求日幣'}</div>\n" +
"                <Package size={20} color=\"#16a34a\" />\n" +
"              </div>\n" +
"              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>\n" +
"                <span style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a' }}>{isDaili ? `NT$ \${jpyTotalDemand.toLocaleString()}` : `¥ \${jpyTotalDemand.toLocaleString()}`}</span>\n" +
"              </div>\n" +
"              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '整批商品總成本(台幣)' : '整批商品總成本(日幣)'}</div>\n" +
"            </div>";

const newCard7 = "            {/* 3. 總需求日幣/成本 */}\n" +
"            <div className=\"card\" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>\n" +
"              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>\n" +
"                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '總成本' : '總需求日幣'}</div>\n" +
"                <Package size={20} color=\"#16a34a\" />\n" +
"              </div>\n" +
"              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>\n" +
"                <span style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a' }}>{isDaili ? `NT$ \${jpyTotalDemand.toLocaleString()}` : `¥ \${jpyTotalDemand.toLocaleString()}`}</span>\n" +
"              </div>\n" +
"              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '待採購成本 + 已採購成本' : '整批商品總成本(日幣)'}</div>\n" +
"            </div>";

logReplace("Update Card 7 text/title", oldCard7, newCard7);

const oldCard8 = "            {/* 4. 預估台幣 */}\n" +
"            <div className=\"card\" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>\n" +
"              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>\n" +
"                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>預估台幣</div>\n" +
"                <DollarSign size={20} color=\"#ca8a04\" />\n" +
"              </div>\n" +
"              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>\n" +
"                <span style={{ fontSize: '28px', fontWeight: 700, color: '#ca8a04' }}>NTD {Math.round(estimatedTwd).toLocaleString()}</span>\n" +
"              </div>\n" +
"              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '預估總台幣成本' : `總需求日幣 × 匯率 \${exchangeRate}`}</div>\n" +
"            </div>";

const newCard8 = "            {/* 4. 預估台幣 */}\n" +
"            <div className=\"card\" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>\n" +
"              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>\n" +
"                <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>{isDaili ? '預估毛利' : '預估台幣'}</div>\n" +
"                <DollarSign size={20} color=\"#ca8a04\" />\n" +
"              </div>\n" +
"              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>\n" +
"                <span style={{ fontSize: '28px', fontWeight: 700, color: '#ca8a04' }}>\n" +
"                  {isDaili ? `NT$ \${dailiEstimatedProfit.toLocaleString()}` : `NTD \${Math.round(estimatedTwd).toLocaleString()}`}\n" +
"                </span>\n" +
"              </div>\n" +
"              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '訂單總金額 - 總成本' : `總需求日幣 × 匯率 \${exchangeRate}`}</div>\n" +
"            </div>";

logReplace("Update Card 8 estimated profit", oldCard8, newCard8);

// Restore line endings
content = content.split('\n').join(originalLineEndings);

fs.writeFileSync(filePath, content, 'utf-8');
console.log("Replacement complete.");
