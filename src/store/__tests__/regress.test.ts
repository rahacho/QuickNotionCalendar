/**
 * Regression tests for review findings in the store (B1, B5, B6, E5, E7, E9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '@shared/dates';
import { buildTaskGroups } from '@shared/grouping';
import { getOccurrence, occurrencesInRange } from '@shared/occurrences';
import { badgeCount, computeRemindAt, zonedInstant } from '@shared/reminders';
import {
  createTask,
  createTasksFromText,
  deleteTask,
  moveOccurrence,
  redo,
  renameTask,
  setDone,
  setRecurrence,
  setSchedule,
  setSeriesTime,
  showMoreCompleted,
  undo,
} from '@/store/actions';
import { useStore } from '@/store/store';
import { taskGroupsOf } from '@/store/selectors';
import { redoDepth, undoDepth } from '@/store/undo';
import { setup, task, tasks, teardownAll, toasts } from './helpers';

const TODAY = '2026-11-19';
const NY = 'America/New_York';
let now = new Date('2026-11-19T15:00:00Z').getTime(); // 10:00 in New York

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  now = new Date('2026-11-19T15:00:00Z').getTime();
  vi.setSystemTime(now);
  await setup();
});

afterEach(() => {
  teardownAll();
  vi.useRealTimers();
});

function tick(ms: number): void {
  now += ms;
  vi.setSystemTime(now);
}

function toastAction(prefix: string): () => void {
  const t = useStore.getState().toasts.findLast((x) => x.message.startsWith(prefix));
  if (!t?.action) throw new Error(`no toast action for "${prefix}"`);
  return t.action.run;
}

const groups = () => buildTaskGroups(Object.values(tasks()), TODAY);
const openListed = () =>
  groups()
    .filter((g) => g.id !== 'completed')
    .flatMap((g) => g.items.map((i) => `${i.occ.title}@${i.occ.date}`));
const onCalendar = (from: string, to: string) => occurrencesInRange(Object.values(tasks()), from, to).map((o) => `${o.title}@${o.date}`);

describe('E5: ⌘Z never removes or changes a task silently', () => {
  it('⌘Z after a rename reverts the rename (not the newest creation) and says so', () => {
    const dentist = createTask({ title: 'Call dentist', date: TODAY });
    const milk = createTask({ title: 'Buy milk' });
    renameTask(dentist, 'Call dentist about crown');
    undo();
    expect(task(dentist).title).toBe('Call dentist');
    expect(tasks()[milk]).toBeDefined();
    expect(toasts().at(-1)).toBe('Undid: renamed “Call dentist”');
  });

  it('an undo that removes a task shows what it removed, and Redo brings it back', () => {
    const milk = createTask({ title: 'Buy milk' });
    undo();
    expect(tasks()[milk]).toBeUndefined();
    expect(toasts().at(-1)).toBe('Undid: added “Buy milk”');
    toastAction('Undid:')();
    expect(task(milk).title).toBe('Buy milk');
    expect(toasts().at(-1)).toBe('Redid: added “Buy milk”');
    // ...which can be undone again.
    undo();
    expect(tasks()[milk]).toBeUndefined();
  });

  it('redo() re-applies the undone step; a new change clears what can be redone', () => {
    const id = createTask({ title: 'x', date: TODAY });
    moveOccurrence({ taskId: id, origDate: null }, '2026-11-21');
    undo();
    expect(task(id).date).toBe(TODAY);
    redo();
    expect(task(id).date).toBe('2026-11-21');
    undo();
    expect(redoDepth()).toBe(1);
    createTask({ title: 'y' });
    expect(redoDepth()).toBe(0);
    redo();
    expect(task(id).date).toBe(TODAY);
  });

  it('title saves while typing are one undo step; a later edit session is another', () => {
    const id = createTask({ title: 'a' });
    const depth = undoDepth();
    renameTask(id, 'ab');
    tick(500);
    renameTask(id, 'abc');
    tick(500);
    renameTask(id, 'abcd');
    expect(undoDepth()).toBe(depth + 1);
    tick(11_000);
    renameTask(id, 'abcde');
    expect(undoDepth()).toBe(depth + 2);
    undo();
    expect(task(id).title).toBe('abcd');
    undo();
    expect(task(id).title).toBe('a');
  });

  it('a rename of another task, or any other change in between, starts a new step', () => {
    const a = createTask({ title: 'a' });
    const b = createTask({ title: 'b' });
    renameTask(a, 'a1');
    renameTask(b, 'b1');
    renameTask(a, 'a2');
    undo();
    expect([task(a).title, task(b).title]).toEqual(['a1', 'b1']);
  });
});

describe('E5 (gap): an Undo clicked out of order never comes back in a later ⌘Z', () => {
  it('"Task completed · Undo" clicked after a rename keeps the rename; typing on, then ⌘Z, never re-completes', () => {
    const id = createTask({ title: 'a', date: TODAY });
    setDone({ taskId: id, origDate: null }, true);
    const undoCompletion = toastAction('Task completed');
    renameTask(id, 'ab');
    undoCompletion();
    // Only the completion is taken back: the rename typed meanwhile stays.
    expect([task(id).title, task(id).done]).toEqual(['ab', false]);
    renameTask(id, 'abc');
    undo();
    expect(task(id).done).toBe(false);
    expect(toasts().at(-1)?.startsWith('Undid: renamed')).toBe(true);
    // Every rename step taken back, the task is still open (not quietly in Completed).
    while (task(id).title !== 'a' && undoDepth() > 0) undo();
    expect([task(id).title, task(id).done]).toEqual(['a', false]);
  });

  it('an out-of-order Undo of a creation drops the later steps on that task (nothing resurrects it)', () => {
    const id = createTask({ title: 'Milk', date: TODAY });
    undo();
    toastAction('Undid:')(); // Redo → "Redid: added “Milk”" with Undo
    const undoCreation = toastAction('Redid:');
    const depth = undoDepth();
    renameTask(id, 'Oat milk');
    expect(undoDepth()).toBe(depth + 1);
    undoCreation();
    expect(tasks()[id]).toBeUndefined();
    // The rename step went with the task it renamed: ⌘Z can't bring the task back half-way.
    expect(undoDepth()).toBe(depth - 1);
    while (undoDepth() > 0) undo();
    expect(tasks()[id]).toBeUndefined();
  });

  it('the rename step only merges saves of the task as it last left it', () => {
    const id = createTask({ title: 'a', date: TODAY });
    renameTask(id, 'ab');
    const depth = undoDepth();
    setDone({ taskId: id, origDate: null }, true);
    toastAction('Task completed')(); // undone from its toast: the task changed under the rename step
    renameTask(id, 'abc');
    expect(undoDepth()).toBe(depth + 1);
  });
});

describe('E5 (gap): a Redo button never silently does nothing', () => {
  it('a new change dismisses the "Undid: … · Redo" toast', () => {
    createTask({ title: 'a', date: TODAY });
    undo();
    expect(useStore.getState().toasts.some((t) => t.message === 'Undid: added “a”')).toBe(true);
    createTask({ title: 'b', date: TODAY });
    expect(redoDepth()).toBe(0);
    expect(useStore.getState().toasts.some((t) => t.message === 'Undid: added “a”')).toBe(false);
  });
});

describe('B1: Repeat → Never never hides the planned task', () => {
  it("today's occurrence already checked off → the one-time task is tomorrow's, open", () => {
    const id = createTask({ title: 'Gym', date: TODAY, recurrence: { freq: 'daily', interval: 1 } });
    setDone({ taskId: id, origDate: TODAY }, true);
    setRecurrence(id, null);
    expect(task(id)).toMatchObject({ recurrence: null, date: '2026-11-20', done: false });
    expect(openListed()).toContain('Gym@2026-11-20');
    expect(onCalendar('2026-11-16', '2026-11-29')).toEqual(['Gym@2026-11-20']);
  });

  it('keeps the occurrence being viewed (with its moved date and time)', () => {
    const id = createTask({ title: 'Gym', date: TODAY, recurrence: { freq: 'daily', interval: 1 } });
    setSchedule({ taskId: id, origDate: '2026-11-23' }, { date: '2026-11-24', time: '07:30' });
    setRecurrence(id, null, { keepOrigDate: '2026-11-23' });
    expect(task(id)).toMatchObject({ recurrence: null, date: '2026-11-24', time: '07:30', done: false, overrides: {} });
  });

  it('a viewed occurrence that is done or in the past falls back to the next open one', () => {
    const id = createTask({ title: 'Gym', date: '2026-11-10', recurrence: { freq: 'daily', interval: 1 } });
    setDone({ taskId: id, origDate: '2026-11-21' }, true);
    setRecurrence(id, null, { keepOrigDate: '2026-11-21' });
    expect(task(id)).toMatchObject({ date: TODAY, done: false });
    undo();
    setRecurrence(id, null, { keepOrigDate: '2026-11-12' });
    expect(task(id)).toMatchObject({ date: TODAY, done: false });
  });

  it('every upcoming occurrence checked off → the task ends up completed, not overdue', () => {
    const id = createTask({ title: 'Course', date: '2026-11-18', recurrence: { freq: 'daily', interval: 1, count: 3 } });
    setDone({ taskId: id, origDate: TODAY }, true);
    setDone({ taskId: id, origDate: '2026-11-20' }, true);
    setRecurrence(id, null);
    expect(task(id)).toMatchObject({ date: '2026-11-20', done: true });
    expect(groups().find((g) => g.id === 'overdue')).toBeUndefined();
  });

  it('dropping the completed history offers Undo (phones have no ⌘Z)', () => {
    const id = createTask({ title: 'Gym', date: '2026-11-10', recurrence: { freq: 'daily', interval: 1 } });
    setDone({ taskId: id, origDate: '2026-11-15' }, true);
    setRecurrence(id, null);
    expect(task(id).overrides).toEqual({});
    toastAction('Repeat removed')();
    expect(task(id).recurrence).not.toBeNull();
    expect(getOccurrence(task(id), '2026-11-15')?.done).toBe(true);
  });
});

describe('B5: making an overdue one-time task repeat keeps the missed instance in Overdue', () => {
  it('the Nov 1 instance stays overdue; the series continues Dec 1; badge unchanged; one Undo', () => {
    const id = createTask({ title: 'Pay rent', date: '2026-11-01', time: '09:00' });
    const badge = badgeCount(Object.values(tasks()), TODAY);
    setRecurrence(id, { freq: 'monthly', interval: 1 });
    const overdue = groups().find((g) => g.id === 'overdue');
    expect(overdue?.items.map((i) => `${i.occ.title}@${i.occ.date}`)).toEqual(['Pay rent@2026-11-01']);
    expect(overdue?.items[0]?.occ.taskId).not.toBe(id);
    expect(task(id).recurrence).not.toBeNull();
    expect(onCalendar('2026-11-01', '2026-12-31')).toEqual(['Pay rent@2026-11-01', 'Pay rent@2026-12-01']);
    expect(badgeCount(Object.values(tasks()), TODAY)).toBe(badge);
    expect(toasts().at(-1)).toBe('“Pay rent” repeats now · the Nov 1 one stays in Overdue');
    undo();
    expect(Object.values(tasks()).map((t) => [t.title, t.date, t.recurrence])).toEqual([['Pay rent', '2026-11-01', null]]);
  });

  it('changing your mind with Repeat → Never gives back the one overdue task (no second task on Dec 1)', () => {
    const id = createTask({ title: 'Pay rent', date: '2026-11-01', time: '09:00' });
    const before = task(id);
    setRecurrence(id, { freq: 'monthly', interval: 1 });
    setRecurrence(id, null, { keepOrigDate: '2026-12-01' }); // from the Dec 1 card's peek
    expect(Object.values(tasks()).map((t) => [t.id, t.title, t.date, t.time, t.recurrence])).toEqual([
      [id, 'Pay rent', '2026-11-01', '09:00', null],
    ]);
    expect(task(id).order).toBe(before.order);
    expect(groups().find((g) => g.id === 'overdue')?.items.map((i) => i.occ.taskId)).toEqual([id]);
    expect(toasts().at(-1)).toBe('Repeat removed');
    // ...and that is one undoable step: the series and its Overdue copy come back.
    toastAction('Repeat removed')();
    expect(task(id).recurrence).not.toBeNull();
    expect(onCalendar('2026-11-01', '2026-12-31')).toEqual(['Pay rent@2026-11-01', 'Pay rent@2026-12-01']);
  });

  it('…also when the old date is not one of the new repeat days', () => {
    const id = createTask({ title: 'Lesson', date: '2026-11-12' }); // a Thursday
    setRecurrence(id, { freq: 'weekly', interval: 1, byWeekday: [1] }); // Mondays
    expect(Object.keys(tasks())).toHaveLength(2);
    setRecurrence(id, null, { keepOrigDate: '2026-11-23' });
    expect(Object.values(tasks()).map((t) => [t.id, t.date, t.recurrence])).toEqual([[id, '2026-11-12', null]]);
  });

  it('a series used since (an occurrence checked off) keeps the viewed occurrence as before', () => {
    const id = createTask({ title: 'Pay rent', date: '2026-11-01', time: '09:00' });
    setRecurrence(id, { freq: 'monthly', interval: 1 });
    setDone({ taskId: id, origDate: '2026-12-01' }, true);
    setRecurrence(id, null, { keepOrigDate: '2027-01-01' });
    expect(Object.values(tasks()).map((t) => [t.title, t.date, t.recurrence]).sort()).toEqual([
      ['Pay rent', '2026-11-01', null],
      ['Pay rent', '2027-01-01', null],
    ]);
  });

  it('a count-limited series keeps its total (the missed one counts as the first)', () => {
    const id = createTask({ title: 'Lesson', date: '2026-11-12' });
    setRecurrence(id, { freq: 'weekly', interval: 1, count: 3 });
    expect(onCalendar('2026-11-01', '2026-12-31')).toEqual(['Lesson@2026-11-12', 'Lesson@2026-11-19', 'Lesson@2026-11-26']);
  });

  it('a task that is not overdue (or done) converts in place as before', () => {
    const future = createTask({ title: 'Future', date: '2026-11-25' });
    setRecurrence(future, { freq: 'weekly', interval: 1 });
    const done = createTask({ title: 'Done', date: '2026-11-01' });
    setDone({ taskId: done, origDate: null }, true);
    setRecurrence(done, { freq: 'monthly', interval: 1 });
    expect(Object.keys(tasks())).toHaveLength(2);
    expect(task(done).overrides['2026-11-01']).toMatchObject({ done: true });
  });
});

describe('B6: a repeating series can get / change its time', () => {
  it('setSeriesTime times every occurrence and arms the timed alert', () => {
    const id = createTask({ title: 'Gym', date: TODAY, recurrence: { freq: 'daily', interval: 1 } });
    setSchedule({ taskId: id, origDate: TODAY }, { date: TODAY, time: '07:00' }); // this occurrence only
    setSchedule({ taskId: id, origDate: '2026-11-22' }, { date: '2026-11-22', time: '18:00' }); // deliberate exception
    setSeriesTime(id, '07:00');
    const t = task(id);
    expect(t.time).toBe('07:00');
    expect(t.overrides[TODAY]).toBeUndefined(); // redundant override dropped
    expect(occurrencesInRange([t], '2026-11-20', '2026-11-22').map((o) => o.time)).toEqual(['07:00', '07:00', '18:00']);
    expect(t.remindAt).toBe(zonedInstant('2026-11-20', '07:00', NY));
    expect(computeRemindAt(t, NY, zonedInstant('2026-11-20', '08:00', NY))).toBe(zonedInstant('2026-11-21', '07:00', NY));
    setSeriesTime(id, '06:00');
    expect(occurrencesInRange([task(id)], '2026-11-20', '2026-11-20')[0]?.time).toBe('06:00');
    undo();
    expect(task(id).time).toBe('07:00');
  });

  it('a one-time task just gets the time; an Inbox task is left alone', () => {
    const one = createTask({ title: 'One', date: '2026-11-20' });
    setSeriesTime(one, '09:15');
    expect(task(one).time).toBe('09:15');
    const inbox = createTask({ title: 'Inbox' });
    setSeriesTime(inbox, '09:15');
    expect(task(inbox).time).toBeNull();
  });
});

describe('E7: every completion stays reachable from the Completed group', () => {
  it('"Show more" lists older completions so they can be restored', () => {
    const first = createTask({ title: 'Accidentally checked', date: '2026-11-20' });
    setDone({ taskId: first, origDate: null }, true);
    const habit = createTask({ title: 'Habit', date: '2026-10-01', recurrence: { freq: 'daily', interval: 1 } });
    for (let i = 0; i < 60; i++) {
      tick(60_000);
      setDone({ taskId: habit, origDate: addDays('2026-10-01', i) }, true);
    }
    const listed = () => {
      const s = useStore.getState();
      return (taskGroupsOf(s.tasks, s.today, s.ui.completedLimit).find((g) => g.id === 'completed')?.items ?? []).map((i) => i.occ.taskId);
    };
    expect(listed()).not.toContain(first);
    showMoreCompleted();
    expect(listed()).toContain(first);
    setDone({ taskId: first, origDate: null }, false);
    expect(task(first).done).toBe(false);
  });
});

describe('E9: pasting keeps titles that merely start with a number', () => {
  const titles = (text: string): string[] => createTasksFromText(text, null).map((id) => task(id).title);

  it('a year or a lone numbered line is part of the title', () => {
    expect(titles('2027. Budget review\nCall mom')).toEqual(['2027. Budget review', 'Call mom']);
    expect(titles('Order\n4) wheels')).toEqual(['Order', '4) wheels']);
    expect(titles('- 1. x\nother')).toEqual(['1. x', 'other']);
  });

  it('a numbered list loses its numbers (once per line)', () => {
    expect(titles('1. a\n2. b')).toEqual(['a', 'b']);
    expect(titles('- Call the bank\n1. Pick a gift')).toEqual(['Call the bank', 'Pick a gift']);
    expect(titles('1) 2. two\n2) b\n2027. c')).toEqual(['2. two', 'b', '2027. c']);
  });
});

describe('deleting from a toast still works with labelled entries', () => {
  it('Task deleted · Undo', () => {
    const id = createTask({ title: 'x', date: TODAY });
    deleteTask(id);
    toastAction('Task deleted')();
    expect(task(id).title).toBe('x');
  });
});

describe('C4: unscheduling to the Inbox offers Undo (phones have no ⌘Z)', () => {
  it('a dated task moved to the Inbox → "Moved to Inbox" + Undo restores date, end date and time', () => {
    const id = createTask({ title: 'Trip', date: '2026-11-20', endDate: '2026-11-22', time: '15:00' });
    moveOccurrence({ taskId: id, origDate: null }, null);
    expect(task(id)).toMatchObject({ date: null, endDate: null, time: null });
    expect(toasts().at(-1)).toBe('Moved to Inbox');
    toastAction('Moved to Inbox')();
    expect(task(id)).toMatchObject({ date: '2026-11-20', endDate: '2026-11-22', time: '15:00' });
  });

  it('reordering inside the Inbox stays quiet', () => {
    const a = createTask({ title: 'a' });
    createTask({ title: 'b' });
    const before = toasts().length;
    moveOccurrence({ taskId: a, origDate: null }, null, { prevOrder: task(a).order, nextOrder: null });
    expect(toasts()).toHaveLength(before);
  });
});

describe('B2: a repeat change is one step and never drops planned occurrences silently', () => {
  it('a new start and the new rule are one undo entry', () => {
    const id = createTask({ title: 'Team sync', date: '2026-11-05', recurrence: { freq: 'weekly', interval: 1, byWeekday: [4] } });
    const depth = undoDepth();
    setRecurrence(id, { freq: 'monthly', interval: 1 }, { start: '2026-12-03' });
    expect(undoDepth()).toBe(depth + 1);
    expect(task(id).date).toBe('2026-12-03');
    expect(task(id).recurrence?.freq).toBe('monthly');
    undo();
    expect(task(id).date).toBe('2026-11-05');
    expect(task(id).recurrence?.freq).toBe('weekly');
  });

  it('weekly → monthly drops planned weeks → "Repeat changed" + Undo brings them back', () => {
    const id = createTask({ title: 'Team sync', date: '2026-11-19', recurrence: { freq: 'weekly', interval: 1, byWeekday: [4] } });
    setRecurrence(id, { freq: 'monthly', interval: 1 });
    expect(toasts().at(-1)).toBe('Repeat changed');
    expect(onCalendar('2026-11-26', '2026-11-26')).toEqual([]);
    toastAction('Repeat changed')();
    expect(onCalendar('2026-11-26', '2026-11-26')).toEqual(['Team sync@2026-11-26']);
  });

  it('weekly → daily only adds occurrences: no toast', () => {
    const id = createTask({ title: 'Walk', date: '2026-11-19', recurrence: { freq: 'weekly', interval: 1, byWeekday: [4] } });
    const before = toasts().length;
    setRecurrence(id, { freq: 'daily', interval: 1 });
    expect(toasts()).toHaveLength(before);
  });

  it('a one-time task ignores `start` (it repeats from its own date)', () => {
    const id = createTask({ title: 'Once', date: '2026-11-25' });
    setRecurrence(id, { freq: 'weekly', interval: 1 }, { start: '2026-12-02' });
    expect(task(id).date).toBe('2026-11-25');
  });
});

describe('B6: the date picker can time every repeat', () => {
  it('setSeriesTime on a series toasts with Undo', () => {
    const id = createTask({ title: 'Gym', date: TODAY, recurrence: { freq: 'daily', interval: 1 } });
    setSeriesTime(id, '07:00');
    expect(toasts().at(-1)).toBe('Every repeat is at 7:00 AM now');
    toastAction('Every repeat')();
    expect(task(id).time).toBeNull();
  });
});
