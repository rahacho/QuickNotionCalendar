import type { ISODate, Recurrence, Task } from '../types';

/** Builds a Task with sane defaults; `title` defaults to the id. */
export function mkTask(p: Partial<Task> & { id: string }): Task {
  return {
    title: p.id,
    date: null,
    endDate: null,
    time: null,
    order: 'a0',
    done: false,
    doneAt: null,
    recurrence: null,
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  };
}

export function rule(freq: Recurrence['freq'], extra: Partial<Recurrence> = {}): Recurrence {
  return { freq, interval: 1, ...extra };
}

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** Reference implementation via Date.UTC (independent of the code under test). */
export function refAddDays(d: ISODate, n: number): ISODate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, day + n);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function randomDate(r: () => number, fromYear = 1900, toYear = 2200): ISODate {
  const y = randInt(r, fromYear, toYear);
  const m = randInt(r, 1, 12);
  const dim = new Date(Date.UTC(2000, m, 0)).getUTCDate();
  const leapAdj = m === 2 && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 28 : dim;
  const d = randInt(r, 1, leapAdj);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
