import { initializeApp } from 'firebase-admin/app';
import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './app';

if (process.env.FUNCTIONS_EMULATOR === 'true' && (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST)) {
  throw new Error('Auth and Firestore emulators must both be running.');
}
initializeApp();
export const api = onRequest({ region: 'europe-west1', minInstances: 0, maxInstances: 5, concurrency: 20 }, createApp());

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { processNotificationJobs } from './commerce/service';
export const notificationReminders = onSchedule({schedule:'every 15 minutes',region:'europe-west1',timeZone:'Europe/Bucharest',maxInstances:1}, async () => { await processNotificationJobs(100); });
