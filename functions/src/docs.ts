/**
 * Firestore document → domain types, defensively. Clients write well-formed docs (shared/types.ts),
 * but a scheduled job must never crash on one odd document: anything unexpected degrades to a safe
 * default and the shared domain functions (which are robust to bad dates/rules) do the rest.
 */
import type { DeviceDoc, HM, ISODate, OccurrenceOverride, Recurrence, Reminder, Settings, Task } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import { isHM, isValidISODate } from '../../shared/dates.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Millis from a number, a Date, or a Firestore Timestamp-like object (e.g. `syncedAt`); null otherwise. */
export function toMillis(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (isObj(v) && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => unknown }).toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function isoOrNull(v: unknown): ISODate | null {
  return typeof v === 'string' && isValidISODate(v) ? v : null;
}

function hmOrNull(v: unknown): HM | null {
  return typeof v === 'string' && isHM(v) ? v : null;
}

function toReminder(v: unknown): Reminder {
  if (!isObj(v)) return { kind: 'default' };
  switch (v.kind) {
    case 'none':
      return { kind: 'none' };
    case 'offset':
      return typeof v.minutes === 'number' && Number.isFinite(v.minutes)
        ? { kind: 'offset', minutes: v.minutes }
        : { kind: 'default' };
    case 'at':
      return typeof v.time === 'string' && isHM(v.time)
        ? { kind: 'at', time: v.time, daysBefore: typeof v.daysBefore === 'number' && Number.isFinite(v.daysBefore) ? v.daysBefore : 0 }
        : { kind: 'default' };
    default:
      return { kind: 'default' };
  }
}

function toOverrides(v: unknown): Record<ISODate, OccurrenceOverride> {
  const out: Record<ISODate, OccurrenceOverride> = {};
  if (!isObj(v)) return out;
  for (const [k, o] of Object.entries(v)) {
    if (isValidISODate(k) && isObj(o)) out[k] = o as OccurrenceOverride;
  }
  return out;
}

/** A task document → Task. null only when the document has no data. */
export function toTask(raw: Obj | undefined, id: string): Task | null {
  if (!isObj(raw)) return null;
  const updatedAt = toMillis(raw.updatedAt);
  const createdAt = toMillis(raw.createdAt) ?? updatedAt ?? 0;
  return {
    id,
    title: typeof raw.title === 'string' ? raw.title : '',
    date: isoOrNull(raw.date),
    endDate: isoOrNull(raw.endDate),
    time: hmOrNull(raw.time),
    order: typeof raw.order === 'string' && raw.order !== '' ? raw.order : 'a0',
    done: raw.done === true,
    doneAt: toMillis(raw.doneAt),
    recurrence: isObj(raw.recurrence) ? (raw.recurrence as unknown as Recurrence) : null,
    overrides: toOverrides(raw.overrides),
    reminder: toReminder(raw.reminder),
    remindAt: toMillis(raw.remindAt),
    createdAt,
    updatedAt: updatedAt ?? createdAt,
  };
}

/** users/{uid}.settings → Settings (unknown time zone → UTC; the domain also falls back to UTC). */
export function toSettings(raw: unknown): Settings {
  const s = isObj(raw) ? raw : {};
  const summary = isObj(s.summary) ? s.summary : {};
  return {
    weekStart: s.weekStart === 0 ? 0 : 1,
    summary: {
      enabled: typeof summary.enabled === 'boolean' ? summary.enabled : DEFAULT_SETTINGS.summary.enabled,
      time: typeof summary.time === 'string' && isHM(summary.time) ? summary.time : DEFAULT_SETTINGS.summary.time,
    },
    timezone: typeof s.timezone === 'string' && s.timezone.trim() !== '' ? s.timezone : DEFAULT_SETTINGS.timezone,
  };
}

/** devices/{id}.subscription → a sendable Web Push subscription (https endpoint + both keys), else null. */
export function toSubscription(raw: Obj | undefined): DeviceDoc['subscription'] | null {
  if (!isObj(raw) || !isObj(raw.subscription)) return null;
  const sub = raw.subscription;
  const keys = isObj(sub.keys) ? sub.keys : {};
  if (typeof sub.endpoint !== 'string' || !/^https:\/\/\S+$/.test(sub.endpoint)) return null;
  if (typeof keys.p256dh !== 'string' || keys.p256dh === '' || typeof keys.auth !== 'string' || keys.auth === '') return null;
  return {
    endpoint: sub.endpoint,
    expirationTime: typeof sub.expirationTime === 'number' ? sub.expirationTime : null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}
