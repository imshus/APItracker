// Starts the two separate projects together on this computer: `npm start` in the project root.
// backend (API, port 4310) and frontend (dashboard, port 4300). Each also runs alone:
// `npm run start:backend`, `npm run start:frontend`.
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const parts = [
  { name: 'backend ', cwd: path.join(ROOT, 'backend'), script: 'src/server.js' },
  { name: 'frontend', cwd: path.join(ROOT, 'frontend'), script: 'server.js' },
];

const children = parts.map(({ name, cwd, script }) => {
  const child = spawn(process.execPath, [script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) out.write(`[${name}] ${line}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`[${name}] stopped (code ${code}). Stopping the other part.`);
    shutdown(code || 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
