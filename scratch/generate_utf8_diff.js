import { execSync } from 'child_process';
import fs from 'fs';

try {
  console.log('Generating git diff in UTF-8...');
  const diff = execSync('git diff HEAD~1 HEAD -- src/pages/Dashboard.tsx', { encoding: 'utf8' });
  fs.writeFileSync('dashboard_diff.txt', diff, 'utf8');
  console.log('Successfully wrote UTF-8 diff to dashboard_diff.txt');
} catch (err) {
  console.error('Failed to generate diff:', err);
}
