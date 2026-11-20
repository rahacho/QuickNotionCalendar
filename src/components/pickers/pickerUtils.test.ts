// @vitest-environment jsdom
/**
 * Repeat changes must never silently remove planned occurrences (review B2): a monthly/yearly anchor
 * moves the series start only as far as needed, and a later daily/weekly choice puts it back.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ISODate, Recurrence, Task } from '@shared/types';
import { getOccurrence, occurrencesInRange } from '@shared/occurrences';
import { createTask, setDone, setRecurrence, setSeriesStart, undo } from '@/store/actions';
import { undoDepth } from '@/store/undo';
import { useStore } from '@/store/store';
import { setup, task, teardownAll } from '@/store/__tests__/helpers';
import { anchoredStart, applyRepeat, matchPreset, repeatPresets, resetRepeatMemory } from './pickerUtils';

vi.mock('@/data/env', () => ({ firebaseConfigured: false, firebaseOptions: {} }));

afterEach(() => {
  teardownAll();
  resetRepeatMemory();
  vi.restoreAllMocks();
});

const WEEKLY_THU: Recurrence = { freq: 'weekly', interval: 1, byWeekday: [4] };

const dates = (id: string, from: ISODate, to: ISODate): Array<ISODate | null> =>
  occurrencesInRange([task(id)], from, to).map((o) => o.date);

function peekAt(id: string, origDate: ISODate | null): void {
  useStore.setState({ ui: { ...useStore.getState().ui, peek: { taskId: id, origDate } } });
}

function preset(base: ISODate, id: string): Recurrence | null {
  const p = repeatPresets(base).find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p.rule;
}

function view(id: string, date: ISODate) {
  const occ = getOccurrence(task(id), date);
  if (!occ) throw new Error(`no occurrence on ${date}`);
  return occ;
}

describe('anchoredStart', () => {
  it('walks back on the cycle to the first matching day not before the bound', () => {
    expect(anchoredStart('monthly', 1, '2027-03-03', '2026-11-19')).toBe('2026-12-03');
    expect(anchoredStart('monthly', 2, '2027-03-03', '2026-11-19')).toBe('2027-01-03');
    expect(anchoredStart('yearly', 1, '2028-03-03', '2026-11-19')).toBe('2027-03-03');
  });

  it('skips months without that day (31st) and keeps a past base as is', () => {
    expect(anchoredStart('monthly', 1, '2027-03-31', '2027-01-15')).toBe('2027-01-31');
    expect(anchoredStart('monthly', 1, '2027-03-31', '2027-02-10')).toBe('2027-03-31');
    expect(anchoredStart('monthly', 1, '2026-11-12', '2026-11-19')).toBe('2026-11-12');
    expect(anchoredStart('monthly', 1, '2026-11-19', '2026-11-19')).toBe('2026-11-19');
  });
});

describe('applyRepeat keeps planned occurrences', () => {
  it('monthly preset, then weekly preset (two separate menu visits) restores the series', async () => {
    await setup();
    const id = createTask({ title: 'Team sync', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2026-12-03');
    applyRepeat(view(id, '2026-12-03'), preset('2026-12-03', 'monthly'), '2026-12-03');
    expect(task(id).recurrence?.freq).toBe('monthly');
    expect(task(id).date).toBe('2026-12-03');
    applyRepeat(view(id, '2026-12-03'), preset('2026-12-03', 'weekly'), '2026-12-03');
    expect(task(id).date).toBe('2026-11-05');
    expect(task(id).recurrence).toMatchObject(WEEKLY_THU);
    expect(dates(id, '2026-11-19', '2026-11-26')).toEqual(['2026-11-19', '2026-11-26']);
    expect(useStore.getState().ui.peek).toEqual({ taskId: id, origDate: '2026-12-03' });
  });

  it('custom unit round trip (weeks → months → weeks) leaves the series start unchanged', async () => {
    await setup();
    const id = createTask({ title: 'Team sync', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2026-12-03');
    const weekly: Recurrence = { ...WEEKLY_THU, until: null, count: null };
    applyRepeat(view(id, '2026-12-03'), { ...weekly, freq: 'monthly', byWeekday: null }, '2026-12-03');
    applyRepeat(getOccurrence(task(id), '2026-12-03') ?? view(id, '2026-12-03'), weekly, '2026-12-03');
    expect(task(id).date).toBe('2026-11-05');
    expect(dates(id, '2026-11-05', '2026-11-26')).toEqual(['2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26']);
  });

  it('a monthly anchor chosen on a far occurrence moves the start no further than needed', async () => {
    await setup();
    const id = createTask({ title: 'Pay rent', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2027-03-04');
    applyRepeat(view(id, '2027-03-04'), preset('2027-03-04', 'monthly'), '2027-03-04');
    expect(task(id).date).toBe('2026-12-04');
    expect(dates(id, '2026-11-19', '2027-03-04')).toEqual(['2026-12-04', '2027-01-04', '2027-02-04', '2027-03-04']);
    expect(matchPreset(task(id), '2027-03-04')).toBe('monthly');
    expect(useStore.getState().ui.peek).toEqual({ taskId: id, origDate: '2027-03-04' });
  });

  it('choosing monthly on today’s occurrence keeps today’s occurrence', async () => {
    await setup();
    const id = createTask({ title: 'Water plants', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2026-11-19');
    applyRepeat(view(id, '2026-11-19'), preset('2026-11-19', 'monthly'), '2026-11-19');
    expect(task(id).date).toBe('2026-11-19');
    expect(dates(id, '2026-11-19', '2026-11-19')).toEqual(['2026-11-19']);
  });

  it('a yearly anchor on a future occurrence, then daily, restores the original start', async () => {
    await setup();
    const id = createTask({ title: 'Stretch', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2027-03-04');
    applyRepeat(view(id, '2027-03-04'), preset('2027-03-04', 'yearly'), '2027-03-04');
    expect(task(id).date).toBe('2027-03-04');
    applyRepeat(view(id, '2027-03-04'), preset('2027-03-04', 'daily'), '2027-03-04');
    expect(task(id).date).toBe('2026-11-05');
    expect(dates(id, '2026-11-19', '2026-11-20')).toEqual(['2026-11-19', '2026-11-20']);
  });

  it('a series start that moved some other way is never "restored"', async () => {
    await setup();
    const id = createTask({ title: 'Team sync', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2026-12-03');
    applyRepeat(view(id, '2026-12-03'), preset('2026-12-03', 'monthly'), '2026-12-03');
    setSeriesStart(id, '2027-01-03');
    applyRepeat(view(id, '2027-01-03'), { freq: 'weekly', interval: 1, byWeekday: [0] }, '2027-01-03');
    expect(task(id).date).toBe('2027-01-03');
  });

  it('Repeat → Never forgets the move, so a later rule never drags the one-time task back', async () => {
    await setup();
    const id = createTask({ title: 'Team sync', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2026-12-03');
    applyRepeat(view(id, '2026-12-03'), preset('2026-12-03', 'monthly'), '2026-12-03');
    applyRepeat(view(id, '2026-12-03'), null, '2026-12-03');
    const oneTime: Task = task(id);
    expect(oneTime.recurrence).toBeNull();
    const date = oneTime.date as ISODate;
    applyRepeat(view(id, date), preset(date, 'weekly'), date);
    expect(task(id).date).toBe(date);
  });

  it('daily/weekly choices on an untouched series never move its start', async () => {
    await setup();
    const id = createTask({ title: 'Later series', date: '2026-12-10', recurrence: WEEKLY_THU });
    peekAt(id, '2026-12-17');
    applyRepeat(view(id, '2026-12-17'), preset('2026-12-17', 'daily'), '2026-12-17');
    expect(task(id).date).toBe('2026-12-10');
    setRecurrence(id, WEEKLY_THU);
    expect(task(id).date).toBe('2026-12-10');
  });

  it('a monthly anchor that moves the start is ONE undo step (and ⌘Z restores the weekly series)', async () => {
    await setup();
    const id = createTask({ title: 'Team sync', date: '2026-11-05', recurrence: WEEKLY_THU });
    peekAt(id, '2026-12-03');
    const depth = undoDepth();
    applyRepeat(view(id, '2026-12-03'), preset('2026-12-03', 'monthly'), '2026-12-03');
    expect(task(id).date).toBe('2026-12-03');
    expect(undoDepth()).toBe(depth + 1);
    undo();
    expect(task(id).date).toBe('2026-11-05');
    expect(dates(id, '2026-11-19', '2026-11-26')).toEqual(['2026-11-19', '2026-11-26']);
  });
});

describe('applyRepeat → Never keeps the occurrence being viewed (B1)', () => {
  it('Never on next week’s open card makes the one-time task that card', async () => {
    await setup();
    const id = createTask({ title: 'Gym', date: '2026-11-19', recurrence: { freq: 'daily', interval: 1 } });
    peekAt(id, '2026-11-26');
    applyRepeat(view(id, '2026-11-26'), null, '2026-11-26');
    expect(task(id)).toMatchObject({ recurrence: null, date: '2026-11-26', done: false });
    expect(useStore.getState().ui.peek).toEqual({ taskId: id, origDate: null });
  });

  it('Never on tomorrow’s open card after today’s was checked off keeps an OPEN task', async () => {
    await setup();
    const id = createTask({ title: 'Gym', date: '2026-11-19', recurrence: { freq: 'daily', interval: 1 } });
    setDone({ taskId: id, origDate: '2026-11-19' }, true);
    applyRepeat(view(id, '2026-11-20'), null, '2026-11-20');
    expect(task(id)).toMatchObject({ date: '2026-11-20', done: false });
  });
});
