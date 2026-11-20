import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/types';
import { DELETE_FIELD } from '@/data/repo';
import {
  applyOps,
  applyTaskPatch,
  cleanTitle,
  deepEqual,
  diffTask,
  mergeSettings,
  normalizeSettings,
  normalizeTask,
  normalizeUserDoc,
  sanitizeTask,
  serializeTask,
} from '@/data/taskDoc';
import { syncErrorReason } from '@/data/errors';
import { authErrorMessage } from '@/data/auth';

function base(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Task',
    date: '2026-11-19',
    endDate: null,
    time: null,
    order: 'a0',
    done: false,
    doneAt: null,
    recurrence: null,
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('normalizeTask', () => {
  it('fills defaults for partial / legacy documents', () => {
    const t = normalizeTask({ title: 'Legacy', date: '2026-11-19', updatedAt: { toMillis: () => 42 } }, 'x');
    expect(t).toEqual({
      id: 'x',
      title: 'Legacy',
      date: '2026-11-19',
      endDate: null,
      time: null,
      order: 'a0',
      done: false,
      doneAt: null,
      recurrence: null,
      overrides: {},
      reminder: { kind: 'default' },
      remindAt: null,
      createdAt: 42,
      updatedAt: 42,
    });
    expect(normalizeTask(null, 'x')).toBeNull();
    expect(normalizeTask('nope', 'x')).toBeNull();
  });

  it('repairs invalid fields and enforces invariants', () => {
    const t = normalizeTask(
      {
        title: 5,
        date: '2026-02-30',
        endDate: '2026-03-01',
        time: '25:00',
        done: 'yes',
        reminder: { kind: 'at', time: 'bad' },
        overrides: { '2026-11-19': { done: true, junk: 1 }, 'not-a-date': { done: true }, '2026-11-20': 'x' },
      },
      'y',
    );
    expect(t).toMatchObject({ title: '', date: null, endDate: null, time: null, done: false, reminder: { kind: 'default' } });
    expect(t?.overrides).toEqual({ '2026-11-19': { done: true } });
  });

  it('normalizes recurrence and drops endDate / top-level done on recurring docs', () => {
    const t = normalizeTask(
      { title: 'r', date: '2026-11-19', endDate: '2026-11-22', done: true, doneAt: 5, recurrence: { freq: 'weekly' } },
      'r',
    );
    expect(t).toMatchObject({
      endDate: null,
      done: false,
      doneAt: null,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [4], until: null, count: null },
    });
  });
});

describe('sanitizeTask', () => {
  it('returns the same object when already valid', () => {
    const t = base();
    expect(sanitizeTask(t)).toBe(t);
  });

  it('clears date-dependent fields for Inbox tasks and overrides for one-time tasks', () => {
    const t = sanitizeTask(base({ date: null, endDate: '2026-11-20', time: '09:00', recurrence: { freq: 'daily', interval: 1 } }));
    expect(t).toMatchObject({ date: null, endDate: null, time: null, recurrence: null });
    const u = sanitizeTask(base({ overrides: { '2026-11-19': { done: true } } }));
    expect(u.overrides).toEqual({});
    const v = sanitizeTask(base({ endDate: '2026-11-19' }));
    expect(v.endDate).toBeNull();
    const w = sanitizeTask(base({ done: false, doneAt: 9 }));
    expect(w.doneAt).toBeNull();
  });

  it('drops empty override entries on recurring tasks', () => {
    const t = sanitizeTask(
      base({ recurrence: { freq: 'daily', interval: 1, byWeekday: null, until: null, count: null }, overrides: { '2026-11-20': {} } }),
    );
    expect(t.overrides).toEqual({});
  });
});

describe('diffTask / applyTaskPatch', () => {
  it('produces minimal field and override patches that round-trip', () => {
    const rec = { freq: 'daily' as const, interval: 1, byWeekday: null, until: null, count: null };
    const prev = base({ recurrence: rec, overrides: { '2026-11-20': { done: true, doneAt: 3 }, '2026-11-21': { skipped: true } } });
    const next = base({
      title: 'Renamed',
      recurrence: rec,
      overrides: { '2026-11-20': { done: true, time: null }, '2026-11-22': { date: '2026-11-25' } },
    });
    const patch = diffTask(prev, next);
    expect(patch).toEqual({
      fields: { title: 'Renamed' },
      overrides: {
        '2026-11-20': { doneAt: DELETE_FIELD, time: null },
        '2026-11-21': null,
        '2026-11-22': { date: '2026-11-25' },
      },
    });
    const applied = applyTaskPatch(prev, patch!, 99);
    expect(applied.updatedAt).toBe(99);
    expect(deepEqual({ ...applied, updatedAt: 1 }, next)).toBe(true);
  });

  it('returns null for equal tasks and ignores updatedAt/createdAt', () => {
    expect(diffTask(base(), base({ updatedAt: 5, createdAt: 7 }))).toBeNull();
  });
});

describe('applyOps', () => {
  it('keeps identity of untouched tasks and of the record when nothing applies', () => {
    const a = base({ id: 'a' });
    const b = base({ id: 'b' });
    const rec = { a, b };
    expect(applyOps(rec, [{ type: 'update', id: 'zzz', patch: { fields: { title: 'x' } } }], 1)).toBe(rec);
    expect(applyOps(rec, [{ type: 'delete', id: 'zzz' }], 1)).toBe(rec);
    const next = applyOps(rec, [{ type: 'update', id: 'a', patch: { fields: { title: 'x' } } }], 2);
    expect(next).not.toBe(rec);
    expect(next.b).toBe(b);
    expect(next.a?.title).toBe('x');
    const created = applyOps(next, [{ type: 'set', task: base({ id: 'c' }) }, { type: 'delete', id: 'a' }], 3);
    expect(Object.keys(created).sort()).toEqual(['b', 'c']);
  });
});

describe('settings', () => {
  it('normalizes and deep-merges', () => {
    const s = normalizeSettings({ weekStart: 0, summary: { time: '07:00' } }, 'Europe/Paris');
    expect(s).toEqual({ weekStart: 0, summary: { enabled: true, time: '07:00' }, timezone: 'Europe/Paris' });
    const m = mergeSettings(s, { summary: { enabled: false } as never, timezone: 'Asia/Tokyo' });
    expect(m).toEqual({ weekStart: 0, summary: { enabled: false, time: '07:00' }, timezone: 'Asia/Tokyo' });
    expect(normalizeUserDoc(null)).toBeNull();
    expect(normalizeUserDoc({ summaryAt: 5 })?.summaryAt).toBe(5);
  });
});

describe('misc helpers', () => {
  it('cleanTitle trims, single-lines and caps without splitting surrogate pairs', () => {
    expect(cleanTitle('  a\nb\r\nc  ')).toBe('a b c');
    const emoji = `${'x'.repeat(499)}😀`;
    expect(cleanTitle(emoji)).toBe('x'.repeat(499));
    expect(cleanTitle(42)).toBe('');
  });

  it('serializeTask never contains undefined', () => {
    const t = serializeTask(base({ recurrence: { freq: 'weekly', interval: 2 }, overrides: { '2026-11-19': { done: undefined, skipped: true } } }));
    const walk = (v: unknown): void => {
      expect(v).not.toBeUndefined();
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(t);
    expect(t.recurrence).toEqual({ freq: 'weekly', interval: 2, byWeekday: null, until: null, count: null });
  });

  it('friendly error reasons', () => {
    expect(syncErrorReason({ code: 'permission-denied' })).toBe('permission denied');
    expect(syncErrorReason(new Error('FirebaseError: Boom (x)'))).toBe('Boom');
    expect(syncErrorReason(42)).toBe('unknown error');
    expect(authErrorMessage({ code: 'auth/invalid-credential' })).toBe('Incorrect email or password.');
    expect(authErrorMessage({ code: 'auth/email-already-in-use' })).toMatch(/already exists/);
    expect(authErrorMessage({ code: 'auth/something-new' })).toBe('Something went wrong. Try again.');
  });
});
