const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, collection, query, where, limit, getDocs } = require('firebase/firestore');
const { createApp } = require('../lib/app');
const projectId = 'demo-parcare-iasi';
let environment, server, base, alice, bob;

async function identity(email) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const response = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(email ? {email,password:'Local-Test-Password-123!',returnSecureToken:true} : {returnSecureToken:true}),
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return { uid: result.localId, token: result.idToken };
}
async function request(method, route, who, data, extra = {}) {
  const response = await fetch(base+route, {method,headers:{'Content-Type':'application/json',...(who?{Authorization:`Bearer ${who.token}`} : {}),...extra},body:data?JSON.stringify(data):undefined});
  return {status:response.status,body:await response.json()};
}
const contact = {email:'guest@example.com',phone:'0700123456'};
before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Emulators are mandatory. Never run against live data.');
  process.env.GCLOUD_PROJECT = projectId;
  process.env.ALLOWED_ORIGINS = 'http://localhost:3005';
  initializeApp({projectId});
  environment = await initializeTestEnvironment({projectId,firestore:{rules:fs.readFileSync(path.join(__dirname,'../../firestore.rules'),'utf8')}});
  await environment.clearFirestore();
  server = createApp().listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  alice = await identity(); bob = await identity();
});
after(async () => { await environment?.cleanup(); if(server)await new Promise(resolve=>server.close(resolve)); });

test('meta has no database dependency; unauthenticated and email-header access are rejected', async () => {
  assert.equal((await request('GET','/v1/meta')).body.projectId,projectId);
  assert.equal((await request('GET','/v1/me')).status,401);
  assert.equal((await request('GET','/v1/me',null,null,{'X-Guest-Email':contact.email})).status,401);
  assert.equal((await request('GET','/v1/me',{token:'forged'})).status,401);
  assert.equal((await request('GET','/v1/meta',null,null,{Origin:'https://untrusted.invalid'})).status,403);
});
test('guest session restores its profile, validates payload and returns a recovery token by email', async () => {
  const a = await request('POST','/v1/guest/session',alice,contact);
  assert.equal(a.status,200); assert.equal(a.body.profile.uid,alice.uid);
  const again = await request('POST','/v1/guest/session',alice,{email:'different@example.com',phone:'0700999999'});
  assert.deepEqual(again.body.profile,a.body.profile);
  const b = await request('POST','/v1/guest/session',bob,contact);
  assert.equal(b.status,200); assert.ok(b.body.customToken);
  assert.equal((await request('POST','/v1/guest/session',alice,{...contact,uid:bob.uid})).status,400);
  assert.equal((await request('POST','/v1/guest/session',alice,{email:'bad',phone:'x'})).status,400);
  assert.equal((await request('GET','/v1/me',alice)).body.profile.email,contact.email);
});
test('profile edit rejects stale revisions and attempts to change ownership', async () => {
  const a = await request('PATCH','/v1/me',alice,{name:'Ana Iasi',expectedRevision:1});
  assert.equal(a.status,200); assert.equal(a.body.profile.revision,2);
  assert.equal((await request('PATCH','/v1/me',alice,{name:'Stale',expectedRevision:1})).status,409);
  assert.equal((await request('PATCH','/v1/me',alice,{uid:bob.uid,expectedRevision:2})).status,400);
});
test('staff requires both claim and active access; disabling access works with an existing token', async () => {
  assert.equal((await request('GET','/v1/staff/session',alice)).status,403);
  const staff = await identity('operator-stage-one@example.com');
  await getAuth().setCustomUserClaims(staff.uid,{role:'operator'});
  const login = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'operator-stage-one@example.com',password:'Local-Test-Password-123!',returnSecureToken:true})});
  staff.token=(await login.json()).idToken;
  assert.equal((await request('GET','/v1/staff/session',staff)).status,403);
  const access=getFirestore().doc(`staffAccess/${staff.uid}`);
  await access.set({enabled:true,role:'operator'});
  assert.equal((await request('GET','/v1/staff/session',staff)).body.session.role,'operator');
  await access.update({enabled:false});
  assert.equal((await request('GET','/v1/staff/session',staff)).status,403);
  assert.equal((await request('POST','/v1/guest/session',staff,contact)).status,403);
});
test('Firestore Rules: own reads only, bounded queries, no financial or role writes, private collections denied', async () => {
  const own=environment.authenticatedContext(alice.uid,{firebase:{sign_in_provider:'anonymous'}}).firestore();
  const other=environment.authenticatedContext(bob.uid).firestore();
  const publicDb=environment.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(own,`users/${alice.uid}`)));
  await assertFails(getDoc(doc(other,`users/${alice.uid}`)));
  await assertFails(getDocs(collection(own,'users')));
  await assertFails(setDoc(doc(own,`users/${alice.uid}`),{points:99999}));
  await assertFails(setDoc(doc(own,`staffAccess/${alice.uid}`),{role:'admin',enabled:true}));
  await getFirestore().doc('bookings/a').set({ownerUid:alice.uid,amountBani:9000});
  await getFirestore().doc('bookings/b').set({ownerUid:bob.uid,amountBani:9000});
  await getFirestore().doc('publicConfig/booking').set({version:1});
  await assertSucceeds(getDoc(doc(publicDb,'publicConfig/booking')));
  await assertFails(getDocs(collection(publicDb,'publicConfig')));
  await assertSucceeds(getDocs(query(collection(own,'bookings'),where('ownerUid','==',alice.uid),limit(20))));
  await assertFails(getDocs(query(collection(own,'bookings'),limit(20))));
  await assertFails(getDocs(query(collection(own,'bookings'),where('ownerUid','==',alice.uid))));
  await assertFails(setDoc(doc(own,'bookings/a'),{amountBani:1}));
  for (const collectionName of ['payments','providerEvents','identityKeys','idempotency','jobs','outbox']) {
    await assertFails(getDoc(doc(own,`${collectionName}/private`)));
  }
  const staffId='rules-staff';
  const staffDb=environment.authenticatedContext(staffId,{role:'admin'}).firestore();
  await getFirestore().doc(`staffAccess/${staffId}`).set({enabled:true,role:'admin'});
  await assertSucceeds(getDocs(query(collection(staffDb,'bookings'),limit(50))));
  await getFirestore().doc(`users/${staffId}/meta/notifications`).set({sequence:1,unread:1,readThrough:0});
  await assertSucceeds(getDoc(doc(staffDb,`users/${staffId}/meta/notifications`)));
  await getFirestore().doc(`staffAccess/${staffId}`).update({enabled:false});
  await assertFails(getDoc(doc(staffDb,`users/${staffId}/meta/notifications`)));
  await assertFails(getDoc(doc(staffDb,'bookings/a')));
});
