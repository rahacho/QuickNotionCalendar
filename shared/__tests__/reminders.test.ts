import { TZDate, tzScan } from '@date-fns/tz';
import { describe, expect, it } from 'vitest';
import {
  badgeCount,
  computeRemindAt,
  nextReminder,
  nextSummaryAt,
  reminderInstantFor,
  repairedRemindAt,
  summaryText,
  zonedInstant,
  zonedToday,
} from '../reminders';
import { addDays, minutesToHM } from '../dates';
import { occurrencesInRange } from '../occurrences';
import { DEFAULT_SETTINGS, type Settings, type Task } from '../types';
import { mkTask, randInt, randomDate, rng, rule } from './helpers';

const Z = (s: string) => Date.parse(s);
const NY = 'America/New_York';

describe('zonedInstant', () => {
  it('converts plain wall-clock times', () => {
    expect(zonedInstant('2026-11-19', '09:00', 'UTC')).toBe(Z('2026-11-19T09:00:00Z'));
    expect(zonedInstant('2026-11-19', '09:00', NY)).toBe(Z('2026-11-19T14:00:00Z')); // EST
    expect(zonedInstant('2026-07-04', '09:00', NY)).toBe(Z('2026-07-04T13:00:00Z')); // EDT
    expect(zonedInstant('2026-11-19', '09:00', 'Asia/Kolkata')).toBe(Z('2026-11-19T03:30:00Z'));
    expect(zonedInstant('2026-11-19', '09:00', 'Asia/Kathmandu')).toBe(Z('2026-11-19T03:15:00Z'));
    expect(zonedInstant('2026-11-19', '00:00', 'Pacific/Kiritimati')).toBe(Z('2026-11-18T10:00:00Z'));
    expect(zonedInstant('2026-11-19', '23:59', 'Pacific/Pago_Pago')).toBe(Z('2026-11-20T10:59:00Z'));
  });

  it('America/New_York spring forward 2026-03-08: gap times shift forward', () => {
    expect(zonedInstant('2026-03-08', '01:59', NY)).toBe(Z('2026-03-08T06:59:00Z')); // EST
    expect(zonedInstant('2026-03-08', '02:00', NY)).toBe(Z('2026-03-08T07:00:00Z')); // = 03:00 EDT
    expect(zonedInstant('2026-03-08', '02:30', NY)).toBe(Z('2026-03-08T07:30:00Z')); // = 03:30 EDT
    expect(zonedInstant('2026-03-08', '02:59', NY)).toBe(Z('2026-03-08T07:59:00Z'));
    expect(zonedInstant('2026-03-08', '03:00', NY)).toBe(Z('2026-03-08T07:00:00Z')); // EDT
    expect(zonedInstant('2026-03-08', '08:00', NY)).toBe(Z('2026-03-08T12:00:00Z'));
    expect(zonedInstant('2026-03-07', '08:00', NY)).toBe(Z('2026-03-07T13:00:00Z'));
  });

  it('America/New_York fall back 2026-11-01: overlap picks the earlier instant', () => {
    expect(zonedInstant('2026-11-01', '00:30', NY)).toBe(Z('2026-11-01T04:30:00Z')); // EDT
    expect(zonedInstant('2026-11-01', '01:00', NY)).toBe(Z('2026-11-01T05:00:00Z')); // EDT (not 06:00Z)
    expect(zonedInstant('2026-11-01', '01:30', NY)).toBe(Z('2026-11-01T05:30:00Z')); // EDT (not 06:30Z)
    expect(zonedInstant('2026-11-01', '01:59', NY)).toBe(Z('2026-11-01T05:59:00Z'));
    expect(zonedInstant('2026-11-01', '02:00', NY)).toBe(Z('2026-11-01T07:00:00Z')); // EST
    expect(zonedInstant('2026-11-01', '08:00', NY)).toBe(Z('2026-11-01T13:00:00Z'));
  });

  it('other zones: London, Sydney (southern hemisphere), Lord Howe (30-minute DST)', () => {
    expect(zonedInstant('2026-03-29', '01:30', 'Europe/London')).toBe(Z('2026-03-29T01:30:00Z')); // gap → 02:30 BST
    expect(zonedInstant('2026-10-25', '01:30', 'Europe/London')).toBe(Z('2026-10-25T00:30:00Z')); // overlap → BST
    expect(zonedInstant('2026-10-04', '02:30', 'Australia/Sydney')).toBe(Z('2026-10-03T16:30:00Z')); // gap → 03:30 AEDT
    expect(zonedInstant('2026-04-05', '02:30', 'Australia/Sydney')).toBe(Z('2026-04-04T15:30:00Z')); // overlap → AEDT
    expect(zonedInstant('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBe(Z('2026-10-03T15:45:00Z')); // → 02:45 LHDT
    expect(zonedInstant('2026-04-05', '01:45', 'Australia/Lord_Howe')).toBe(Z('2026-04-04T14:45:00Z')); // overlap → +11
  });

  it('falls back to UTC for an unknown zone and validates inputs', () => {
    expect(zonedInstant('2026-11-19', '09:00', 'Mars/Olympus')).toBe(Z('2026-11-19T09:00:00Z'));
    expect(zonedInstant('2026-11-19', '09:00', '')).toBe(Z('2026-11-19T09:00:00Z'));
    expect(() => zonedInstant('2026-02-30', '09:00', NY)).toThrow(RangeError);
    expect(() => zonedInstant('2026-11-19', '9:00', NY)).toThrow(RangeError);
  });

  it('property: the wall clock of the result reads the requested time except inside DST gaps', () => {
    const zones = [NY, 'Europe/London', 'Australia/Sydney', 'Australia/Lord_Howe', 'Asia/Tokyo', 'America/Sao_Paulo', 'UTC'];
    const r = rng(404);
    for (let i = 0; i < 1500; i++) {
      const tz = zones[randInt(r, 0, zones.length - 1)]!;
      const date = randomDate(r, 2025, 2027);
      const time = minutesToHM(randInt(r, 0, 1439));
      const at = zonedInstant(date, time, tz);
      const w = new TZDate(at, tz);
      const wallDate = `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}`;
      const wallTime = `${String(w.getHours()).padStart(2, '0')}:${String(w.getMinutes()).padStart(2, '0')}`;
      if (wallDate === date && wallTime === time) continue;
      // Must be a spring-forward gap: a positive offset change within a day of the instant.
      const changes = tzScan(tz, { start: new Date(at - 86_400_000), end: new Date(at + 86_400_000) });
      expect(changes.some((c) => c.change > 0), `${tz} ${date} ${time}`).toBe(true);
    }
  });

  it('agrees with TZDate away from transitions', () => {
    const r = rng(405);
    for (let i = 0; i < 300; i++) {
      const tz = ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata', 'Australia/Adelaide'][randInt(r, 0, 3)]!;
      const y = randInt(r, 2024, 2028);
      const m = [1, 7][randInt(r, 0, 1)]!;
      const d = randInt(r, 1, 28);
      const h = randInt(r, 0, 23);
      const mi = randInt(r, 0, 59);
      const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      expect(zonedInstant(date, minutesToHM(h * 60 + mi), tz)).toBe(+new TZDate(y, m - 1, d, h, mi, tz));
    }
  });
});

describe('zonedToday', () => {
  it('reads the wall date in the zone', () => {
    const t = Z('2026-11-19T04:30:00Z');
    expect(zonedToday(t, 'UTC')).toBe('2026-11-19');
    expect(zonedToday(t, NY)).toBe('2026-11-18');
    expect(zonedToday(t, 'Asia/Tokyo')).toBe('2026-11-19');
    expect(zonedToday(Z('2026-11-19T10:00:00Z'), 'Pacific/Kiritimati')).toBe('2026-11-20');
    expect(zonedToday(Z('2026-11-19T09:59:59Z'), 'Pacific/Kiritimati')).toBe('2026-11-19');
    expect(zonedToday(Z('2026-11-01T04:59:00Z'), NY)).toBe('2026-11-01');
    expect(zonedToday(Z('2026-11-01T03:59:00Z'), NY)).toBe('2026-10-31');
    expect(zonedToday(t, 'Nope/Zone')).toBe('2026-11-19');
  });

  it('round-trips with zonedInstant', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const tz = [NY, 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'][randInt(r, 0, 3)]!;
      const date = randomDate(r, 2025, 2027);
      expect(zonedToday(zonedInstant(date, '12:00', tz), tz)).toBe(date);
    }
  });
});

describe('reminderInstantFor', () => {
  const timed = { date: '2026-11-19', time: '15:00' };
  const untimed = { date: '2026-11-19', time: null };
  it('default: at the time for timed, null for untimed', () => {
    expect(reminderInstantFor(timed, { kind: 'default' }, NY)).toBe(Z('2026-11-19T20:00:00Z'));
    expect(reminderInstantFor(untimed, { kind: 'default' }, NY)).toBeNull();
  });
  it('none → null', () => {
    expect(reminderInstantFor(timed, { kind: 'none' }, NY)).toBeNull();
  });
  it('offset: minutes before (untimed behaves like default)', () => {
    expect(reminderInstantFor(timed, { kind: 'offset', minutes: 10 }, NY)).toBe(Z('2026-11-19T19:50:00Z'));
    expect(reminderInstantFor(timed, { kind: 'offset', minutes: 1440 }, NY)).toBe(Z('2026-11-18T20:00:00Z'));
    expect(reminderInstantFor(timed, { kind: 'offset', minutes: -5 }, NY)).toBe(Z('2026-11-19T20:05:00Z'));
    expect(reminderInstantFor(untimed, { kind: 'offset', minutes: 10 }, NY)).toBeNull();
  });
  it('at: clock time N days before (works for untimed)', () => {
    expect(reminderInstantFor(untimed, { kind: 'at', time: '09:00', daysBefore: 0 }, NY)).toBe(Z('2026-11-19T14:00:00Z'));
    expect(reminderInstantFor(timed, { kind: 'at', time: '09:00', daysBefore: 1 }, NY)).toBe(Z('2026-11-18T14:00:00Z'));
    // across DST: Nov 2 09:00 EST, one day before = Nov 1 09:00 EST
    expect(reminderInstantFor({ date: '2026-11-02', time: null }, { kind: 'at', time: '09:00', daysBefore: 1 }, NY)).toBe(
      Z('2026-11-01T14:00:00Z'),
    );
    expect(reminderInstantFor(untimed, { kind: 'at', time: 'nope', daysBefore: 0 }, NY)).toBeNull();
    expect(reminderInstantFor(untimed, { kind: 'at', time: '09:00', daysBefore: -3 }, NY)).toBe(Z('2026-11-19T14:00:00Z'));
  });
  it('clamps absurd parameters instead of throwing', () => {
    expect(reminderInstantFor(untimed, { kind: 'at', time: '09:00', daysBefore: 1e12 }, NY)).toBe(
      zonedInstant(addDays('2026-11-19', -3660), '09:00', NY), // clamped to 3660 days before
    );
    expect(reminderInstantFor(timed, { kind: 'offset', minutes: Number.NaN }, NY)).toBe(Z('2026-11-19T20:00:00Z'));
    expect(() => reminderInstantFor(timed, { kind: 'offset', minutes: -1e15 }, NY)).not.toThrow();
    const t = mkTask({ id: 'z', date: '2026-11-01', time: '09:00', recurrence: rule('daily'), reminder: { kind: 'offset', minutes: -1e15 } });
    expect(() => nextReminder(t, NY, Z('2026-11-19T15:00:00Z'))).not.toThrow();
    expect(() => zonedToday(Number.NaN, NY)).toThrow(RangeError);
  });

  it('DST: a 02:30 task on spring-forward day alerts at 03:30 EDT', () => {
    expect(reminderInstantFor({ date: '2026-03-08', time: '02:30' }, { kind: 'default' }, NY)).toBe(Z('2026-03-08T07:30:00Z'));
  });
});

describe('nextReminder / computeRemindAt', () => {
  const now = Z('2026-11-19T15:00:00Z'); // 10:00 EST

  it('non-recurring: future instant, else null; done/Inbox/none → null', () => {
    const t = mkTask({ id: 'a', date: '2026-11-19', time: '15:00' });
    expect(nextReminder(t, NY, now)).toEqual({ at: Z('2026-11-19T20:00:00Z'), origDate: null, occDate: '2026-11-19' });
    expect(computeRemindAt(t, NY, now)).toBe(Z('2026-11-19T20:00:00Z'));
    expect(nextReminder({ ...t, time: '09:00' }, NY, now)).toBeNull();
    expect(nextReminder({ ...t, done: true }, NY, now)).toBeNull();
    expect(nextReminder({ ...t, reminder: { kind: 'none' } }, NY, now)).toBeNull();
    expect(nextReminder(mkTask({ id: 'i', time: '15:00' }), NY, now)).toBeNull();
    expect(nextReminder(mkTask({ id: 'u', date: '2026-11-20' }), NY, now)).toBeNull(); // untimed default
    expect(computeRemindAt(mkTask({ id: 'u', date: '2026-11-20' }), NY, now)).toBeNull();
  });

  it('strictly after afterMs', () => {
    const t = mkTask({ id: 'a', date: '2026-11-19', time: '10:00' });
    expect(nextReminder(t, NY, now)).toBeNull(); // exactly now → not > now
    expect(nextReminder(t, NY, now - 1)?.at).toBe(now);
  });

  it('untimed task with an "at" reminder', () => {
    const t = mkTask({ id: 'a', date: '2026-11-21', reminder: { kind: 'at', time: '09:00', daysBefore: 1 } });
    expect(nextReminder(t, NY, now)).toEqual({ at: Z('2026-11-20T14:00:00Z'), origDate: null, occDate: '2026-11-21' });
  });

  it('multi-day: relative to the start date', () => {
    const t = mkTask({ id: 'm', date: '2026-11-20', endDate: '2026-11-23', time: '08:00' });
    expect(nextReminder(t, NY, now)?.at).toBe(Z('2026-11-20T13:00:00Z'));
  });

  it('recurring: next not-done, not-skipped occurrence (with moves and time overrides)', () => {
    const t = mkTask({
      id: 'r',
      date: '2026-11-01',
      time: '09:00',
      recurrence: rule('daily'),
      overrides: {
        '2026-11-20': { done: true, doneAt: 1 },
        '2026-11-21': { skipped: true },
        '2026-11-22': { time: '07:00' },
      },
    });
    // today's 09:00 has passed at 10:00 → Nov 20 done, Nov 21 skipped → Nov 22 at 07:00
    expect(nextReminder(t, NY, now)).toEqual({ at: Z('2026-11-22T12:00:00Z'), origDate: '2026-11-22', occDate: '2026-11-22' });
    const moved = { ...t, overrides: { ...t.overrides, '2026-11-25': { date: '2026-11-19', time: '18:00' } } };
    expect(nextReminder(moved, NY, now)).toEqual({ at: Z('2026-11-19T23:00:00Z'), origDate: '2026-11-25', occDate: '2026-11-19' });
    const untimed = { ...t, overrides: { '2026-11-22': { time: null } }, time: null };
    expect(nextReminder(untimed, NY, now)).toBeNull();
  });

  it('recurring with daysBefore looks far enough ahead', () => {
    const t = mkTask({
      id: 'y',
      date: '2026-12-25',
      recurrence: rule('yearly'),
      reminder: { kind: 'at', time: '09:00', daysBefore: 30 },
    });
    expect(nextReminder(t, NY, now)).toEqual({ at: Z('2026-11-25T14:00:00Z'), origDate: '2026-12-25', occDate: '2026-12-25' });
    expect(nextReminder(t, NY, Z('2026-11-26T00:00:00Z'))?.occDate).toBe('2027-12-25');
  });

  it('recurring: occurrences beyond the 400-day scan are still found (never a silent null)', () => {
    // next occurrence 2028-01-15 is ~787 days away → found by the closed-form jump
    const far = mkTask({ id: 'b', date: '2026-01-15', time: '09:00', recurrence: rule('yearly', { interval: 2 }) });
    expect(nextReminder(far, NY, now)).toEqual({ at: Z('2028-01-15T14:00:00Z'), origDate: '2028-01-15', occDate: '2028-01-15' });
    // next occurrence 2027-06-01 is ~194 days away → found by the scan
    const near = mkTask({ id: 'c', date: '2025-06-01', time: '09:00', recurrence: rule('yearly', { interval: 2 }) });
    expect(nextReminder(near, NY, now)).toEqual({ at: Z('2027-06-01T13:00:00Z'), origDate: '2027-06-01', occDate: '2027-06-01' });
    // yearly with next year's occurrence deleted → the one after
    const skipped = mkTask({
      id: 'y',
      date: '2026-11-19',
      time: '09:00',
      recurrence: rule('yearly'),
      overrides: { '2027-11-19': { skipped: true } },
    });
    expect(nextReminder(skipped, NY, Z('2026-11-19T15:00:00Z'))?.occDate).toBe('2028-11-19');
    // a series that starts more than 400 days ahead
    const later = mkTask({ id: 'l', date: '2028-03-01', time: '09:00', recurrence: rule('monthly') });
    expect(nextReminder(later, NY, now)?.at).toBe(Z('2028-03-01T14:00:00Z'));
    // every 14 months, after the first alert
    const m14 = mkTask({ id: 'm', date: '2026-11-19', time: '09:00', recurrence: rule('monthly', { interval: 14 }) });
    expect(nextReminder(m14, NY, Z('2026-11-19T14:00:01Z'))?.occDate).toBe('2028-01-19');
    // far occurrences that are done or moved are honored
    const done = { ...far, overrides: { '2028-01-15': { done: true, doneAt: 1 } } };
    expect(nextReminder(done, NY, now)?.occDate).toBe('2030-01-15');
    const moved = { ...far, overrides: { '2028-01-15': { date: '2028-02-01', time: '07:30' } } };
    expect(nextReminder(moved, NY, now)).toEqual({ at: Z('2028-02-01T12:30:00Z'), origDate: '2028-01-15', occDate: '2028-02-01' });
    // a finite series whose last occurrence has passed, or an untimed default series → null
    expect(nextReminder(mkTask({ id: 'f', date: '2026-01-15', time: '09:00', recurrence: rule('yearly', { interval: 2, count: 1 }) }), NY, now)).toBeNull();
    expect(nextReminder(mkTask({ id: 'u', date: '2026-01-15', recurrence: rule('yearly', { interval: 2 }) }), NY, now)).toBeNull();
  });

  it('recurring: ended series → null', () => {
    const t = mkTask({ id: 'e', date: '2026-11-01', time: '09:00', recurrence: rule('daily', { until: '2026-11-19' }) });
    expect(nextReminder(t, NY, now)).toBeNull();
  });

  it('recurring: negative offsets ("after") still find a reminder whose occurrence was yesterday', () => {
    const t = mkTask({
      id: 'n',
      date: '2026-11-01',
      time: '23:00',
      recurrence: rule('weekly', { byWeekday: [3] }), // Wednesdays
      reminder: { kind: 'offset', minutes: -720 },
    });
    // Wed Nov 18 23:00 EST + 12h = Thu Nov 19 11:00 EST = 16:00Z > now
    expect(nextReminder(t, NY, now)).toEqual({ at: Z('2026-11-19T16:00:00Z'), origDate: '2026-11-18', occDate: '2026-11-18' });
  });

  it('property: equals the brute-force minimum over occurrences', () => {
    const r = rng(55);
    for (let i = 0; i < 100; i++) {
      const t = mkTask({
        id: `p${i}`,
        date: randomDate(r, 2026, 2026),
        time: r() < 0.7 ? minutesToHM(randInt(r, 0, 95) * 15) : null,
        recurrence: rule(['daily', 'weekly', 'monthly'][randInt(r, 0, 2)] as 'daily', { interval: randInt(r, 1, 3) }),
        reminder:
          r() < 0.5
            ? { kind: 'default' }
            : r() < 0.5
              ? { kind: 'offset', minutes: randInt(r, 0, 3000) }
              : { kind: 'at', time: minutesToHM(randInt(r, 0, 1439)), daysBefore: randInt(r, 0, 3) },
      });
      const after = Z('2026-11-19T15:00:00Z') + randInt(r, -5, 5) * 86_400_000;
      const res = nextReminder(t, NY, after);
      // brute force over the next 400 days of occurrences
      let best: number | null = null;
      for (const o of occurrencesInRange([t], '2026-01-01', '2028-06-01')) {
        const at = reminderInstantFor({ date: o.date!, time: o.time }, t.reminder, NY);
        if (at !== null && at > after && at < after + 400 * 86_400_000 && (best === null || at < best)) best = at;
      }
      expect(res?.at ?? null, JSON.stringify(t)).toBe(best);
    }
  });
});

describe('nextReminder across daylight saving (from review B)', () => {
  it('a daily 02:30 series alerts once per day through spring-forward, never twice or never', () => {
    const t = mkTask({ id: 'd', date: '2026-03-06', time: '02:30', recurrence: rule('daily') });
    let at = zonedInstant('2026-03-06', '00:00', NY);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = nextReminder(t, NY, at);
      if (!n) break;
      seen.push(n.occDate);
      at = n.at;
    }
    expect(seen).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });
});

describe('nextSummaryAt', () => {
  const s = (p: Partial<Settings> & { time?: string; enabled?: boolean }): Settings => ({
    ...DEFAULT_SETTINGS,
    timezone: p.timezone ?? NY,
    summary: { enabled: p.enabled ?? true, time: p.time ?? '08:00' },
  });
  it('today if still ahead, else tomorrow', () => {
    expect(nextSummaryAt(s({}), Z('2026-11-19T12:00:00Z'))).toBe(Z('2026-11-19T13:00:00Z'));
    expect(nextSummaryAt(s({}), Z('2026-11-19T13:00:00Z'))).toBe(Z('2026-11-20T13:00:00Z'));
    expect(nextSummaryAt(s({}), Z('2026-11-19T15:00:00Z'))).toBe(Z('2026-11-20T13:00:00Z'));
  });
  it('disabled → null', () => {
    expect(nextSummaryAt(s({ enabled: false }), Z('2026-11-19T12:00:00Z'))).toBeNull();
  });
  it('DST days and odd settings', () => {
    expect(nextSummaryAt(s({}), Z('2026-03-08T05:00:00Z'))).toBe(Z('2026-03-08T12:00:00Z')); // EDT that morning
    expect(nextSummaryAt(s({ time: '02:30' }), Z('2026-03-08T05:00:00Z'))).toBe(Z('2026-03-08T07:30:00Z')); // gap → 03:30
    expect(nextSummaryAt(s({ time: '01:30' }), Z('2026-11-01T05:00:00Z'))).toBe(Z('2026-11-01T05:30:00Z')); // first 01:30
    expect(nextSummaryAt(s({ time: '01:30' }), Z('2026-11-01T05:30:00Z'))).toBe(Z('2026-11-02T06:30:00Z')); // not the repeat
    expect(nextSummaryAt(s({ time: 'bad' }), Z('2026-11-19T12:00:00Z'))).toBe(Z('2026-11-19T13:00:00Z'));
    expect(nextSummaryAt(s({ timezone: 'Bad/Zone' }), Z('2026-11-19T07:00:00Z'))).toBe(Z('2026-11-19T08:00:00Z'));
    expect(nextSummaryAt(DEFAULT_SETTINGS, Z('2026-11-19T07:00:00Z'))).toBe(Z('2026-11-19T08:00:00Z'));
  });
});

describe('badgeCount / summaryText', () => {
  const today = '2026-11-19';
  const tasks: Task[] = [
    mkTask({ id: 'a', title: 'Finish report', date: today, order: 'a1' }),
    mkTask({ id: 'b', title: 'Call mom', date: today, order: 'a2' }),
    mkTask({ id: 'c', title: 'Gym', date: today, time: '18:00' }),
    mkTask({ id: 'm', title: 'Trip', date: '2026-11-17', endDate: '2026-11-20' }),
    mkTask({ id: 'r', title: 'Stretch', date: '2026-11-01', order: 'a3', recurrence: rule('daily'), overrides: { '2026-11-18': { done: false } } }),
    mkTask({ id: 'o1', title: 'Old', date: '2026-11-10' }),
    mkTask({ id: 'o2', title: 'Older', date: '2026-11-01', endDate: '2026-11-05' }),
    mkTask({ id: 'done', date: today, done: true }),
    mkTask({ id: 'inbox' }),
    mkTask({ id: 'later', date: '2026-11-25' }),
  ];

  it('badge = open occurrences today (incl. active multi-day and recurring) + overdue', () => {
    expect(badgeCount(tasks, today)).toBe(5 + 2);
    expect(badgeCount([], today)).toBe(0);
    expect(badgeCount(new Map(tasks.map((t) => [t.id, t])).values(), today)).toBe(7);
  });

  it('summary text', () => {
    expect(summaryText(tasks, today)).toEqual({
      title: 'Today · 5 tasks',
      body: 'Trip, Finish report, Call mom +2 more · 2 overdue',
    });
    expect(summaryText([mkTask({ id: 'x', title: '  Solo  ', date: today })], today)).toEqual({ title: 'Today · 1 task', body: 'Solo' });
    expect(summaryText([mkTask({ id: 'x', date: '2026-11-01' })], today)).toEqual({ title: 'Nothing planned today', body: '1 overdue' });
    expect(summaryText([], today)).toEqual({ title: 'Nothing planned today', body: '' });
    expect(summaryText([mkTask({ id: 'x', title: '', date: today })], today).body).toBe('Untitled');
    const long = 'x'.repeat(200);
    expect(summaryText([mkTask({ id: 'x', title: long, date: today })], today).body).toHaveLength(60);
  });
});

describe('repairedRemindAt', () => {
  const now = 1_000;
  it('fills a missing value and lowers a too-late one', () => {
    expect(repairedRemindAt(null, 5_000, now)).toBe(5_000);
    expect(repairedRemindAt(9_000, 5_000, now)).toBe(5_000);
  });
  it('leaves due values (the tick owns them), too-early values and equal values alone', () => {
    expect(repairedRemindAt(900, 5_000, now)).toBeUndefined();
    expect(repairedRemindAt(1_000, 5_000, now)).toBeUndefined();
    expect(repairedRemindAt(3_000, 5_000, now)).toBeUndefined();
    expect(repairedRemindAt(5_000, 5_000, now)).toBeUndefined();
  });
  it('never clears a value', () => {
    expect(repairedRemindAt(9_000, null, now)).toBeUndefined();
    expect(repairedRemindAt(null, null, now)).toBeUndefined();
  });
});
