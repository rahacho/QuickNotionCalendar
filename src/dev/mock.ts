/** Dev-only mock data for the gallery (no store dependency). */
import type { ISODate, HM, Occurrence, Task } from '@shared/types';

let seq = 0;

export function mockOcc(
  title: string,
  opts: { date?: ISODate | null; endDate?: ISODate | null; time?: HM | null; recurring?: boolean; done?: boolean } = {},
): Occurrence {
  const id = `mock${++seq}`;
  const date = opts.date === undefined ? '2026-11-19' : opts.date;
  const endDate = opts.endDate ?? date;
  const task: Task = {
    id,
    title,
    date,
    endDate: opts.endDate ?? null,
    time: opts.time ?? null,
    order: 'a0',
    done: opts.done ?? false,
    doneAt: null,
    recurrence: opts.recurring ? { freq: 'weekly', interval: 1, byWeekday: [4] } : null,
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    key: opts.recurring ? `${id}@${date}` : id,
    taskId: id,
    origDate: opts.recurring ? date : null,
    date,
    endDate,
    time: opts.time ?? null,
    title,
    order: 'a0',
    done: opts.done ?? false,
    doneAt: null,
    recurring: !!opts.recurring,
    multiDay: !!opts.endDate && opts.endDate !== date,
    task,
  };
}
