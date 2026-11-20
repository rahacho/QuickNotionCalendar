import { describe, expect, it } from 'vitest';
import {
  doneOccurrencesOfTask,
  firstOpenOccurrenceFrom,
  getOccurrence,
  inboxTasks,
  isOverdue,
  occKey,
  occurrencesInRange,
  parseOccKey,
  refOf,
} from '../occurrences';
import { addDays } from '../dates';
import { occurrenceDates } from '../recurrence';
import type { ISODate, OccurrenceOverride, Task } from '../types';
import { mkTask, randInt, randomDate, refAddDays, rng, rule } from './helpers';

const keys = (tasks: Task[], from: ISODate, to: ISODate, includeDone = false): string[] =>
  occurrencesInRange(tasks, from, to, { includeDone }).map((o) => o.key);

describe('occKey / parseOccKey / refOf', () => {
  it('round-trips', () => {
    expect(occKey('abc', null)).toBe('abc');
    expect(occKey('abc', '2026-11-19')).toBe('abc@2026-11-19');
    expect(parseOccKey('abc')).toEqual({ taskId: 'abc', origDate: null });
    expect(parseOccKey('abc@2026-11-19')).toEqual({ taskId: 'abc', origDate: '2026-11-19' });
  });

  it('treats a non-date suffix as part of the id', () => {
    expect(parseOccKey('a@b')).toEqual({ taskId: 'a@b', origDate: null });
    expect(parseOccKey('abc@2026-02-30')).toEqual({ taskId: 'abc@2026-02-30', origDate: null });
    expect(parseOccKey('@2026-11-19')).toEqual({ taskId: '@2026-11-19', origDate: null });
    expect(parseOccKey('a@b@2026-11-19')).toEqual({ taskId: 'a@b', origDate: '2026-11-19' });
  });

  it('refOf extracts the ref', () => {
    const t = mkTask({ id: 'r', date: '2026-11-19', recurrence: rule('daily') });
    const o = getOccurrence(t, '2026-11-20');
    expect(o && refOf(o)).toEqual({ taskId: 'r', origDate: '2026-11-20' });
    expect(parseOccKey(o?.key ?? '')).toEqual(o && refOf(o));
  });
});

describe('occurrencesInRange — one-time tasks', () => {
  const tasks = [
    mkTask({ id: 'inbox' }),
    mkTask({ id: 'today', date: '2026-11-19' }),
    mkTask({ id: 'past', date: '2026-11-10' }),
    mkTask({ id: 'future', date: '2026-12-01' }),
    mkTask({ id: 'multi', date: '2026-11-15', endDate: '2026-11-20' }),
    mkTask({ id: 'done', date: '2026-11-19', done: true, doneAt: 5 }),
  ];

  it('includes tasks overlapping the range (multi-day by span), excludes Inbox and done', () => {
    expect(keys(tasks, '2026-11-19', '2026-11-19').sort()).toEqual(['multi', 'today']);
    expect(keys(tasks, '2026-11-21', '2026-11-30')).toEqual([]);
    expect(keys(tasks, '2026-11-20', '2026-11-20')).toEqual(['multi']);
    expect(keys(tasks, '2026-11-14', '2026-11-15')).toEqual(['multi']);
    expect(keys(tasks, '2026-11-01', '2026-12-31')).toEqual(['past', 'multi', 'today', 'future']);
  });

  it('includeDone adds done tasks', () => {
    expect(keys(tasks, '2026-11-19', '2026-11-19', true).sort()).toEqual(['done', 'multi', 'today']);
    const d = occurrencesInRange(tasks, '2026-11-19', '2026-11-19', { includeDone: true }).find((o) => o.key === 'done');
    expect(d).toMatchObject({ done: true, doneAt: 5, recurring: false, origDate: null });
  });

  it('builds the occurrence fields', () => {
    const [o] = occurrencesInRange([mkTask({ id: 'm', date: '2026-11-18', endDate: '2026-11-21', time: '15:00', title: 'Trip' })], '2026-11-19', '2026-11-19');
    expect(o).toMatchObject({
      key: 'm',
      taskId: 'm',
      origDate: null,
      date: '2026-11-18',
      endDate: '2026-11-21',
      time: '15:00',
      title: 'Trip',
      done: false,
      doneAt: null,
      recurring: false,
      multiDay: true,
    });
    const [s] = occurrencesInRange([mkTask({ id: 's', date: '2026-11-19' })], '2026-11-19', '2026-11-19');
    expect(s).toMatchObject({ endDate: '2026-11-19', multiDay: false });
  });

  it('returns [] for an inverted range', () => {
    expect(keys(tasks, '2026-11-20', '2026-11-19')).toEqual([]);
  });

  it('sanitizes stored data: invalid endDate/time ignored, invalid date → Inbox', () => {
    const t = [
      mkTask({ id: 'badEnd', date: '2026-11-19', endDate: 'nope' }),
      mkTask({ id: 'revEnd', date: '2026-11-19', endDate: '2026-11-10' }),
      mkTask({ id: 'badTime', date: '2026-11-19', time: '25:00' }),
      mkTask({ id: 'badDate', date: '2026-13-01' }),
      mkTask({ id: 'recNoDate', date: null, recurrence: rule('daily') }),
      mkTask({ id: 'recMulti', date: '2026-11-19', endDate: '2026-11-22', recurrence: rule('weekly') }),
    ];
    const occs = occurrencesInRange(t, '2026-11-19', '2026-11-21');
    expect(occs.find((o) => o.key === 'badEnd')).toMatchObject({ endDate: '2026-11-19', multiDay: false });
    expect(occs.find((o) => o.key === 'revEnd')).toMatchObject({ endDate: '2026-11-19', multiDay: false });
    expect(occs.find((o) => o.key === 'badTime')).toMatchObject({ time: null });
    expect(occs.some((o) => o.taskId === 'badDate' || o.taskId === 'recNoDate')).toBe(false);
    expect(occs.filter((o) => o.taskId === 'recMulti').map((o) => [o.key, o.multiDay])).toEqual([
      ['recMulti@2026-11-19', false],
    ]);
    expect(inboxTasks(t).map((x) => x.id)).toEqual(['badDate', 'recNoDate']);
  });

  it('accepts any iterable', () => {
    const m = new Map(tasks.map((t) => [t.id, t]));
    expect(occurrencesInRange(m.values(), '2026-11-19', '2026-11-19')).toHaveLength(2);
  });

  it('throws on malformed range bounds', () => {
    expect(() => occurrencesInRange(tasks, 'x', '2026-11-19')).toThrow(RangeError);
  });
});

describe('occurrencesInRange — recurring with overrides', () => {
  const base = (overrides: Record<ISODate, OccurrenceOverride>, extra: Partial<Task> = {}): Task =>
    mkTask({ id: 'r', date: '2026-11-16', time: '09:00', order: 'a5', recurrence: rule('daily'), overrides, ...extra });

  it('expands rule dates', () => {
    expect(keys([base({})], '2026-11-18', '2026-11-20')).toEqual(['r@2026-11-18', 'r@2026-11-19', 'r@2026-11-20']);
    expect(keys([base({})], '2026-11-01', '2026-11-16')).toEqual(['r@2026-11-16']);
  });

  it('skipped occurrences are removed (even when also moved)', () => {
    expect(
      keys([base({ '2026-11-19': { skipped: true }, '2026-11-20': { skipped: true, date: '2026-11-18' } })], '2026-11-18', '2026-11-20'),
    ).toEqual(['r@2026-11-18']);
  });

  it('moved out of range → gone from that range, present in the target range', () => {
    const t = base({ '2026-11-19': { date: '2026-12-25' } });
    expect(keys([t], '2026-11-18', '2026-11-20')).toEqual(['r@2026-11-18', 'r@2026-11-20']);
    const moved = occurrencesInRange([t], '2026-12-25', '2026-12-25');
    // same date, same time/order → key tiebreak
    expect(moved.map((o) => [o.key, o.date, o.origDate])).toEqual([
      ['r@2026-11-19', '2026-12-25', '2026-11-19'],
      ['r@2026-12-25', '2026-12-25', '2026-12-25'],
    ]);
  });

  it('moved in from BEFORE and from AFTER the range is found', () => {
    const t = base({ '2026-11-17': { date: '2026-11-30' }, '2027-03-01': { date: '2026-12-01' } });
    expect(keys([t], '2026-11-30', '2026-12-01')).toEqual([
      'r@2026-11-17',
      'r@2026-11-30',
      'r@2026-12-01',
      'r@2027-03-01',
    ]);
  });

  it('moved within the range appears once on its new date', () => {
    const t = base({ '2026-11-18': { date: '2026-11-20' } });
    const occs = occurrencesInRange([t], '2026-11-18', '2026-11-20');
    expect(occs.map((o) => [o.key, o.date])).toEqual([
      ['r@2026-11-19', '2026-11-19'],
      ['r@2026-11-18', '2026-11-20'],
      ['r@2026-11-20', '2026-11-20'],
    ]);
  });

  it('a "move" back to the original date is a no-op', () => {
    const t = base({ '2026-11-19': { date: '2026-11-19' } });
    expect(keys([t], '2026-11-19', '2026-11-19')).toEqual(['r@2026-11-19']);
  });

  it('done occurrences hidden unless includeDone; done flag and doneAt applied', () => {
    const t = base({ '2026-11-19': { done: true, doneAt: 123 }, '2026-12-01': { done: true, doneAt: 9, date: '2026-11-20' } });
    expect(keys([t], '2026-11-19', '2026-11-20')).toEqual(['r@2026-11-20']);
    const all = occurrencesInRange([t], '2026-11-19', '2026-11-20', { includeDone: true });
    expect(all.map((o) => [o.key, o.done, o.doneAt])).toEqual([
      ['r@2026-11-19', true, 123],
      ['r@2026-11-20', false, null],
      ['r@2026-12-01', true, 9],
    ]);
  });

  it('time and order overrides: absent inherits, null = explicitly untimed', () => {
    const t = base({
      '2026-11-18': { time: '07:30' },
      '2026-11-19': { time: null },
      '2026-11-20': { order: 'a1' },
    });
    const occs = occurrencesInRange([t], '2026-11-18', '2026-11-20');
    const by = Object.fromEntries(occs.map((o) => [o.key, o]));
    expect(by['r@2026-11-18']).toMatchObject({ time: '07:30', order: 'a5' });
    expect(by['r@2026-11-19']).toMatchObject({ time: null });
    expect(by['r@2026-11-20']).toMatchObject({ time: '09:00', order: 'a1' });
    expect(by['r@2026-11-20']).toMatchObject({ recurring: true, multiDay: false, endDate: '2026-11-20' });
  });

  it('ignores orphan overrides (keys that are not rule dates) and corrupt entries', () => {
    const weekly = mkTask({
      id: 'w',
      date: '2026-11-19',
      recurrence: rule('weekly'),
      overrides: {
        '2026-11-20': { date: '2026-11-21' }, // Friday is not a rule date
        '2026-11-26': { date: 'garbage' }, // invalid move → stays on its rule date
        '2026-12-03': null as unknown as OccurrenceOverride,
        'not-a-date': { date: '2026-11-21' },
      },
    });
    expect(keys([weekly], '2026-11-19', '2026-12-03')).toEqual(['w@2026-11-19', 'w@2026-11-26', 'w@2026-12-03']);
  });

  it('a moved occurrence stays visible after until/count, but overrides past the end are orphans', () => {
    const t = mkTask({
      id: 'c',
      date: '2026-11-19',
      recurrence: rule('daily', { count: 2 }),
      overrides: { '2026-11-20': { date: '2026-12-31' }, '2026-11-21': { date: '2026-12-31' } },
    });
    expect(keys([t], '2026-12-31', '2026-12-31')).toEqual(['c@2026-11-20']);
  });

  it('weekly interval + overrides across a year boundary', () => {
    const t = mkTask({
      id: 'y',
      date: '2026-12-16',
      recurrence: rule('weekly', { interval: 2, byWeekday: [1, 5] }),
      overrides: { '2027-01-01': { date: '2027-01-04' }, '2027-01-11': { skipped: true } },
    });
    expect(occurrencesInRange([t], '2026-12-28', '2027-01-15').map((o) => `${o.origDate}>${o.date}`)).toEqual([
      '2026-12-28>2026-12-28',
      '2027-01-01>2027-01-04',
      '2027-01-15>2027-01-15',
    ]);
  });

  it('sorts output by date then compareInDay', () => {
    const tasks = [
      mkTask({ id: 'b', date: '2026-11-19', time: '10:00' }),
      mkTask({ id: 'a', date: '2026-11-19', order: 'a3' }),
      mkTask({ id: 'm', date: '2026-11-18', endDate: '2026-11-19' }),
      mkTask({ id: 'z', date: '2026-11-18', order: 'a0' }),
    ];
    expect(keys(tasks, '2026-11-18', '2026-11-19')).toEqual(['m', 'z', 'a', 'b']);
  });

  it('handles thousands of overrides quickly', () => {
    const overrides: Record<ISODate, OccurrenceOverride> = {};
    let d = '2016-01-01';
    for (let i = 0; i < 4000; i++) {
      overrides[d] = i % 10 === 0 ? { date: addDays(d, 1) } : { done: true, doneAt: i };
      d = addDays(d, 1);
    }
    const tasks = Array.from({ length: 50 }, (_, i) =>
      mkTask({ id: `t${i}`, date: '2016-01-01', recurrence: rule('daily'), overrides }),
    );
    const t0 = performance.now();
    for (let rep = 0; rep < 5; rep++) occurrencesInRange(tasks, '2026-10-26', '2027-03-14');
    const per = (performance.now() - t0) / 5;
    expect(per).toBeLessThan(150);
  });
});

describe('getOccurrence', () => {
  const rec = mkTask({
    id: 'r',
    date: '2026-11-19',
    recurrence: rule('weekly', { byWeekday: [4] }),
    overrides: { '2026-11-26': { skipped: true }, '2026-12-03': { done: true, doneAt: 1, date: '2026-12-04' } },
  });

  it('returns valid occurrences of a series (done included)', () => {
    expect(getOccurrence(rec, '2026-11-19')).toMatchObject({ key: 'r@2026-11-19', date: '2026-11-19' });
    expect(getOccurrence(rec, '2026-12-03')).toMatchObject({ done: true, date: '2026-12-04', origDate: '2026-12-03' });
  });

  it('null for skipped, non-rule and malformed dates', () => {
    expect(getOccurrence(rec, '2026-11-26')).toBeNull();
    expect(getOccurrence(rec, '2026-11-20')).toBeNull();
    expect(getOccurrence(rec, '2026-11-12')).toBeNull();
    expect(getOccurrence(rec, 'bad')).toBeNull();
  });

  it('recurring + null origDate → the start occurrence when the start is a rule date', () => {
    expect(getOccurrence(rec, null)).toMatchObject({ key: 'r@2026-11-19' });
    const offRule = { ...rec, recurrence: rule('weekly', { byWeekday: [1] }) };
    expect(getOccurrence(offRule, null)).toBeNull();
  });

  it('non-recurring: its single occurrence (also for a stale origDate), incl. Inbox and done', () => {
    const t = mkTask({ id: 'n', date: '2026-11-19' });
    expect(getOccurrence(t, null)).toMatchObject({ key: 'n', origDate: null, date: '2026-11-19' });
    expect(getOccurrence(t, '2026-11-19')).toMatchObject({ key: 'n', origDate: null });
    expect(getOccurrence(mkTask({ id: 'i' }), null)).toMatchObject({ key: 'i', date: null, endDate: null, time: null });
    expect(getOccurrence(mkTask({ id: 'd', date: '2026-11-19', done: true, doneAt: 7 }), null)).toMatchObject({ done: true, doneAt: 7 });
  });
});

describe('inboxTasks', () => {
  it('returns unscheduled, open tasks by order then id', () => {
    const t = [
      mkTask({ id: 'b', order: 'a1' }),
      mkTask({ id: 'a', order: 'a1' }),
      mkTask({ id: 'top', order: 'Zz' }),
      mkTask({ id: 'done', done: true }),
      mkTask({ id: 'sched', date: '2026-11-19' }),
    ];
    expect(inboxTasks(t).map((x) => x.id)).toEqual(['top', 'a', 'b']);
    expect(inboxTasks([])).toEqual([]);
  });
});

describe('isOverdue', () => {
  const today = '2026-11-19';
  const one = (p: Partial<Task>) => getOccurrence(mkTask({ id: 'x', ...p }), null)!;
  it('one-time, open, (end) date before today', () => {
    expect(isOverdue(one({ date: '2026-11-18' }), today)).toBe(true);
    expect(isOverdue(one({ date: '2026-11-19' }), today)).toBe(false);
    expect(isOverdue(one({ date: '2026-11-18', done: true }), today)).toBe(false);
    expect(isOverdue(one({ date: '2026-11-10', endDate: '2026-11-19' }), today)).toBe(false); // still active
    expect(isOverdue(one({ date: '2026-11-10', endDate: '2026-11-18' }), today)).toBe(true);
    expect(isOverdue(one({}), today)).toBe(false); // Inbox
  });
  it('recurring occurrences never go overdue', () => {
    const r = mkTask({ id: 'r', date: '2026-11-01', recurrence: rule('daily') });
    expect(isOverdue(getOccurrence(r, '2026-11-02')!, today)).toBe(false);
  });
});

describe('firstOpenOccurrenceFrom / doneOccurrencesOfTask', () => {
  it('skips done/skipped/moved-away dates and considers moved-in ones', () => {
    const t = mkTask({
      id: 'r',
      date: '2026-11-01',
      recurrence: rule('weekly', { byWeekday: [4] }),
      overrides: {
        '2026-12-03': { done: true, doneAt: 1 },
        '2026-12-10': { skipped: true },
        '2026-12-17': { date: '2027-01-20' },
        '2026-11-05': { date: '2026-12-05' }, // moved from the past into the future
      },
    });
    expect(firstOpenOccurrenceFrom(t, '2026-12-01')).toMatchObject({ key: 'r@2026-11-05', date: '2026-12-05' });
    expect(firstOpenOccurrenceFrom(t, '2026-12-06')).toMatchObject({ key: 'r@2026-12-24', date: '2026-12-24' });
    expect(firstOpenOccurrenceFrom({ ...t, recurrence: rule('weekly', { byWeekday: [4], until: '2026-12-20' }) }, '2026-12-06')).toMatchObject({
      key: 'r@2026-12-17',
      date: '2027-01-20',
    });
    expect(doneOccurrencesOfTask(t).map((o) => o.key)).toEqual(['r@2026-12-03']);
  });

  it('non-recurring', () => {
    expect(firstOpenOccurrenceFrom(mkTask({ id: 'a', date: '2026-12-01' }), '2026-11-30')).toMatchObject({ key: 'a' });
    expect(firstOpenOccurrenceFrom(mkTask({ id: 'a', date: '2026-12-01' }), '2026-12-02')).toBeNull();
    expect(firstOpenOccurrenceFrom(mkTask({ id: 'a', date: '2026-12-01', done: true }), '2026-11-30')).toBeNull();
    expect(doneOccurrencesOfTask(mkTask({ id: 'i', done: true }))).toHaveLength(1);
    expect(doneOccurrencesOfTask(mkTask({ id: 'i' }))).toHaveLength(0);
  });

  it('ended series → null', () => {
    const t = mkTask({ id: 'e', date: '2026-11-01', recurrence: rule('daily', { count: 3 }) });
    expect(firstOpenOccurrenceFrom(t, '2026-11-04')).toBeNull();
  });
});

describe('properties', () => {
  function randomTasks(r: () => number, n: number): Task[] {
    const out: Task[] = [];
    for (let i = 0; i < n; i++) {
      const date = randomDate(r, 2026, 2027);
      if (r() < 0.5) {
        const multi = r() < 0.3;
        out.push(mkTask({ id: `n${i}`, date, endDate: multi ? refAddDays(date, randInt(r, 1, 20)) : null, done: r() < 0.1 }));
      } else {
        const rec = r() < 0.5 ? rule('daily', { interval: randInt(r, 1, 3) }) : rule('weekly', { byWeekday: [1, 4] });
        const overrides: Record<ISODate, OccurrenceOverride> = {};
        for (const od of occurrenceDates(rec, date, date, refAddDays(date, 200))) {
          const p = r();
          if (p < 0.1) overrides[od] = { skipped: true };
          else if (p < 0.25) overrides[od] = { date: refAddDays(od, randInt(r, -60, 60)) };
          else if (p < 0.3) overrides[od] = { done: true, doneAt: i };
        }
        out.push(mkTask({ id: `r${i}`, date, recurrence: rec, overrides }));
      }
    }
    return out;
  }

  it('a range equals the union over split sub-ranges', () => {
    const r = rng(77);
    for (let trial = 0; trial < 40; trial++) {
      const tasks = randomTasks(r, 30);
      const from = randomDate(r, 2026, 2027);
      const to = refAddDays(from, randInt(r, 0, 120));
      const cut = refAddDays(from, randInt(r, 0, 120));
      const whole = new Set(keys(tasks, from, to));
      const union = new Set([...keys(tasks, from, cut < to ? cut : to), ...(cut < to ? keys(tasks, refAddDays(cut, 1), to) : [])]);
      expect([...union].sort()).toEqual([...whole].sort());
    }
  });

  it('every occurrence lies in the range and keys are unique', () => {
    const r = rng(78);
    for (let trial = 0; trial < 40; trial++) {
      const tasks = randomTasks(r, 30);
      const from = randomDate(r, 2026, 2027);
      const to = refAddDays(from, randInt(r, 0, 60));
      const occs = occurrencesInRange(tasks, from, to, { includeDone: r() < 0.5 });
      const ks = occs.map((o) => o.key);
      expect(new Set(ks).size).toBe(ks.length);
      for (const o of occs) {
        expect(o.date! <= to && o.endDate! >= from).toBe(true);
        expect(getOccurrence(o.task, o.origDate)).toMatchObject({ key: o.key, date: o.date });
      }
    }
  });
});
