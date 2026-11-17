const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const args = process.argv.slice(2);
const command = args[0] === 'test' ? ['emulators:exec','--project','demo-parcare-iasi','--only','auth,firestore','npm --prefix functions test'] : ['emulators:start','--project','parcare-aeroport-iasi','--only','auth,firestore,functions'];
const cli = require.resolve('firebase-tools/lib/bin/firebase.js', { paths: [root] });
// Isolate the CLI process group so shutdown also reaches its Java emulator and
// Functions workers. Killing only npx leaves Firestore holding port 8088.
const grouped = process.platform !== 'win32';
const child = spawn('npx', ['--yes','--package=node@22','node',fs.realpathSync(cli),...command], {cwd:root, stdio:'inherit', detached:grouped, env:{...process.env,FIREBASE_EMULATORS_PATH:path.join(root,'.cache/emulators')}});
let stopping = false;
let forceTimer;
function signalChildren(signal) {
  try {
    if (grouped && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function stop(signal) {
  if (stopping) return;
  stopping = true;
  signalChildren(signal);
  forceTimer = setTimeout(() => signalChildren('SIGKILL'), 10000);
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.on('exit', code => {
  clearTimeout(forceTimer);
  signalChildren('SIGTERM');
  // Reap descendants even if the CLI exits before they do.
  setTimeout(() => {
    signalChildren('SIGKILL');
    process.exitCode = code ?? (stopping ? 0 : 1);
  }, 1000);
});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
