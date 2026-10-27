const { spawn } = require('child_process');
const path = require('path');

const electronBin = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [path.resolve(__dirname)], {
  env,
  detached: true,
  stdio: 'ignore',
  windowsHide: false
});

child.unref();
console.log('AI Pulse Widget iniciado en el escritorio.');
