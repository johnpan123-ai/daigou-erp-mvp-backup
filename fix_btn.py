import fs

with open('src/pages/PurchaseManagement.tsx', 'r', encoding='utf-8') as f:
    code = f.read()

old_header = """          </h1>
        </div>"""

new_header = """          </h1>
          
          <div style={{ display: 'flex', gap: '12px' }}>
            {activeTab === 'worksheet' && (
              isEditMode ? (
                <>
                  <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', color: '#64748b', borderColor: '#cbd5e1' }}>
                    <X size={16} />
                    取消
                  </button>
                  <button className="btn btn-primary" onClick={handleSaveEdits} style={{ backgroundColor: '#2563eb' }}>
                    <CheckSquare size={16} />
                    儲存修改
                  </button>
                </>
              ) : (
                <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', borderColor: '#cbd5e1' }}>
                  <Edit2 size={16} />
                  編輯數量
                </button>
              )
            )}
          </div>
        </div>"""

# To avoid matching multiple `</h1> </div>`, let's make it more specific
old_header_specific = """            )}
          </h1>
        </div>
      </div>"""

new_header_specific = """            )}
          </h1>
          <div style={{ display: 'flex', gap: '12px' }}>
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
                <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', borderColor: '#cbd5e1', color: '#334155' }}>
                  編輯數量
                </button>
              )
            )}
          </div>
        </div>
      </div>"""

code = code.replace(old_header_specific, new_header_specific)

with open('src/pages/PurchaseManagement.tsx', 'w', encoding='utf-8') as f:
    f.write(code)

print("Button fixed")
