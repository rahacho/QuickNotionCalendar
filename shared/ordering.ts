/**
 * Ordering: fractional-index keys (fractional-indexing, default base-62 alphabet → keys like
 * "a0", "a0V", "Zz") and the comparators used everywhere a list of tasks is rendered.
 *
 * Keys are compared by UTF-16 code unit (plain < / >), never localeCompare: fractional-indexing
 * keys are only ordered under byte-wise comparison ("Z" < "a").
 */
import { generateKeyBetween } from 'fractional-indexing';
import type { Occurrence, Task } from './types.js';

const KEY_CHARS = /^[0-9A-Za-z]+$/;

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tryKey(a: string | null, b: string | null): string | null {
  try {
    return generateKeyBetween(a, b);
  } catch {
    return null;
  }
}

/** True when `k` is a well-formed key for the default fractional-indexing alphabet. */
export function isValidOrderKey(k: unknown): k is string {
  return typeof k === 'string' && KEY_CHARS.test(k) && tryKey(k, null) !== null;
}

/**
 * A key sorting strictly between a and b (null = open end). Never throws:
 *  - a malformed bound is treated as open (null);
 *  - a === b (duplicate keys, e.g. two offline devices inserting at the same spot) → a key just
 *    above a (a + suffix), so the dropped item lands right after `a`, before anything that
 *    sorted after both duplicates;
 *  - a > b (neighbors whose rendered order disagrees with their keys, e.g. an untimed card
 *    dropped above a timed one) → a key after `a` (keyBetween(a, null)): honoring "after prev"
 *    keeps untimed tasks in the position the user dropped them relative to their untimed peers.
 */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = isValidOrderKey(a) ? a : null;
  const hi = isValidOrderKey(b) ? b : null;
  if (lo !== null && hi !== null && lo >= hi) {
    if (lo === hi) return tryKey(lo, `${lo}z`) ?? tryKey(lo, null) ?? `${lo}V`;
    return tryKey(lo, null) ?? `${lo}V`;
  }
  return tryKey(lo, hi) ?? tryKey(lo, null) ?? tryKey(null, hi) ?? 'a0';
}

/** Key before the current first item (null when the list is empty). */
export function keyAtStart(firstKey: string | null): string {
  return keyBetween(null, firstKey);
}

/** Key after the current last item (null when the list is empty). */
export function keyAtEnd(lastKey: string | null): string {
  return keyBetween(lastKey, null);
}

/** 0 = multi-day bar, 1 = untimed, 2 = timed. */
function rank(o: Occurrence): number {
  return o.multiDay ? 0 : o.time == null ? 1 : 2;
}

/**
 * Order of cards within one day:
 * multi-day first (earlier start, then longer) → untimed (by order) → timed (by time, then order) → key.
 * Multi-day ties additionally fall back to order before key.
 */
export function compareInDay(a: Occurrence, b: Occurrence): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  let c = 0;
  if (ra === 0) {
    c = cmpStr(a.date ?? '', b.date ?? '');
    if (c !== 0) return c;
    c = cmpStr(b.endDate ?? '', a.endDate ?? '');
    if (c !== 0) return c;
  } else if (ra === 2) {
    c = cmpStr(a.time ?? '', b.time ?? '');
    if (c !== 0) return c;
  }
  c = cmpStr(a.order ?? '', b.order ?? '');
  if (c !== 0) return c;
  return cmpStr(a.key, b.key);
}

/** Inbox order: order asc, then id. */
export function compareInbox(a: Task, b: Task): number {
  return cmpStr(a.order ?? '', b.order ?? '') || cmpStr(a.id, b.id);
}
