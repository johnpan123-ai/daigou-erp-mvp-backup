with open('src/pages/PurchaseManagement.tsx', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f, 1):
        if 'getDailiVariantModalName' in line:
            print(f"Line {i}: {line.strip()}")
