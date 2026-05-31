import subprocess
import sys

try:
    content = subprocess.check_output(['git', 'show', '5b5d619:src/pages/PurchaseRecords.tsx'], stderr=subprocess.STDOUT)
    text = content.decode('utf-8', errors='ignore')
    print("Length of file content:", len(text))
    print("WACA in content:", 'WACA' in text)
    print("editMode in content:", 'editMode' in text)
    print("鎖定在內容中:", '鎖定' in text)
    print("編輯在內容中:", '編輯' in text)
    
    # search for activeTab === 'proxy'
    idx = text.find("activeTab === 'proxy'")
    if idx != -1:
        print("Found activeTab === 'proxy' at index:", idx)
        print("Context:")
        print(text[idx:idx+500])
except Exception as e:
    print("Error:", e)
    if hasattr(e, 'output'):
        print("Output:", e.output.decode('utf-8', errors='ignore'))
