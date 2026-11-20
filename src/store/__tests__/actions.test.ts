import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recurrence } from '@shared/types';
import { computeRemindAt, nextSummaryAt, zonedInstant } from '@shared/reminders';
import { getOccurrence } from '@shared/occurrences';
import { keyBetween } from '@shared/ordering';
import {
  createTask,
  createTasksFromText,
  deleteOccurrence,
  deleteTask,
  duplicateTask,
  goNext,
  goPrev,
  goToday,
  moveAllOverdueToToday,
  moveOccurrence,
  openPeek,
  renameTask,
  resizeTask,
  scrollCalendarTo,
  setDone,
  setRecurrence,
  setReminder,
  setSchedule,
  setSeriesStart,
  setTheme,
  setView,
  setVisibleMonth,
  showToast,
  toggleGroup,
  undo,
  updateSettings,
} from '@/store/actions';
import { useStore } from '@/store/store';
import { UNDO_LIMIT, undoDepth } from '@/store/undo';
import { taskGroupsOf } from '@/store/selectors';
import { dayTitles, inboxTitles, setup, task, tasks, teardownAll, toasts, until } from './helpers';

const DAILY: Recurrence = { freq: 'daily', interval: 1 };
const NOW = new Date('2026-11-19T15:00:00Z').getTime(); // 10:00 in New York

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await setup();
});

afterEach(() => {
  teardownAll();
  vi.useRealTimers();
});

function toastAction(message: string): () => void {
  const t = useStore.getState().toasts.find((x) => x.message === message);
  if (!t?.action) throw new Error(`no toast action for "${message}"`);
  return t.action.run;
}

describe('createTask', () => {
  it('Inbox defaults to top, a day defaults to the bottom of its untimed cards', () => {
    createTask({ title: 'inbox 1' });
    createTask({ title: 'inbox 2' });
    expect(inboxTitles()).toEqual(['inbox 2', 'inbox 1']);

    createTask({ title: 'day 1', date: '2026-11-20' });
    createTask({ title: 'day 2', date: '2026-11-20' });
    createTask({ title: 'day 0', date: '2026-11-20', position: 'top' });
    expect(dayTitles('2026-11-20')).toEqual(['day 0', 'day 1', 'day 2']);

    createTask({ title: 'inbox last', position: 'bottom' });
    expect(inboxTitles()).toEqual(['inbox 2', 'inbox 1', 'inbox last']);
  });

  it('honors an explicit drop position', () => {
    const a = createTask({ title: 'a', date: '2026-11-20' });
    const c = createTask({ title: 'c', date: '2026-11-20' });
    createTask({ title: 'b', date: '2026-11-20', position: { prevOrder: task(a).order, nextOrder: task(c).order } });
    expect(dayTitles('2026-11-20')).toEqual(['a', 'b', 'c']);
  });

  it('ignores blank titles and cleans the title', () => {
    expect(createTask({ title: '   ' })).toBe('');
    expect(Object.keys(tasks())).toHaveLength(0);
    const id = createTask({ title: '  Call\nmom  ' });
    expect(task(id).title).toBe('Call mom');
    const long = createTask({ title: 'x'.repeat(800) });
    expect(task(long).title).toHaveLength(500);
  });

  it('enforces invariants: no time/end without date, end after start, no end with a repeat', () => {
    const inbox = createTask({ title: 'a', date: null, time: '09:00', endDate: '2026-11-22' });
    expect(task(inbox)).toMatchObject({ date: null, time: null, endDate: null });

    const swapped = createTask({ title: 'b', date: '2026-11-25', endDate: '2026-11-22' });
    expect(task(swapped)).toMatchObject({ date: '2026-11-22', endDate: '2026-11-25' });

    const single = createTask({ title: 'c', date: '2026-11-25', endDate: '2026-11-25' });
    expect(task(single).endDate).toBeNull();

    const rec = createTask({ title: 'd', date: '2026-11-25', endDate: '2026-11-27', recurrence: DAILY });
    expect(task(rec).endDate).toBeNull();
    expect(task(rec).recurrence).toEqual({ freq: 'daily', interval: 1, byWeekday: null, until: null, count: null });

    const bad = createTask({ title: 'e', date: 'not-a-date' });
    expect(task(bad).date).toBeNull();
  });

  it('computes remindAt for timed tasks', () => {
    const id = createTask({ title: 'Meeting', date: '2026-11-19', time: '15:00' });
    expect(task(id).remindAt).toBe(zonedInstant('2026-11-19', '15:00', 'America/New_York'));
    const untimed = createTask({ title: 'x', date: '2026-11-19' });
    expect(task(untimed).remindAt).toBeNull();
  });

  it('is undoable', () => {
    const id = createTask({ title: 'oops' });
    undo();
    expect(tasks()[id]).toBeUndefined();
  });
});

describe('createTasksFromText', () => {
  it('strips bullets, skips blanks and keeps line order on top of the Inbox', () => {
    createTask({ title: 'existing' });
    const ids = createTasksFromText('- one\n* two\n\n   \n• three\r\n[ ] four\n1. five\n- [ ] six\n12) seven', null);
    expect(ids).toHaveLength(7);
    expect(ids.map((id) => task(id).title)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven']);
    expect(inboxTitles()).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'existing']);
  });

  it('appends to a day in line order', () => {
    createTask({ title: 'existing', date: '2026-11-21' });
    createTasksFromText('a\nb\nc', '2026-11-21');
    expect(dayTitles('2026-11-21')).toEqual(['existing', 'a', 'b', 'c']);
  });

  it('keeps titles that merely start with numbers or dashes', () => {
    const ids = createTasksFromText('2.5 hours of work\n-5 degrees', null);
    expect(ids.map((id) => task(id).title)).toEqual(['2.5 hours of work', '-5 degrees']);
  });

  it('is one undo entry', () => {
    const before = undoDepth();
    createTasksFromText('a\nb\nc', null);
    expect(undoDepth()).toBe(before + 1);
    undo();
    expect(inboxTitles()).toEqual([]);
  });

  it('returns [] for blank text', () => {
    expect(createTasksFromText('\n  \n', null)).toEqual([]);
  });
});

describe('renameTask', () => {
  it('trims and ignores empty titles', () => {
    const id = createTask({ title: 'a' });
    renameTask(id, '  b  ');
    expect(task(id).title).toBe('b');
    renameTask(id, '   ');
    expect(task(id).title).toBe('b');
  });
});

describe('moveOccurrence', () => {
  it('moves a single task to another day, at the end of its untimed cards', () => {
    createTask({ title: 'there', date: '2026-11-22' });
    const id = createTask({ title: 'mover', date: '2026-11-20', time: '09:00' });
    moveOccurrence({ taskId: id, origDate: null }, '2026-11-22');
    expect(task(id)).toMatchObject({ date: '2026-11-22', time: '09:00', endDate: null });
    const untimed = createTask({ title: 'u', date: '2026-11-20' });
    moveOccurrence({ taskId: untimed, origDate: null }, '2026-11-22');
    expect(dayTitles('2026-11-22')).toEqual(['there', 'u']);
  });

  it('shifts a multi-day task keeping its length', () => {
    const id = createTask({ title: 'trip', date: '2026-11-18', endDate: '2026-11-21' });
    moveOccurrence({ taskId: id, origDate: null }, '2026-11-30');
    expect(task(id)).toMatchObject({ date: '2026-11-30', endDate: '2026-12-03' });
  });

  it('moves to the Inbox (top by default), clearing date, end and time', () => {
    createTask({ title: 'inbox' });
    const id = createTask({ title: 'x', date: '2026-11-18', endDate: '2026-11-21', time: '10:00' });
    moveOccurrence({ taskId: id, origDate: null }, null);
    expect(task(id)).toMatchObject({ date: null, endDate: null, time: null, remindAt: null });
    expect(inboxTitles()).toEqual(['x', 'inbox']);
  });

  it('reorders inside the Inbox with a drop position', () => {
    const a = createTask({ title: 'a', position: 'bottom' });
    const b = createTask({ title: 'b', position: 'bottom' });
    const c = createTask({ title: 'c', position: 'bottom' });
    moveOccurrence({ taskId: a, origDate: null }, null, { prevOrder: task(b).order, nextOrder: task(c).order });
    expect(inboxTitles()).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when nothing changes (no undo entry)', () => {
    const id = createTask({ title: 'x', date: '2026-11-20' });
    const depth = undoDepth();
    const before = task(id);
    moveOccurrence({ taskId: id, origDate: null }, '2026-11-20');
    expect(task(id)).toBe(before);
    expect(undoDepth()).toBe(depth);
  });

  it('recurring: sets the date override, and clears it when moved back to its original date', () => {
    const id = createTask({ title: 'gym', date: '2026-11-16', recurrence: DAILY });
    const ref = { taskId: id, origDate: '2026-11-20' };
    moveOccurrence(ref, '2026-11-22');
    expect(task(id).overrides['2026-11-20']).toMatchObject({ date: '2026-11-22' });
    expect(getOccurrence(task(id), '2026-11-20')?.date).toBe('2026-11-22');
    expect(task(id).date).toBe('2026-11-16');

    moveOccurrence(ref, '2026-11-20');
    expect(task(id).overrides['2026-11-20']).toBeUndefined();
    expect(getOccurrence(task(id), '2026-11-20')?.date).toBe('2026-11-20');
  });

  it('recurring: a drop position sets an order override', () => {
    const id = createTask({ title: 'gym', date: '2026-11-16', recurrence: DAILY });
    moveOccurrence({ taskId: id, origDate: '2026-11-20' }, '2026-11-20', { prevOrder: null, nextOrder: 'a0' });
    expect(task(id).overrides['2026-11-20']).toEqual({ order: keyBetween(null, 'a0') });
  });

  it('recurring → Inbox is refused with a toast', () => {
    const id = createTask({ title: 'gym', date: '2026-11-16', recurrence: DAILY });
    const before = task(id);
    const depth = undoDepth();
    moveOccurrence({ taskId: id, origDate: '2026-11-20' }, null);
    expect(task(id)).toBe(before);
    expect(undoDepth()).toBe(depth);
    expect(toasts()).toContain("Repeating tasks can't go to the Inbox");
  });

  it('is undoable', () => {
    const id = createTask({ title: 'x', date: '2026-11-20' });
    moveOccurrence({ taskId: id, origDate: null }, '2026-11-25');
    undo();
    expect(task(id).date).toBe('2026-11-20');
  });
});

describe('resizeTask', () => {
  it('changes start/end; equal dates → single-day; recurring ignored; undoable', () => {
    const id = createTask({ title: 'x', date: '2026-11-20' });
    resizeTask(id, '2026-11-20', '2026-11-23');
    expect(task(id)).toMatchObject({ date: '2026-11-20', endDate: '2026-11-23' });
    resizeTask(id, '2026-11-21', '2026-11-23');
    expect(task(id)).toMatchObject({ date: '2026-11-21', endDate: '2026-11-23' });
    resizeTask(id, '2026-11-21', '2026-11-21');
    expect(task(id).endDate).toBeNull();
    undo();
    expect(task(id)).toMatchObject({ date: '2026-11-21', endDate: '2026-11-23' });
    resizeTask(id, '2026-11-25', '2026-11-22');
    expect(task(id)).toMatchObject({ date: '2026-11-22', endDate: '2026-11-25' });

    const rec = createTask({ title: 'r', date: '2026-11-20', recurrence: DAILY });
    const before = task(rec);
    resizeTask(rec, '2026-11-20', '2026-11-22');
    expect(task(rec)).toBe(before);
  });
});

describe('setSchedule', () => {
  it('non-recurring: sets date, end and time; swaps an end before the start', () => {
    const id = createTask({ title: 'x', date: '2026-11-20' });
    const ref = { taskId: id, origDate: null };
    setSchedule(ref, { date: '2026-11-24', endDate: '2026-11-22', time: '08:30' });
    expect(task(id)).toMatchObject({ date: '2026-11-22', endDate: '2026-11-24', time: '08:30' });
    // endDate omitted keeps the end while it is still after the start.
    setSchedule(ref, { date: '2026-11-23' });
    expect(task(id)).toMatchObject({ date: '2026-11-23', endDate: '2026-11-24', time: '08:30' });
    setSchedule(ref, { date: '2026-11-26' });
    expect(task(id)).toMatchObject({ date: '2026-11-26', endDate: null });
    setSchedule(ref, { date: '2026-11-26', time: null });
    expect(task(id).time).toBeNull();
  });

  it('schedules an Inbox task at the end of the day', () => {
    createTask({ title: 'first', date: '2026-11-20' });
    const id = createTask({ title: 'inbox' });
    setSchedule({ taskId: id, origDate: null }, { date: '2026-11-20' });
    expect(dayTitles('2026-11-20')).toEqual(['first', 'inbox']);
  });

  it('recurring: overrides only that occurrence; time equal to the series time clears the override', () => {
    const id = createTask({ title: 'standup', date: '2026-11-16', time: '09:00', recurrence: DAILY });
    const ref = { taskId: id, origDate: '2026-11-20' };
    setSchedule(ref, { date: '2026-11-21', endDate: '2026-11-25', time: '10:00' });
    expect(task(id).overrides['2026-11-20']).toMatchObject({ date: '2026-11-21', time: '10:00' });
    expect(task(id).endDate).toBeNull();
    expect(task(id).date).toBe('2026-11-16');
    setSchedule(ref, { date: '2026-11-20', time: '09:00' });
    expect(task(id).overrides['2026-11-20']).toBeUndefined();
    setSchedule(ref, { date: '2026-11-20', time: null });
    expect(task(id).overrides['2026-11-20']).toEqual({ time: null });
    expect(getOccurrence(task(id), '2026-11-20')?.time).toBeNull();
  });

  it('date null → Inbox (refused for recurring)', () => {
    const id = createTask({ title: 'x', date: '2026-11-20', time: '09:00' });
    setSchedule({ taskId: id, origDate: null }, { date: null });
    expect(task(id)).toMatchObject({ date: null, time: null });
    const rec = createTask({ title: 'r', date: '2026-11-20', recurrence: DAILY });
    setSchedule({ taskId: rec, origDate: '2026-11-20' }, { date: null });
    expect(task(rec).date).toBe('2026-11-20');
    expect(toasts()).toContain("Repeating tasks can't go to the Inbox");
  });
});

describe('setSeriesStart', () => {
  it('moves the series start', () => {
    const id = createTask({ title: 'r', date: '2026-11-20', recurrence: DAILY });
    setSeriesStart(id, '2026-11-25');
    expect(task(id).date).toBe('2026-11-25');
    expect(getOccurrence(task(id), '2026-11-21')).toBeNull();
  });
});

describe('setDone', () => {
  it('completes with a toast; Undo restores (toast action and ⌘Z)', () => {
    const id = createTask({ title: 'x', date: '2026-11-19' });
    setDone({ taskId: id, origDate: null }, true);
    expect(task(id)).toMatchObject({ done: true, doneAt: NOW });
    expect(toasts()).toContain('Task completed');
    toastAction('Task completed')();
    expect(task(id)).toMatchObject({ done: false, doneAt: null });
    expect(toasts()).not.toContain('Task completed');

    setDone({ taskId: id, origDate: null }, true);
    undo();
    expect(task(id).done).toBe(false);
    // ⌘Z dismissed the toast and consumed the entry: its Undo is gone.
    expect(toasts()).not.toContain('Task completed');
  });

  it('a stale toast Undo after ⌘Z is a no-op', () => {
    const id = createTask({ title: 'x', date: '2026-11-19' });
    setDone({ taskId: id, origDate: null }, true);
    const run = toastAction('Task completed');
    undo();
    setDone({ taskId: id, origDate: null }, true);
    run();
    expect(task(id).done).toBe(true);
  });

  it('recurring: marks only that occurrence; top-level done stays false', () => {
    const id = createTask({ title: 'gym', date: '2026-11-16', recurrence: DAILY });
    setDone({ taskId: id, origDate: '2026-11-19' }, true);
    expect(task(id).done).toBe(false);
    expect(task(id).overrides['2026-11-19']).toEqual({ done: true, doneAt: NOW });
    expect(getOccurrence(task(id), '2026-11-20')?.done).toBe(false);
    setDone({ taskId: id, origDate: '2026-11-19' }, false);
    expect(task(id).overrides['2026-11-19']).toBeUndefined();
  });

  it('unchecking does not toast; no-op when unchanged', () => {
    const id = createTask({ title: 'x', date: '2026-11-19' });
    const depth = undoDepth();
    setDone({ taskId: id, origDate: null }, false);
    expect(undoDepth()).toBe(depth);
    expect(toasts()).toEqual([]);
  });

  it('done tasks move to the Completed group', () => {
    const id = createTask({ title: 'x', date: '2026-11-19' });
    setDone({ taskId: id, origDate: null }, true);
    const groups = taskGroupsOf(tasks(), '2026-11-19');
    expect(groups.map((g) => g.id)).toEqual(['completed']);
  });

  it('recomputes remindAt (done → no reminder)', () => {
    const id = createTask({ title: 'x', date: '2026-11-19', time: '15:00' });
    expect(task(id).remindAt).not.toBeNull();
    setDone({ taskId: id, origDate: null }, true);
    expect(task(id).remindAt).toBeNull();
    undo();
    expect(task(id).remindAt).toBe(zonedInstant('2026-11-19', '15:00', 'America/New_York'));
  });
});

describe('deleteOccurrence / deleteTask', () => {
  it('recurring: skips just that occurrence; Undo restores it', () => {
    const id = createTask({ title: 'gym', date: '2026-11-16', recurrence: DAILY });
    openPeek({ taskId: id, origDate: '2026-11-20' });
    deleteOccurrence({ taskId: id, origDate: '2026-11-20' });
    expect(task(id).overrides['2026-11-20']).toEqual({ skipped: true });
    expect(getOccurrence(task(id), '2026-11-20')).toBeNull();
    expect(getOccurrence(task(id), '2026-11-21')).not.toBeNull();
    expect(useStore.getState().ui.peek).toBeNull();
    expect(toasts()).toContain('Task deleted');
    toastAction('Task deleted')();
    expect(task(id).overrides['2026-11-20']).toBeUndefined();
  });

  it('deletes a finite series outright once every occurrence is skipped', () => {
    const id = createTask({ title: 'twice', date: '2026-11-20', recurrence: { freq: 'daily', interval: 1, count: 2 } });
    deleteOccurrence({ taskId: id, origDate: '2026-11-20' });
    expect(tasks()[id]).toBeDefined();
    deleteOccurrence({ taskId: id, origDate: '2026-11-21' });
    expect(tasks()[id]).toBeUndefined();
    undo();
    expect(task(id).overrides['2026-11-20']).toEqual({ skipped: true });
  });

  it('non-recurring: deletes the task; Undo restores the full doc', () => {
    const id = createTask({ title: 'x', date: '2026-11-20', time: '11:00' });
    const snapshot = task(id);
    deleteOccurrence({ taskId: id, origDate: null });
    expect(tasks()[id]).toBeUndefined();
    undo();
    expect(task(id)).toMatchObject({ ...snapshot, updatedAt: expect.any(Number) });
  });

  it('deleteTask removes the whole series and closes its peek', () => {
    const id = createTask({ title: 'gym', date: '2026-11-16', recurrence: DAILY });
    openPeek({ taskId: id, origDate: '2026-11-19' });
    deleteTask(id);
    expect(tasks()[id]).toBeUndefined();
    expect(useStore.getState().ui.peek).toBeNull();
    undo();
    expect(task(id).recurrence).not.toBeNull();
  });
});

describe('moveAllOverdueToToday', () => {
  it('moves overdue one-time tasks (not recurring, not done) in one undoable batch', () => {
    const a = createTask({ title: 'a', date: '2026-11-10' });
    const b = createTask({ title: 'b', date: '2026-11-12', endDate: '2026-11-14' });
    const done = createTask({ title: 'done', date: '2026-11-11' });
    setDone({ taskId: done, origDate: null }, true);
    const rec = createTask({ title: 'rec', date: '2026-11-01', recurrence: DAILY });
    const active = createTask({ title: 'active', date: '2026-11-17', endDate: '2026-11-20' });
    createTask({ title: 'today', date: '2026-11-19' });

    const depth = undoDepth();
    moveAllOverdueToToday();
    expect(undoDepth()).toBe(depth + 1);
    expect(task(a)).toMatchObject({ date: '2026-11-19', endDate: null });
    expect(task(b)).toMatchObject({ date: '2026-11-19', endDate: '2026-11-21' });
    expect(task(done).date).toBe('2026-11-11');
    expect(task(rec).date).toBe('2026-11-01');
    expect(task(active).date).toBe('2026-11-17');
    expect(dayTitles('2026-11-19')).toEqual(['today', 'a']);
    expect(toasts()).toContain('Moved 2 tasks to today');

    toastAction('Moved 2 tasks to today')();
    expect(task(a).date).toBe('2026-11-10');
    expect(task(b)).toMatchObject({ date: '2026-11-12', endDate: '2026-11-14' });
  });

  it('singular toast and no-op without overdue tasks', () => {
    moveAllOverdueToToday();
    expect(toasts()).toEqual([]);
    createTask({ title: 'a', date: '2026-11-10' });
    moveAllOverdueToToday();
    expect(toasts()).toContain('Moved 1 task to today');
  });
});

describe('setRecurrence', () => {
  it('setting a rule clears the end date; requires a date', () => {
    const id = createTask({ title: 'x', date: '2026-11-20', endDate: '2026-11-22' });
    setRecurrence(id, { freq: 'weekly', interval: 1 });
    expect(task(id).endDate).toBeNull();
    expect(task(id).recurrence).toEqual({ freq: 'weekly', interval: 1, byWeekday: [5], until: null, count: null });

    const inbox = createTask({ title: 'inbox' });
    setRecurrence(inbox, DAILY);
    expect(task(inbox).recurrence).toBeNull();
  });

  it('carries a one-time completion to the start occurrence', () => {
    const id = createTask({ title: 'x', date: '2026-11-19' });
    setDone({ taskId: id, origDate: null }, true);
    setRecurrence(id, DAILY);
    expect(task(id).done).toBe(false);
    expect(task(id).overrides['2026-11-19']).toMatchObject({ done: true });
  });

  it('clearing the rule makes a one-time task on the next occurrence on/after today and drops overrides', () => {
    const id = createTask({ title: 'x', date: '2026-11-01', time: '07:00', recurrence: DAILY });
    setDone({ taskId: id, origDate: '2026-11-10' }, true);
    setRecurrence(id, null);
    expect(task(id)).toMatchObject({ recurrence: null, date: '2026-11-19', time: '07:00', overrides: {}, done: false });
    undo();
    expect(task(id).recurrence).not.toBeNull();
    expect(task(id).date).toBe('2026-11-01');
  });

  it('no-op for an identical rule', () => {
    const id = createTask({ title: 'x', date: '2026-11-19', recurrence: DAILY });
    const depth = undoDepth();
    setRecurrence(id, { freq: 'daily', interval: 1, byWeekday: null });
    expect(undoDepth()).toBe(depth);
  });
});

describe('reminders', () => {
  it('remindAt follows time changes and the reminder setting', () => {
    const id = createTask({ title: 'x', date: '2026-11-20', time: '09:00' });
    const ref = { taskId: id, origDate: null };
    expect(task(id).remindAt).toBe(zonedInstant('2026-11-20', '09:00', 'America/New_York'));
    setSchedule(ref, { date: '2026-11-20', time: '13:30' });
    expect(task(id).remindAt).toBe(zonedInstant('2026-11-20', '13:30', 'America/New_York'));
    setReminder(id, { kind: 'offset', minutes: 30 });
    expect(task(id).remindAt).toBe(zonedInstant('2026-11-20', '13:00', 'America/New_York'));
    setReminder(id, { kind: 'none' });
    expect(task(id).remindAt).toBeNull();
    setReminder(id, { kind: 'at', time: '18:00', daysBefore: 1 });
    expect(task(id).remindAt).toBe(zonedInstant('2026-11-19', '18:00', 'America/New_York'));
    // 08:00 the day before has already passed (now = 10:00 New York) → nothing left to fire.
    setReminder(id, { kind: 'at', time: '08:00', daysBefore: 1 });
    expect(task(id).remindAt).toBeNull();
  });

  it('recurring: remindAt is the next occurrence after now', () => {
    const id = createTask({ title: 'x', date: '2026-11-16', time: '09:00', recurrence: DAILY });
    // 09:00 NY today has passed (now = 10:00 NY) → tomorrow.
    expect(task(id).remindAt).toBe(zonedInstant('2026-11-20', '09:00', 'America/New_York'));
    expect(task(id).remindAt).toBe(computeRemindAt(task(id), 'America/New_York', NOW));
  });

  it('updateSettings(timezone) recomputes every remindAt and summaryAt', async () => {
    const a = createTask({ title: 'a', date: '2026-11-20', time: '09:00' });
    const b = createTask({ title: 'b', date: '2026-11-21', time: '18:00' });
    const untimed = createTask({ title: 'c', date: '2026-11-21' });
    let userDoc: unknown = null;
    updateSettings({ timezone: 'Asia/Tokyo' });
    expect(useStore.getState().settings.timezone).toBe('Asia/Tokyo');
    expect(task(a).remindAt).toBe(zonedInstant('2026-11-20', '09:00', 'Asia/Tokyo'));
    expect(task(b).remindAt).toBe(zonedInstant('2026-11-21', '18:00', 'Asia/Tokyo'));
    expect(task(untimed).remindAt).toBeNull();
    // The user doc got the new zone and the next summary instant in it.
    const { getRepo } = await import('@/data/current');
    const repo = getRepo();
    expect(repo).not.toBeNull();
    const unsub = repo!.subscribeUser((d) => {
      userDoc = d;
    }, () => undefined);
    await until(() => userDoc !== null);
    unsub();
    expect(userDoc).toMatchObject({
      settings: { timezone: 'Asia/Tokyo' },
      summaryAt: nextSummaryAt(useStore.getState().settings, NOW),
    });
  });

  it('updateSettings merges the summary sub-object', () => {
    updateSettings({ summary: { time: '07:30' } as never });
    expect(useStore.getState().settings.summary).toEqual({ enabled: true, time: '07:30' });
    updateSettings({ weekStart: 0 });
    expect(useStore.getState().settings).toMatchObject({ weekStart: 0, summary: { enabled: true, time: '07:30' } });
  });
});

describe('duplicateTask', () => {
  it('copies right below the original, not done', () => {
    const a = createTask({ title: 'a', date: '2026-11-20' });
    createTask({ title: 'c', date: '2026-11-20' });
    setDone({ taskId: a, origDate: null }, true);
    setDone({ taskId: a, origDate: null }, false);
    const copy = duplicateTask(a);
    expect(copy).not.toBe('');
    expect(task(copy)).toMatchObject({ title: 'a', date: '2026-11-20', done: false });
    expect(dayTitles('2026-11-20')).toEqual(['a', 'a', 'c']);
    undo();
    expect(tasks()[copy]).toBeUndefined();
  });
});

describe('undo stack', () => {
  it(`keeps at most ${UNDO_LIMIT} entries`, () => {
    for (let i = 0; i < UNDO_LIMIT + 10; i++) createTask({ title: `t${i}` });
    expect(undoDepth()).toBe(UNDO_LIMIT);
  });

  it('undoes in reverse order', () => {
    const id = createTask({ title: 'x', date: '2026-11-20' });
    moveOccurrence({ taskId: id, origDate: null }, '2026-11-21');
    moveOccurrence({ taskId: id, origDate: null }, '2026-11-22');
    undo();
    expect(task(id).date).toBe('2026-11-21');
    undo();
    expect(task(id).date).toBe('2026-11-20');
    undo();
    expect(tasks()[id]).toBeUndefined();
    undo(); // empty stack: nothing happens
  });
});

describe('toasts', () => {
  it('caps the list and defaults to 5 s', () => {
    for (let i = 0; i < 8; i++) showToast(`m${i}`);
    const list = useStore.getState().toasts;
    expect(list).toHaveLength(5);
    expect(list.at(-1)).toMatchObject({ message: 'm7', duration: 5000 });
  });
});

describe('UI actions', () => {
  it('goPrev/goNext in month view request a scroll to the 1st of the month with a fresh nonce', () => {
    setView('month');
    setVisibleMonth('2026-11-14');
    expect(useStore.getState().ui.visibleMonth).toBe('2026-11-01');
    goNext();
    const r1 = useStore.getState().ui.scrollRequest;
    expect(r1).toMatchObject({ date: '2026-12-01', behavior: 'smooth' });
    expect(useStore.getState().ui.visibleMonth).toBe('2026-12-01');
    goNext();
    const r2 = useStore.getState().ui.scrollRequest;
    expect(r2?.date).toBe('2027-01-01');
    expect(r2!.nonce).toBeGreaterThan(r1!.nonce);
    goPrev();
    goPrev();
    goPrev();
    expect(useStore.getState().ui.scrollRequest?.date).toBe('2026-10-01');
    goToday();
    expect(useStore.getState().ui.scrollRequest?.date).toBe('2026-11-19');
    scrollCalendarTo('2027-03-03', 'instant');
    expect(useStore.getState().ui.scrollRequest).toMatchObject({ date: '2027-03-03', behavior: 'instant' });
  });

  it('week view steps weekAnchor by 7 days', () => {
    setView('week');
    expect(useStore.getState().ui.weekAnchor).toBe('2026-11-19');
    goNext();
    expect(useStore.getState().ui.weekAnchor).toBe('2026-11-26');
    goPrev();
    goPrev();
    expect(useStore.getState().ui.weekAnchor).toBe('2026-11-12');
    goToday();
    expect(useStore.getState().ui.weekAnchor).toBe('2026-11-19');
    setView('month');
    expect(useStore.getState().ui.scrollRequest?.date).toBe('2026-11-19');
  });

  it('toggleGroup uses the default until the device has a preference', () => {
    toggleGroup('completed', true);
    expect(useStore.getState().ui.collapsedGroups.completed).toBe(false);
    toggleGroup('completed', true);
    expect(useStore.getState().ui.collapsedGroups.completed).toBe(true);
  });

  it('setTheme validates', () => {
    setTheme('dark');
    expect(useStore.getState().theme).toBe('dark');
    setTheme('neon' as never);
    expect(useStore.getState().theme).toBe('dark');
  });
});
