import fs
import re

with open('src/pages/PurchaseManagement.tsx', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Add states if missing
if 'const [isEditMode, setIsEditMode]' not in code:
    old_state = "  const [activeTab, setActiveTab] = useState<'worksheet' | 'purchase_batches' | 'private_orders'>('worksheet');"
    new_state = """  const [activeTab, setActiveTab] = useState<'worksheet' | 'purchase_batches' | 'private_orders'>('worksheet');
  const [isEditMode, setIsEditMode] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, {m: number, w: number, p: number, pu: number}>>({});

  const handleEditModeToggle = () => {
    if (!isEditMode) {
      const drafts: Record<string, {m: number, w: number, p: number, pu: number}> = {};
      variants.forEach(v => {
        drafts[v.id] = {
          m: (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0),
          w: (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0),
          p: (v.private_manual_adjustment || 0),
          pu: (v.purchased_manual_adjustment || 0)
        };
      });
      setEditDrafts(drafts);
      setIsEditMode(true);
    } else {
      setIsEditMode(false);
      setEditDrafts({});
    }
  };

  const handleSaveEdits = async () => {
    const allVars = await db.getProductVariants();
    const updated = allVars.map(v => {
      const draft = editDrafts[v.id];
      if (draft) {
        return {
          ...v,
          myacg_manual_adjustment: draft.m - (v.myacg_auto_quantity || 0),
          waca_manual_adjustment: draft.w - (v.waca_auto_quantity || 0),
          private_manual_adjustment: draft.p,
          purchased_manual_adjustment: draft.pu
        };
      }
      return v;
    });
    await db.saveProductVariants(updated);
    setIsEditMode(false);
    setEditDrafts({});
    await loadData();
  };

  const handleDraftChange = (id: string, field: 'm'|'w'|'p'|'pu', val: number) => {
    if (isNaN(val) || val < 0) val = 0;
    setEditDrafts(prev => ({
      ...prev,
      [id]: {
        ...prev[id],
        [field]: val
      }
    }));
  };"""
    code = code.replace(old_state, new_state)


# 2. Add Edit Toggle Button
# We look for navigate('/purchase-records') to insert the button
if 'handleEditModeToggle' not in code.split("navigate('/purchase-records')")[0]:
    old_btn = """<div style={{ display: 'flex', gap: '12px' }}>
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/purchase-records')}"""
    new_btn = """<div style={{ display: 'flex', gap: '12px' }}>
          {activeTab === 'worksheet' && (
            isEditMode ? (
              <>
                <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', color: '#64748b', borderColor: '#cbd5e1' }}>
                  取消
                </button>
                <button className="btn btn-primary" onClick={handleSaveEdits} style={{ backgroundColor: '#2563eb' }}>
                  儲存修改
                </button>
              </>
            ) : (
              <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff' }}>
                編輯數量
              </button>
            )
          )}
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/purchase-records')}"""
    code = code.replace(old_btn, new_btn)


with open('src/pages/PurchaseManagement.tsx', 'w', encoding='utf-8') as f:
    f.write(code)

print("Python script applied")
