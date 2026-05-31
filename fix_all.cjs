const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Remove the duplicate toggleGroup I just added
const duplicateToggleGroup = `
  const toggleGroup = (title: string) => {
    const newSet = new Set(manualExpandedGroups);
    if (newSet.has(title)) newSet.delete(title);
    else newSet.add(title);
    setManualExpandedGroups(newSet);
  };
`;
code = code.replace(duplicateToggleGroup, '');

// 2. Fix the imports
const importsToReplace = "import { ChevronRight, ChevronDown, Plus, X, ArrowLeft } from 'lucide-react';";
const newImports = "import { ChevronRight, ChevronDown, Plus, X, ArrowLeft, Search, AlertTriangle, Package, CheckSquare, RefreshCw, ShoppingCart, DollarSign, Filter, ListOrdered } from 'lucide-react';";
if (code.includes(importsToReplace)) {
  code = code.replace(importsToReplace, newImports);
} else {
  // Try to find the lucide import if it has Search already
  const regex = /import \{([^}]+)\} from 'lucide-react';/;
  const match = code.match(regex);
  if (match) {
    code = code.replace(match[0], newImports);
  }
}

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Fixed imports and duplicate toggleGroup');
