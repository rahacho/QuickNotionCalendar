# pwa (PWA / push / backend) — notes for other agents

## Action needed (shell agent / integrator)
- **Mount `<InstallHint />` once at the top level of `src/App.tsx`, next to `<UpdatePrompt />`** (outside the
  auth/loading switch, so it also shows on the sign-in screen). It is self-contained: a floating card portaled
  to `<body>`, fixed under the header (`top: safe-top + header-h + 8px`), `z-index: var(--z-sheet)` (above the
  calendar and the Inbox sheet, below the drawer, peek, popovers and toasts). It renders only on iPhone/iPad
  **Safari** that isn't running from the Home Screen, slides in after 1.2 s, hides during drags, and remembers
  a dismissal in localStorage (`tasks.installHint.dismissed`). `data-testid="install-hint"` / `install-hint-dismiss`.
  Not mounting it is harmless; Settings → Notifications already explains the install step for `needs-install`.

## What `useBadgeSync()` does (App already calls it once)
- Sets the app-icon badge to `useBadgeCount()` (today's open + overdue) when the Badging API exists and is
  permitted. It is skipped until `tasksLoaded`, set to 0 when signed out, and re-applied when the app becomes visible.
- Listens to service-worker messages:
  - `{type:'open', url}` (notification tapped while the app is open) → opens that task's peek. `occ` may
    be the original rule date or the moved-to date; it waits up to 6 s for the task to sync, else toasts
    "That task no longer exists". (A cold launch still goes through App's own `?task=&occ=` deep link.)
  - `{type:'push-subscription-changed'}` → re-saves this device's Firestore doc.
- Device upkeep after the first snapshot of each signed-in account: if push was enabled on this device, it
  renews a lost or stale-key subscription and re-saves `users/{uid}/devices/{deviceId}` when the endpoint
  or account changed, or at least weekly.

## `@/push` API (stub API kept exactly; extras marked +)
`PushState`, `pushConfigured`, `usePushState()`, `enablePush()` (call **synchronously from the click**: the
permission prompt is requested before any await), `disablePush()`, `useBadgeSync()`,
`showLocalTestNotification()` (asks for permission itself if it's still "default"),
+`refreshPushState()`, +`getDeviceId()` (localStorage `tasks.deviceId`, uuid).
- `pushConfigured` = Firebase mode && `VITE_VAPID_PUBLIC_KEY` is a valid 65-byte P-256 key.
- States: `unsupported` (also when !pushConfigured) · `needs-install` (iOS ≥ 16.4 in a browser tab) ·
  `default` · `denied` · `subscribed` · `error` (the last enable/upkeep failed; cleared by a later success).
  State re-checks when the page becomes visible and on Permissions API changes.
- Firestore offline: `saveDevice` is awaited for up to 8 s and then treated as queued, so the UI never hangs.
- Headless Playwright Chromium reports `Notification.permission === 'denied'`, so the state reads `denied` there.
  The old headless shell also crashes on `setAppBadge` inside a service worker. Use `channel: 'chromium'` for any push e2e.

## Service worker (`src/sw.ts` → `dist/sw.js`)
- Precache: all JS/CSS/HTML (Firebase SDK chunks included, so a cold offline launch works) + icons + manifest.
  iOS splash images are not precached. Navigation fallback goes to `index.html`, except `/__/*` and file-like paths.
- Prompt-based updates. `UpdatePrompt` shows "A new version is available · Reload" (30 s toast, which returns on the
  next foreground if ignored). Other open tabs get "Tasks was updated · Reload" instead of a surprise reload.
- push → always calls `showNotification` (title/body/tag/data.url, icon `/pwa-192.png`, badge `/badge-96.png`,
  `renotify` when tagged) and `setAppBadge(badge)`. Malformed payloads still show a notification. A foreign
  `url` is replaced with the app root.
- Message protocol: `src/push/messages.ts` (shared by the SW and the page; no DOM/WebWorker types).

## Backend
- `functions/` (own package; `npm --prefix functions install|run build|test`). `tick` runs every minute in
  us-central1 and sends reminders plus the morning summary. Each send is guarded by a conditional write on the
  doc's `updateTime`, so overlapping ticks or a concurrent client edit can't double-send. It skips sends more
  than 15 min late (but still advances), and prunes device docs on 404/410. Tests: `functions/src/tick.test.ts`
  (they run under the root `npm test`; no functions deps are needed for them).
- Payloads: reminder `{title: task title, body: "Today at 3:00 PM" | "Tomorrow" | "Tue, Nov 24 at 9:05 AM" |
  "Nov 20 → 22", tag: task-<id>-<occ>, url: /?task=<id>&occ=<origDate|date>}`; summary `{summaryText(),
  tag: summary-<today>, url: '/'}`. Both carry `badge = badgeCount(open tasks, today)`.
- Store agent FYI: the function reads `users/{uid}/tasks where done == false` for badge and summary, plus per
  allowlisted user `tasks where remindAt <= now` and `tasks where syncedAt > now − 20 min`. It writes only
  `remindAt` + `syncedAt` on tasks, and `summaryAt` / `summarySentAt` / `sweptAt` / `sweptTz` on users (no `updatedAt` bump).
- `firestore.rules`: allowlisted owner only. Tasks: `title is string && size ≤ 500`, `id == docId` when present,
  `remindAt`/`updatedAt` number|null, `syncedAt` a timestamp when present, `overrides` is a map. Devices: https endpoint plus both keys. User doc:
  `summaryAt`/`updatedAt` number|null, `settings` is a map. Other subcollections under the user: owner-only.
  **Not run against the emulator** (no firebase-tools/Java here).

## Known platform limits (not bugs)
- If you sign out and sign in as a different account on the same device, that device stays registered under
  the old account too. The old account can't be written after sign-out, and its doc is pruned only when the
  push service rejects the endpoint.
- A task edited in the < 1 min window between its reminder time and the next tick gets `remindAt` recomputed
  past "now" by the client, so that one alert is skipped. This is deliberate: the alternative risks a duplicate.

## Resolved by integration
- `<InstallHint />` is mounted once in `App.tsx` next to `<UpdatePrompt />` (outside the auth/loading switch; removed
  from the Tasks sidebar footer). It also steps aside while the phone Inbox sheet is raised.
- Sign-out calls `disablePush({ resumeOnSignIn: true })` first (bounded to 3s) when this device is subscribed. That
  sets localStorage `tasks.push.resumeOnSignIn` (only if push was on here); the next sign-in's upkeep re-subscribes and
  saves the device, then clears it. If WebKit refuses the subscribe without a gesture, the state is 'error' (Settings:
  "Try again") and the Tasks list footer shows "Reminders are off on this device · Turn on" (`push-off-hint`, shown
  whenever push is default/denied/error while the summary is on or a task alerts on its own). A plain `disablePush()`
  (Settings → Turn off) clears the flag.

## Review fixes (core)
- **Allowlist.** firestore.rules only let ALLOWLISTED accounts (a document `allow/{uid}` created by the owner in the
  console; clients may read their own entry, nobody may write it) read/write `users/{uid}/**`. The tick serves only
  allowlisted accounts, with PER-USER queries (`users/{uid}/tasks where remindAt <= now`, ≤ 200) instead of one
  collection-group query — another account can no longer starve the owner's reminders or make the function POST to
  its endpoints. docs/DEPLOY.md step 10 creates `allow/<your uid>`; a tasks/user listener refused with
  permission-denied reports "Couldn't sync — this account isn't allowlisted yet (docs/DEPLOY.md, step 10)".
- **Sweep** per user (`sweptAt` on the user doc; hourly at first, now daily + the per-minute recent-writes repair, see Gap fixes): every open task's remindAt is re-derived from the merged doc and
  missing/too-late values are lowered (`repairedRemindAt`). summaryAt that disagrees with the settings (e.g. null while
  the summary is on) is repaired every tick. No Firestore triggers (their region must match the database location).
- **No duplicate alerts:** what was sent is recorded in `users/{uid}/fired/{taskId}` `{at, occs, expireAt}` (admin only;
  rules deny clients; TTL policy on `fired.expireAt` in firestore.indexes.json). A client write queued offline / an
  undo restore that re-arms an already-fired instant is not sent again.
- **Catch-up:** a late tick sends every non-stale (≤ 15 min) alert of a task in (stored, now], up to 5, each with its
  own tag. TickResult gained `duplicatesSkipped` and `repaired`.
- `.gitignore`: `.firebaserc`, `.env.*` (not `.env.example`), `functions/.env*`, `*.local`, `.secret.local`,
  `.runtimeconfig.json`, service-account JSON files.

## Gap fixes (core, after review)
- **remindAt is repaired on write, server-side.** The hourly sweep left a window (a merge landing between sweeps with
  no app open lost its alert). Now every client task write stamps `syncedAt = serverTimestamp()` (FirestoreRepo
  commit), and each tick first re-derives remindAt for every task written in the last `FEED_MS` (20 min) from the
  MERGED doc, computed from the moment the write landed (so an alert due seconds after a stale write is still
  armed and sent by the same tick; a clock-ahead device that thought the alert had passed is corrected too). Due
  values are never touched (the reminder step owns them). The tick's own task writes also stamp `syncedAt` so the
  feed never re-arms what it just handled. The full sweep is now DAILY (+ immediately when `settings.timezone`
  differs from `sweptTz`). No Firestore triggers (no region coupling, no Eventarc setup). Reads: see DEPLOY step 5.
- **Fired marker = exact pairs.** `users/{uid}/fired/{taskId}` is `{ sent: [{at, occ}], expireAt }` (pairs of the
  last ~16 min; the earlier `{at, occs}` shape is still read). Only an exact (occurrence, instant) already sent is
  skipped — an earlier alert of another occurrence that never went out (moved before it while offline) is sent.
- **One summary per instant.** The claim that sends a summary records `summarySentAt` on the user doc; a due
  summaryAt ≤ it (re-armed by a device whose clock is behind) is advanced without sending (`duplicatesSkipped`).
  The client only re-arms a MISSING summaryAt now; every other mismatch is left to the tick (repaired each minute).
