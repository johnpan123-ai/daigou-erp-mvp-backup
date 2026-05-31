const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

const highlightTextComponent = `
const HighlightText = ({ text, highlight }: { text: string | undefined | null; highlight: string }) => {
  if (!text) return null;
  if (!highlight.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(\`(\${highlight})\`, 'gi'));
  return (
    <>
      {parts.map((part, i) => 
        part.toLowerCase() === highlight.toLowerCase() ? (
          <span key={i} style={{ backgroundColor: '#fef08a', padding: '0 2px', borderRadius: '2px', color: '#854d0e' }}>{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
};

export default function PurchaseManagement() {
`;

code = code.replace('export default function PurchaseManagement() {', highlightTextComponent);

const stateInsert = `
  const [searchTerm, setSearchTerm] = useState('');
  const [manualExpandedGroups, setManualExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (title: string) => {
    const newSet = new Set(manualExpandedGroups);
    if (newSet.has(title)) newSet.delete(title);
    else newSet.add(title);
    setManualExpandedGroups(newSet);
  };

  const [filterMode, setFilterMode] = useState<'all' | 'abnormal'>('all');
`;

code = code.replace("const [filterMode, setFilterMode] = useState<'all' | 'abnormal'>('all');", stateInsert);

// Fix duplicate state declarations if they exist.
// since I am operating on the file AFTER apply_ui_script, there shouldn't be duplicate states because apply_ui_script replaced the whole end of the file.
// Wait, I did `git checkout` which restored the duplicate states?
// No, I did `git checkout` which restored it to the commit BEFORE my search bar revamp!
// So I don't have the duplicate states. But I do need to re-add salesOrders because they were added by apply_state.cjs!
// Let me just run this and check the build errors to see what else I need.

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Recovered missing states');
