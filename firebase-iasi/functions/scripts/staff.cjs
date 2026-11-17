// Run with a scoped service account/ADC for this project. No credential is logged.
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('node:fs');
(async () => {
  const config = require('../../project.json');
  const projectId = process.env.GCLOUD_PROJECT || config.projectId;
  if (!!process.env.FIREBASE_AUTH_EMULATOR_HOST !== !!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Auth and Firestore must both use the emulator or both use cloud.');
  const emulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST && !!process.env.FIRESTORE_EMULATOR_HOST;
  if (projectId !== config.projectId && projectId !== 'demo-parcare-iasi') throw new Error('Unexpected project');
  if (!emulator && process.env.IASI_STAFF_BOOTSTRAP !== 'true') throw new Error('For live bootstrap, set IASI_STAFF_BOOTSTRAP=true and provide scoped credentials.');
  const [email, role = 'operator', action = 'enable'] = process.argv.slice(2);
  if (!email || !['admin','operator'].includes(role) || !['enable','disable'].includes(action)) throw new Error('Usage: npm run staff -- email admin|operator enable|disable (new user password from stdin)');
  initializeApp({projectId});
  const auth = getAuth();
  let user;
  try { user = await auth.getUserByEmail(email); }
  catch (error) {
    if (error.code !== 'auth/user-not-found' || action === 'disable') throw error;
    if (process.stdin.isTTY) throw new Error('A new user password must be provided via protected stdin.');
    const password = fs.readFileSync(0,'utf8').trim();
    if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
    user = await auth.createUser({email,password});
  }
  await getFirestore().doc(`staffAccess/${user.uid}`).set({role,enabled:action === 'enable',updatedAt:FieldValue.serverTimestamp()});
  await auth.setCustomUserClaims(user.uid,{...user.customClaims,role:action === 'enable' ? role : null});
  if (action === 'disable') await auth.revokeRefreshTokens(user.uid);
  console.log(JSON.stringify({uid:user.uid,role,enabled:action === 'enable',projectId}));
})().catch(e => {console.error(e.message);process.exitCode=1;});
