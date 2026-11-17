const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
(async () => {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) throw Error('Emulators required; live seeding is forbidden.');
  const {projectId}=require('../../project.json');
  initializeApp({projectId});
  let user;
  try { user=await getAuth().getUserByEmail('operator@example.com'); }
  catch(error) { if(error.code!=='auth/user-not-found')throw error; user=await getAuth().createUser({email:'operator@example.com',password:'Local-Emulator-Only-123!'}); }
  await getAuth().setCustomUserClaims(user.uid,{role:'admin'});
  await getFirestore().doc(`staffAccess/${user.uid}`).set({enabled:true,role:'admin'});
  console.log('Local emulator staff ready; credentials are documented in README.');
})().catch(error=>{console.error(error.message);process.exitCode=1});
