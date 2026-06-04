const fs = require('fs');
const path = require('path');

const firefoxDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Roaming',
  'Mozilla',
  'Firefox',
  'Profiles'
);

if (fs.existsSync(firefoxDir)) {
  console.log("Firefox Profiles directory exists!");
  const files = fs.readdirSync(firefoxDir);
  console.log("Profiles:", files);
} else {
  console.log("Firefox Profiles directory does not exist at:", firefoxDir);
}
