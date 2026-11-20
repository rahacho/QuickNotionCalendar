/**
 * Pure document helpers shared by both repos and the actions:
 *  - normalize*: read stored (possibly partial / legacy / corrupt) documents into full, valid objects
 *  - sanitizeTask: enforce the Task invariants documented in shared/types.ts
 *  - applyTaskPatch / applyOps: the in-memory mirror of a repo write (same semantics as Firestore)
 *  - diffTask: the minimal field-level patch between two versions of a task
 */
import { DEFAULT_SETTINGS } from '@shared/types';
import type { ISODate, OccurrenceOverride, Recurrence, Reminder, Settings, Task, UserDoc } from '@shared/types';
import { isHM, isValidISODate } from '@shared/dates';
import { normalizeRecurrence } from '@shared/recurrence';
import { nextSummaryAt } from '@shared/reminders';
import { DELETE_FIELD, type OverridePatch, type RepoOp, type TaskPatch } from './repo';

/** Firestore rules cap titles at 500 characters. */
export const MAX_TITLE_LENGTH = 500;
/** Order key used when a stored task has none. */
export const DEFAULT_ORDER = 'a0';

const OVERRIDE_FIELDS = ['done', 'doneAt', 'skipped', 'date', 'time', 'order'] as const satisfies ReadonlyArray<keyof OccurrenceOverride>;
const DIFF_FIELDS = [
  'title',
  'date',
  'endDate',
  'time',
  'order',
  'done',
  'doneAt',
  'recurrence',
  'reminder',
  'remindAt',
] as const satisfies ReadonlyArray<keyof Task>;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** The device's IANA time zone ('UTC' when the runtime can't tell). */
export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz !== '' ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Millis from a number or a Firestore Timestamp-like object (legacy docs); null otherwise. */
function toMillis(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (isObj(v) && typeof v.toMillis === 'function') {
    try {
      const n = (v.toMillis as () => unknown)();
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Cleans a title for storage: single line (line breaks → spaces), trimmed, at most 500 UTF-16
 * code units without splitting a surrogate pair.
 */
export function cleanTitle(s: unknown): string {
  if (typeof s !== 'string') return '';
  let t = s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  if (t.length > MAX_TITLE_LENGTH) {
    t = t.slice(0, MAX_TITLE_LENGTH);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
    t = t.trimEnd();
  }
  return t;
}

export function normalizeReminder(r: unknown): Reminder {
  if (!isObj(r)) return { kind: 'default' };
  switch (r.kind) {
    case 'none':
      return { kind: 'none' };
    case 'offset':
      return typeof r.minutes === 'number' && Number.isFinite(r.minutes)
        ? { kind: 'offset', minutes: Math.round(r.minutes) }
        : { kind: 'default' };
    case 'at':
      return typeof r.time === 'string' && isHM(r.time)
        ? {
            kind: 'at',
            time: r.time,
            daysBefore: typeof r.daysBefore === 'number' && Number.isFinite(r.daysBefore) ? Math.max(0, Math.floor(r.daysBefore)) : 0,
          }
        : { kind: 'default' };
    default:
      return { kind: 'default' };
  }
}

function isValidReminder(r: unknown): r is Reminder {
  if (!isObj(r)) return false;
  switch (r.kind) {
    case 'default':
    case 'none':
      return true;
    case 'offset':
      return typeof r.minutes === 'number' && Number.isFinite(r.minutes);
    case 'at':
      return typeof r.time === 'string' && isHM(r.time) && typeof r.daysBefore === 'number' && Number.isFinite(r.daysBefore) && r.daysBefore >= 0;
    default:
      return false;
  }
}

/** A stored override with only valid fields; null when nothing usable is left. */
export function normalizeOverride(o: unknown): OccurrenceOverride | null {
  if (!isObj(o)) return null;
  const out: OccurrenceOverride = {};
  if (typeof o.done === 'boolean') out.done = o.done;
  if (hasOwn(o, 'doneAt')) {
    const ms = toMillis(o.doneAt);
    if (ms !== null || o.doneAt === null) out.doneAt = ms;
  }
  if (typeof o.skipped === 'boolean') out.skipped = o.skipped;
  if (typeof o.date === 'string' && isValidISODate(o.date)) out.date = o.date;
  if (o.time === null) out.time = null;
  else if (typeof o.time === 'string' && isHM(o.time)) out.time = o.time;
  if (typeof o.order === 'string' && o.order !== '') out.order = o.order;
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeOverrides(raw: unknown): Record<ISODate, OccurrenceOverride> {
  const out: Record<ISODate, OccurrenceOverride> = {};
  if (!isObj(raw)) return out;
  for (const k of Object.keys(raw)) {
    if (!isValidISODate(k)) continue;
    const o = normalizeOverride(raw[k]);
    if (o !== null) out[k] = o;
  }
  return out;
}

/**
 * Reads a stored task document into a full Task (robust to partial / legacy docs). Returns null
 * only when the document isn't an object at all. Invariants are enforced (see sanitizeTask).
 */
export function normalizeTask(raw: unknown, id: string): Task | null {
  if (!isObj(raw)) return null;
  const updatedAt = toMillis(raw.updatedAt);
  const createdAt = toMillis(raw.createdAt) ?? updatedAt ?? 0;
  const task: Task = {
    id,
    title: typeof raw.title === 'string' ? raw.title : '',
    date: typeof raw.date === 'string' && isValidISODate(raw.date) ? raw.date : null,
    endDate: typeof raw.endDate === 'string' && isValidISODate(raw.endDate) ? raw.endDate : null,
    time: typeof raw.time === 'string' && isHM(raw.time) ? raw.time : null,
    order: typeof raw.order === 'string' && raw.order !== '' ? raw.order : DEFAULT_ORDER,
    done: raw.done === true,
    doneAt: toMillis(raw.doneAt),
    recurrence: isObj(raw.recurrence) ? (raw.recurrence as unknown as Recurrence) : null,
    overrides: normalizeOverrides(raw.overrides),
    reminder: normalizeReminder(raw.reminder),
    remindAt: toMillis(raw.remindAt),
    createdAt,
    updatedAt: updatedAt ?? createdAt,
  };
  return sanitizeTask(task, { keepOverrides: true });
}

/**
 * Enforces the Task invariants (shared/types.ts):
 *  - no date → no endDate, no time, no recurrence
 *  - endDate > date, else null (single-day); never with a recurrence
 *  - recurrence normalized; recurring tasks are never done at top level
 *  - doneAt only when done
 *  - non-recurring tasks carry no overrides; empty override entries are dropped
 * Returns the same object when nothing changed.
 */
export function sanitizeTask(t: Task, opts?: { keepOverrides?: boolean }): Task {
  const date = typeof t.date === 'string' && isValidISODate(t.date) ? t.date : null;
  let recurrence: Recurrence | null = null;
  if (date !== null && isObj(t.recurrence)) recurrence = normalizeRecurrence(t.recurrence, date);
  const endDate =
    date !== null && recurrence === null && typeof t.endDate === 'string' && isValidISODate(t.endDate) && t.endDate > date
      ? t.endDate
      : null;
  const time = date !== null && typeof t.time === 'string' && isHM(t.time) ? t.time : null;
  const done = recurrence === null && t.done === true;
  const doneAt = done ? (typeof t.doneAt === 'number' && Number.isFinite(t.doneAt) ? t.doneAt : null) : null;
  let overrides = t.overrides;
  if (recurrence === null && !opts?.keepOverrides) {
    overrides = isObj(overrides) && Object.keys(overrides).length === 0 ? overrides : {};
  } else if (!isObj(overrides)) {
    overrides = {};
  } else {
    let pruned: Record<ISODate, OccurrenceOverride> | null = null;
    for (const k of Object.keys(overrides)) {
      const o = overrides[k];
      if (!isObj(o) || Object.keys(o).every((f) => (o as Obj)[f] === undefined)) {
        pruned ??= { ...overrides };
        delete pruned[k];
      }
    }
    if (pruned) overrides = pruned;
  }
  const title = typeof t.title === 'string' ? t.title : '';
  const order = typeof t.order === 'string' && t.order !== '' ? t.order : DEFAULT_ORDER;
  const reminder = isValidReminder(t.reminder) ? t.reminder : normalizeReminder(t.reminder);
  if (
    date === t.date &&
    endDate === t.endDate &&
    time === t.time &&
    done === t.done &&
    doneAt === t.doneAt &&
    deepEqual(recurrence, t.recurrence) &&
    overrides === t.overrides &&
    title === t.title &&
    order === t.order &&
    reminder === t.reminder
  ) {
    return t;
  }
  return { ...t, title, date, endDate, time, order, done, doneAt, recurrence, overrides, reminder };
}

export function normalizeSettings(raw: unknown, fallbackTimeZone: string = deviceTimeZone()): Settings {
  const s = isObj(raw) ? raw : {};
  const summary = isObj(s.summary) ? s.summary : {};
  return {
    weekStart: s.weekStart === 0 ? 0 : 1,
    summary: {
      enabled: typeof summary.enabled === 'boolean' ? summary.enabled : DEFAULT_SETTINGS.summary.enabled,
      time: typeof summary.time === 'string' && isHM(summary.time) ? summary.time : DEFAULT_SETTINGS.summary.time,
    },
    timezone: typeof s.timezone === 'string' && s.timezone.trim() !== '' ? s.timezone : fallbackTimeZone,
  };
}

/** Deep merge of a settings patch (summary merged field by field), normalized. */
export function mergeSettings(base: Settings, patch: Partial<Settings> | undefined): Settings {
  if (!patch) return base;
  const summaryPatch: Obj = isObj(patch.summary) ? patch.summary : {};
  const merged: Obj = { ...base, summary: { ...base.summary } };
  for (const k of Object.keys(patch) as Array<keyof Settings>) {
    if (k === 'summary' || patch[k] === undefined) continue;
    merged[k] = patch[k];
  }
  const summary = merged.summary as Obj;
  for (const k of Object.keys(summaryPatch)) if (summaryPatch[k] !== undefined) summary[k] = summaryPatch[k];
  return normalizeSettings(merged, base.timezone);
}

/**
 * A stored user document. A missing time zone reads as 'UTC' — what the scheduled function uses for
 * it — not as this device's zone, so boot notices the difference and writes the device zone.
 */
export function normalizeUserDoc(raw: unknown): UserDoc | null {
  if (!isObj(raw)) return null;
  return {
    settings: normalizeSettings(raw.settings, DEFAULT_SETTINGS.timezone),
    summaryAt: toMillis(raw.summaryAt),
    updatedAt: toMillis(raw.updatedAt) ?? 0,
  };
}

/** A new user's document: default settings in the device's time zone, next summary scheduled. */
export function defaultUserDoc(now: number): UserDoc {
  const settings: Settings = { ...DEFAULT_SETTINGS, summary: { ...DEFAULT_SETTINGS.summary }, timezone: deviceTimeZone() };
  return { settings, summaryAt: safeNextSummaryAt(settings, now), updatedAt: now };
}

export function safeNextSummaryAt(settings: Settings, now: number): number | null {
  try {
    return nextSummaryAt(settings, now);
  } catch {
    return null;
  }
}

/** Structural equality for JSON-like values (undefined object members count as absent). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
    return true;
  }
  const ao = a as Obj;
  const bo = b as Obj;
  for (const k of Object.keys(ao)) if (ao[k] !== undefined && !deepEqual(ao[k], bo[k])) return false;
  for (const k of Object.keys(bo)) if (bo[k] !== undefined && ao[k] === undefined) return false;
  return true;
}

/** The in-memory result of a repo update (Firestore semantics: deleting every field of an entry leaves `{}`). */
export function applyTaskPatch(task: Task, patch: TaskPatch, now: number): Task {
  const next: Task = { ...task };
  const fields = patch.fields;
  if (fields) {
    for (const k of Object.keys(fields) as Array<keyof typeof fields>) {
      const v = fields[k];
      if (v !== undefined) (next as unknown as Obj)[k] = v;
    }
  }
  if (patch.overrides) {
    const ov: Record<ISODate, OccurrenceOverride> = { ...(isObj(task.overrides) ? task.overrides : {}) };
    for (const d of Object.keys(patch.overrides)) {
      const op = patch.overrides[d];
      if (op === undefined) continue;
      if (op === null) {
        delete ov[d];
        continue;
      }
      const entry: Obj = { ...(isObj(ov[d]) ? ov[d] : {}) };
      for (const f of Object.keys(op) as Array<keyof OverridePatch>) {
        const v = op[f];
        if (v === DELETE_FIELD) delete entry[f];
        else if (v !== undefined) entry[f] = v;
      }
      ov[d] = entry as OccurrenceOverride;
    }
    next.overrides = ov;
  }
  next.updatedAt = now;
  return next;
}

/**
 * Applies ops to a tasks record, returning a NEW record when anything changed (unchanged tasks
 * keep their object identity) or the same record otherwise. Updates of unknown ids are skipped.
 */
export function applyOps(record: Record<string, Task>, ops: RepoOp[], now: number): Record<string, Task> {
  let out: Record<string, Task> | null = null;
  const w = (): Record<string, Task> => (out ??= { ...record });
  for (const op of ops) {
    const cur = out ?? record;
    if (op.type === 'set') {
      w()[op.task.id] = { ...op.task, updatedAt: now };
    } else if (op.type === 'update') {
      const t = hasOwn(cur, op.id) ? cur[op.id] : undefined;
      if (!t) continue;
      w()[op.id] = applyTaskPatch(t, op.patch, now);
    } else if (hasOwn(cur, op.id)) {
      delete w()[op.id];
    }
  }
  return out ?? record;
}

function cleanOverride(o: OccurrenceOverride): OverridePatch {
  const out: OverridePatch = {};
  for (const f of OVERRIDE_FIELDS) {
    const v = o[f];
    if (v !== undefined) (out as Obj)[f] = v;
  }
  return out;
}

function isEmptyOverride(o: OccurrenceOverride | undefined): boolean {
  return !isObj(o) || OVERRIDE_FIELDS.every((f) => o[f] === undefined);
}

/**
 * Minimal field-level patch turning `prev` into `next` (top-level fields + per-occurrence override
 * fields), or null when they are equal. updatedAt/createdAt/id are not compared.
 */
export function diffTask(prev: Task, next: Task): TaskPatch | null {
  let fields: TaskPatch['fields'] | undefined;
  for (const k of DIFF_FIELDS) {
    if (!deepEqual(prev[k], next[k])) {
      fields ??= {};
      (fields as Obj)[k] = next[k] === undefined ? null : next[k];
    }
  }
  let overrides: Record<ISODate, OverridePatch | null> | undefined;
  const pOv = isObj(prev.overrides) ? prev.overrides : {};
  const nOv = isObj(next.overrides) ? next.overrides : {};
  const keys = new Set([...Object.keys(pOv), ...Object.keys(nOv)]);
  for (const d of keys) {
    const a = hasOwn(pOv, d) ? pOv[d] : undefined;
    const b = hasOwn(nOv, d) ? nOv[d] : undefined;
    if (isEmptyOverride(b)) {
      if (a !== undefined) (overrides ??= {})[d] = null;
      continue;
    }
    const bo = b as OccurrenceOverride;
    if (a === undefined || !isObj(a)) {
      (overrides ??= {})[d] = cleanOverride(bo);
      continue;
    }
    let p: OverridePatch | null = null;
    for (const f of OVERRIDE_FIELDS) {
      const av = a[f];
      const bv = bo[f];
      if (bv === undefined) {
        if (av !== undefined) ((p ??= {}) as Obj)[f] = DELETE_FIELD;
      } else if (!deepEqual(av, bv)) {
        ((p ??= {}) as Obj)[f] = bv;
      }
    }
    if (p) (overrides ??= {})[d] = p;
  }
  if (!fields && !overrides) return null;
  const patch: TaskPatch = {};
  if (fields) patch.fields = fields;
  if (overrides) patch.overrides = overrides;
  return patch;
}

/** A Firestore/IDB-safe copy of a task: no undefined anywhere (Firestore rejects undefined). */
export function serializeTask(t: Task): Task {
  const overrides: Record<ISODate, OccurrenceOverride> = {};
  for (const d of Object.keys(t.overrides ?? {})) {
    const o = t.overrides[d];
    if (o) overrides[d] = cleanOverride(o) as OccurrenceOverride;
  }
  const reminder = { ...t.reminder } as Obj;
  for (const k of Object.keys(reminder)) if (reminder[k] === undefined) delete reminder[k];
  let recurrence: Recurrence | null = null;
  if (t.recurrence) {
    recurrence = {
      freq: t.recurrence.freq,
      interval: t.recurrence.interval,
      byWeekday: t.recurrence.byWeekday ?? null,
      until: t.recurrence.until ?? null,
      count: t.recurrence.count ?? null,
    };
  }
  return {
    id: t.id,
    title: t.title,
    date: t.date ?? null,
    endDate: t.endDate ?? null,
    time: t.time ?? null,
    order: t.order,
    done: t.done === true,
    doneAt: t.doneAt ?? null,
    recurrence,
    overrides,
    reminder: reminder as unknown as Reminder,
    remindAt: t.remindAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
