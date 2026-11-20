/**
 * Memoized selector hooks (SPEC §4.3). zustand runs every selector on every store change (drag
 * state, toasts, …), so each one is an O(1) cache hit unless `tasks` (or `today`) changed, and
 * results are referentially stable:
 *
 *  - Occurrence interning: an occurrence is fully determined by (task object, key), and repos keep
 *    the identity of unchanged task objects, so the same Occurrence object is returned for an
 *    unchanged task across store versions → memo'd cards don't re-render when another task changes.
 *  - Structural sharing: when a recomputed list/layout/group holds the same (interned) items as
 *    the previous result for the same input, the previous object is returned.
 *  - Week layouts expand occurrences once per tasks version in 8-week chunks shared by all rows.
 */
import type { ISODate, ListGroup, ListItem, Occurrence, OccurrenceRef, Task, WeekBar, WeekLayout } from '@shared/types';
import { fromEpochDay, isValidISODate, toEpochDay } from '@shared/dates';
import { getOccurrence, inboxTasks, occurrencesInRange } from '@shared/occurrences';
import { buildTaskGroups } from '@shared/grouping';
import { layoutWeek } from '@shared/layout';
import { badgeCount } from '@shared/reminders';
import { COMPLETED_PAGE, useStore } from './store';

type TasksRecord = Record<string, Task>;

const EMPTY_OCCS: Occurrence[] = [];
const EMPTY_TASKS: Task[] = [];
const EMPTY_LAYOUT: WeekLayout = { days: [], bars: [], laneCount: 0, singles: {} };

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Map with a size cap; the oldest insertion is evicted first (re-setting refreshes recency). */
function setBounded<K, V>(m: Map<K, V>, k: K, v: V, cap: number): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > cap) {
    const oldest = m.keys().next();
    if (!oldest.done) m.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------------------------
// Interning
// ---------------------------------------------------------------------------------------------

const internTable = new WeakMap<Task, Map<string, Occurrence>>();

/** The canonical Occurrence object for (occ.task, occ.key). */
export function internOccurrence(occ: Occurrence): Occurrence {
  let m = internTable.get(occ.task);
  if (!m) {
    m = new Map();
    internTable.set(occ.task, m);
  }
  const prev = m.get(occ.key);
  if (prev) return prev;
  m.set(occ.key, occ);
  return occ;
}

function internAll(list: Occurrence[]): Occurrence[] {
  for (let i = 0; i < list.length; i++) list[i] = internOccurrence(list[i] as Occurrence);
  return list;
}

// ---------------------------------------------------------------------------------------------
// Tasks list
// ---------------------------------------------------------------------------------------------

const listCache = new WeakMap<TasksRecord, Task[]>();

/** Object.values(tasks), cached per tasks version. */
export function tasksListOf(tasks: TasksRecord): Task[] {
  let l = listCache.get(tasks);
  if (!l) {
    l = Object.values(tasks);
    listCache.set(tasks, l);
  }
  return l;
}

export function useTasksList(): Task[] {
  return useStore((s) => tasksListOf(s.tasks));
}

// ---------------------------------------------------------------------------------------------
// Occurrences in range
// ---------------------------------------------------------------------------------------------

const rangeCache = new WeakMap<TasksRecord, Map<string, Occurrence[]>>();
const lastRange = new Map<string, Occurrence[]>();

export function occurrencesInRangeOf(tasks: TasksRecord, from: ISODate, to: ISODate): Occurrence[] {
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) return EMPTY_OCCS;
  const key = `${from}|${to}`;
  let perVersion = rangeCache.get(tasks);
  if (!perVersion) {
    perVersion = new Map();
    rangeCache.set(tasks, perVersion);
  }
  const hit = perVersion.get(key);
  if (hit) return hit;
  const fresh = internAll(occurrencesInRange(tasksListOf(tasks), from, to));
  const prev = lastRange.get(key);
  const result = prev && sameArray(prev, fresh) ? prev : fresh;
  setBounded(lastRange, key, result, 64);
  perVersion.set(key, result);
  return result;
}

export function useOccurrencesInRange(from: ISODate, to: ISODate): Occurrence[] {
  return useStore((s) => occurrencesInRangeOf(s.tasks, from, to));
}

// ---------------------------------------------------------------------------------------------
// Week layout
// ---------------------------------------------------------------------------------------------

/** Days per expansion chunk (8 weeks): a month view touches 1–2 chunks. */
const CHUNK_DAYS = 56;

interface VersionData {
  chunks: Map<number, Occurrence[]>;
  layouts: Map<string, WeekLayout>;
}

const versionCache = new WeakMap<TasksRecord, VersionData>();
const lastLayouts = new Map<string, WeekLayout>();

function versionData(tasks: TasksRecord): VersionData {
  let vd = versionCache.get(tasks);
  if (!vd) {
    vd = { chunks: new Map(), layouts: new Map() };
    versionCache.set(tasks, vd);
  }
  return vd;
}

function chunkOccurrences(tasks: TasksRecord, vd: VersionData, idx: number): Occurrence[] {
  let c = vd.chunks.get(idx);
  if (!c) {
    const from = fromEpochDay(idx * CHUNK_DAYS);
    const to = fromEpochDay(idx * CHUNK_DAYS + CHUNK_DAYS - 1);
    c = internAll(occurrencesInRange(tasksListOf(tasks), from, to));
    vd.chunks.set(idx, c);
  }
  return c;
}

function sameBar(a: WeekBar, b: WeekBar): boolean {
  return (
    a.occ === b.occ &&
    a.startCol === b.startCol &&
    a.endCol === b.endCol &&
    a.lane === b.lane &&
    a.continuesBefore === b.continuesBefore &&
    a.continuesAfter === b.continuesAfter
  );
}

function sameLayout(a: WeekLayout, b: WeekLayout): boolean {
  if (a.laneCount !== b.laneCount || a.bars.length !== b.bars.length || !sameArray(a.days, b.days)) return false;
  for (let i = 0; i < a.bars.length; i++) if (!sameBar(a.bars[i] as WeekBar, b.bars[i] as WeekBar)) return false;
  for (const d of a.days) if (!sameArray(a.singles[d] ?? EMPTY_OCCS, b.singles[d] ?? EMPTY_OCCS)) return false;
  return true;
}

/** Layout of one row of consecutive days, stable per tasks version (and across versions when unchanged). */
export function weekLayoutOf(tasks: TasksRecord, days: ISODate[]): WeekLayout {
  const first = days[0];
  if (first === undefined || !days.every((d) => isValidISODate(d))) return EMPTY_LAYOUT;
  const key = `${first}:${days.length}`;
  const vd = versionData(tasks);
  const hit = vd.layouts.get(key);
  if (hit) return hit;
  const firstE = toEpochDay(first);
  const lastE = firstE + days.length - 1;
  const c0 = Math.floor(firstE / CHUNK_DAYS);
  const c1 = Math.floor(lastE / CHUNK_DAYS);
  let occs = chunkOccurrences(tasks, vd, c0);
  if (c1 !== c0) {
    // Interned → a multi-day occurrence present in both chunks is the same object.
    const seen = new Set(occs);
    occs = occs.slice();
    for (let i = c0 + 1; i <= c1; i++) {
      for (const o of chunkOccurrences(tasks, vd, i)) {
        if (!seen.has(o)) {
          seen.add(o);
          occs.push(o);
        }
      }
    }
  }
  const fresh = layoutWeek(days, occs);
  const prev = lastLayouts.get(key);
  const result = prev && sameLayout(prev, fresh) ? prev : fresh;
  setBounded(lastLayouts, key, result, 400);
  vd.layouts.set(key, result);
  return result;
}

/** Uses a per-tasks-version cache keyed by days[0]. */
export function useWeekLayout(days: ISODate[]): WeekLayout {
  return useStore((s) => weekLayoutOf(s.tasks, days));
}

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

const inboxCache = new WeakMap<TasksRecord, Task[]>();
let lastInbox: Task[] = EMPTY_TASKS;

export function inboxTasksOf(tasks: TasksRecord): Task[] {
  let r = inboxCache.get(tasks);
  if (!r) {
    const fresh = inboxTasks(tasksListOf(tasks));
    r = sameArray(lastInbox, fresh) ? lastInbox : fresh;
    lastInbox = r;
    inboxCache.set(tasks, r);
  }
  return r;
}

export function useInboxTasks(): Task[] {
  return useStore((s) => inboxTasksOf(s.tasks));
}

// ---------------------------------------------------------------------------------------------
// Task groups (left list)
// ---------------------------------------------------------------------------------------------

let groupsMemo: { tasks: TasksRecord; today: ISODate; limit: number; groups: ListGroup[] } | null = null;

function shareItems(prev: ListItem[], next: ListItem[]): ListItem[] {
  let same = prev.length === next.length;
  const out = next.map((it, i) => {
    const occ = internOccurrence(it.occ);
    const p = prev[i];
    if (p && p.occ === occ && p.meta === it.meta && p.overdue === it.overdue) return p;
    same = false;
    return occ === it.occ ? it : { ...it, occ };
  });
  return same ? prev : out;
}

function shareGroup(prev: ListGroup | undefined, next: ListGroup): ListGroup {
  const items = shareItems(prev?.items ?? [], next.items);
  if (
    prev &&
    items === prev.items &&
    prev.title === next.title &&
    prev.subtitle === next.subtitle &&
    prev.count === next.count &&
    prev.collapsible === next.collapsible &&
    prev.defaultCollapsed === next.defaultCollapsed
  ) {
    return prev;
  }
  return items === next.items ? next : { ...next, items };
}

/** `completedLimit`: how many Completed items to list (store.ui.completedLimit; "Show more" grows it). */
export function taskGroupsOf(tasks: TasksRecord, today: ISODate, completedLimit: number = COMPLETED_PAGE): ListGroup[] {
  if (groupsMemo && groupsMemo.tasks === tasks && groupsMemo.today === today && groupsMemo.limit === completedLimit) {
    return groupsMemo.groups;
  }
  const prevGroups = groupsMemo?.groups ?? [];
  const prevById = new Map(prevGroups.map((g) => [g.id, g]));
  const fresh = buildTaskGroups(tasksListOf(tasks), today, { completedLimit });
  const shared = fresh.map((g) => shareGroup(prevById.get(g.id), g));
  const groups = sameArray(prevGroups, shared) ? prevGroups : shared;
  groupsMemo = { tasks, today, limit: completedLimit, groups };
  return groups;
}

export function useTaskGroups(): ListGroup[] {
  return useStore((s) => taskGroupsOf(s.tasks, s.today, s.ui.completedLimit));
}

// ---------------------------------------------------------------------------------------------
// Single task / occurrence / badge
// ---------------------------------------------------------------------------------------------

export function useTask(id: string | null | undefined): Task | undefined {
  return useStore((s) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(s.tasks, id) ? s.tasks[id] : undefined));
}

const occByRef = new WeakMap<Task, Map<string, Occurrence | null>>();

/** The (interned) occurrence a ref points at, or null. Stable while the task object is unchanged. */
export function occurrenceOf(tasks: TasksRecord, ref: OccurrenceRef | null): Occurrence | null {
  if (!ref || !Object.prototype.hasOwnProperty.call(tasks, ref.taskId)) return null;
  const task = tasks[ref.taskId] as Task;
  let m = occByRef.get(task);
  if (!m) {
    m = new Map();
    occByRef.set(task, m);
  }
  const k = ref.origDate ?? '';
  if (m.has(k)) return m.get(k) ?? null;
  const occ = getOccurrence(task, ref.origDate ?? null);
  const result = occ ? internOccurrence(occ) : null;
  m.set(k, result);
  return result;
}

export function useOccurrence(ref: OccurrenceRef | null): Occurrence | null {
  return useStore((s) => occurrenceOf(s.tasks, ref));
}

let badgeMemo: { tasks: TasksRecord; today: ISODate; count: number } | null = null;

export function badgeCountOf(tasks: TasksRecord, today: ISODate): number {
  if (badgeMemo && badgeMemo.tasks === tasks && badgeMemo.today === today) return badgeMemo.count;
  const count = badgeCount(tasksListOf(tasks), today);
  badgeMemo = { tasks, today, count };
  return count;
}

export function useBadgeCount(): number {
  return useStore((s) => badgeCountOf(s.tasks, s.today));
}
