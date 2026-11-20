/**
 * Actions — the ONLY way components mutate state. All synchronous (no promises), optimistic,
 * undoable where noted (SPEC §4.3).
 *
 * Every task mutation follows one pipeline (write()):
 *   1. compute the full next version of each affected task (pure),
 *   2. sanitizeTask() enforces the invariants of shared/types.ts,
 *   3. diffTask() produces a minimal field-level patch (top-level fields + override fields),
 *   4. remindAt is recomputed with settings.timezone for every changed task,
 *   5. one repo.apply() batch; the repo updates the store synchronously,
 *   6. an undo entry records full snapshots of the touched docs + created ids, labelled with what
 *      the action did ("added “Buy milk”") so ⌘Z can say what it undid.
 */
import type {
  HM,
  ISODate,
  Occurrence,
  OccurrenceOverride,
  OccurrenceRef,
  Recurrence,
  Reminder,
  Settings,
  Task,
  ThemePref,
} from '@shared/types';
import { addDays, addMonths, diffDays, fromEpochDay, isHM, isValidISODate, startOfMonth } from '@shared/dates';
import { compileRecurrence, compiledForEach, normalizeRecurrence } from '@shared/recurrence';
import { formatDateShort, formatTime } from '@shared/format';
import {
  firstOpenOccurrenceFrom,
  getOccurrence,
  inboxTasks,
  isOverdue,
  occurrencesInRange,
  occurrencesOfTask,
  singleOccurrence,
  taskDate,
  taskRule,
} from '@shared/occurrences';
import { compareInDay, keyAtEnd, keyAtStart, keyBetween } from '@shared/ordering';
import { computeRemindAt } from '@shared/reminders';
import { getRepo } from '@/data/current';
import type { RepoOp } from '@/data/repo';
import {
  applyTaskPatch,
  cleanTitle,
  deepEqual,
  diffTask,
  mergeSettings,
  normalizeReminder,
  safeNextSummaryAt,
  sanitizeTask,
} from '@/data/taskDoc';
import { newId } from '@/lib/ids';
import { isThemePref } from './prefs';
import {
  clearRedo,
  clearUndo,
  peekUndo,
  pushRedo,
  pushUndo,
  rewriteUndo,
  takeRedo,
  takeUndo,
  undoEntriesAfter,
  type UndoEntry,
} from './undo';
import { COMPLETED_PAGE, initialSettings, useStore, type AppState, type ToastItem, type UIState } from './store';

/** Neighbors in the target list after a drop. */
export interface DropPosition {
  prevOrder: string | null;
  nextOrder: string | null;
}

const TOAST_MS = 5000;
const MAX_TOASTS = 5;
/** Title edits of one task within this window (the peek saves while you type) are one undo step. */
const RENAME_COALESCE_MS = 10_000;
const LABEL_TITLE_CHARS = 40;

// =============================================================================================
// Internals
// =============================================================================================

const st = (): AppState => useStore.getState();

function setUI(patch: Partial<UIState>): void {
  const ui = st().ui;
  let changed = false;
  for (const k of Object.keys(patch) as Array<keyof UIState>) {
    if (ui[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  if (changed) useStore.setState({ ui: { ...ui, ...patch } });
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function getTask(id: string | null | undefined): Task | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  const tasks = st().tasks;
  return hasOwn(tasks, id) ? tasks[id] : undefined;
}

function validDate(d: unknown): ISODate | null {
  return typeof d === 'string' && isValidISODate(d) ? d : null;
}

/** A task title quoted for a toast: “Buy milk” (long titles shortened). */
function q(title: string): string {
  const t = title.trim();
  const chars = Array.from(t === '' ? 'Untitled' : t);
  return `“${chars.length > LABEL_TITLE_CHARS ? `${chars.slice(0, LABEL_TITLE_CHARS - 1).join('').trimEnd()}…` : chars.join('')}”`;
}

function remindAtFor(task: Task, tz: string, now: number): number | null {
  try {
    return computeRemindAt(task, tz, now);
  } catch {
    return null;
  }
}

interface Change {
  prev: Task | undefined;
  next: Task | undefined;
}

/**
 * The write pipeline (see header). Returns the undo entry (when `undoable` and something changed),
 * `true` when something was written but not recorded, or null when nothing changed. `label` says
 * what the action did, for the toast after ⌘Z ('added “Buy milk”').
 */
function write(changes: Change[], undoable: boolean, label = ''): UndoEntry | true | null {
  const repo = getRepo();
  if (!repo) return null;
  const now = Date.now();
  const tz = st().settings.timezone;
  const ops: RepoOp[] = [];
  const before: Task[] = [];
  const created: string[] = [];
  for (const { prev, next } of changes) {
    if (!next) {
      if (prev) {
        ops.push({ type: 'delete', id: prev.id });
        before.push(prev);
      }
      continue;
    }
    const n = sanitizeTask(next);
    if (!prev) {
      const task: Task = { ...n, createdAt: n.createdAt || now, updatedAt: now };
      task.remindAt = remindAtFor(task, tz, now);
      ops.push({ type: 'set', task });
      created.push(task.id);
      continue;
    }
    // Diff without remindAt first so a stale remindAt alone never causes a write.
    const patch = diffTask(prev, { ...n, remindAt: prev.remindAt });
    if (!patch) continue;
    const remindAt = remindAtFor(n, tz, now);
    if (remindAt !== prev.remindAt) patch.fields = { ...patch.fields, remindAt };
    ops.push({ type: 'update', id: prev.id, patch });
    before.push(prev);
  }
  if (ops.length === 0) return null;
  repo.apply(ops);
  dropRedo();
  return undoable ? pushUndo(before, created, label) : true;
}

/** Entries that can no longer be applied take their toast's Undo / Redo button with them. */
function dismissToastsOf(entries: readonly UndoEntry[]): void {
  for (const e of entries) if (e.toastId) dismissToast(e.toastId);
}

/** A new change: what was undone before it can't be redone any more (nor offered as "Redo"). */
function dropRedo(): void {
  dismissToastsOf(clearRedo());
}

/** Shows `message` with an Undo button bound to `entry` (if one was recorded). */
function toastWithUndo(message: string, result: UndoEntry | true | null): void {
  if (result === null) return;
  if (result === true) {
    showToast(message);
    return;
  }
  const entry = result;
  entry.toastId = showToast(message, {
    action: {
      label: 'Undo',
      run: () => {
        const e = takeUndo(entry.id);
        if (!e) return;
        // Possibly out of order: later steps may have touched the same tasks since.
        const inverse = restore(e, true);
        if (inverse) pushRedo(inverse.before, inverse.created, e.label);
      },
    },
  });
}

/**
 * `task` with ONE step's change taken back: the fields / occurrence fields that differ between the
 * step's `before` and `after` snapshots get their `before` values; everything else (later steps'
 * changes) stays.
 */
function withoutStep(task: Task, before: Task, after: Task, now: number): Task {
  const patch = diffTask({ ...after, remindAt: before.remindAt }, before);
  return patch ? sanitizeTask(applyTaskPatch(task, patch, now)) : task;
}

/**
 * Puts the docs of `entry` back (snapshots set, created docs deleted) in one batch. Returns the
 * inverse — the same docs as they were just before — so the step can be redone, or null when there
 * was nothing to restore.
 *
 * `outOfOrder` (a toast's Undo, which may be clicked after later steps): when a later, still
 * undoable step touched the same task, only what THIS step changed is taken back — the later
 * changes stay — and those later entries are rebased the same way, so undoing them afterwards can't
 * bring this step's change back (e.g. "Task completed · Undo", then a rename, then ⌘Z must not
 * quietly complete the task again). Later snapshots of a task this step created are dropped with it.
 */
function restore(entry: UndoEntry, outOfOrder = false): { before: Task[]; created: string[] } | null {
  if (entry.toastId) dismissToast(entry.toastId);
  const repo = getRepo();
  if (!repo) return null;
  const now = Date.now();
  const tz = st().settings.timezone;
  const current = st().tasks;
  const later = outOfOrder ? undoEntriesAfter(entry.id) : [];
  const ops: RepoOp[] = [];
  const inverse = { before: [] as Task[], created: [] as string[] };
  const restored = new Set<string>();
  /** Rewrites every later entry's snapshot of `id` with `fn`; null drops the task from them. */
  const rebase = (id: string, fn: ((t: Task) => Task) | null): void => {
    for (const e of later) {
      if (!e.before.some((b) => b.id === id) && !e.created.includes(id)) continue;
      const before = fn ? e.before.map((b) => (b.id === id ? fn(b) : b)) : e.before.filter((b) => b.id !== id);
      const created = fn ? e.created : e.created.filter((c) => c !== id);
      if (!rewriteUndo(e, before, created)) dismissToastsOf([e]);
    }
  };
  for (const t of entry.before) {
    restored.add(t.id);
    const cur = hasOwn(current, t.id) ? current[t.id] : undefined;
    // The task as this step left it: the snapshot the next later step took of it.
    const after = later.map((e) => e.before.find((b) => b.id === t.id)).find((b) => b !== undefined);
    let target = t;
    if (after) {
      if (cur) target = withoutStep(cur, t, after, now);
      rebase(t.id, (b) => withoutStep(b, t, after, now));
    }
    ops.push({ type: 'set', task: { ...target, updatedAt: now, remindAt: remindAtFor(target, tz, now) } });
    if (cur) inverse.before.push(cur);
    else inverse.created.push(t.id);
  }
  for (const id of entry.created) {
    if (restored.has(id)) continue;
    ops.push({ type: 'delete', id });
    if (hasOwn(current, id)) inverse.before.push(current[id] as Task);
    rebase(id, null);
  }
  if (ops.length === 0) return null;
  repo.apply(ops);
  const peek = st().ui.peek;
  if (peek && entry.created.includes(peek.taskId) && !restored.has(peek.taskId)) setUI({ peek: null });
  return inverse;
}

function resolveRef(ref: OccurrenceRef | null | undefined): { task: Task; occ: Occurrence } | null {
  if (!ref) return null;
  const task = getTask(ref.taskId);
  if (!task) return null;
  const occ = getOccurrence(task, ref.origDate ?? null);
  return occ ? { task, occ } : null;
}

/** Order keys of the untimed single-day cards shown on `date` (sorted), excluding one occurrence. */
function dayUntimedOrders(date: ISODate, excludeKey?: string): string[] {
  const out: string[] = [];
  for (const o of occurrencesInRange(Object.values(st().tasks), date, date)) {
    if (o.date === date && !o.multiDay && o.time == null && o.key !== excludeKey) out.push(o.order);
  }
  return out.sort();
}

/** Order keys of the Inbox (sorted), excluding one task. */
function inboxOrders(excludeId?: string): string[] {
  const out: string[] = [];
  for (const t of inboxTasks(Object.values(st().tasks))) if (t.id !== excludeId) out.push(t.order);
  return out.sort();
}

function dropKey(pos: DropPosition): string {
  return keyBetween(pos.prevOrder ?? null, pos.nextOrder ?? null);
}

function orderFor(pos: DropPosition | 'top' | 'bottom', orders: string[]): string {
  if (pos === 'top') return keyAtStart(orders[0] ?? null);
  if (pos === 'bottom') return keyAtEnd(orders[orders.length - 1] ?? null);
  return dropKey(pos);
}

function isDropPosition(p: unknown): p is DropPosition {
  return p != null && typeof p === 'object';
}

/** Replaces one override entry (by original rule date) of a recurring task. */
function withOverride(task: Task, origDate: ISODate, o: OccurrenceOverride): Task {
  return { ...task, overrides: { ...task.overrides, [origDate]: o } };
}

/** True when a finite series has no remaining (non-skipped) occurrence. */
function allOccurrencesSkipped(task: Task): boolean {
  const date = taskDate(task);
  if (date === null || !task.recurrence) return false;
  const rule = compileRecurrence(task.recurrence, date);
  if (!Number.isFinite(rule.lastE)) return false;
  let remaining = false;
  compiledForEach(rule, rule.startE, rule.lastE, (e) => {
    const d = fromEpochDay(e);
    if (task.overrides[d]?.skipped !== true) {
      remaining = true;
      return false;
    }
    return true;
  });
  return !remaining;
}

function closePeekIf(pred: (peek: OccurrenceRef) => boolean): void {
  const peek = st().ui.peek;
  if (peek && pred(peek)) setUI({ peek: null });
}

let scrollNonce = 0;

// =============================================================================================
// Task mutations
// =============================================================================================

/**
 * Creates a task. Inbox default position 'top'; day default 'bottom' (among untimed).
 * Empty/whitespace title → returns '' and does nothing. Undoable (⌘Z removes it).
 */
export function createTask(input: {
  title: string;
  date?: ISODate | null;
  endDate?: ISODate | null;
  time?: HM | null;
  recurrence?: Recurrence | null;
  position?: DropPosition | 'top' | 'bottom';
}): string {
  const title = cleanTitle(input.title);
  if (!title) return '';
  let date = validDate(input.date);
  let endDate = date !== null ? validDate(input.endDate) : null;
  if (date !== null && endDate !== null && endDate < date) [date, endDate] = [endDate, date];
  const recurrence = date !== null && input.recurrence ? normalizeRecurrence(input.recurrence, date) : null;
  if (recurrence || endDate === date) endDate = null;
  const time = date !== null && typeof input.time === 'string' && isHM(input.time) ? input.time : null;
  const pos = input.position ?? (date !== null ? 'bottom' : 'top');
  const order = orderFor(pos, date !== null ? dayUntimedOrders(date) : inboxOrders());
  const now = Date.now();
  const task: Task = {
    id: newId(),
    title,
    date,
    endDate,
    time,
    order,
    done: false,
    doneAt: null,
    recurrence,
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return write([{ prev: undefined, next: task }], true, `added ${q(title)}`) ? task.id : '';
}

/** List bullets and checkboxes: "- ", "* ", "• ", "[ ] ", "[x] ". */
const BULLET_RE = /^(?:[-*•‣◦+]\s+|\[[ xX]?\]\s*)/;
/** A numbered-list marker at the start of a line: "1. ", "12) " (never 4 digits: "2027. Budget review"). */
const NUMBER_RE = /^\d{1,3}[.)]\s+/;

/**
 * Strips list markup from a pasted line: up to three bullets / checkboxes, and — only when the
 * pasted block is a list (`listed`) — one leading number. A title that merely starts with a number
 * ("4) wheels", "2027. Budget review") keeps it.
 */
function stripBullets(line: string, listed: boolean): string {
  let s = line.trim();
  if (listed) {
    const n = NUMBER_RE.exec(s);
    if (n) s = s.slice(n[0].length).trimStart();
  }
  for (let i = 0; i < 3; i++) {
    const m = BULLET_RE.exec(s);
    if (!m) break;
    s = s.slice(m[0].length).trimStart();
  }
  return s;
}

/**
 * One task per non-blank line, keeping line order: the first line ends up on top. Bullets "- ",
 * "* ", "• ", "[ ] " are stripped; a leading "1. " / "1) " only when the block is a list (two or
 * more numbered lines, or a numbered line among bulleted ones). One batch, one undo entry.
 * Returns ids in line order.
 */
export function createTasksFromText(text: string, date: ISODate | null): string[] {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r\n|\r|\n|\u2028|\u2029/);
  const numbered = lines.filter((l) => NUMBER_RE.test(l.trim())).length;
  const listed = numbered >= 2 || (numbered === 1 && lines.some((l) => BULLET_RE.test(l.trim())));
  const titles = lines.map((l) => cleanTitle(stripBullets(l, listed))).filter((t) => t !== '');
  if (titles.length === 0) return [];
  const day = validDate(date);
  const keys: string[] = new Array<string>(titles.length);
  if (day === null) {
    // Inbox: the block goes on top, first line first → generate keys downwards from the current top.
    let first = inboxOrders()[0] ?? null;
    for (let i = titles.length - 1; i >= 0; i--) {
      first = keyAtStart(first);
      keys[i] = first;
    }
  } else {
    const orders = dayUntimedOrders(day);
    let last = orders[orders.length - 1] ?? null;
    for (let i = 0; i < titles.length; i++) {
      last = keyAtEnd(last);
      keys[i] = last;
    }
  }
  const now = Date.now();
  const tasks: Task[] = titles.map((title, i) => ({
    id: newId(),
    title,
    date: day,
    endDate: null,
    time: null,
    order: keys[i] ?? keyAtEnd(null),
    done: false,
    doneAt: null,
    recurrence: null,
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  const first = tasks[0];
  const label = tasks.length === 1 && first ? `added ${q(first.title)}` : `added ${tasks.length} tasks`;
  return write(
    tasks.map((t) => ({ prev: undefined, next: t })),
    true,
    label,
  )
    ? tasks.map((t) => t.id)
    : [];
}

/** The open rename step: its entry, and the task exactly as its last save left it. */
let lastRename: { taskId: string; entryId: number; at: number; written: Task | undefined } | null = null;

/**
 * Trims (single line, ≤ 500 chars); empty → ignored. Applies to the whole series. Undoable:
 * consecutive saves of one task's title (the peek saves while you type) are one undo step — as long
 * as nothing else changed the task in between (an Undo, another device, another action), so that
 * step never takes anything but the title back.
 */
export function renameTask(taskId: string, title: string): void {
  const task = getTask(taskId);
  const t = cleanTitle(title);
  if (!task || !t || t === task.title) return;
  const now = Date.now();
  const top = peekUndo();
  const next = { ...task, title: t };
  if (
    lastRename &&
    lastRename.taskId === taskId &&
    top?.id === lastRename.entryId &&
    now - lastRename.at < RENAME_COALESCE_MS &&
    lastRename.written === task
  ) {
    // The open entry already holds the title from before this editing session.
    if (write([{ prev: task, next }], false)) {
      lastRename.at = now;
      lastRename.written = getTask(taskId);
    }
    return;
  }
  const result = write([{ prev: task, next }], true, `renamed ${q(task.title)}`);
  lastRename = result && result !== true ? { taskId, entryId: result.id, at: now, written: getTask(taskId) } : null;
}

/**
 * Moves one occurrence (drag & drop).
 *  - non-recurring: date=toDate, endDate shifted by the same delta (multi-day keeps its length),
 *    order from pos (default: end of the target day's untimed cards).
 *  - toDate=null → Inbox: date/endDate/time cleared, order from pos (default: top), toast
 *    "Moved to Inbox" + Undo when it had a date. Recurring + null → refused with a toast.
 *  - recurring: overrides[orig].date = toDate (deleted when toDate is the original date),
 *    order override from pos. No-op if unchanged. Undoable.
 */
export function moveOccurrence(ref: OccurrenceRef, toDate: ISODate | null, pos?: DropPosition): void {
  const r = resolveRef(ref);
  if (!r) return;
  if (toDate !== null && !isValidISODate(toDate)) return;
  const { task, occ } = r;
  const p = isDropPosition(pos) ? pos : undefined;

  if (occ.recurring) {
    if (toDate === null) {
      showToast("Repeating tasks can't go to the Inbox");
      return;
    }
    if (toDate === occ.date && !p) return;
    const od = occ.origDate as ISODate;
    const o: OccurrenceOverride = { ...task.overrides[od] };
    if (toDate === od) delete o.date;
    else o.date = toDate;
    if (p) o.order = dropKey(p);
    else if (toDate === od) delete o.order;
    else o.order = keyAtEnd(dayUntimedOrders(toDate, occ.key).at(-1) ?? null);
    write([{ prev: task, next: withOverride(task, od, o) }], true, `moved ${q(task.title)}`);
    return;
  }

  if (toDate === null) {
    if (occ.date === null && !p) return;
    const order = p ? dropKey(p) : keyAtStart(inboxOrders(task.id)[0] ?? null);
    const label = occ.date === null ? `reordered ${q(task.title)}` : `moved ${q(task.title)} to the Inbox`;
    const result = write([{ prev: task, next: { ...task, date: null, endDate: null, time: null, order } }], true, label);
    // Unscheduling clears date, end date and time: phones have no ⌘Z, so offer Undo.
    if (occ.date !== null) toastWithUndo('Moved to Inbox', result);
    return;
  }

  if (occ.date === toDate && !p) return;
  let endDate: ISODate | null = null;
  if (occ.date !== null && occ.multiDay && occ.endDate !== null) endDate = addDays(occ.endDate, diffDays(toDate, occ.date));
  let order = task.order;
  if (p) order = dropKey(p);
  else if (occ.date !== toDate) order = keyAtEnd(dayUntimedOrders(toDate, occ.key).at(-1) ?? null);
  write([{ prev: task, next: { ...task, date: toDate, endDate, order } }], true, `moved ${q(task.title)}`);
}

/** Changes start/end of a non-recurring task (resize handles). endDate === date → single-day; an inverted range is swapped. Undoable. */
export function resizeTask(taskId: string, date: ISODate, endDate: ISODate): void {
  const task = getTask(taskId);
  if (!task || taskRule(task) !== null) return;
  if (!isValidISODate(date) || !isValidISODate(endDate)) return;
  const start = endDate < date ? endDate : date;
  const end = endDate < date ? date : endDate;
  write([{ prev: task, next: { ...task, date: start, endDate: end > start ? end : null } }], true, `changed the dates of ${q(task.title)}`);
}

/**
 * Date picker. Non-recurring → task fields (endDate undefined keeps the current end when still
 * after the start; an end before the start is swapped). Recurring occurrence → override date/time
 * (endDate ignored; a time equal to the series time removes the override). date null → like
 * moveOccurrence(ref, null). A changed start date puts the card at the end of that day. Undoable.
 */
export function setSchedule(ref: OccurrenceRef, s: { date: ISODate | null; endDate?: ISODate | null; time?: HM | null }): void {
  if (s.date === null) {
    moveOccurrence(ref, null);
    return;
  }
  const r = resolveRef(ref);
  if (!r || !isValidISODate(s.date)) return;
  const { task, occ } = r;
  const timeIn: HM | null | undefined =
    s.time === undefined ? undefined : s.time === null ? null : typeof s.time === 'string' && isHM(s.time) ? s.time : undefined;

  if (occ.recurring) {
    const od = occ.origDate as ISODate;
    const o: OccurrenceOverride = { ...task.overrides[od] };
    if (s.date !== occ.date) {
      if (s.date === od) {
        delete o.date;
        delete o.order;
      } else {
        o.date = s.date;
        o.order = keyAtEnd(dayUntimedOrders(s.date, occ.key).at(-1) ?? null);
      }
    }
    if (timeIn !== undefined) {
      if (timeIn === (task.time ?? null)) delete o.time;
      else o.time = timeIn;
    }
    write([{ prev: task, next: withOverride(task, od, o) }], true, `changed the date of ${q(task.title)}`);
    return;
  }

  let start: ISODate = s.date;
  let end: ISODate | null;
  if (s.endDate === undefined) end = task.endDate !== null && task.endDate > start ? task.endDate : null;
  else end = validDate(s.endDate);
  if (end !== null && end < start) [start, end] = [end, start];
  if (end === start) end = null;
  const time = timeIn === undefined ? task.time : timeIn;
  const order = start !== task.date ? keyAtEnd(dayUntimedOrders(start, occ.key).at(-1) ?? null) : task.order;
  write([{ prev: task, next: { ...task, date: start, endDate: end, time, order } }], true, `changed the date of ${q(task.title)}`);
}

/** Recurring series start (RepeatEditor). For a one-time task this is setSchedule(date). Undoable. */
export function setSeriesStart(taskId: string, date: ISODate): void {
  const task = getTask(taskId);
  if (!task || !isValidISODate(date)) return;
  if (!task.recurrence || taskDate(task) === null) {
    setSchedule({ taskId, origDate: null }, { date });
    return;
  }
  if (task.date === date) return;
  write(
    [{ prev: task, next: { ...task, date, recurrence: normalizeRecurrence(task.recurrence, date) } }],
    true,
    `changed the start of ${q(task.title)}`,
  );
}

/** Check / uncheck one occurrence. done=true → toast "Task completed" + Undo. */
export function setDone(ref: OccurrenceRef, done: boolean): void {
  const r = resolveRef(ref);
  if (!r) return;
  const { task, occ } = r;
  if (occ.done === done) return;
  const now = Date.now();
  let next: Task;
  if (occ.recurring) {
    const od = occ.origDate as ISODate;
    const o: OccurrenceOverride = { ...task.overrides[od] };
    if (done) {
      o.done = true;
      o.doneAt = now;
    } else {
      delete o.done;
      delete o.doneAt;
    }
    next = withOverride(task, od, o);
  } else {
    next = { ...task, done, doneAt: done ? now : null };
  }
  const result = write([{ prev: task, next }], true, `${done ? 'completed' : 'reopened'} ${q(task.title)}`);
  if (done) toastWithUndo('Task completed', result);
}

/**
 * Deletes one occurrence: recurring → overrides[orig].skipped = true (a finite series whose every
 * occurrence is skipped is deleted outright); otherwise the task. Toast "Task deleted" + Undo.
 */
export function deleteOccurrence(ref: OccurrenceRef): void {
  const r = resolveRef(ref);
  if (!r) return;
  const { task, occ } = r;
  if (!occ.recurring) {
    deleteTask(task.id);
    return;
  }
  const od = occ.origDate as ISODate;
  let next: Task | undefined = withOverride(task, od, { ...task.overrides[od], skipped: true });
  if (allOccurrencesSkipped(next)) next = undefined;
  const result = write([{ prev: task, next }], true, `deleted ${q(task.title)}`);
  if (result === null) return;
  closePeekIf((p) => p.taskId === task.id && (next === undefined || (p.origDate ?? taskDate(task)) === od));
  toastWithUndo('Task deleted', result);
}

/** Deletes the whole task / series. Toast + Undo (restores the full doc). */
export function deleteTask(taskId: string): void {
  const task = getTask(taskId);
  if (!task) return;
  const result = write([{ prev: task, next: undefined }], true, `deleted ${q(task.title)}`);
  if (result === null) return;
  closePeekIf((p) => p.taskId === taskId);
  toastWithUndo('Task deleted', result);
}

/** Days ahead checked for planned occurrences a repeat change would drop. */
const REPEAT_LOOKAHEAD_DAYS = 400;

/** Dates of open occurrences in [today, today + 400] that `prev` has and `next` no longer has. */
function lostPlannedDates(prev: Task, next: Task): ISODate[] {
  const today = st().today;
  const to = addDays(today, REPEAT_LOOKAHEAD_DAYS);
  const dates = (t: Task): Set<ISODate> => {
    const out = new Set<ISODate>();
    for (const o of occurrencesOfTask(t, today, to)) if (!o.done && o.date !== null) out.add(o.date);
    return out;
  };
  const after = dates(sanitizeTask(next));
  return [...dates(sanitizeTask(prev))].filter((d) => !after.has(d));
}

/**
 * The occurrence a series keeps when its repeat is removed:
 *  1. the one the user is looking at (`keepOrigDate`), if it is open and not in the past;
 *  2. else the first OPEN occurrence on/after today (a checked-off today never hides tomorrow's);
 *  3. else, when everything ahead is checked off, the latest of those (the task stays completed);
 *  4. else null (the series start is used).
 */
function occurrenceToKeep(task: Task, keepOrigDate: ISODate | null): Occurrence | null {
  const today = st().today;
  if (keepOrigDate !== null) {
    const viewed = getOccurrence(task, keepOrigDate);
    if (viewed && viewed.recurring && !viewed.done && viewed.date !== null && viewed.date >= today) return viewed;
  }
  const open = firstOpenOccurrenceFrom(task, today);
  if (open) return open;
  const done = occurrencesOfTask(task, today, addDays(today, 400), true)
    .filter((o) => o.done && o.date !== null)
    .sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : compareInDay(a, b)));
  return done.at(-1) ?? null;
}

/**
 * The one-time copy an overdue task left in Overdue when it was made to repeat (setRecurrence), if
 * the series is still exactly what that conversion made — its start skipped (or not one of its
 * dates), no occurrence checked off, moved or deleted since — and the copy is still open on that
 * date, unchanged.
 */
function missedCopyOf(series: Task): Task | null {
  const start = taskDate(series);
  if (start === null || !series.recurrence) return null;
  const dates = Object.keys(series.overrides);
  const untouched =
    dates.length === 0
      ? getOccurrence(series, start) === null
      : dates.length === 1 && dates[0] === start && deepEqual(series.overrides[start], { skipped: true });
  if (!untouched) return null;
  let copy: Task | null = null;
  for (const t of Object.values(st().tasks)) {
    if (t.id === series.id || taskRule(t) !== null || t.done || t.date !== start || t.endDate !== null) continue;
    if (t.title !== series.title || (t.time ?? null) !== (series.time ?? null) || !deepEqual(t.reminder, series.reminder)) continue;
    if (copy === null || t.createdAt > copy.createdAt) copy = t;
  }
  return copy;
}

/**
 * Sets or clears the repeat rule (Undoable).
 *  - Setting a rule requires a date (else no-op), clears endDate and carries a one-time completion
 *    over to the start occurrence. An OVERDUE one-time task keeps its missed instance: it stays a
 *    one-time task in Overdue (a copy) while the new series skips that date — repeating occurrences
 *    never go overdue, so converting it in place would silently drop it from every list.
 *  - `opts.start` (an existing series only): the new series start, written together with the rule
 *    — one write, one undo entry (the RepeatEditor anchors monthly/yearly rules this way).
 *  - Changing an existing series' rule in a way that drops planned (open) occurrences within the next
 *    400 days shows "Repeat changed" + Undo; a change that only adds occurrences stays quiet.
 *  - Clearing it turns the series into a one-time task on the occurrence from occurrenceToKeep()
 *    (`opts.keepOrigDate`: the occurrence the user is viewing), with its date, time and done state;
 *    per-occurrence overrides (incl. the completed history) are dropped, so a toast offers Undo.
 *    A series made from an overdue task that nothing happened to since goes back to being that one
 *    overdue task (its copy in Overdue is folded back in): changing your mind with Repeat → Never
 *    restores what you had, rather than leaving the copy plus a second task on the next date.
 */
export function setRecurrence(
  taskId: string,
  rule: Recurrence | null,
  opts?: { keepOrigDate?: ISODate | null; start?: ISODate },
): void {
  const task = getTask(taskId);
  if (!task) return;
  const start = taskDate(task);
  if (rule === null) {
    if (!task.recurrence) return;
    const copy = missedCopyOf(task);
    if (copy && start !== null) {
      const result = write(
        [
          { prev: task, next: { ...task, recurrence: null, date: start, endDate: null, done: false, doneAt: null, overrides: {} } },
          { prev: copy, next: undefined },
        ],
        true,
        `removed the repeat of ${q(task.title)}`,
      );
      if (result !== null) closePeekIf((p) => p.taskId === copy.id);
      toastWithUndo('Repeat removed', result);
      return;
    }
    let date = start;
    let time = task.time;
    let done = false;
    let doneAt: number | null = null;
    let excludeKey: string | undefined;
    const kept = start !== null ? occurrenceToKeep(task, validDate(opts?.keepOrigDate) ?? null) : null;
    if (kept && kept.date !== null) {
      date = kept.date;
      time = kept.time;
      done = kept.done;
      doneAt = kept.done ? (kept.doneAt ?? Date.now()) : null;
      excludeKey = kept.key;
    }
    const order = date !== null && date !== start ? keyAtEnd(dayUntimedOrders(date, excludeKey).at(-1) ?? null) : task.order;
    const result = write(
      [{ prev: task, next: { ...task, recurrence: null, date, endDate: null, time, done, doneAt, overrides: {}, order } }],
      true,
      `removed the repeat of ${q(task.title)}`,
    );
    toastWithUndo('Repeat removed', result);
    return;
  }
  if (start === null) return;
  const wanted = task.recurrence ? validDate(opts?.start) : null;
  const newStart: ISODate = wanted ?? start;
  const norm = normalizeRecurrence(rule, newStart);
  if (task.recurrence && newStart === start && deepEqual(normalizeRecurrence(task.recurrence, start), norm)) return;
  let next: Task = { ...task, date: newStart, recurrence: norm, endDate: null };
  if (task.recurrence) {
    const result = write([{ prev: task, next }], true, `changed the repeat of ${q(task.title)}`);
    if (result !== null && lostPlannedDates(task, next).length > 0) toastWithUndo('Repeat changed', result);
    return;
  }
  // A one-time task becomes a series starting on its own date.
  const changes: Change[] = [];
  let missed: Task | null = null;
  next = { ...next, done: false, doneAt: null, overrides: {} };
  const startIsOccurrence = getOccurrence(sanitizeTask(next), start) !== null;
  if (task.done) {
    if (startIsOccurrence) next.overrides = { [start]: { done: true, doneAt: task.doneAt ?? Date.now() } };
  } else if (isOverdue(singleOccurrence(task), st().today)) {
    const now = Date.now();
    missed = { ...task, id: newId(), recurrence: null, overrides: {}, remindAt: null, createdAt: now, updatedAt: now };
    if (startIsOccurrence) next.overrides = { [start]: { skipped: true } };
    changes.push({ prev: undefined, next: missed });
  }
  changes.unshift({ prev: task, next });
  const result = write(changes, true, `made ${q(task.title)} repeat`);
  if (missed && result !== null) toastWithUndo(`${q(task.title)} repeats now · the ${formatDateShort(start)} one stays in Overdue`, result);
}

/**
 * Sets the clock time of a whole repeating series (the date picker's time edits only change one
 * occurrence; its "Use 7:00 AM for every repeat" calls this). Per-occurrence times equal to the new
 * series time are dropped as redundant; deliberately different ones stay. A one-time task just gets
 * the time. Undoable, with a toast + Undo for a series.
 */
export function setSeriesTime(taskId: string, time: HM | null): void {
  const task = getTask(taskId);
  if (!task || (time !== null && !(typeof time === 'string' && isHM(time)))) return;
  if (taskRule(task) === null) {
    if (task.date !== null) setSchedule({ taskId, origDate: null }, { date: task.date, time });
    return;
  }
  const overrides: Record<ISODate, OccurrenceOverride> = {};
  for (const [d, o] of Object.entries(task.overrides)) {
    if (o.time !== undefined && (o.time ?? null) === time) {
      const rest: OccurrenceOverride = { ...o };
      delete rest.time;
      overrides[d] = rest;
    } else {
      overrides[d] = o;
    }
  }
  const result = write([{ prev: task, next: { ...task, time, overrides } }], true, `changed the time of ${q(task.title)}`);
  // Every occurrence (and its alerts) changes: phones have no ⌘Z, so offer Undo.
  toastWithUndo(time ? `Every repeat is at ${formatTime(time)} now` : 'Time removed from every repeat', result);
}

/** Per-task reminder override. Undoable. */
export function setReminder(taskId: string, reminder: Reminder): void {
  const task = getTask(taskId);
  if (!task) return;
  const r = normalizeReminder(reminder);
  if (deepEqual(r, task.reminder)) return;
  write([{ prev: task, next: { ...task, reminder: r } }], true, `changed the reminder of ${q(task.title)}`);
}

/**
 * Moves every overdue one-time task to today (multi-day keep their length). One repo.apply, one undo
 * entry (the repo commits each task on its own: one task deleted elsewhere can't sink the others).
 */
export function moveAllOverdueToToday(): void {
  const s = st();
  const today = s.today;
  const overdue: Occurrence[] = [];
  for (const t of Object.values(s.tasks)) {
    if (taskRule(t) !== null || taskDate(t) === null) continue;
    const occ = singleOccurrence(t);
    if (isOverdue(occ, today)) overdue.push(occ);
  }
  if (overdue.length === 0) return;
  overdue.sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : compareInDay(a, b)));
  let last = dayUntimedOrders(today).at(-1) ?? null;
  const changes: Change[] = overdue.map((occ) => {
    const len = occ.multiDay && occ.date !== null && occ.endDate !== null ? diffDays(occ.endDate, occ.date) : 0;
    last = keyAtEnd(last);
    return { prev: occ.task, next: { ...occ.task, date: today, endDate: len > 0 ? addDays(today, len) : null, order: last } };
  });
  const n = overdue.length;
  const what = `${n} ${n === 1 ? 'task' : 'tasks'} to today`;
  toastWithUndo(`Moved ${what}`, write(changes, true, `moved ${what}`));
}

/** Copy of a task right below the original (not done; recurring keeps moves/skips). Undoable. */
export function duplicateTask(taskId: string): string {
  const task = getTask(taskId);
  if (!task) return '';
  const orders = taskDate(task) === null ? inboxOrders() : dayUntimedOrders(task.date as ISODate);
  const after = orders.find((o) => o > task.order) ?? null;
  const overrides: Record<ISODate, OccurrenceOverride> = {};
  if (task.recurrence) {
    for (const [d, o] of Object.entries(task.overrides)) {
      const copy: OccurrenceOverride = { ...o };
      delete copy.done;
      delete copy.doneAt;
      if (Object.values(copy).some((v) => v !== undefined)) overrides[d] = copy;
    }
  }
  const now = Date.now();
  const copy: Task = {
    ...task,
    id: newId(),
    order: keyBetween(task.order, after),
    done: false,
    doneAt: null,
    overrides,
    remindAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return write([{ prev: undefined, next: copy }], true, `duplicated ${q(task.title)}`) ? copy.id : '';
}

/**
 * Merges synced settings (summary merged field by field) and recomputes summaryAt. A time zone
 * change recomputes every task's remindAt (one repo.apply of the ones that changed; the repo
 * commits each task on its own, so one task deleted elsewhere can't sink the rest).
 */
export function updateSettings(patch: Partial<Settings>): void {
  const s = st();
  const prev = s.settings;
  const next = mergeSettings(prev, patch);
  if (deepEqual(prev, next)) return;
  const now = Date.now();
  useStore.setState({ settings: next });
  const repo = getRepo();
  if (!repo) return;

  // Only the leaves that changed: other devices' concurrent edits to other fields survive.
  const changed: Partial<Settings> = {};
  if (next.weekStart !== prev.weekStart) changed.weekStart = next.weekStart;
  if (next.timezone !== prev.timezone) changed.timezone = next.timezone;
  const summary: Partial<Settings['summary']> = {};
  if (next.summary.enabled !== prev.summary.enabled) summary.enabled = next.summary.enabled;
  if (next.summary.time !== prev.summary.time) summary.time = next.summary.time;
  if (Object.keys(summary).length > 0) changed.summary = summary as Settings['summary'];
  repo.updateUser({ settings: changed, summaryAt: safeNextSummaryAt(next, now) });

  if (next.timezone !== prev.timezone) {
    const ops: RepoOp[] = [];
    for (const t of Object.values(s.tasks)) {
      const remindAt = remindAtFor(t, next.timezone, now);
      if (remindAt !== t.remindAt) ops.push({ type: 'update', id: t.id, patch: { fields: { remindAt } } });
    }
    if (ops.length > 0) repo.apply(ops);
  }
}

/** Per-device theme preference (persisted to localStorage by the store). */
export function setTheme(theme: ThemePref): void {
  if (!isThemePref(theme) || st().theme === theme) return;
  useStore.setState({ theme });
}

/**
 * Pops the undo stack (max 50); also bound to ⌘Z. Always says what it undid ("Undid: added
 * “Buy milk”") with a Redo button, so an undo never removes or changes a task silently.
 */
export function undo(): void {
  const entry = takeUndo();
  if (!entry) return;
  const inverse = restore(entry);
  if (!inverse) return;
  const r = pushRedo(inverse.before, inverse.created, entry.label);
  r.toastId = showToast(entry.label ? `Undid: ${entry.label}` : 'Undone', {
    action: { label: 'Redo', run: () => redoEntry(r.id) },
  });
}

/**
 * Re-applies the most recently undone step (⌘⇧Z / the toast's Redo). Any new change clears it —
 * and dismisses the "Undid: … · Redo" toasts, so a Redo button never silently does nothing.
 */
export function redo(): void {
  redoEntry();
}

function redoEntry(id?: number): void {
  const entry = takeRedo(id);
  if (!entry) return;
  const inverse = restore(entry);
  if (!inverse) return;
  toastWithUndo(entry.label ? `Redid: ${entry.label}` : 'Redone', pushUndo(inverse.before, inverse.created, entry.label));
}

// =============================================================================================
// Toasts
// =============================================================================================

let toastSeq = 0;

export function showToast(message: string, opts?: { action?: { label: string; run: () => void }; duration?: number }): string {
  const id = `toast-${++toastSeq}`;
  const item: ToastItem = { id, message, duration: opts?.duration ?? TOAST_MS };
  if (opts?.action) item.action = opts.action;
  const toasts = [...st().toasts, item];
  useStore.setState({ toasts: toasts.length > MAX_TOASTS ? toasts.slice(-MAX_TOASTS) : toasts });
  return id;
}

export function dismissToast(id: string): void {
  const toasts = st().toasts;
  if (!toasts.some((t) => t.id === id)) return;
  useStore.setState({ toasts: toasts.filter((t) => t.id !== id) });
}

// =============================================================================================
// UI
// =============================================================================================

export function openPeek(ref: OccurrenceRef): void {
  if (!ref || typeof ref.taskId !== 'string') return;
  const cur = st().ui.peek;
  const origDate = ref.origDate ?? null;
  if (cur && cur.taskId === ref.taskId && cur.origDate === origDate) return;
  setUI({ peek: { taskId: ref.taskId, origDate } });
}

export function closePeek(): void {
  setUI({ peek: null });
}

export function setView(view: 'month' | 'week'): void {
  if (view !== 'month' && view !== 'week') return;
  const { ui, today } = st();
  if (ui.view === view) return;
  if (view === 'week') {
    // Keep context: the visible month's week containing today, else its first week.
    const anchor = startOfMonth(today) === ui.visibleMonth ? today : ui.visibleMonth;
    setUI({ view, weekAnchor: anchor });
  } else {
    setUI({
      view,
      visibleMonth: startOfMonth(ui.weekAnchor),
      scrollRequest: { date: ui.weekAnchor, behavior: 'instant', nonce: ++scrollNonce },
    });
  }
}

export function goToday(): void {
  const { ui, today } = st();
  if (ui.view === 'week') setUI({ weekAnchor: today });
  else setUI({ visibleMonth: startOfMonth(today), scrollRequest: { date: today, behavior: 'smooth', nonce: ++scrollNonce } });
}

function step(dir: 1 | -1): void {
  const ui = st().ui;
  if (ui.view === 'week') {
    setUI({ weekAnchor: addDays(ui.weekAnchor, 7 * dir) });
    return;
  }
  // The header switches immediately (optimistic); rapid presses accumulate from the new month.
  const target = addMonths(startOfMonth(ui.visibleMonth), dir);
  setUI({ visibleMonth: target, scrollRequest: { date: target, behavior: 'smooth', nonce: ++scrollNonce } });
}

export function goPrev(): void {
  step(-1);
}

export function goNext(): void {
  step(1);
}

/** Asks the month scroller to bring `date` into view (a new nonce every time). Week view: shows that week. */
export function scrollCalendarTo(date: ISODate, behavior: 'smooth' | 'instant' = 'smooth'): void {
  if (!isValidISODate(date)) return;
  const patch: Partial<UIState> = { scrollRequest: { date, behavior, nonce: ++scrollNonce } };
  if (st().ui.view === 'week') patch.weekAnchor = date;
  setUI(patch);
}

/** MonthScroller reports the dominating month (no-op if same). */
export function setVisibleMonth(firstOfMonth: ISODate): void {
  if (!isValidISODate(firstOfMonth)) return;
  setUI({ visibleMonth: startOfMonth(firstOfMonth) });
}

export function openComposer(date: ISODate): void {
  if (!isValidISODate(date)) return;
  if (st().ui.composer?.date === date) return;
  setUI({ composer: { date } });
}

export function closeComposer(): void {
  setUI({ composer: null });
}

export function setSheet(s: UIState['sheet']): void {
  if (s !== 'collapsed' && s !== 'half' && s !== 'full') return;
  setUI({ sheet: s });
}

export function setDrawer(open: boolean): void {
  setUI({ drawerOpen: open });
}

export function toggleLeft(): void {
  setUI({ leftOpen: !st().ui.leftOpen });
}

export function toggleRight(): void {
  setUI({ rightOpen: !st().ui.rightOpen });
}

export function setSettingsOpen(open: boolean): void {
  setUI({ settingsOpen: open });
}

export function setDragging(d: UIState['dragging']): void {
  const cur = st().ui.dragging;
  if (cur === d) return;
  if (cur && d && cur.occKey === d.occKey && cur.source === d.source && cur.recurring === d.recurring) return;
  setUI({ dragging: d });
}

/** Flips a group's collapsed state; `collapsedDefault` is used when the device has no preference yet. */
export function toggleGroup(id: string, collapsedDefault: boolean): void {
  const groups = st().ui.collapsedGroups;
  const current = hasOwn(groups, id) ? groups[id] === true : collapsedDefault;
  setUI({ collapsedGroups: { ...groups, [id]: !current } });
}

/** The Completed group lists 50 more (older) items — every completion stays reachable. */
export function showMoreCompleted(): void {
  setUI({ completedLimit: st().ui.completedLimit + COMPLETED_PAGE });
}

// =============================================================================================
// Session (used by data/boot.ts)
// =============================================================================================

/** Clears per-account state (sign-in/out): tasks, settings, undo history, open overlays. */
export function resetSession(): void {
  dismissToastsOf(clearUndo());
  lastRename = null;
  const s = st();
  useStore.setState({
    tasks: {},
    tasksLoaded: false,
    settings: initialSettings(),
    sync: { ...s.sync, pendingWrites: false, fromCache: false, error: null, loadFailed: false },
    ui: {
      ...s.ui,
      peek: null,
      composer: null,
      dragging: null,
      settingsOpen: false,
      drawerOpen: false,
      completedLimit: COMPLETED_PAGE,
    },
  });
}
