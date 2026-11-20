/**
 * Cloud Functions entry point (bundled by build.mjs → lib/index.js).
 *
 * `tick` — every minute (UTC): task reminders + morning summaries over Web Push, for the accounts
 * allowlisted in `allow/{uid}` (created by the owner in the console; firestore.rules use the same
 * list), plus the server-side repair of derived remindAt values (recently written tasks every minute, every
 * open task daily). See tick.ts.
 *
 * Configuration (see docs/DEPLOY.md):
 *   secret  VAPID_PRIVATE_KEY   `firebase functions:secrets:set VAPID_PRIVATE_KEY`
 *   param   VAPID_PUBLIC_KEY    functions/.env — the same key as the web app's VITE_VAPID_PUBLIC_KEY
 *   param   VAPID_SUBJECT       optional; defaults to the app's Hosting URL https://<project-id>.web.app
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString, projectID } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import webpush from 'web-push';
import { runTick, type FsDb, type SendNotification } from './tick.js';

const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');

const VAPID_PUBLIC_KEY = defineString('VAPID_PUBLIC_KEY', {
  label: 'VAPID public key',
  description: 'Web Push public key (the same value as VITE_VAPID_PUBLIC_KEY in the web app .env).',
});

const VAPID_SUBJECT = defineString('VAPID_SUBJECT', {
  label: 'VAPID subject',
  description: 'Contact URL sent to push services. Leave empty to use the app URL https://<project-id>.web.app.',
  default: '',
});

if (getApps().length === 0) initializeApp();

/** The VAPID "sub" claim: an explicit https:/mailto: value, else the app's Hosting URL (never a personal email). */
function vapidSubject(): string {
  const explicit = VAPID_SUBJECT.value().trim();
  if (/^(https:\/\/|mailto:)\S+$/.test(explicit)) return explicit;
  return `https://${projectID.value()}.web.app`;
}

export const tick = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'UTC',
    region: 'us-central1',
    secrets: [VAPID_PRIVATE_KEY],
    memory: '256MiB',
    timeoutSeconds: 55,
    // A failed run is simply retried by the next minute's run (claims are conditional writes).
    retryCount: 0,
    maxInstances: 1,
  },
  async () => {
    const vapidDetails = {
      subject: vapidSubject(),
      publicKey: VAPID_PUBLIC_KEY.value().trim(),
      privateKey: VAPID_PRIVATE_KEY.value().trim(),
    };
    const sendNotification: SendNotification = (subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, { ...options, vapidDetails });
    // The Admin SDK's Firestore is a superset of the minimal interface tick.ts is written against.
    const db = getFirestore() as unknown as FsDb;
    const result = await runTick({ db, sendNotification, log: logger });
    const busy = Object.values(result).some((n) => n > 0);
    if (busy) logger.info('tick', result);
  },
);
