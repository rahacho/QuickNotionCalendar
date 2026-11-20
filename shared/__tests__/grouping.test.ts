import { describe, expect, it } from 'vitest';
import { buildTaskGroups } from '../grouping';
import { addDays } from '../dates';
import type { ISODate, ListGroup, OccurrenceOverride, Task } from '../types';
import { mkTask, rule } from './helpers';

const TODAY = '2026-11-19'; // Thursday

const ids = (gs: ListGroup[]) => gs.map((g) => g.id);
const group = (gs: ListGroup[], id: string) => gs.find((g) => g.id === id);
const itemKeys = (g: ListGroup | undefined) => (g ? g.items.map((i) => i.occ.key) : []);
const metas = (g: ListGroup | undefined) => (g ? g.items.map((i) => i.meta) : []);

describe('buildTaskGroups — structure', () => {
  it('returns [] when there is nothing', () => {
    expect(buildTaskGroups([], TODAY)).toEqual([]);
    expect(buildTaskGroups([mkTask({ id: 'inbox' })], TODAY)).toEqual([]);
  });

  it('orders groups overdue → today → tomorrow → days → later → completed and omits empty ones', () => {
    const tasks = [
      mkTask({ id: 'c', date: '2026-11-17', done: true, doneAt: 1 }),
      mkTask({ id: 'l', date: '2026-12-05' }),
      mkTask({ id: 'd6', date: '2026-11-25' }),
      mkTask({ id: 'd2', date: '2026-11-21' }),
      mkTask({ id: 'tm', date: '2026-11-20' }),
      mkTask({ id: 't', date: '2026-11-19' }),
      mkTask({ id: 'o', date: '2026-11-12' }),
      mkTask({ id: 'inbox' }),
    ];
    const gs = buildTaskGroups(tasks, TODAY);
    expect(ids(gs)).toEqual(['overdue', 'today', 'tomorrow', 'day:2026-11-21', 'day:2026-11-25', 'later', 'completed']);
    expect(gs.map((g) => [g.title, g.subtitle])).toEqual([
      ['Overdue', ''],
      ['Today', 'Thu, Nov 19'],
      ['Tomorrow', 'Fri, Nov 20'],
      ['Saturday', 'Nov 21'],
      ['Wednesday', 'Nov 25'],
      ['Later', ''],
      ['Completed', ''],
    ]);
    expect(gs.map((g) => [g.collapsible, g.defaultCollapsed])).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [true, true],
      [true, true],
    ]);
    expect(gs.every((g) => g.count === g.items.length)).toBe(true);
    expect(gs.flatMap((g) => g.items).some((i) => i.occ.taskId === 'inbox')).toBe(false);
  });

  it('horizon: today+7 is a day group, today+8 goes to Later', () => {
    const gs = buildTaskGroups(
      [mkTask({ id: 'h7', date: addDays(TODAY, 7) }), mkTask({ id: 'h8', date: addDays(TODAY, 8) })],
      TODAY,
    );
    expect(ids(gs)).toEqual(['day:2026-11-26', 'later']);
    expect(group(gs, 'day:2026-11-26')?.title).toBe('Thursday');
    expect(itemKeys(group(gs, 'later'))).toEqual(['h8']);
  });

  it('horizonDays option', () => {
    const tasks = [mkTask({ id: 'a', date: TODAY }), mkTask({ id: 'b', date: '2026-11-20' }), mkTask({ id: 'c', date: '2026-11-21' })];
    expect(ids(buildTaskGroups(tasks, TODAY, { horizonDays: 0 }))).toEqual(['today', 'later']);
    expect(ids(buildTaskGroups(tasks, TODAY, { horizonDays: 1 }))).toEqual(['today', 'tomorrow', 'later']);
    expect(ids(buildTaskGroups(tasks, TODAY, { horizonDays: -5 }))).toEqual(['today', 'later']);
  });
});

describe('buildTaskGroups — overdue', () => {
  it('lists one-time past tasks by date then compareInDay with Notion metas', () => {
    const tasks = [
      mkTask({ id: 'b', date: '2026-11-12', time: '15:00' }),
      mkTask({ id: 'a', date: '2026-11-12', order: 'a9' }),
      mkTask({ id: 'old', date: '2025-12-30' }),
      mkTask({ id: 'multi', date: '2026-11-10', endDate: '2026-11-18' }),
      mkTask({ id: 'doneOld', date: '2026-11-01', done: true, doneAt: 3 }),
    ];
    const g = group(buildTaskGroups(tasks, TODAY), 'overdue');
    expect(itemKeys(g)).toEqual(['old', 'multi', 'a', 'b']);
    expect(metas(g)).toEqual(['Dec 30, 2025', 'Nov 10 → 18', 'Nov 12', 'Nov 12 · 3:00 PM']);
    expect(g?.items.every((i) => i.overdue)).toBe(true);
  });

  it('recurring occurrences never go overdue and past undone ones appear nowhere', () => {
    const daily = mkTask({ id: 'r', date: '2026-11-01', recurrence: rule('daily') });
    const gs = buildTaskGroups([daily], TODAY);
    expect(group(gs, 'overdue')).toBeUndefined();
    const all = gs.flatMap((g) => g.items.map((i) => i.occ.date));
    expect(all.every((d) => d !== null && d >= TODAY)).toBe(true);
    expect(ids(gs)).toEqual([
      'today',
      'tomorrow',
      'day:2026-11-21',
      'day:2026-11-22',
      'day:2026-11-23',
      'day:2026-11-24',
      'day:2026-11-25',
      'day:2026-11-26',
    ]);
    expect(gs.flatMap((g) => g.items).every((i) => i.meta === '' && !i.overdue)).toBe(true);
  });

  it('today rollover: yesterday’s open task becomes overdue', () => {
    const t = mkTask({ id: 'x', date: TODAY });
    expect(ids(buildTaskGroups([t], TODAY))).toEqual(['today']);
    expect(ids(buildTaskGroups([t], '2026-11-20'))).toEqual(['overdue']);
  });
});

describe('buildTaskGroups — multi-day', () => {
  it('appears once, in the group of max(start, today), with a range meta', () => {
    const tasks = [
      mkTask({ id: 'active', date: '2026-11-18', endDate: '2026-11-21' }),
      mkTask({ id: 'long', date: '2026-11-01', endDate: '2027-01-10', time: '09:00' }),
      mkTask({ id: 'soon', date: '2026-11-21', endDate: '2026-11-23' }),
      mkTask({ id: 'far', date: '2026-12-30', endDate: '2027-01-02' }),
    ];
    const gs = buildTaskGroups(tasks, TODAY);
    expect(itemKeys(group(gs, 'today'))).toEqual(['long', 'active']);
    expect(metas(group(gs, 'today'))).toEqual(['Nov 1, 2026 → Jan 10, 2027 · 9:00 AM', 'Nov 18 → 21']);
    expect(itemKeys(group(gs, 'day:2026-11-21'))).toEqual(['soon']);
    expect(metas(group(gs, 'day:2026-11-21'))).toEqual(['Nov 21 → 23']);
    expect(metas(group(gs, 'later'))).toEqual(['Dec 30, 2026 → Jan 2, 2027']);
    const total = gs.flatMap((g) => g.items).length;
    expect(total).toBe(4);
  });
});

describe('buildTaskGroups — day groups', () => {
  it('sorts with compareInDay and shows time metas', () => {
    const tasks = [
      mkTask({ id: 't2', date: TODAY, time: '15:00' }),
      mkTask({ id: 'u', date: TODAY, order: 'a1' }),
      mkTask({ id: 't1', date: TODAY, time: '09:05' }),
      mkTask({ id: 'rec', date: '2026-11-01', recurrence: rule('daily'), time: '12:00', order: 'a0' }),
    ];
    const g = group(buildTaskGroups(tasks, TODAY), 'today');
    expect(itemKeys(g)).toEqual(['u', 't1', 'rec@2026-11-19', 't2']);
    expect(metas(g)).toEqual(['', '9:05 AM', '12:00 PM', '3:00 PM']);
  });

  it('recurring: each occurrence in the window in its day group; moved occurrences follow their date', () => {
    const overrides: Record<ISODate, OccurrenceOverride> = {
      '2026-11-19': { date: '2026-11-22' }, // moved within window
      '2026-11-26': { date: '2026-11-10' }, // moved into the past → hidden from lists
      '2026-12-31': { date: '2026-11-20' }, // moved in from far future
    };
    const t = mkTask({ id: 'w', date: '2026-11-05', recurrence: rule('weekly'), overrides });
    const gs = buildTaskGroups([t], TODAY);
    expect(gs.map((g) => [g.id, itemKeys(g)])).toEqual([
      ['tomorrow', ['w@2026-12-31']],
      ['day:2026-11-22', ['w@2026-11-19']],
    ]);
  });
});

describe('buildTaskGroups — later', () => {
  it('non-recurring beyond the horizon sorted by date; recurring series with no occurrence in window → next occurrence', () => {
    const tasks = [
      mkTask({ id: 'n2', date: '2027-01-05', time: '10:00' }),
      mkTask({ id: 'n1', date: '2026-12-05' }),
      mkTask({ id: 'monthly', date: '2026-10-05', recurrence: rule('monthly') }),
      mkTask({ id: 'weekly', date: '2026-10-01', recurrence: rule('weekly') }), // has occurrences in window
      mkTask({ id: 'ended', date: '2026-10-01', recurrence: rule('daily', { count: 3 }) }),
    ];
    const g = group(buildTaskGroups(tasks, TODAY), 'later');
    expect(itemKeys(g)).toEqual(['monthly@2026-12-05', 'n1', 'n2']);
    expect(metas(g)).toEqual(['Dec 5', 'Dec 5', 'Jan 5, 2027 · 10:00 AM']);
  });

  it('a series whose only window occurrence is done still shows its next one in Later', () => {
    const t = mkTask({
      id: 'm',
      date: '2026-10-20',
      recurrence: rule('monthly'),
      overrides: { '2026-11-20': { done: true, doneAt: 10 } },
    });
    const gs = buildTaskGroups([t], TODAY);
    expect(itemKeys(group(gs, 'later'))).toEqual(['m@2026-12-20']);
    expect(itemKeys(group(gs, 'completed'))).toEqual(['m@2026-11-20']);
  });

  it('next occurrence honors skipped / done / moved overrides', () => {
    const t = mkTask({
      id: 'y',
      date: '2026-01-10',
      recurrence: rule('monthly'),
      overrides: {
        '2026-12-10': { skipped: true },
        '2027-01-10': { done: true, doneAt: 1 },
        '2027-02-10': { date: '2027-03-01' },
        '2027-03-10': { date: '2027-02-20' },
      },
    });
    expect(itemKeys(group(buildTaskGroups([t], TODAY), 'later'))).toEqual(['y@2027-03-10']);
    expect(metas(group(buildTaskGroups([t], TODAY), 'later'))).toEqual(['Feb 20, 2027']);
  });
});

describe('buildTaskGroups — completed', () => {
  const done = (id: string, doneAt: number | null, extra: Partial<Task> = {}): Task =>
    mkTask({ id, date: '2026-11-18', done: true, doneAt, ...extra });

  it('done non-recurring + done recurring occurrences by doneAt desc with date metas', () => {
    const rec = mkTask({
      id: 'r',
      date: '2026-11-01',
      recurrence: rule('daily'),
      overrides: {
        '2026-11-10': { done: true, doneAt: 50 },
        '2026-11-11': { done: true, doneAt: 5, skipped: true }, // skipped wins
        '2026-11-12': { done: true, doneAt: 70, date: '2026-11-13' },
      },
    });
    const tasks = [done('a', 10), done('b', 100), done('inboxDone', 60, { date: null }), done('nullAt', null), rec];
    const g = group(buildTaskGroups(tasks, TODAY), 'completed');
    expect(itemKeys(g)).toEqual(['b', 'r@2026-11-12', 'inboxDone', 'r@2026-11-10', 'a', 'nullAt']);
    expect(metas(g)).toEqual(['Nov 18', 'Nov 13', '', 'Nov 10', 'Nov 18', 'Nov 18']);
    expect(g?.items.every((i) => i.occ.done && !i.overdue)).toBe(true);
  });

  it('truncates to completedLimit but counts the total', () => {
    const tasks = Array.from({ length: 120 }, (_, i) => done(`t${String(i).padStart(3, '0')}`, i));
    const g = group(buildTaskGroups(tasks, TODAY), 'completed');
    expect(g?.count).toBe(120);
    expect(g?.items).toHaveLength(50);
    expect(g?.items[0]?.occ.key).toBe('t119');
    expect(g?.items[49]?.occ.key).toBe('t070');
    const g5 = group(buildTaskGroups(tasks, TODAY, { completedLimit: 5 }), 'completed');
    expect(itemKeys(g5)).toEqual(['t119', 't118', 't117', 't116', 't115']);
    const g0 = group(buildTaskGroups(tasks, TODAY, { completedLimit: 0 }), 'completed');
    expect(g0?.count).toBe(120);
    expect(g0?.items).toEqual([]);
  });

  it('stays fast with years of done history', () => {
    const overrides: Record<ISODate, OccurrenceOverride> = {};
    let d = '2016-01-01';
    for (let i = 0; i < 3650; i++) {
      overrides[d] = { done: true, doneAt: i };
      d = addDays(d, 1);
    }
    const tasks = Array.from({ length: 30 }, (_, i) => mkTask({ id: `s${i}`, date: '2016-01-01', recurrence: rule('daily'), overrides }));
    const t0 = performance.now();
    const g = group(buildTaskGroups(tasks, TODAY), 'completed');
    expect(performance.now() - t0).toBeLessThan(250);
    expect(g?.count).toBe(30 * 3650);
    expect(g?.items).toHaveLength(50);
    expect(g?.items[0]?.occ.doneAt).toBe(3649);
  });
});

describe('buildTaskGroups — nothing is lost', () => {
  it('every open one-time scheduled task appears exactly once', () => {
    const tasks: Task[] = [];
    for (let i = -40; i <= 40; i++) {
      tasks.push(mkTask({ id: `n${i}`, date: addDays(TODAY, i) }));
      if (i % 3 === 0) tasks.push(mkTask({ id: `m${i}`, date: addDays(TODAY, i), endDate: addDays(TODAY, i + 5) }));
    }
    const gs = buildTaskGroups(tasks, TODAY);
    const seen = gs.filter((g) => g.id !== 'completed').flatMap((g) => g.items.map((i) => i.occ.key));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(tasks.map((t) => t.id).sort());
  });
});
