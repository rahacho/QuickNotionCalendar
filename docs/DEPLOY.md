# Deploying Tasks

This guide takes you from zero to Tasks running as an app on your iPhone (and any other device),
synced through your own Firebase project, with reminders and a morning summary.

It takes about 20 minutes. Everything runs in **your** Google account. For one person the usage stays
inside Firebase's free allowances, but the project has to be on the pay-as-you-go **Blaze** plan
because scheduled Cloud Functions require it. Step 5 sets a budget alert so you'd hear about any cost.

> Commands run from the project folder (`QuickNotionCalendar/`) unless stated otherwise.
> You need **Node.js 22 or newer** (`node -v`).

---

## 1. Install the Firebase CLI and sign in

```bash
npm install -g firebase-tools
firebase login
```

## 2. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project** → name it (e.g. `tasks-yourname`).
   Google Analytics is not needed, so you can turn it off.
2. Note the **Project ID** shown under the name, e.g. `tasks-yourname`. Your app will live at
   `https://<project-id>.web.app`.
3. Point this folder at the project:

   ```bash
   cp .firebaserc.example .firebaserc
   ```

   Then replace `your-firebase-project-id` in `.firebaserc` with your Project ID.
   (Running `firebase use --add` and picking the project works too.)

## 3. Enable Email/Password sign-in

Console → **Build → Authentication** → **Get started** → **Sign-in method** → **Email/Password** →
turn on **Enable** (leave "Email link" off) → **Save**.

You will create your account from the app in step 10 and then **allowlist** it: only accounts listed
in Firestore under `allow/<user id>` can read or write anything, and only they get reminders. After
that, stop anyone else from creating accounts: **Authentication → Settings → User actions** → untick
**Enable create (sign-up)**. Other accounts could never read your data, but this keeps the project
yours alone.

## 4. Create the Firestore database

Console → **Build → Firestore Database** → **Create database**:

- **Location**: pick the region closest to you, e.g. `nam5 (United States)` or `eur3 (Europe)`.
  **You can't change this later.**
- **Security rules**: choose **production mode**. The real rules (owner-only access) are deployed in step 9.

## 5. Upgrade to the Blaze plan and set a budget alert

Console → the plan badge at the bottom left (**Spark**) → **Upgrade** → **Blaze** → link or create a
billing account.

Then set an alert: Google Cloud console → **Billing → Budgets & alerts** → **Create budget** →
amount **$1** → keep the default email alerts.

Blaze is needed for Cloud Functions, Cloud Scheduler (the every-minute reminder check) and Secret
Manager (holds the push signing key). What the reminder function reads, for one account:

- about **6,000 reads a day** for the every-minute checks themselves (4 small queries a minute);
- about **20 reads per task you add or change** (a changed task is re-checked every minute for 20 minutes);
- for every reminder or morning summary sent, **one read per open task** (to count the app badge), plus
  about 20 for a reminder (its task counts as changed);
- once a day, **one read per open task** (a safety check of every reminder).

So with a few hundred open tasks and about ten reminders a day, expect roughly 10,000–15,000 reads a
day; with 1,000 open tasks and 20 reminders, about 30,000. Writes are a few dozen a day. All of this
fits in the free allowance (50,000 reads and 20,000 writes a day), plus one scheduler job.

## 6. Register the web app and fill in `.env`

1. Console → **Project settings** (gear icon) → **General** → **Your apps** → the **Web** icon (`</>`) →
   nickname `Tasks` → leave "Firebase Hosting" unticked → **Register app**.
2. Firebase shows a `firebaseConfig` object. Create your env file:

   ```bash
   cp .env.example .env
   ```

   Then copy each value from `firebaseConfig` into `.env`:

   ```dotenv
   VITE_FIREBASE_API_KEY=AIza...
   VITE_FIREBASE_AUTH_DOMAIN=tasks-yourname.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=tasks-yourname
   VITE_FIREBASE_STORAGE_BUCKET=tasks-yourname.firebasestorage.app
   VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890
   VITE_FIREBASE_APP_ID=1:1234567890:web:abc123
   VITE_VAPID_PUBLIC_KEY=        # filled in step 7
   ```

   These values are not secrets because they ship inside the web app. Your data is protected by the
   Firestore rules and sign-in.

## 7. Create the push-notification keys (VAPID)

Web Push signs each notification with a key pair that you generate once:

```bash
npm --prefix functions install
npx --prefix functions web-push generate-vapid-keys
```

It prints a **Public Key** and a **Private Key**. Then:

1. **Public key → the web app.** In `.env`:

   ```dotenv
   VITE_VAPID_PUBLIC_KEY=<Public Key>
   ```

2. **Public key → the function.** Create `functions/.env` containing:

   ```dotenv
   VAPID_PUBLIC_KEY=<Public Key>
   # Optional contact URL for push services. Leave it out to use https://<project-id>.web.app
   # VAPID_SUBJECT=https://your-own-domain.example
   ```

3. **Private key → Secret Manager** (it never goes into a file):

   ```bash
   firebase functions:secrets:set VAPID_PRIVATE_KEY
   ```

   Paste the **Private Key** when prompted. If it asks to enable the Secret Manager API, answer **Y**.

Keep the private key out of chats and commits. If you ever generate new keys, update all three
places and redeploy. Every device then has to turn notifications on again.

## 8. Build

```bash
npm install
npm run build
```

This produces `dist/`, which contains the app, `sw.js` (offline support and notifications), `manifest.webmanifest` and the icons.

## 9. Deploy

```bash
firebase deploy
```

This deploys **Hosting** (the app), **Firestore** rules and indexes, and **Functions** (the `tick`
function, which runs every minute and sends reminders and the morning summary). The functions build
runs automatically first.

On the first deploy the CLI may ask to enable several Google Cloud APIs (Cloud Functions, Cloud Build,
Artifact Registry, Cloud Scheduler, Cloud Run, Eventarc, Secret Manager). Answer **Y**. If it asks
about a cleanup policy for container images, accept the default (e.g. 1 day). The first functions
deploy takes a few minutes, and the Firestore index can take a few more minutes to finish building.

When it finishes, the CLI prints **Hosting URL: `https://<project-id>.web.app`**.

## 10. Create your account and allowlist it

1. On the iPhone, open **Safari** and go to `https://<project-id>.web.app`.
2. Choose **Create account**, then enter your email and a password. Use the same account on every device.
   The app opens on **"Couldn't load your tasks — This account isn't allowlisted yet"**: that's expected
   (nothing can be added until the next step, so nothing you type can be lost).
3. **Allowlist the account** (once, from a computer):
   1. Console → **Build → Authentication → Users** → copy your account's **User UID**.
   2. Console → **Build → Firestore Database → Data** → **Start collection** → Collection ID `allow` →
      **Next** → Document ID: paste the **User UID** → add one field, e.g. `owner` (boolean) `true` →
      **Save**.

   Within a minute the app loads on its own (or tap **Try again**) and shows your calendar. The reminder
   function also only serves accounts listed in `allow`.
4. Now turn off sign-ups as described in step 3.

## 11. Install on your iPhone

1. In Safari (still on `https://<project-id>.web.app`, signed in), tap **Share** (the square with an
   up-arrow; on iOS 26 it's under the **•••** button), scroll, tap **Add to Home Screen**, keep the
   name **Tasks**, and tap **Add**.
2. Close Safari and open **Tasks from the Home Screen**. Sign in once more there (Home Screen apps keep
   their own sign-in). From here on it runs full-screen like an app, works offline, and syncs.

## 12. Turn on notifications on the iPhone

Notifications on iPhone need iOS 16.4 or later and only work in the Home Screen app (step 11).

1. In the Tasks app, open **Settings** → **Notifications** → **Enable**, then tap **Allow**.
2. Tap **Send test**. A notification should appear within a second or two.
3. In the iPhone **Settings** app → **Notifications** → **Tasks**, make sure **Allow Notifications**
   and **Badges** are on, so the app icon shows today's open tasks plus anything overdue.
4. In Tasks → Settings, set the **Morning summary** time you want (default 8:00 AM).

Reminders come from your own Firebase project, so they arrive even when the app is closed.

## 13. Other devices (Mac, PC, iPad, Android)

Open `https://<project-id>.web.app` and sign in with the same account. To install it:

- **Chrome / Edge**: click the install icon in the address bar, or open the ⋮ menu → **Install Tasks**.
- **Safari on Mac**: **File → Add to Dock**.
- **iPad**: same as iPhone (Safari → Share → Add to Home Screen).

Then turn on notifications on each device under **Settings → Notifications → Enable**. Every device keeps its
own on/off setting. Tasks sync live across all of them.

---

## Updating the app later

```bash
npm run build
firebase deploy            # or: firebase deploy --only hosting   (when only the app changed)
```

Open apps show **"A new version is available · Reload"**. Tap Reload. It never reloads on its own while
you're working, and the next time the app is fully reopened it starts on the new version anyway.

## Troubleshooting

| Problem | Fix |
|---|---|
| No notifications at all | In Tasks → Settings → Notifications it should say **On for this device**; use **Send test**. On iPhone, the app must be opened from the Home Screen, and Focus or Do Not Disturb can hide alerts. |
| The test works but reminders don't | Check the function's logs: `firebase functions:log --only tick`. Make sure step 7 was completed (`functions/.env` and the secret), then run `firebase deploy --only functions`. |
| "Notifications are blocked" | iPhone: Settings app → Notifications → Tasks → Allow Notifications. Desktop: the site settings (lock icon in the address bar) → Notifications → Allow. |
| The badge number doesn't show | iPhone: Settings app → Notifications → Tasks → Badges. The badge is today's open tasks plus overdue ones. |
| Reminders at the wrong hour | The app takes the time zone from the device it last started on. Open Tasks on the device in your current time zone once. |
| "Couldn't load your tasks — This account isn't allowlisted yet" (or "Couldn't sync — …" with the same reason) | Create the `allow/<your User UID>` document (step 10). The app retries on its own; **Try again** reloads right away. Signed in with the wrong account? Use **Sign out** on that screen. |
| "Couldn't load your tasks" with another reason | Tap **Try again**. If it persists, check your connection and the Firestore quota (Console → Firestore → Usage). |
| "Couldn't sync — …" | Check your connection. Changes made offline are queued and sync when you're back online. |
| "Reminders are off on this device · Turn on" (Tasks list) | Notifications aren't on for this device while you have reminders planned. Tap it, then **Enable**. |
| Index error in function logs | Run `firebase deploy --only firestore:indexes` and wait a few minutes for the index to build. |
| You changed the VAPID keys | Update all three places from step 7, run `npm run build && firebase deploy`, then on each device go to Settings → Notifications → Turn off → Enable. |

## Optional: custom domain

Console → **Hosting** → **Add custom domain**, then follow the DNS steps. Add the same domain under
**Authentication → Settings → Authorized domains**. If you want push services to see that URL, set
`VAPID_SUBJECT=https://your-domain` in `functions/.env` and run `firebase deploy --only functions`.
On iPhone, install the app again from the new address: a Home Screen app is tied to the address it was
added from.

## Optional: local development

- `npm run dev`: with no Firebase values in `.env`, the app runs in **local mode** (no sign-in,
  stored in this browser only). That's handy for trying the UI.
- `npm test`: unit tests, including the reminder function's logic (`functions/src/tick.test.ts`).
- `firebase emulators:start`: local Auth, Firestore, Functions and Hosting (ports are set in `firebase.json`).
