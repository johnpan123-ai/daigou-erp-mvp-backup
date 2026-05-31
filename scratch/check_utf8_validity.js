import fs from 'fs';

const filePath = 'src/pages/Dashboard.tsx';
try {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let nonAsciiCount = 0;
  
  console.log('Scanning lines for non-ASCII characters...');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // RegExp to check for non-ASCII characters
    if (/[^\x00-\x7F]/.test(line)) {
      nonAsciiCount++;
      if (nonAsciiCount <= 50) {
        console.log(`Line ${i + 1}: ${line.trim()}`);
      }
    }
  }
  console.log(`Total lines with non-ASCII characters: ${nonAsciiCount}`);
} catch (err) {
  console.error('Error:', err);
}
