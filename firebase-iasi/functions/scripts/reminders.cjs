if(!process.env.FIRESTORE_EMULATOR_HOST||!process.env.FIREBASE_AUTH_EMULATOR_HOST)throw Error('This helper only runs with both emulators configured.');
const {initializeApp}=require('firebase-admin/app');
const {processNotificationJobs}=require('../lib/commerce/service');
initializeApp({projectId:require('../../project.json').projectId});
processNotificationJobs(100).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
