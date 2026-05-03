// Web assets を www/ にコピーするビルドスクリプト
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

const files = ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.json'];
const dirs = ['icons'];

if (!fs.existsSync(www)) fs.mkdirSync(www, { recursive: true });

for (const f of files) {
  fs.copyFileSync(path.join(root, f), path.join(www, f));
  console.log(`Copied: ${f}`);
}

for (const d of dirs) {
  const srcDir = path.join(root, d);
  const dstDir = path.join(www, d);
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    console.log(`Copied: ${d}/${f}`);
  }
}

console.log('Build complete → www/');
