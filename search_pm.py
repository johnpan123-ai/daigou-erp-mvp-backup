import os

keywords = ['purchaseGridColumns', 'selectedCell', 'editingCell', 'productName', '購買日期', '訂購人', '單價', '備註']

for root, dirs, files in os.walk('.'):
    # prune directories
    dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', 'dist', 'build')]
    for file in files:
        if file.endswith(('.tsx', '.ts', '.js', '.jsx', '.html', '.json', '.css')):
            path = os.path.join(root, file)
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    for kw in keywords:
                        if kw in content:
                            print(f"Found '{kw}' in {path}")
            except Exception as e:
                pass
