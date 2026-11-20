# Tasks

A personal calendar for task names, styled after Notion's full-page calendar. It installs to the
iPhone Home Screen as a full-screen app, works offline, and syncs across devices through your own
Firebase project.

> Personal project. Not affiliated with or endorsed by Notion Labs.

## What it does

- **Calendar**: a continuous month grid (Monday-first by default) with a Week view. Hover a day and
  click **+** to add a task there. Tasks show as Notion-style cards.
- **Inbox** (right): type tasks to get them out of your head. Each one becomes a bubble you can drag
  onto a day.
- **Tasks list** (left): Overdue, Today, Tomorrow, each of the next days, Later and Completed. Tick a
  task to complete it everywhere, with **Undo** and a Completed log to restore it.
- **Overdue never hides.** Missed one-time tasks stay on their day, tinted red, under **Overdue**, with
  **Move all to today**. Repeating tasks don't pile up as overdue.
- **Every name stays visible on iPhone.** The phone grid wraps full task names and grows each row.
  It never shows "+3 more".
- **Open a task** for a Notion-style peek with date, optional time, multi-day range, repeat rule and
  reminder. On a phone the peek is a bottom sheet.
- **Reminders and badge**: a morning summary plus alerts at task times, set per task. The app icon badge
  counts today's open tasks plus overdue ones. These are delivered by Web Push from a scheduled Cloud
  Function, so they arrive even when the app is closed.
- Light and dark themes follow the system, with a manual toggle. Keyboard shortcuts work on desktop.

### On iPhone

The calendar is the home screen. Pull up the **Inbox** sheet from the bottom, long-press a bubble, and
drop it on a day. Swipe from the left edge, or tap ☰, for the Tasks list.

### Keyboard (desktop)

| Key | Action |
|---|---|
| `t` | Jump to today |
| `←` / `→` | Previous / next month or week |
| `m` / `w` | Month / week view |
| `n` | Type in the Inbox |
| `[` / `]` | Toggle the Tasks list / the Inbox |
| `⌘Z` / `Ctrl+Z` | Undo (says what it undid) |
| `⌘⇧Z` / `Ctrl+Shift+Z` | Redo |
| `Esc` | Close the top overlay |

## Set it up

Follow **[docs/DEPLOY.md](docs/DEPLOY.md)**. It takes about 20 minutes and covers:

- creating a Firebase project on the Blaze plan with a $1 budget alert;
- generating the push keys;
- deploying the app;
- creating your account and **allowlisting** it (`allow/<your user id>` in Firestore);
- installing it on your iPhone with Safari → Share → **Add to Home Screen**.

Your data stays in your own Firebase project, and the Firestore rules let only allowlisted accounts
read or write their own data.

## Develop

Requires Node.js 22 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
```

Without Firebase values in `.env`, the app runs in **local mode**. There is no sign-in, and data is
stored in that browser (IndexedDB). That's enough for working on the UI.

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript across the app, service worker, tooling and E2E |
| `npm test` | Unit tests (domain logic, store, data layer, reminder function) |
| `npx playwright test` | End-to-end tests on desktop Chromium and an emulated iPhone 13 (WebKit) |
| `npm run build` | Production build into `dist/` (app, service worker, manifest, icons) |
| `npm run icons` | Regenerate the app icons and iOS splash screens (`scripts/generate-icons.mjs`) |

### Layout

```
shared/      Pure domain logic shared by the app, service worker and functions:
             dates, recurrence, occurrences, grouping, layout, reminders, formatting
src/data/    Firestore repo (offline cache, field-level merges), local IndexedDB repo, auth
src/store/   zustand store: actions, undo, selectors, clock
src/dnd/     Drag and drop (dnd-kit) with mouse, long-press touch and keyboard
src/components/  Calendar, Inbox, Tasks list, peek, pickers, settings, UI primitives
src/sw.ts    Service worker: precache, push, notification clicks, badge
functions/   Cloud Function `tick`: reminders and morning summary over Web Push
e2e/         Playwright tests
SPEC.md      The design and behaviour spec the app is built against
```

Never commit `.env`, `functions/.env` or `.firebaserc`; they are git-ignored. The VAPID private key
lives only in Firebase Secret Manager.
