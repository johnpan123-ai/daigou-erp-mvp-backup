import re

with open('src/pages/PurchaseManagement.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Imports
content = content.replace(
    "import { ChevronRight, ChevronDown, Plus, X, ArrowLeft } from 'lucide-react';",
    "import { ChevronRight, ChevronDown, Plus, X, ArrowLeft, Search } from 'lucide-react';"
)

# 2. HighlightText
highlight_component = """
const HighlightText = ({ text, highlight }: { text: string; highlight: string }) => {
  if (!highlight || !highlight.trim()) {
    return <span>{text}</span>;
  }
  const regex = new RegExp(`(${highlight})`, 'gi');
  const parts = text.split(regex);
  return (
    <span>
      {parts.map((part, i) => 
        regex.test(part) ? <mark key={i} style={{ backgroundColor: '#fef08a', color: 'inherit' }}>{part}</mark> : <span key={i}>{part}</span>
      )}
    </span>
  );
};
"""
content = content.replace(
    "export default function PurchaseManagement() {",
    highlight_component + "\nexport default function PurchaseManagement() {"
)

# 3. State
old_state = """  const [activeTab, setActiveTab] = useState<'worksheet' | 'purchase_batches' | 'private_orders'>('worksheet');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedOrderRows, setExpandedOrderRows] = useState<Set<string>>(new Set());"""

new_state = """  const [activeTab, setActiveTab] = useState<'worksheet' | 'purchase_batches' | 'private_orders'>('worksheet');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedOrderRows, setExpandedOrderRows] = useState<Set<string>>(new Set());

  const [manualExpandedGroups, setManualExpandedGroups] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`erp_expanded_groups_${id}`);
      return saved ? new Set<string>(JSON.parse(saved)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  useEffect(() => {
    if (id) {
      if (manualExpandedGroups.size > 0) {
        localStorage.setItem(`erp_expanded_groups_${id}`, JSON.stringify(Array.from(manualExpandedGroups)));
      } else {
        localStorage.removeItem(`erp_expanded_groups_${id}`);
      }
    }
  }, [manualExpandedGroups, id]);"""
content = content.replace(old_state, new_state)

# 4. loadData default expansion
old_loaddata_expand = """    // Expand all groups by default
    const groupCatTitles = new Set(allCats.filter(c => c.product_group_id === id).map(c => c.title));
    setExpandedGroups(groupCatTitles);"""
content = content.replace(old_loaddata_expand, "")

# 5. toggleGroup
old_toggle = """  const toggleGroup = (title: string) => {
    const next = new Set(expandedGroups);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setExpandedGroups(next);
  };"""
new_toggle = """  const toggleGroup = (title: string) => {
    const next = new Set(manualExpandedGroups);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    setManualExpandedGroups(next);
  };"""
content = content.replace(old_toggle, new_toggle)

# 6. Buttons
old_buttons = """<button className="btn btn-outline" style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: '#fff' }} onClick={() => setExpandedGroups(new Set(Object.keys(groupedVariants)))}>展開群組</button>
                  <button className="btn btn-outline" style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: '#fff' }} onClick={() => setExpandedGroups(new Set())}>收合群組</button>"""
new_buttons = """<button className="btn btn-outline" style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: '#fff' }} onClick={() => setManualExpandedGroups(new Set(Object.keys(groupedVariants)))}>展開群組</button>
                  <button className="btn btn-outline" style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: '#fff' }} onClick={() => setManualExpandedGroups(new Set())}>收合群組</button>"""
content = content.replace(old_buttons, new_buttons)

# 7. Search Bar
old_tabs = """          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', backgroundColor: '#fff', padding: '0 16px' }}>"""
new_tabs = """          {/* Search Bar */}
          {activeTab === 'worksheet' && (
            <div style={{ padding: '16px 24px', borderBottom: '1px solid #e5e7eb', backgroundColor: '#fff', display: 'flex', alignItems: 'center' }}>
              <div className="relative" style={{ width: '450px' }}>
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted" size={16} />
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="🔍 搜尋規格名稱 / SKU / 角色名稱..." 
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={{ paddingLeft: '36px', width: '100%' }}
                />
              </div>
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', backgroundColor: '#fff', padding: '0 16px' }}>"""
content = content.replace(old_tabs, new_tabs)

# 8. Render loop mapping
old_loop = """              <tbody>
                {Object.entries(groupedVariants).map(([title, groupItems]) => {
                  const isExpanded = expandedGroups.has(title);"""
new_loop = """              <tbody>
                {Object.entries(groupedVariants).filter(([title, groupItems]) => {
                  if (!searchTerm) return true;
                  const lowerSearch = searchTerm.toLowerCase();
                  const groupMatch = title.toLowerCase().includes(lowerSearch);
                  const hasMatch = groupItems.some(v => 
                    (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                    (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                  );
                  return groupMatch || hasMatch;
                }).map(([title, groupItems]) => {
                  const lowerSearch = searchTerm.toLowerCase();
                  const isSearchMatched = searchTerm && (
                    title.toLowerCase().includes(lowerSearch) || 
                    groupItems.some(v => 
                      (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                      (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                    )
                  );
                  // Auto-expand if search matched, else use manual state
                  const isExpanded = isSearchMatched ? true : manualExpandedGroups.has(title);"""
content = content.replace(old_loop, new_loop)

# 9. Single Item Display
old_single_display = """                          <td style={tdStyle('left')}>
                            <div style={{ fontWeight: 600, color: '#111827' }}>{displayName}</div>
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{v.myacg_item_code}</div>
                          </td>"""
new_single_display = """                          <td style={tdStyle('left')}>
                            <div style={{ fontWeight: 600, color: '#111827' }}>
                              <HighlightText text={title} highlight={searchTerm} />
                            </div>
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                              SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                              {v.variant_name && ` | 規格: `}
                              {v.variant_name && <HighlightText text={v.variant_name} highlight={searchTerm} />}
                            </div>
                          </td>"""
content = content.replace(old_single_display, new_single_display)

# 10. Multi Item Parent
old_multi_parent = """                        <td style={tdStyle('left')} onClick={() => toggleGroup(title)}>
                          <div className="flex items-center gap-sm cursor-pointer" style={{ fontWeight: 600, color: '#111827' }}>
                            {isExpanded ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
                            {title}
                            <span style={{ backgroundColor: '#e2e8f0', color: '#475569', padding: '2px 6px', borderRadius: '12px', fontSize: '11px', fontWeight: 500 }}>"""
new_multi_parent = """                        <td style={tdStyle('left')} onClick={() => toggleGroup(title)}>
                          <div className="flex items-center gap-sm cursor-pointer" style={{ fontWeight: 600, color: '#111827' }}>
                            {isExpanded ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
                            <HighlightText text={title} highlight={searchTerm} />
                            <span style={{ backgroundColor: '#e2e8f0', color: '#475569', padding: '2px 6px', borderRadius: '12px', fontSize: '11px', fontWeight: 500 }}>"""
content = content.replace(old_multi_parent, new_multi_parent)

# 11. Multi Item Child
old_multi_child = """                                <div style={{ fontWeight: 500, color: '#334155' }}>{v.variant_name}</div>
                                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{v.myacg_item_code}</div>"""
new_multi_child = """                                <div style={{ fontWeight: 500, color: '#334155' }}>
                                  <HighlightText text={v.variant_name} highlight={searchTerm} />
                                </div>
                                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                                  SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                </div>"""
content = content.replace(old_multi_child, new_multi_child)

with open('src/pages/PurchaseManagement.tsx', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done!')
