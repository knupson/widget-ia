// Punto de entrada para `node --test test/` en Node 22/24+ (donde pasar un directorio resuelve test/index.js)
const fs = require('fs');
const path = require('path');

for (const entry of fs.readdirSync(__dirname)) {
  if (entry.endsWith('.test.js')) {
    require(path.join(__dirname, entry));
  }
}
