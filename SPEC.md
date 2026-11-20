# Tasks — product & engineering spec

A personal, installable PWA that looks and feels exactly like **Notion's full-page Calendar view**, used to
schedule *task names* (never notes pages). Syncs across iPhone + other devices via Firebase.
Home-screen name: **Tasks**.

> North star (from the owner): *scope and confidence that everything I've planned is visible and nothing is
> forgotten or left behind.* When in doubt, favor visibility of every planned task over compactness.

---

## 1. Product decisions (locked — do not change)

| Area | Decision |
|---|---|
| Sync | Firebase: Firestore (persistent offline cache), Auth (email + password), Hosting, Cloud Functions (reminders). |
| Theme | Follow system + manual override (System / Light / Dark), per device. Notion light & dark palettes. |
| Layout | Desktop: **Tasks list (left) · Calendar (center) · Inbox (right)**. Phone: calendar is home; Inbox is a pull-up bottom sheet; Tasks list is a left drawer. |
| Calendar | Notion month grid, **continuous vertical scroll by weeks** (like Notion), Month ⇄ Week toggle. Week starts Monday (setting allows Sunday). "Manage in Calendar" button removed. Hover "+" on a day adds a task inline. |
| Phone grid | **Full-name grid**: every task shows its full name in small wrapped text; rows grow; never "+N more". Landscape phone shows regular-size cards. |
| Task | Title + date (or none = Inbox) + optional end date (multi-day) + optional time + optional repeat + reminder. No notes/body. |
| Open task | Notion **center peek** (phone: bottom sheet) with title + properties: Date, Repeat, Remind, Done, Created; actions Move to Inbox, Delete. |
| Check off | Card vanishes from calendar + list with animation, **Undo toast** (5 s), kept in a collapsible **Completed** group (restore by unchecking). |
| Overdue | One-time tasks whose (end) date < today and not done: stay on their day with **red tint** + listed in **Overdue** group at top of Tasks list + "Move all to today". **Recurring occurrences never go overdue.** |
| Tasks list groups | Overdue · Today · Tomorrow · each of the next days up to today+7 (only days with tasks, titled by weekday) · Later (collapsed) · Completed (collapsed). |
| Inbox | Type + Enter → bubble appears **directly under the input** (newest first). Paste multi-line → one bubble per line. Drag bubbles onto days; drag calendar cards back into Inbox; reorder by drag. |
| Recurring | Daily / weekdays / weekly(byWeekday) / monthly (day-of-month, clamped to month end) / yearly; interval; ends never / until / count. Drag/check/date-edit affect **only that occurrence**; title edits apply to the series; Repeat edits apply to the series. Multi-day tasks cannot repeat. |
| Reminders | Morning summary push at a chosen time (default 08:00, e.g. "4 tasks today · 2 overdue"). Timed tasks alert at their time by default; per-task Remind override (none / N min before / at a clock time N days before). |
| Badge | Home-screen icon badge = today's open tasks + overdue count. |
| Extras | Keyboard shortcuts (desktop), drag-to-reorder, offline-first. NOT included: color labels, search, notes. |

---

## 2. Architecture

```
shared/           Pure TS domain logic (NO react/firebase imports). Used by app, service worker, functions.
  types.ts        ← contract (exists; do not change shapes without integration sign-off)
  dates.ts  recurrence.ts  occurrences.ts  ordering.ts  grouping.ts  layout.ts  reminders.ts  format.ts
src/
  main.tsx  App.tsx
  styles/tokens.css (exists) global.css
  data/           firebase init, repos (Firestore + Local), auth, boot
  store/          zustand store, actions (all mutations), selectors, undo, clock
  dnd/            dnd-kit provider, sensors, collision, overlay, autoscroll, hooks
  hooks/          useLayoutMode, useMediaQuery, useHotkeys, useIsStandalone, useReducedMotion, useTheme
  lib/            cx.ts, ids.ts, platform.ts
  push/           web-push subscribe/unsubscribe, badge sync
  pwa/            SW registration + update toast, InstallHint
  sw.ts           service worker (precache + push + notificationclick)
  components/
    ui/           primitives (Button, IconButton, Checkbox, Toggle, Popover, Menu, Modal, Sheet, Toaster, Tooltip, TextInput, Kbd, Icon)
    card/         TaskCard (shared by calendar, inbox, drag overlay)
    layout/       AppShell (responsive 3-panel / drawer / sheet slots), Drawer
    calendar/     CalendarView, CalendarHeader, MonthScroller, WeekRow, DayCell, MultiDayBar, WeekView, InlineComposer
    tasks/        TasksSidebar (left list), groups, rows, sync footer
    inbox/        InboxPanel (desktop), InboxSheet (phone), InboxInput, InboxList
    peek/         TaskPeek (center peek + phone sheet), PropertyRow, TitleEditor
    pickers/      DatePicker, MiniCalendar, TimeInput, RepeatEditor, ReminderMenu
    settings/     SettingsModal
    auth/         AuthScreen
    quickadd/     QuickAddSheet (phone: tap empty day → add)
functions/        Cloud Functions (Node 22, TS, esbuild-bundled incl. ../shared)
e2e/              Playwright specs
public/           icons, apple-touch-icon, splash
```

Path aliases: `@/…` → `src/…`, `@shared/…` → `shared/…` (vite + tsconfig).
Stack: React 19, Vite 8, TypeScript 7 (strict, `noUncheckedIndexedAccess`), zustand 5, date-fns 4 (+ @date-fns/tz
in shared/reminders), @dnd-kit/core 6 + sortable 10, motion 14 (`import { motion, AnimatePresence } from 'motion/react'`),
@floating-ui/react, lucide-react icons, fractional-indexing, firebase 13, vite-plugin-pwa 2 (injectManifest), workbox 7.
**These versions may be newer than your training data — verify APIs against `node_modules/**/*.d.ts` before use.**

Styling: **CSS Modules** (`Foo.module.css`) + the tokens in `src/styles/tokens.css`. Never hard-code a color,
shadow, or duration — always `var(--…)`. Theme = `<html data-theme="light|dark">` (resolved).

---

## 3. Data model & sync

Types: see `shared/types.ts` (authoritative). Firestore layout:

```
users/{uid}                     UserDoc { settings, summaryAt, updatedAt }
users/{uid}/tasks/{taskId}      Task (id duplicated inside doc)
users/{uid}/devices/{deviceId}  DeviceDoc (Web Push subscription)
```

Rules: owner-only read/write on `users/{uid}` and everything beneath, for ALLOWLISTED accounts only (`allow/{uid}`, created by
the owner in the console; docs/DEPLOY.md) (plus light shape validation on tasks: `title is string && title.size() <= 500`,
numeric `remindAt`, timestamp `syncedAt`). `users/{uid}/fired/*` is the function's own (no client access).
Indexes: `tasks.remindAt` ASC (collection scope: the function queries each user's tasks); **exempt `overrides` from indexing**
(map can grow large); TTL on `fired.expireAt`.

Sync semantics:
- **Optimistic & offline-first.** UI never awaits a write. Firestore `persistentLocalCache` + `persistentMultipleTabManager`;
  `onSnapshot(..., { includeMetadataChanges: true })` drives the store, so local writes show instantly and queued writes
  survive reloads/offline.
- **Field-level last-write-wins**: every mutation is an `updateDoc` of only the changed top-level fields, and
  per-occurrence override changes use `FieldPath('overrides', date, field)` so two devices editing different
  occurrences/fields never clobber each other. Full-doc `setDoc` only for create and undo-restore.
- Every write sets `updatedAt = Date.now()` and recomputes `remindAt` (shared/reminders.ts) with `settings.timezone`.
- `remindAt` is DERIVED but written as its own field, so a field-level merge of two devices' edits (or a write computed
  from a stale offline copy, or by a device whose clock is off) can leave it wrong. Every task write therefore also stamps
  `syncedAt = serverTimestamp()` (Firestore only; not part of `Task`), and the scheduled function re-derives remindAt from
  the MERGED document of every task written in the last 20 minutes (§7). Server-confirmed snapshots on an open client are
  repaired the same way right away (boot.ts).
- Local mode: when `VITE_FIREBASE_API_KEY` is unset (dev/E2E), the app skips auth and uses `LocalRepo`
  (IndexedDB via idb-keyval + BroadcastChannel for cross-tab), uid `"local"`. Same Repo interface.

---

## 4. Module contracts (implement EXACTLY these exports; add private helpers freely)

### 4.1 shared/ (pure, 100% unit-tested with vitest)

```ts
// dates.ts — all ISODate math is calendar math on "YYYY-MM-DD" strings; never via UTC Date pitfalls.
export function toISODate(d: Date): ISODate                 // local calendar date of a JS Date
export function parseISODate(s: ISODate): Date              // local midnight
export function isValidISODate(s: string): boolean
export function addDays(d: ISODate, n: number): ISODate
export function addMonths(d: ISODate, n: number): ISODate   // clamps day to month end
export function diffDays(a: ISODate, b: ISODate): number    // a - b in whole days
export function compareDates(a: ISODate, b: ISODate): number
export function minDate(a: ISODate, b: ISODate): ISODate; export function maxDate(a, b): ISODate
export function weekday(d: ISODate): Weekday
export function startOfWeek(d: ISODate, weekStart: 0 | 1): ISODate
export function startOfMonth(d: ISODate): ISODate; export function endOfMonth(d: ISODate): ISODate
export function daysInMonth(year: number, month1: number): number
export function eachDay(from: ISODate, to: ISODate): ISODate[]          // inclusive
export function weekDates(weekStartDate: ISODate): ISODate[]            // 7 dates
export function isHM(s: string): boolean
export function hmToMinutes(t: HM): number; export function minutesToHM(m: number): HM
export function todayISO(now?: Date): ISODate

// recurrence.ts
export function normalizeRecurrence(rule: Recurrence, start: ISODate): Recurrence  // sorted unique byWeekday default [weekday(start)], interval>=1, until/count exclusive
export function occurrenceDates(rule: Recurrence, start: ISODate, from: ISODate, to: ISODate): ISODate[] // rule dates in [from,to] (inclusive), >= start, honoring until/count (count counted from start)
export function isRuleDate(rule: Recurrence, start: ISODate, date: ISODate): boolean
export function nextRuleDate(rule: Recurrence, start: ISODate, onOrAfter: ISODate): ISODate | null
export function describeRecurrence(rule: Recurrence, start: ISODate): string
//   "Every day" | "Every 2 days" | "Every weekday" | "Every week on Thursday" | "Every week on Mon, Wed" |
//   "Every 2 weeks on Mon" | "Every month on the 19th" | "Every year on Nov 19" (+ ", until Dec 31, 2026" | ", 10 times")
// Weekly interval>1: weeks counted Monday-based from the week containing start. Monthly: day-of-month of start,
// clamped to last day (31st → Feb 28/29). Yearly: month/day of start, Feb 29 → Feb 28 in non-leap years.
// Start date is an occurrence only if it matches the rule (UI defaults byWeekday to include it).

// occurrences.ts
export function occKey(taskId: string, origDate: ISODate | null): string     // "id" | "id@2026-11-19"
export function parseOccKey(key: string): OccurrenceRef
export function refOf(occ: Occurrence): OccurrenceRef
export function occurrencesInRange(tasks: Iterable<Task>, from: ISODate, to: ISODate, opts?: { includeDone?: boolean }): Occurrence[]
//   all scheduled occurrences overlapping [from,to]: non-recurring tasks (date!=null) and expanded recurring ones
//   (rule dates + overrides: skipped removed, moved-in ones found even when origDate is outside range, done flag/time/order applied).
//   includeDone default false.
export function getOccurrence(task: Task, origDate: ISODate | null): Occurrence | null   // null if not a valid occurrence
export function inboxTasks(tasks: Iterable<Task>): Task[]          // date==null && !done, sorted by order asc then id
export function isOverdue(occ: Occurrence, today: ISODate): boolean // !recurring && !done && date!=null && endDate < today

// ordering.ts
export function keyBetween(a: string | null, b: string | null): string   // fractional-indexing generateKeyBetween; robust if a>=b (falls back sensibly, never throws)
export function keyAtStart(firstKey: string | null): string; export function keyAtEnd(lastKey: string | null): string
export function compareInDay(a: Occurrence, b: Occurrence): number
//   multiDay first (earlier start, then longer) → untimed (by order) → timed (by time, then order) → key
export function compareInbox(a: Task, b: Task): number                  // order asc, then id

// grouping.ts
export function buildTaskGroups(tasks: Iterable<Task>, today: ISODate, opts?: { horizonDays?: number /*7*/, completedLimit?: number /*50*/ }): ListGroup[]
//   Order: overdue, today, tomorrow, day:YYYY-MM-DD (today+2..today+horizon, only non-empty, title = weekday name,
//   subtitle "Nov 21"), later, completed. Empty groups omitted EXCEPT none required. Rules:
//   - Inbox tasks excluded. Done excluded except in completed.
//   - Overdue: isOverdue (non-recurring only), sorted by date then compareInDay. meta "Nov 12" (+" · 3:00 PM").
//   - A multi-day task appears ONCE: in the group of max(date, today) (e.g. active today → Today, meta "Nov 18 → 21").
//   - Recurring: each occurrence in today..today+horizon appears in its day group; past undone occurrences do not appear anywhere.
//   - Later (collapsible, default collapsed): non-recurring with date > today+horizon (sorted by date) + for each recurring
//     series with NO occurrence in the window, its next occurrence. meta "Dec 5".
//   - Completed (collapsible, default collapsed): done non-recurring + done recurring occurrences, by doneAt desc,
//     truncated to completedLimit; count = total. meta "Nov 18".
//   - Today/Tomorrow titles "Today"/"Tomorrow", subtitle "Thu, Nov 19". Timed items meta "3:00 PM". Recurring items carry no extra meta.

// layout.ts
export function layoutWeek(days: ISODate[], occurrences: Occurrence[]): WeekLayout
//   multi-day occurrences overlapping the row → bars, lane-packed greedily (sort: start asc, longer first, compareInDay);
//   continuesBefore/After when the occurrence extends past the row. Single-day ones → singles[date] sorted by compareInDay.
export function computeWeekRows(anchor: ISODate, weeksBefore: number, weeksAfter: number, weekStart: 0 | 1): ISODate[] // week start dates

// reminders.ts (uses @date-fns/tz TZDate for wall-clock→instant in an IANA zone; DST-correct)
export function zonedInstant(date: ISODate, time: HM, tz: string): Millis
export function zonedToday(nowMs: Millis, tz: string): ISODate
export function reminderInstantFor(occ: { date: ISODate; time: HM | null }, reminder: Reminder, tz: string): Millis | null
export function nextReminder(task: Task, tz: string, afterMs: Millis): { at: Millis; origDate: ISODate | null; occDate: ISODate } | null
//   earliest instant > afterMs over not-done, not-skipped occurrences (recurring: search ≤ 400 days ahead). Inbox → null.
export function computeRemindAt(task: Task, tz: string, nowMs: Millis): Millis | null   // nextReminder(...)?.at ?? null
export function nextSummaryAt(settings: Settings, afterMs: Millis): Millis | null       // next settings.summary.time in settings.timezone, null if disabled
export function badgeCount(tasks: Iterable<Task>, today: ISODate): number             // open occurrences today (incl. active multi-day) + overdue
export function summaryText(tasks: Iterable<Task>, today: ISODate): { title: string; body: string }
//   title "Today · 4 tasks" (or "Nothing planned today"), body "Finish report, Call mom, Gym +1 more · 2 overdue"

// format.ts (en-US, Notion wording)
export function formatTime(t: HM): string                 // "3:00 PM", "12:00 PM", "9:05 AM"
export function parseTimeInput(s: string): HM | null      // "3pm" "3:30 pm" "15:00" "1530" "9" "noon" → HM
export function formatDateLong(d: ISODate): string        // "November 19, 2026"
export function formatDateShort(d: ISODate): string       // "Nov 19"
export function formatDateMedium(d: ISODate): string      // "Nov 19, 2026"
export function formatWeekdayShort(d: ISODate): string    // "Thu, Nov 19"
export function formatMonthYear(d: ISODate): string       // "November 2026"
export function formatRange(start: ISODate, end: ISODate): string // "Nov 19 → 21", "Nov 30 → Dec 2", "Dec 30, 2026 → Jan 2, 2027"
export function formatReminder(r: Reminder, timed: boolean): string // "At time of task" | "10 minutes before" | "1 hour before" | "1 day before" | "On day (9:00 AM)" | "1 day before (9:00 AM)" | "None" | "Default"
export function parseDateInput(s: string, today: ISODate): ISODate | null // "Nov 19", "11/19", "11/19/2026", "2026-11-19", "today", "tomorrow", "fri"
```

### 4.2 src/data/

```ts
// repo.ts
export const DELETE_FIELD: unique symbol
export type OverridePatch = { [K in keyof OccurrenceOverride]?: OccurrenceOverride[K] | typeof DELETE_FIELD }
export interface TaskPatch {
  fields?: Partial<Omit<Task, 'id' | 'overrides' | 'createdAt'>>        // top-level fields to set (updatedAt is added by the repo)
  overrides?: Record<ISODate, OverridePatch | null>                    // per occurrence; null deletes the whole entry
}
export type RepoOp = { type: 'set'; task: Task } | { type: 'update'; id: string; patch: TaskPatch } | { type: 'delete'; id: string }
export interface SnapshotMeta { fromCache: boolean; hasPendingWrites: boolean }
export interface Repo {
  readonly kind: 'firebase' | 'local'
  subscribeTasks(onChange: (tasks: Record<string, Task>, meta: SnapshotMeta) => void, onError: (e: Error) => void): () => void
  subscribeUser(onChange: (doc: UserDoc | null, meta?: SnapshotMeta) => void, onError: (e: Error) => void): () => void   // meta: from the offline cache?
  apply(ops: RepoOp[]): void                 // fire-and-forget; applied to the in-memory view at once, in order; persisted PER DOCUMENT
                                             // (Firestore: the ops of one task in one microtask are one commit; different tasks commit
                                             // independently — no all-or-nothing batch across tasks); errors → store.sync.error + toast
  updateUser(patch: { settings?: Partial<Settings>; summaryAt?: number | null }): void   // merge; settings merged deeply (summary sub-object too)
  saveDevice(deviceId: string, doc: DeviceDoc): Promise<void>
  deleteDevice(deviceId: string): Promise<void>
  dispose(): void
}
// firebase.ts
export const firebaseConfigured: boolean
export function getFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore }   // lazy singleton; persistentLocalCache + multi-tab
// firestoreRepo.ts: export function createFirestoreRepo(uid: string): Repo
// localRepo.ts:     export function createLocalRepo(namespace?: string): Repo
// auth.ts
export function signIn(email: string, password: string): Promise<void>
export function signUp(email: string, password: string): Promise<void>
export function signOutUser(): Promise<void>
export function resetPassword(email: string): Promise<void>
export function authErrorMessage(e: unknown): string        // friendly text for firebase auth error codes
// boot.ts
export function bootData(): () => void   // wires auth → repo → store (user, tasks, settings, sync); local mode when !firebaseConfigured; returns cleanup
export function getRepo(): Repo | null
```

### 4.3 src/store/

```ts
// store.ts
export type LayoutMode = 'desktop' | 'tablet' | 'phone'
export type DragSource = 'calendar' | 'inbox' | 'list'
export interface ToastItem { id: string; message: string; action?: { label: string; run: () => void }; duration: number }
export interface UIState {
  view: 'month' | 'week'
  visibleMonth: ISODate                 // "YYYY-MM-01" of the month dominating the month scroller (header title + dimming)
  weekAnchor: ISODate                   // any date inside the week shown in week view
  scrollRequest: { date: ISODate; behavior: 'smooth' | 'instant'; nonce: number } | null
  peek: OccurrenceRef | null
  leftOpen: boolean; rightOpen: boolean // desktop sidebars (persisted per device)
  drawerOpen: boolean                   // phone/tablet Tasks drawer
  sheet: 'collapsed' | 'half' | 'full'  // phone Inbox sheet
  dragging: { occKey: string; source: DragSource; recurring: boolean } | null
  composer: { date: ISODate } | null    // desktop inline composer cell / phone QuickAddSheet
  settingsOpen: boolean
  collapsedGroups: Record<string, boolean>   // persisted; missing → group.defaultCollapsed
}
export interface AppState {
  mode: 'firebase' | 'local'
  authReady: boolean
  user: { uid: string; email: string | null } | null
  tasks: Record<string, Task>
  tasksLoaded: boolean
  settings: Settings
  sync: { online: boolean; pendingWrites: boolean; fromCache: boolean; error: string | null }
  theme: ThemePref                      // per device (localStorage 'tasks.theme')
  today: ISODate                        // kept current by startClock()
  ui: UIState
  toasts: ToastItem[]
}
export const useStore: UseBoundStore<StoreApi<AppState>>   // create<AppState>()(...) — state only; mutations live in actions.ts

// actions.ts — the ONLY way components mutate state. All sync (no promises), optimistic, undoable where noted.
export interface DropPosition { prevOrder: string | null; nextOrder: string | null }   // neighbors in target list after drop
export function createTask(input: { title: string; date?: ISODate | null; endDate?: ISODate | null; time?: HM | null; recurrence?: Recurrence | null; position?: DropPosition | 'top' | 'bottom' }): string
//   Inbox default 'top'; day default 'bottom' (among untimed). Empty/whitespace title → returns '' and does nothing.
export function createTasksFromText(text: string, date: ISODate | null): string[]   // split lines; strip "- ", "* ", "• ", "[ ] ", "1. "; skip blanks; keeps line order (first line ends up on top)
export function renameTask(taskId: string, title: string): void          // trims; empty → ignored
export function moveOccurrence(ref: OccurrenceRef, toDate: ISODate | null, pos?: DropPosition): void
//   non-recurring: date=toDate, endDate shifted by same delta (multi-day keeps length), order from pos (default end of untimed)
//   toDate=null → Inbox: date/endDate/time=null, order from pos (default top). Recurring + null → refused with toast "Repeating tasks can't go to the Inbox".
//   recurring: overrides[orig].date = toDate (DELETE_FIELD when toDate===orig), order override from pos. No-op if unchanged. Undoable.
export function resizeTask(taskId: string, date: ISODate, endDate: ISODate): void        // non-recurring; endDate===date → endDate null. Undoable.
export function setSchedule(ref: OccurrenceRef, s: { date: ISODate | null; endDate?: ISODate | null; time?: HM | null }): void
//   date picker: non-recurring → task fields; recurring occurrence → override date/time (endDate ignored). date null → like moveOccurrence(null). Undoable.
export function setSeriesStart(taskId: string, date: ISODate): void      // recurring series start (from RepeatEditor)
export function setDone(ref: OccurrenceRef, done: boolean): void         // done=true → toast "Task completed" + Undo; recomputes remindAt
export function deleteOccurrence(ref: OccurrenceRef): void               // recurring → overrides[orig].skipped=true; else delete task. Toast "Task deleted" + Undo.
export function deleteTask(taskId: string): void                         // whole series. Toast + Undo (restores full doc).
export function setRecurrence(taskId: string, rule: Recurrence | null, opts?: { keepOrigDate?: ISODate | null; start?: ISODate }): void
//   setting a rule clears endDate; requires date (else no-op); an OVERDUE one-time task keeps its missed instance (a one-time copy
//   stays in Overdue, the series skips that date). null → one-time task on the viewed / next open occurrence (Undo toast); a series
//   just made from an overdue task, untouched since, folds back into that one overdue task.
export function setReminder(taskId: string, reminder: Reminder): void
export function moveAllOverdueToToday(): void                            // one repo.apply, one undo entry, toast "Moved N tasks to today" + Undo
export function duplicateTask(taskId: string): string
export function updateSettings(patch: Partial<Settings>): void           // recomputes summaryAt; if timezone changed, recomputes every task's remindAt (batched)
export function setTheme(theme: ThemePref): void
export function undo(): void                                             // pops the undo stack (max 50); also bound to ⌘Z
export function showToast(message: string, opts?: { action?: { label: string; run: () => void }; duration?: number }): string
export function dismissToast(id: string): void
// UI
export function openPeek(ref: OccurrenceRef): void; export function closePeek(): void
export function setView(view: 'month' | 'week'): void
export function goToday(): void; export function goPrev(): void; export function goNext(): void   // month: scrollRequest to 1st of month ±1; week: weekAnchor ±7
export function scrollCalendarTo(date: ISODate, behavior?: 'smooth' | 'instant'): void
export function setVisibleMonth(firstOfMonth: ISODate): void            // MonthScroller reports (no-op if same)
export function openComposer(date: ISODate): void; export function closeComposer(): void
export function setSheet(s: UIState['sheet']): void; export function setDrawer(open: boolean): void
export function toggleLeft(): void; export function toggleRight(): void; export function setSettingsOpen(open: boolean): void
export function setDragging(d: UIState['dragging']): void
export function toggleGroup(id: string, collapsedDefault: boolean): void
export function setLayoutMode?: never  // layout mode is derived by hook, not stored

// selectors.ts — memoized hooks (stable references; recompute only when tasks/today change)
export function useTasksList(): Task[]
export function useOccurrencesInRange(from: ISODate, to: ISODate): Occurrence[]
export function useWeekLayout(days: ISODate[]): WeekLayout        // uses a per-tasks-version cache keyed by days[0]
export function useInboxTasks(): Task[]
export function useTaskGroups(): ListGroup[]
export function useTask(id: string | null | undefined): Task | undefined
export function useOccurrence(ref: OccurrenceRef | null): Occurrence | null
export function useBadgeCount(): number
// clock.ts
export function startClock(): () => void   // sets store.today now, at next local midnight, on visibilitychange→visible and focus; returns cleanup
```

Undo: each undoable action records the affected task docs *before* the change (full snapshots) and the ids created;
undo restores them with `repo.apply([...set/delete])` in one batch. Toast "Undo" button calls the same entry. A toast's Undo
clicked after later steps touched the same task takes back only that step's change (later changes stay) and rebases the later
entries, so no later ⌘Z can bring it back; a new change clears the redo stack and dismisses its "Undid: … · Redo" toasts.

### 4.4 src/dnd/ (owned by calendar agent; used by tasks + inbox)

```ts
export const dragIds: { cal(occKey: string): string; inbox(taskId: string): string; list(occKey: string): string }
export const containerIds: { inbox: 'inbox'; day(date: ISODate): string /* "day:YYYY-MM-DD" */ }
export interface TaskDragData { kind: 'task'; occ: Occurrence; source: DragSource; containerId: string | null }
export function DndProvider(props: { children: React.ReactNode }): JSX.Element
//   MouseSensor {distance: 4}, TouchSensor {delay: 300, tolerance: 8}, KeyboardSensor; custom collision (day cell under pointer
//   via [data-date] hit-test, then closest sortable within that container); DragOverlay renders <TaskCard variant="overlay">;
//   onDragEnd → actions.moveOccurrence with DropPosition computed from the target container's rendered order;
//   multi-day bars keep the grab offset (drop day − grabbed day). Sets store.ui.dragging. Edge auto-scroll for the calendar
//   scroller even when the drag started in the Inbox/list; hovering ‹ › for 600 ms flips month/week. iOS: blocks page scroll
//   during touch drag (non-passive touchmove preventDefault), disables callout/selection. Haptic-free (iOS PWA has none).
export function SortableList(props: { containerId: string; itemIds: string[]; children: React.ReactNode }): JSX.Element
export function useSortableTask(a: { occ: Occurrence; source: 'calendar' | 'inbox'; containerId: string; disabled?: boolean }):
  { setNodeRef: (el: HTMLElement | null) => void; attributes: Record<string, unknown>; listeners: Record<string, Function> | undefined; style: React.CSSProperties; isDragging: boolean }
export function useDraggableTask(a: { occ: Occurrence; source: 'list'; disabled?: boolean }): same shape
export function useDayDropTarget(date: ISODate): { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean }
export function useInboxDropTarget(): { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean }
```

### 4.5 src/components/ui, card, layout, hooks, lib (owned by shell agent)

```tsx
// ui/
<Button variant="ghost|primary|secondary|danger" size="sm|md" icon? />    <IconButton label icon size=24|28 />
<Checkbox checked onChange(next) size?=16 label? />        // Notion to-do box; checked → accent fill, white check draws in, 1.12 pop
<Toggle checked onChange />                                  // Notion switch (accent when on, --toggle-off when off)
<Popover open onOpenChange anchor(ref|element) placement? offset? children />   // @floating-ui; portal; flip/shift; Esc/outside close; 120ms fade+scale(.98)
<Menu> <MenuItem icon label hint? danger? onSelect submenu? /> <MenuSeparator/> </Menu>  // keyboard nav ↑↓ Enter; Notion 28px rows
<Modal open onClose labelledBy width? children />           // center, --backdrop, focus trap, Esc; enter 180ms (opacity, scale .98→1, y 8→0)
<Sheet open onClose snap?="auto|full" children />           // phone bottom sheet, drag handle, drag-to-dismiss, safe-area aware, visualViewport keyboard aware
<Toaster />                                                  // renders store.toasts bottom-center; Undo action; pauses on hover
<Tooltip content children />  <TextInput … />  <Kbd>⌘Z</Kbd>  <Icon icon={LucideIcon} size?=16 />
// card/TaskCard.tsx
export interface TaskCardProps extends React.HTMLAttributes<HTMLDivElement> {
  occ: Occurrence; variant: 'calendar' | 'compact' | 'inbox' | 'bar' | 'overlay'
  overdue?: boolean; continuesBefore?: boolean; continuesAfter?: boolean; dragging?: boolean   // dragging → source ghost (opacity .35)
}
export const TaskCard: React.ForwardRefExoticComponent<TaskCardProps & React.RefAttributes<HTMLDivElement>>   // memo'd
// layout/AppShell.tsx — responsive frame with slots; owns sidebar widths/collapse animations, drawer, safe areas
export function AppShell(p: { left: ReactNode; center: ReactNode; right: ReactNode; phoneSheet: ReactNode; overlays: ReactNode }): JSX.Element
// hooks/
export function useLayoutMode(): LayoutMode      // phone: width<640 || (coarse && height<500); tablet: <1100; else desktop
export function useMediaQuery(q: string): boolean
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps?: unknown[]): void  // "t", "ArrowLeft", "mod+z"; ignores typing targets
export function useIsStandalone(): boolean
export function usePrefersReducedMotion(): boolean
export function useApplyTheme(): void           // resolves store.theme + prefers-color-scheme → <html data-theme>, meta theme-color
// lib/
export function cx(...c: Array<string | false | null | undefined>): string
export function newId(): string                  // 20-char Firestore-safe id
export const platform: { isIOS: boolean; isTouch: boolean; isMac: boolean }
```

`src/App.tsx` (shell agent) composes: `<DndProvider><AppShell left={<TasksSidebar/>} center={<CalendarView/>} right={<InboxPanel/>}
phoneSheet={<InboxSheet/>} overlays={<><TaskPeek/><SettingsModal/><QuickAddSheet/><Toaster/></>} /></DndProvider>`, gated by
`<AuthScreen/>` when `mode==='firebase' && authReady && !user`, and a Notion-style blank loading state until `tasksLoaded` —
or, when the tasks listener failed before any data arrived (`sync.loadFailed`), "Couldn't load your tasks" with the reason,
Try again and Sign out (never an empty calendar that reads as "Nothing planned").
Each imported component's file path/name is fixed by this spec; the shell agent creates **placeholder stubs** for components it
doesn't own (feature agents overwrite them).

### 4.6 Feature components (default export not allowed — named exports with these names)

`calendar/CalendarView` · `tasks/TasksSidebar` · `inbox/InboxPanel` · `inbox/InboxSheet` · `peek/TaskPeek` ·
`settings/SettingsModal` · `auth/AuthScreen` · `quickadd/QuickAddSheet` · `pickers/DatePicker` · `pickers/RepeatEditor` ·
`pickers/ReminderMenu` · `pickers/TimeInput` · `pwa/InstallHint` · `pwa/UpdatePrompt` (no props unless stated).

---

## 5. Visual spec (Notion fidelity)

Fonts: `var(--font)` (system UI stack; SF Pro on Apple). Base 14px, line-height 1.5 for UI text. Inputs on touch devices use
16px to prevent iOS zoom. `-webkit-font-smoothing: antialiased`. Icons: lucide, 16px, strokeWidth 1.75, color `var(--icon)`.

**Calendar header** (44px): left "November 2026" 14px/600. Right cluster (gap 2px): view switcher ghost button "Month ⌄",
chevron-left IconButton, "Today" ghost text button (14px/500), chevron-right IconButton. Ghost buttons: height 28px, radius 4px,
hover `--bg-hover`, active `--bg-active`. Phone: adds ☰ at left (opens Tasks drawer; shows red dot when overdue > 0); title tap
opens Month/Week menu.

**Weekday row**: 24px, 12px `--text-secondary`, centered labels "Mon … Sun" (phone: "M T W T F S S").

**Grid**: 1px `--grid-line` lines (cells draw right+bottom borders; grid has top+left). Weekend columns (Sat/Sun) `--bg-weekend`,
others `--bg`. Desktop row min-height `--cal-row-min-h` (124px); rows grow to fit every card. Date label top-right, padding
6px 8px 0, 14px: current-visible-month days `--text`, other days `--text-secondary` (color transitions 150ms while scrolling);
the 1st of every month renders "Dec 1". Today: 24px circle `--today` with white 500-weight number (phone 20px).
Hover "+" (fine pointers only): top-left 6px, 22×22, radius 4px, `--bg-card` + `--card-shadow`, plus icon 14px; fades in 120ms.
Double-click empty cell area = same as "+". Drop-target cell: background `--bg-drop-target`.

**TaskCard**: `--bg-card`, `--card-shadow`, radius 4px, padding 4px 8px, 14px/20px weight 500 `--text`; text wraps
(`overflow-wrap:anywhere`) — full name always visible. Optional second line: time "3:00 PM" 12px `--text-secondary`;
recurring shows a 12px repeat icon after the time (or alone). Hover `--bg-card-hover` + `--card-shadow-hover`.
Overdue: `--overdue-card-bg`, title `--overdue-card-text`. Margin `0 6px 4px`. `user-select:none; -webkit-touch-callout:none`.
Variants: `compact` (cell width < 96px, i.e. phones): 11px/13px, padding 2px 4px, radius 3px, margin 0 2px 2px, time 10px.
`bar` (multi-day): one line, ellipsis, absolutely positioned across columns, flat edge where it continues.
`inbox`: full width, margin 0 0 6px. `overlay`: `--card-shadow-drag`, cursor grabbing, width locked to source width.
Source while dragging: opacity .35.

**Sidebars** (Notion sidebar): background `--bg-sidebar`, inner edge `box-shadow: inset ±1px 0 0 var(--border)`. Header rows 44px,
14px/600. Section headers 12px/500 `--text-secondary`, 30px tall, caret ▸ rotates 90° (120ms) for collapsible groups; count
right-aligned `--text-tertiary`. Rows: min 30px, padding 4px 8px, radius 4px, hover `--bg-hover`; checkbox 16px; title 14px wraps;
meta 12px `--text-tertiary` (overdue meta `--red-text`). Overdue header text `--red-text` + right "Move all to today" 12px ghost.
Inbox input: 32px, radius 4px, `--bg-input`, placeholder "Type a task, press Enter" `--text-placeholder`.

**Center peek**: backdrop `--backdrop` fade 180ms; panel width min(640px, 100vw − 48px), max-height 85vh, margin-top 10vh, radius
`--radius-lg`, bg `--bg`, shadow `--peek-shadow`; enter: opacity 0→1, scale .98→1, y 8→0 over 180ms `--ease`; exit 120ms.
Top bar 44px (right: ⋯ menu, ✕). Content padding 8px 48px 32px. Title 32px/1.2 weight 700, auto-growing textarea, placeholder
"Untitled". Property rows 34px: label 160px (icon + 14px `--text-secondary`), value 14px in a hoverable 4px-radius box; empty values
"Empty" in `--text-placeholder`. Properties: Date, Repeat, Remind, Done (checkbox), Created (read-only). Divider, then ghost actions
"Move to Inbox" and "Delete" (danger on hover). Phone: same content in `<Sheet>` (title 26px, padding 0 20px).

**Date picker** (Notion clone, 260px popover): top text field(s) (Start/End when range), mini month (header "Nov 2026", Today,
‹ ›; Notion weekday initials; selected = accent fill white text; range = `--bg-selected`; today = red text), then rows: End date
(Toggle; disabled for repeating), Include time (Toggle → TimeInput), Repeat ›, Remind ›, divider, Clear (→ Inbox).

**Toasts**: bottom-center, 24px + safe-area from bottom (phone: above the collapsed Inbox sheet), `--toast-bg`, `--toast-text`,
14px, padding 8px 12px, radius 6px, popover shadow; action text button in `#529CCA`. In: y 8→0 + fade 180ms. 5 s; hover pauses.

**Motion rules**: list insert/remove/reorder use `layout` + `AnimatePresence` (height+opacity, 180ms `--ease`). Card removal on
completion: opacity→0 + scale .96 (160ms). Nothing bounces except the checkbox pop. Honor `prefers-reduced-motion` (durations→0).

---

## 6. Interaction spec

- **Add**: Inbox input (Enter; keeps focus for rapid entry; multi-line paste → many). Day "+" / double-click → inline composer card
  at the bottom of that day (Enter creates & opens another composer below; Esc or blur-empty closes; blur-with-text creates).
  Phone: tap empty part of a day → QuickAddSheet titled "New task · Thu, Nov 19" (Enter creates; stays open for more).
- **Open**: click/tap a card, bubble, or list row title → peek. `?task=ID&occ=DATE` in URL opens it (from notification click), then the URL is cleaned.
- **Drag**: desktop mouse 4px threshold; touch long-press 300ms. Inbox bubble → day; card → other day / reorder within day / Inbox;
  list row → day / Inbox. Multi-day bar drag keeps its length; desktop bar/card edges have 6px resize handles (ew-resize) to change
  start/end (snap per day; live preview). Phone: when a drag starts the Inbox sheet slides fully down and a bottom pill drop zone
  "Move to Inbox" rises; drawer closes. Recurring occurrences can't be dropped in Inbox (zone shows not-allowed).
- **Complete**: list checkbox → local check animation (fill + strikethrough) → after 350ms `setDone` → row collapses, calendar
  card fades out, toast "Task completed · Undo". Uncheck in Completed restores. Peek Done checkbox does the same (peek stays open).
- **Overdue**: red-tinted cards; Overdue group with "Move all to today" (one undo).
- **Delete**: peek ⋯ / action; recurring offers "Delete this occurrence" and "Delete all repeats". Desktop: focused card + Backspace.
- **Keyboard** (desktop, ignored while typing): `t` today · `←`/`→` prev/next · `m` month · `w` week · `n` focus Inbox input ·
  `[` toggle Tasks sidebar · `]` toggle Inbox · `⌘Z`/`Ctrl+Z` undo · `Esc` close topmost overlay.
- **Today rollover**: `store.today` updates at local midnight and on resume (visibilitychange) — grouping/overdue/red tint follow.
- **Phone layout**: header with ☰; full-name compact grid; Inbox sheet snaps collapsed (56px + safe-area: handle + "Inbox · N")
  / half (50dvh) / full; tap collapsed → half; drag handle to snap (velocity-aware); input stays above the iOS keyboard
  (visualViewport). Drawer: from left, min(320px, 85vw), backdrop, swipe-left to close, edge-swipe (20px) to open.

---

## 7. PWA, push, functions

- `vite-plugin-pwa` injectManifest (`src/sw.ts`): precache app shell, SPA navigation fallback, `push` → `showNotification(title,
  {body, tag, data:{url}, icon, badge})` + `navigator.setAppBadge(badge)`; `notificationclick` → focus/open `url`. Update flow:
  prompt toast "A new version is available · Reload" (never auto-reload mid-edit).
- Manifest: name/short_name "Tasks", display standalone, start_url "/", scope "/", background #191919, theme colors via
  `<meta name="theme-color" media=…>` for light/dark, icons 192/512/maskable + apple-touch-icon 180 (minimal Notion-style
  calendar-check glyph). iOS metas: `apple-mobile-web-app-capable`, `mobile-web-app-capable`, status bar `black-translucent`,
  title "Tasks", `viewport-fit=cover`. An inline script in index.html applies the theme before first paint (no flash).
- Body: `position:fixed; inset:0; overscroll-behavior:none`, app height `100dvh`; only inner panes scroll; safe-area padding.
- Push enablement (Settings → Notifications → "Enable on this device", must be a user gesture; iOS requires installed app):
  `Notification.requestPermission()` → `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC })` →
  `repo.saveDevice(deviceId)`; deviceId in localStorage. Badge sync: `navigator.setAppBadge(useBadgeCount())` when permitted.
- Cloud Function `tick` (`onSchedule('every 1 minutes')`, region us-central1), for each ALLOWLISTED user (`allow/{uid}`), with
  per-user queries (another account can never take the owner's slots): (1) tasks written in the last 20 min (`syncedAt`) →
  remindAt re-derived from the merged doc, a missing / too-late value lowered to the first alert after the write landed;
  (2) tasks where `remindAt <= now` (limit 200) → for each: skip if stale (> 15 min late, but still advance), send push to all
  user devices (every non-stale alert since the stored one, each once: sent (occurrence, instant) pairs are kept in
  `users/{uid}/fired/{taskId}`), set `remindAt` = `computeRemindAt(task, tz, now)`; (3) `summaryAt <= now` → `summaryText` +
  `badgeCount` push → set `summaryAt = nextSummaryAt(settings, now)` (an instant already summarized — `summarySentAt` — is not
  sent again; a summaryAt that disagrees with the settings is repaired); (4) once a day, and right after a time-zone change,
  the same remindAt repair over every open task. Every send is preceded by a conditional write (claim). Prune device docs on
  404/410. VAPID private key via `defineSecret('VAPID_PRIVATE_KEY')`; VAPID subject = the hosting URL (never a personal email).
  Built with esbuild (bundles ../shared).

---

## 8. Quality bar

- `npm run typecheck`, `npm test`, `npm run build` all clean. No `any` escapes without a comment. No console errors at runtime.
- Unit tests cover every shared/ function including: month-end/leap-year recurrence, weekly interval>1 across year boundary,
  count+until, overrides (moved in/out of range, skipped, done), multi-day lane packing across week boundaries, grouping edge
  cases (multi-day spanning today, recurring excluded from overdue, Later next-occurrence rule), DST reminders
  (America/New_York 2026-03-08 / 2026-11-01), parseTimeInput/parseDateInput.
- E2E (Playwright, local mode, `page.clock` fixed to 2026-11-19 10:00): desktop Chromium + iPhone (WebKit, touch) projects.
- Test ids (`data-testid`): `calendar`, `cal-title`, `cal-prev`, `cal-next`, `cal-today`, `cal-view`, `day-cell` (+`data-date`),
  `day-add`, `composer-input`, `task-card` (+`data-occ-key`, `data-overdue`), `bar` (+`data-occ-key`), `resize-start`,
  `resize-end`, `inbox`, `inbox-input`, `inbox-bubble` (+`data-task-id`), `inbox-sheet`, `inbox-sheet-handle`, `inbox-dropzone`,
  `tasks-sidebar`, `group` (+`data-group-id`), `group-toggle`, `list-row` (+`data-occ-key`), `list-checkbox`,
  `overdue-move-all`, `peek`, `peek-title`, `peek-date`, `peek-repeat`, `peek-remind`, `peek-done`, `peek-created`,
  `peek-move-inbox`, `peek-delete`, `peek-close`, `peek-menu`, `date-picker`, `toast`, `toast-action`, `settings-open`,
  `settings-modal`, `theme-select`, `drawer-toggle`, `drawer`, `quickadd-input`, `auth-email`, `auth-password`, `auth-submit`.
- Accessibility: every icon button has `aria-label`; focus-visible rings (`--focus-ring`); dialogs labelled; checkboxes are
  `role="checkbox"` with `aria-checked`.
