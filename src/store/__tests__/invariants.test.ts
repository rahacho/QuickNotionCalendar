/**
 * Invariants behind the owner's goal — nothing planned is ever hidden, lost or silently changed.
 * Moved from the adversarial review's repros (lenses A and E):
 *  - random action sequences keep shared/types.ts invariants and an exact remindAt after EVERY action;
 *  - badge = Today + Overdue, and every open one-time task sits in exactly one list group;
 *  - every repeating series with an open occurrence ahead is listed;
 *  - malformed / legacy documents still show up somewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISODate, Recurrence, Task } from '@shared/types';
import { addDays } from '@shared/dates';
import { buildTaskGroups } from '@shared/grouping';
import { badgeCount, computeRemindAt } from '@shared/reminders';
import { inboxTasks, isOverdue, occurrencesInRange, occurrencesOfTask, singleOccurrence, taskDate, taskRule } from '@shared/occurrences';
import { normalizeTask } from '@/data/taskDoc';
import {
  createTask,
  createTasksFromText,
  deleteOccurrence,
  deleteTask,
  duplicateTask,
  moveAllOverdueToToday,
  moveOccurrence,
  renameTask,
  resizeTask,
  setDone,
  setRecurrence,
  setReminder,
  setSchedule,
  setSeriesStart,
  setSeriesTime,
  undo,
  updateSettings,
} from '@/store/actions';
import { useStore } from '@/store/store';
import { setup, tasks, teardownAll } from './helpers';

const NOW = new Date('2026-11-19T15:00:00Z').getTime();
const TODAY = '2026-11-19';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await setup();
});

afterEach(() => {
  teardownAll();
  vi.useRealTimers();
});

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}


function check(label: string, tz: string): string[] {
  const errs: string[] = [];
  for (const t of Object.values(useStore.getState().tasks) as Task[]) {
    if (t.date === null && (t.endDate !== null || t.time !== null || t.recurrence !== null)) errs.push(`${label}: dateless task has end/time/rule ${t.id}`);
    if (t.recurrence && t.endDate !== null) errs.push(`${label}: recurring with endDate ${t.id}`);
    if (t.recurrence && t.done) errs.push(`${label}: recurring done=true ${t.id}`);
    if (!t.recurrence && Object.keys(t.overrides).length > 0) errs.push(`${label}: one-time task with overrides ${t.id} ${JSON.stringify(t.overrides)}`);
    if (t.endDate !== null && t.date !== null && t.endDate <= t.date) errs.push(`${label}: endDate<=date ${t.id}`);
    const want = computeRemindAt(t, tz, NOW);
    if (want !== t.remindAt) errs.push(`${label}: remindAt ${t.remindAt} != ${want} for ${t.id} ${JSON.stringify({ d: t.date, tm: t.time, r: t.reminder, rec: t.recurrence, done: t.done })}`);
  }
  return errs;
}

describe('random action sequences keep every invariant (review A)', () => {
  it('hold across 40 random sequences × 60 actions', () => {
    const errors: string[] = [];
    for (let seq = 0; seq < 40; seq++) {
      // reset tasks between sequences
      for (const id of Object.keys(useStore.getState().tasks)) deleteTask(id);
      useStore.setState({ toasts: [] });
      const r = rng(1000 + seq);
      const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T;
      const days = Array.from({ length: 30 }, (_, i) => addDays('2026-11-05', i));
      const times = [null, '09:00', '10:00', '10:30', '23:59', '00:00'];
      const rules: Array<Recurrence | null> = [null, { freq: 'daily', interval: 1 }, { freq: 'weekly', interval: 1, byWeekday: [1, 4] }, { freq: 'monthly', interval: 1, count: 3 }, { freq: 'daily', interval: 2, until: '2026-11-25' }];
      for (let step = 0; step < 60; step++) {
        const tasks = Object.values(useStore.getState().tasks) as Task[];
        const t = tasks.length ? pick(tasks) : undefined;
        const occRef = (): { taskId: string; origDate: ISODate | null } | null => {
          if (!t) return null;
          if (!t.recurrence) return { taskId: t.id, origDate: null };
          const occs = occurrencesOfTask(t, '2026-10-01', '2027-01-31', true);
          const o = occs.length ? pick(occs) : null;
          return o ? { taskId: t.id, origDate: o.origDate } : null;
        };
        const a = Math.floor(r() * 19);
        let label = '';
        try {
          switch (a) {
            case 0:
            case 1:
              label = 'createTask';
              createTask({ title: 'T' + step, date: r() < 0.2 ? null : pick(days), time: pick(times), recurrence: pick(rules), endDate: r() < 0.2 ? pick(days) : null });
              break;
            case 2:
              label = 'paste';
              createTasksFromText('a\nb', r() < 0.5 ? null : pick(days));
              break;
            case 3: {
              label = 'move';
              const ref = occRef();
              if (ref) moveOccurrence(ref, r() < 0.15 ? null : pick(days));
              break;
            }
            case 4:
              label = 'resize';
              if (t) resizeTask(t.id, pick(days), pick(days));
              break;
            case 5: {
              label = 'setSchedule';
              const ref = occRef();
              if (ref) setSchedule(ref, { date: r() < 0.1 ? null : pick(days), time: pick(times), endDate: r() < 0.3 ? pick(days) : undefined });
              break;
            }
            case 6:
              label = 'seriesStart';
              if (t) setSeriesStart(t.id, pick(days));
              break;
            case 7: {
              label = 'done';
              const ref = occRef();
              if (ref) setDone(ref, r() < 0.7);
              break;
            }
            case 8: {
              label = 'deleteOcc';
              const ref = occRef();
              if (ref) deleteOccurrence(ref);
              break;
            }
            case 9:
              label = 'recurrence';
              if (t) setRecurrence(t.id, pick(rules));
              break;
            case 10:
              label = 'reminder';
              if (t) setReminder(t.id, pick([{ kind: 'default' }, { kind: 'none' }, { kind: 'offset', minutes: 30 }, { kind: 'at', time: '08:00', daysBefore: 1 }] as const));
              break;
            case 11:
              label = 'moveAll';
              moveAllOverdueToToday();
              break;
            case 12:
              label = 'dup';
              if (t) duplicateTask(t.id);
              break;
            case 13:
            case 14:
              label = 'undo';
              undo();
              break;
            case 15:
              label = 'tz';
              updateSettings({ timezone: pick(['America/New_York', 'Asia/Tokyo', 'Europe/London']) });
              break;
            case 16:
              label = 'rename';
              if (t) renameTask(t.id, 'R' + step);
              break;
            case 17:
              label = 'seriesTime';
              if (t) setSeriesTime(t.id, pick(times));
              break;
            case 18:
              label = 'recurrence+start';
              if (t) setRecurrence(t.id, pick(rules), { start: pick(days) });
              break;
          }
        } catch (e) {
          errors.push(`seq ${seq} step ${step} ${label} threw ${String(e)}`);
        }
        errors.push(...check(`seq ${seq} step ${step} ${label}`, useStore.getState().settings.timezone).slice(0, 2));
      }
    }
    expect(errors.slice(0, 15)).toEqual([]);
  });
});

describe('every planned task is surfaced (review E)', () => {
  it('badge == Today count + Overdue count; every open one-time task is in exactly one list group', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const list: Task[] = [];
      const n = 1 + Math.floor(r() * 25);
      for (let i = 0; i < n; i++) {
        const kind = r();
        const date: ISODate | null = kind < 0.1 ? null : addDays(TODAY, Math.floor(r() * 40) - 20);
        const multi = date && r() < 0.25 ? addDays(date, 1 + Math.floor(r() * 6)) : null;
        const rec: Recurrence | null =
          date && !multi && r() < 0.3 ? { freq: (['daily', 'weekly', 'monthly'] as const)[Math.floor(r() * 3)]!, interval: 1 + Math.floor(r() * 2) } : null;
        list.push({
          id: `t${i}`,
          title: `T${i}`,
          date,
          endDate: multi,
          time: r() < 0.3 ? '09:00' : null,
          order: `a${i}`,
          done: !rec && r() < 0.15,
          doneAt: null,
          recurrence: rec,
          overrides: {},
          reminder: { kind: 'default' },
          remindAt: null,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      const groups = buildTaskGroups(list, TODAY);
      const g = (id: string) => groups.find((x) => x.id === id);
      expect(badgeCount(list, TODAY), `seed ${seed}`).toBe((g('today')?.count ?? 0) + (g('overdue')?.count ?? 0));
      for (const t of list) {
        if (taskRule(t) !== null || taskDate(t) === null || t.done) continue;
        const hits = groups.filter((x) => x.id !== 'completed' && x.items.some((i) => i.occ.taskId === t.id));
        expect(hits.length, `seed ${seed} task ${t.id}`).toBe(1);
      }
      expect(inboxTasks(list).length).toBe(list.filter((t) => t.date === null && !t.done).length);
    }
  });

  it('"Move all to today" moves every overdue one-time task (multi-day + timed), one undo restores all', () => {
    createTask({ title: 'a', date: '2026-11-01' });
    createTask({ title: 'b', date: '2026-11-10', endDate: '2026-11-12' });
    createTask({ title: 'c', date: '2026-11-18', time: '17:00' });
    createTask({ title: 'd', date: '2025-01-01' });
    createTask({ title: 'r', date: '2026-11-01', recurrence: { freq: 'daily', interval: 1 } });
    moveAllOverdueToToday();
    const all = Object.values(tasks());
    expect(all.filter((t) => isOverdue(singleOccurrence(t), TODAY) && !t.recurrence)).toEqual([]);
    expect(occurrencesInRange(all, TODAY, TODAY).map((o) => o.title).sort()).toEqual(['a', 'b', 'c', 'd', 'r']);
    undo();
    const back = Object.values(tasks()).filter((t) => !t.recurrence && isOverdue(singleOccurrence(t), TODAY));
    expect(back.length).toBe(4);
    expect(useStore.getState().today).toBe(TODAY);
  });
});

describe('every repeating series with an open occurrence ahead is listed (review E)', () => {
  it('series with an open occurrence on/after today appears in Today/day/Later', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 7919);
      const start = addDays(TODAY, Math.floor(r() * 60) - 40);
      const freq = (['daily', 'weekly', 'monthly', 'yearly'] as const)[Math.floor(r() * 4)]!;
      const rule: Recurrence = { freq, interval: 1 + Math.floor(r() * 3), count: r() < 0.3 ? 1 + Math.floor(r() * 6) : null };
      const t: Task = {
        id: 's', title: 'S', date: start, endDate: null, time: null, order: 'a0', done: false, doneAt: null,
        recurrence: rule, overrides: {}, reminder: { kind: 'default' }, remindAt: null, createdAt: 0, updatedAt: 0,
      };
      const rawDates = occurrencesOfTask(t, start, addDays(TODAY, 800), true).map((o) => o.origDate as string);
      for (const d of rawDates) {
        const x = r();
        if (x < 0.15) t.overrides[d] = { skipped: true };
        else if (x < 0.35) t.overrides[d] = { done: true, doneAt: 1 };
        else if (x < 0.5) t.overrides[d] = { date: addDays(d, Math.floor(r() * 30) - 15) };
      }
      const open = occurrencesOfTask(t, TODAY, addDays(TODAY, 800), false);
      const groups = buildTaskGroups([t], TODAY);
      const listed = groups.some((g) => g.id !== 'completed' && g.items.length > 0);
      if (open.length > 0) expect(listed, `seed ${seed} ${JSON.stringify(rule)} start ${start} ${JSON.stringify(t.overrides)}`).toBe(true);
    }
  });
});

describe('malformed / legacy documents are never hidden (review E)', () => {
  it('each odd document shows up in the Inbox, a list group, or on the calendar around its date', () => {
    const docs: Record<string, unknown> = {
      badDate: { title: 'Bad date', date: '2026-11-5' },
      tsDate: { title: 'Timestamp date', date: { seconds: 1, nanoseconds: 0 } },
      noTitle: { date: '2026-11-20' },
      numTitle: { title: 12345, date: '2026-11-20' },
      badRule: { title: 'Bad rule', date: '2026-11-19', recurrence: { freq: 'WEEKLY', interval: '2', byWeekday: ['MO'] } },
      badUntil: { title: 'Bad until', date: '2026-11-19', recurrence: { freq: 'daily', interval: 1, until: '2026-13-01' } },
      doneRec: { title: 'Done flag on series', date: '2026-11-19', done: true, recurrence: { freq: 'daily', interval: 1 } },
      endBefore: { title: 'End before start', date: '2026-11-21', endDate: '2026-11-20' },
      badTime: { title: 'Bad time', date: '2026-11-19', time: '9:00' },
      strDone: { title: 'String done', date: '2026-11-18', done: 'false' },
      badOverrides: { title: 'Bad overrides', date: '2026-11-19', recurrence: { freq: 'daily', interval: 1 }, overrides: { '2026-11-19': 'x', nope: { done: true } } },
      emptyDoc: {},
    };
    const all = Object.entries(docs).map(([id, raw]) => normalizeTask(raw, id)).filter((t): t is Task => t !== null);
    expect(all.length).toBe(Object.keys(docs).length);
    const groups = buildTaskGroups(all, TODAY);
    const listed = new Set(groups.flatMap((g) => g.items.map((i) => i.occ.taskId)));
    const inInbox = new Set(inboxTasks(all).map((t) => t.id));
    const onCal = new Set(occurrencesInRange(all, '2026-10-01', '2027-01-31').map((o) => o.taskId));
    const hidden = all.filter((t) => !listed.has(t.id) && !inInbox.has(t.id) && !onCal.has(t.id)).map((t) => t.id);
    expect(hidden).toEqual([]);
  });
});
