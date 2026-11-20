# store / data — notes for other agents

Everything in SPEC §4.2/§4.3 is implemented with the exact names. Tests: `npx vitest run src/store src/data`
(local repo on fake-indexeddb, a mocked Firestore SDK, and React hook tests in jsdom).

## How writes flow
`actions.*` → compute the next Task (pure) → `sanitizeTask` (invariants of shared/types.ts) → `diffTask` (minimal
field-level patch, overrides per date/field) → `remindAt` recomputed → one `repo.apply` batch → the repo updates the
store **synchronously** (both repos are optimistic) → undo entry. So right after calling an action,
`useStore.getState().tasks` already reflects it (Firestore mode included).

## Behaviors worth knowing (SPEC silent → chosen)
- **Undoable (⌘Z) but no toast:** `createTask`, `createTasksFromText` (one entry for the whole paste), `duplicateTask`,
  `moveOccurrence` (between days), `resizeTask`, `setSchedule`, `setSeriesStart`, `setRecurrence(rule)` when it only
  adds occurrences, `setReminder`, `renameTask` (saves of one task's title within 10 s of each other are ONE step).
  **Undoable + toast:** `setDone(true)` "Task completed", `deleteOccurrence`/`deleteTask` "Task deleted",
  `moveAllOverdueToToday` "Moved N tasks to today", `moveOccurrence(ref, null)` of a dated task "Moved to Inbox",
  `setRecurrence(null)` "Repeat removed", `setRecurrence(rule)` on a series that drops open occurrences within 400 days
  "Repeat changed", `setSeriesTime` on a series "Every repeat is at 7:00 AM now", and making an overdue one-time task
  repeat ("“X” repeats now · the Nov 1 one stays in Overdue"). Phones have no ⌘Z, so anything that unschedules or
  drops planned items gets a toast.
  **⌘Z (`undo()`) always toasts what it undid** ("Undid: added “Buy milk”") with a **Redo** button; `redo()` (⌘⇧Z)
  re-applies the last undone step; any new change clears the redo stack.
- ⌘Z on an entry that has a toast dismisses that toast; a toast's Undo after ⌘Z already undid it is a no-op.
- `deleteOccurrence` / `deleteTask` close the peek themselves when it shows the deleted thing. A finite series whose
  every occurrence gets skipped is deleted outright (Undo restores it).
- `setRecurrence(id, rule, { start })` (existing series only) writes the new start and rule together — one undo entry.
- `setRecurrence(id, null, { keepOrigDate? })` turns the series into a one-time task on: the viewed occurrence
  (`keepOrigDate`, if open and not past) → else the first OPEN occurrence on/after today → else (all ahead checked off)
  the latest done one, completed → else the series start. Overrides are dropped (toast with Undo). Setting a rule on
  a completed one-time task carries the completion to the start occurrence; on an OVERDUE one-time task it keeps the
  missed instance as a one-time copy (still overdue) and the series skips that date (one undo entry).
- `setSchedule` (non-recurring): `endDate` omitted keeps the current end while it is still after the new start; an end
  before the start is swapped; a changed start date puts the card at the end of that day's untimed cards.
  Recurring: a `time` equal to the series time removes the override; `time: null` = explicitly untimed occurrence.
- `resizeTask` swaps an inverted range (dnd may still clamp; both are fine).
- `moveOccurrence` without `pos`: day → end of that day's untimed cards; Inbox → top. A recurring occurrence moved
  back to its original date with no `pos` loses its order override too (entry removed when empty).
- Titles are single-line, trimmed, ≤ 500 chars (Firestore rule) in create/rename/paste.

## Calendar navigation (calendar agent)
- `goPrev/goNext` (month) set `ui.visibleMonth` **immediately** (header updates on click, rapid presses accumulate) and
  issue `scrollRequest {date: 1st of month, behavior: 'smooth', nonce}`. While that programmatic scroll is in flight
  the MonthScroller should not report intermediate months via `setVisibleMonth`, or the title will flicker back.
- `nonce` is globally monotonic (never reused), so "handle when nonce changes" is safe.
- `goToday` (month) also sets `visibleMonth` to today's month. `scrollCalendarTo` in week view also sets `weekAnchor`.
- `setView('week')` anchors to today when the visible month is the current month, else to the visible month's 1st.
  `setView('month')` issues an `instant` scrollRequest to `weekAnchor`.

## Selectors
- Occurrences are **interned**: for an unchanged task, the same `Occurrence` object is returned by every selector and
  across store versions (repos keep unchanged task objects' identity). `React.memo` on cards/rows works by identity.
- `useWeekLayout(days)` caches per tasks version by `days[0]` + length, expands occurrences in shared 8-week chunks,
  and returns the previous layout object for a row whose content didn't change. Pass consecutive dates.
- Non-hook versions for non-React code: `tasksListOf, occurrencesInRangeOf, weekLayoutOf, inboxTasksOf, taskGroupsOf,
  occurrenceOf, badgeCountOf` (all take `useStore.getState().tasks` [+ today]).

## Data
- `getRepo()` from `@/data/boot` (push agent: `getRepo()?.saveDevice(id, doc)`; null when signed out).
- Firebase SDK is only loaded in Firebase mode (dynamic imports in boot.ts / auth.ts); local mode never downloads it.
- `auth.ts` functions throw the Firebase error; show `authErrorMessage(e)`. They throw `app/not-configured` in local mode.
- Sync failures: `store.sync.error` (short reason) + toast "Couldn't sync — <reason>" (same message deduped for 8 s);
  cleared on the next successful write — except a failed LISTENER, which keeps it until it delivers a snapshot again
  (FirestoreRepo re-listens with backoff 1 s → 60 s, at once on `online` / app shown). `store.sync.loadFailed`: the
  tasks listener failed before any task data arrived (show "Couldn't load your tasks", not an empty calendar).
  `store.sync.pendingWrites/fromCache` mirror Firestore snapshot metadata.
- Local mode storage (E2E seeding if needed): IndexedDB db `tasks-local-default`, object store `kv`, keys
  `task:<id>` (full Task), `user` (UserDoc). Other tabs update live via BroadcastChannel `tasks-local-default`.
- Per-device prefs: localStorage `tasks.theme` (raw string) and `tasks.ui` (JSON: view, leftOpen, rightOpen,
  collapsedGroups).

## Extra exports (beyond SPEC)
- `@/data/boot`: `connectRepo(repo, isActive?)` (wires any repo into the store; used by tests).
- `@/data/localRepo`: `createLocalRepo()` returns `LocalRepo` = `Repo & { flush(): Promise<void> }`. Once hydrated it
  creates each write's IndexedDB transaction synchronously inside `apply()` and calls `commit()` on it: with the old
  promise-chained open, a reload within a few ms of a change lost it (3 of 10 immediate reloads in Chromium).
- `@/data/taskDoc`: pure helpers (`normalizeTask`, `sanitizeTask`, `diffTask`, `applyOps`, `cleanTitle`, …).
- `@/data/env`: `firebaseConfigured`, `firebaseOptions` (no SDK import). `@/data/errors`: `syncErrorReason`.
- `@/store/actions`: `resetSession()` (boot uses it on sign-in/out). `@/store/store`: `createInitialState()`, `initialSettings()`.
- `@/store/__tests__/helpers.ts`: `setup()` gives a fresh store + LocalRepo for any component test.

## Review fixes (core)
- **remindAt / summaryAt are derived** and written per device from its own copy, so a field-level merge could leave
  them pointing too late (silent lost reminder). Now: boot's time-zone sync runs only on SERVER data (tasks + user doc
  `fromCache: false`, `subscribeUser` passes `SnapshotMeta`), compares against the stored zone (a missing one reads as
  'UTC', like the function), and re-runs on resume/focus when the DEVICE changed zone (travel; a device that didn't move
  never fights the zone another device set). Server-confirmed snapshots (no pending writes) get missing/too-late
  `remindAt` lowered (`repairedRemindAt` in shared/reminders.ts; never touches due or too-early values) and an
  inconsistent `summaryAt` re-armed (now: only a missing one, see Gap fixes). The scheduled function repairs
  recently written tasks every minute and sweeps daily (notes/pwa.md).
- **FirestoreRepo.apply** is no longer one atomic batch: writes are queued and committed once per microtask, one batch
  per UPDATED document (sets/deletes still packed ≤ 450) — one task deleted elsewhere can't sink the others, and
  back-to-back writes to one task (rename + delete, setSeriesStart + setRecurrence) are one commit/snapshot (no flicker).
  `dispose()` flushes the queue first. A remindAt-only update of a task that's gone is not reported.
- A failed listener no longer leaves the app silently unsynced (see Sync failures above); writes made after a failure
  before any data still show up.
- New: `setSeriesTime(taskId, time)` (whole series; drops per-occurrence times equal to it), `redo()`,
  `showMoreCompleted()` + `ui.completedLimit` (default `COMPLETED_PAGE` = 50; `taskGroupsOf(tasks, today, limit)`).
- Multi-line paste strips a leading "1. " / "1) " only when the block is a list (≥ 2 numbered lines, or one among
  bulleted lines); never 4 digits ("2027. Budget review" stays).

## Gap fixes (after review)
- `boot.ts`: a tasks-listener failure before any data sets `sync.loadFailed` but leaves `tasksLoaded` false (a
  local write echoed by the repo doesn't count as loaded); only the TASKS listener sets it. App renders
  `LoadFailedFrame` ("Couldn't load your tasks", reason, Try again = reload, Sign out) — never an empty calendar —
  and the calendar appears by itself when a snapshot arrives. Nothing can be typed there, so a not-yet-allowlisted
  account can't lose tasks the server refuses. `repairSummaryAt` only re-arms a NULL summaryAt (see notes/pwa.md).
- Every Firestore task write carries `syncedAt: serverTimestamp()` (not part of Task; normalizeTask ignores it).
- **Out-of-order Undo** (`restore(entry, outOfOrder)`, used by toast Undo buttons): when later, still-undoable
  entries touched the same task, only that step's change is taken back (`withoutStep`: diffTask(after → before)
  applied to the current doc; "after" = the next later entry's snapshot) and the later entries' snapshots are
  rebased the same way (`undoEntriesAfter` / `rewriteUndo` in undo.ts), so ⌘Z can't bring the change back. Later
  snapshots of a task the step created are dropped (entries left empty are removed, their toasts dismissed).
- `renameTask` merges into the open rename step only while the task is still the object its last save produced.
- `clearRedo()` / `clearUndo()` return the dropped entries; a new change dismisses their "Undid: … · Redo" toasts
  (a Redo button never silently does nothing); `resetSession` dismisses undo/redo toasts too.
- B5 round trip: `setRecurrence(id, null)` on a series that is exactly what the overdue conversion made (only its
  start skipped) with its one-time copy still open & unchanged on that date (`missedCopyOf`) folds back into the one
  original overdue task (copy deleted; one undo step) instead of leaving the copy plus a second task.
