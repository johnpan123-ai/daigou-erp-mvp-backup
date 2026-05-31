import fs from 'fs';

const filePath = 'src/pages/Dashboard.tsx';
try {
  const buffer = fs.readFileSync(filePath);
  console.log('File size:', buffer.length, 'bytes');
  console.log('First 32 bytes in Hex:', buffer.subarray(0, 32).toString('hex'));
  
  // Check BOM
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    console.log('Detected encoding: UTF-16 LE');
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    console.log('Detected encoding: UTF-16 BE');
  } else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    console.log('Detected encoding: UTF-8 with BOM');
  } else {
    console.log('No BOM detected, assuming UTF-8 or ASCII');
  }

  // Read a snippet of text
  const text = buffer.toString('utf8');
  console.log('Snippet (first 200 chars in UTF-8):');
  console.log(text.substring(0, 200));
} catch (err) {
  console.error('Error reading file:', err);
}
