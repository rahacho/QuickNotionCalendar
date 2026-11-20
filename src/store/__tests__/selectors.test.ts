import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { weekDates } from '@shared/dates';
import { createTask, moveOccurrence, renameTask, setDone } from '@/store/actions';
import { useStore } from '@/store/store';
import {
  badgeCountOf,
  inboxTasksOf,
  occurrenceOf,
  occurrencesInRangeOf,
  taskGroupsOf,
  tasksListOf,
  weekLayoutOf,
} from '@/store/selectors';
import { setup, teardownAll } from './helpers';

beforeEach(async () => {
  await setup();
});

afterEach(() => {
  teardownAll();
});

const tasksNow = () => useStore.getState().tasks;
const WEEK = weekDates('2026-11-16');
const NEXT_WEEK = weekDates('2026-11-23');

describe('selector reference stability', () => {
  it('returns the same references for the same tasks version', () => {
    createTask({ title: 'a', date: '2026-11-19' });
    createTask({ title: 'inbox' });
    const t = tasksNow();
    expect(tasksListOf(t)).toBe(tasksListOf(t));
    expect(occurrencesInRangeOf(t, '2026-11-16', '2026-11-22')).toBe(occurrencesInRangeOf(t, '2026-11-16', '2026-11-22'));
    expect(weekLayoutOf(t, WEEK)).toBe(weekLayoutOf(t, [...WEEK]));
    expect(inboxTasksOf(t)).toBe(inboxTasksOf(t));
    expect(taskGroupsOf(t, '2026-11-19')).toBe(taskGroupsOf(t, '2026-11-19'));
    expect(badgeCountOf(t, '2026-11-19')).toBe(1);
  });

  it('keeps unaffected results across unrelated task changes', () => {
    const a = createTask({ title: 'a', date: '2026-11-19' });
    createTask({ title: 'inbox' });
    const t1 = tasksNow();
    const range1 = occurrencesInRangeOf(t1, '2026-11-16', '2026-11-22');
    const layout1 = weekLayoutOf(t1, WEEK);
    const inbox1 = inboxTasksOf(t1);
    const occ1 = occurrenceOf(t1, { taskId: a, origDate: null });

    // A change to a task in another week.
    createTask({ title: 'b', date: '2026-11-25' });
    const t2 = tasksNow();
    expect(t2).not.toBe(t1);
    expect(occurrencesInRangeOf(t2, '2026-11-16', '2026-11-22')).toBe(range1);
    expect(weekLayoutOf(t2, WEEK)).toBe(layout1);
    expect(inboxTasksOf(t2)).toBe(inbox1);
    expect(occurrenceOf(t2, { taskId: a, origDate: null })).toBe(occ1);
    expect(weekLayoutOf(t2, NEXT_WEEK).singles['2026-11-25']?.map((o) => o.title)).toEqual(['b']);
  });

  it('interns occurrences: the same object everywhere for an unchanged task', () => {
    const a = createTask({ title: 'a', date: '2026-11-19' });
    const t = tasksNow();
    const fromRange = occurrencesInRangeOf(t, '2026-11-19', '2026-11-19')[0];
    const fromLayout = weekLayoutOf(t, WEEK).singles['2026-11-19']?.[0];
    const fromRef = occurrenceOf(t, { taskId: a, origDate: null });
    const fromGroups = taskGroupsOf(t, '2026-11-19').find((g) => g.id === 'today')?.items[0]?.occ;
    expect(fromRange).toBeDefined();
    expect(fromLayout).toBe(fromRange);
    expect(fromRef).toBe(fromRange);
    expect(fromGroups).toBe(fromRange);
  });

  it('recomputes when the task itself changes', () => {
    const a = createTask({ title: 'a', date: '2026-11-19' });
    const t1 = tasksNow();
    const layout1 = weekLayoutOf(t1, WEEK);
    const groups1 = taskGroupsOf(t1, '2026-11-19');
    renameTask(a, 'renamed');
    const t2 = tasksNow();
    const layout2 = weekLayoutOf(t2, WEEK);
    expect(layout2).not.toBe(layout1);
    expect(layout2.singles['2026-11-19']?.[0]?.title).toBe('renamed');
    const groups2 = taskGroupsOf(t2, '2026-11-19');
    expect(groups2).not.toBe(groups1);
    expect(groups2[0]?.items[0]?.occ.title).toBe('renamed');
  });

  it('task groups share unchanged groups/items and react to today', () => {
    createTask({ title: 'today', date: '2026-11-19' });
    createTask({ title: 'later', date: '2026-12-20' });
    const t1 = tasksNow();
    const g1 = taskGroupsOf(t1, '2026-11-19');
    const later1 = g1.find((g) => g.id === 'later');
    createTask({ title: 'tomorrow', date: '2026-11-20' });
    const g2 = taskGroupsOf(tasksNow(), '2026-11-19');
    expect(g2).not.toBe(g1);
    expect(g2.find((g) => g.id === 'today')).toBe(g1.find((g) => g.id === 'today'));
    expect(g2.find((g) => g.id === 'later')).toBe(later1);
    const g3 = taskGroupsOf(tasksNow(), '2026-11-20');
    expect(g3.find((g) => g.id === 'today')?.items.map((i) => i.occ.title)).toEqual(['tomorrow']);
  });

  it('week layout spans chunk boundaries without duplicating multi-day bars', () => {
    // A long bar crossing many weeks shows up once per row.
    createTask({ title: 'long', date: '2026-10-01', endDate: '2027-01-31' });
    // Rows Oct 5 … Jan 25 (the last one ends on Jan 31, the bar's last day); Feb 1 has no bar.
    for (let w = 0; w <= 17; w++) {
      const start = new Date(Date.UTC(2026, 9, 5 + w * 7)).toISOString().slice(0, 10);
      const layout = weekLayoutOf(tasksNow(), weekDates(start));
      expect(layout.bars).toHaveLength(w < 17 ? 1 : 0);
      if (w < 17) {
        expect(layout.bars[0]?.occ.title).toBe('long');
        expect(layout.bars[0]?.continuesBefore).toBe(true);
        expect(layout.bars[0]?.continuesAfter).toBe(w < 16);
      }
    }
  });

  it('badge counts today + overdue and updates on completion', () => {
    const a = createTask({ title: 'a', date: '2026-11-19' });
    createTask({ title: 'b', date: '2026-11-10' });
    createTask({ title: 'c', date: '2026-11-25' });
    expect(badgeCountOf(tasksNow(), '2026-11-19')).toBe(2);
    setDone({ taskId: a, origDate: null }, true);
    expect(badgeCountOf(tasksNow(), '2026-11-19')).toBe(1);
  });

  it('occurrenceOf returns null for unknown refs and follows moves', () => {
    expect(occurrenceOf(tasksNow(), { taskId: 'nope', origDate: null })).toBeNull();
    const id = createTask({ title: 'r', date: '2026-11-16', recurrence: { freq: 'daily', interval: 1 } });
    moveOccurrence({ taskId: id, origDate: '2026-11-18' }, '2026-11-21');
    expect(occurrenceOf(tasksNow(), { taskId: id, origDate: '2026-11-18' })?.date).toBe('2026-11-21');
    expect(occurrenceOf(tasksNow(), { taskId: id, origDate: '2026-11-17' })?.date).toBe('2026-11-17');
  });

  it('invalid inputs return stable empty results', () => {
    const t = tasksNow();
    expect(occurrencesInRangeOf(t, 'x', '2026-11-19')).toBe(occurrencesInRangeOf(t, 'y', '2026-11-19'));
    expect(weekLayoutOf(t, [])).toBe(weekLayoutOf(t, []));
  });
});
