const { execSync } = require('child_process');

const commits = execSync('git log --oneline', { encoding: 'utf8' })
  .split('\n')
  .map(line => line.split(' ')[0])
  .filter(Boolean);

console.log("Searching all commits...");
for (const commit of commits) {
  try {
    const content = execSync(`git show ${commit}:src/pages/PurchaseRecords.tsx`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const hasWaca = content.includes('WACA');
    const hasEditMode = content.includes('editMode');
    console.log(`Commit ${commit}: WACA=${hasWaca}, editMode=${hasEditMode}`);
  } catch (e) {
    // File might not exist in that commit
  }
}
