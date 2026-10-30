// Chequeo de sintaxis: corre `node --check` sobre los JS del proyecto (main, preload, launcher y src/**).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = ['main.js', 'preload.js', 'start-electron.js'];

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(path.relative(root, full));
  }
};
walk(path.join(root, 'src'));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    process.stderr.write(`Error de sintaxis en ${file}\n${err.stderr || ''}`);
  }
}
console.log(`check: ${files.length - failed}/${files.length} archivos OK`);
process.exit(failed ? 1 : 0);
