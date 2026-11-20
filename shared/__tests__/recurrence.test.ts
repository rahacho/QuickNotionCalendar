import { describe, expect, it } from 'vitest';
import {
  compileRecurrence,
  describeRecurrence,
  isRuleDate,
  nextRuleDate,
  normalizeRecurrence,
  occurrenceDates,
} from '../recurrence';
import { fromEpochDay } from '../dates';
import type { ISODate, Recurrence, Weekday } from '../types';
import { randInt, randomDate, refAddDays, rng, rule } from './helpers';

// ---------------------------------------------------------------------------------------------
// Independent brute-force reference (Date.UTC based, iterates day by day / unit by unit)
// ---------------------------------------------------------------------------------------------
function utc(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, day);
  return dt;
}
function iso(dt: Date): ISODate {
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function refDim(y: number, m1: number): number {
  return new Date(Date.UTC(2000, m1, 0)).getUTCDate() === 29 && m1 === 2
    ? (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
      ? 29
      : 28
    : new Date(Date.UTC(2001, m1, 0)).getUTCDate();
}
function refRuleDates(r: Recurrence, start: ISODate, hardEnd: ISODate): ISODate[] {
  const n = normalizeRecurrence(r, start);
  const out: ISODate[] = [];
  const s = utc(start);
  const push = (d: ISODate): boolean => {
    if (d > hardEnd) return false;
    if (n.until && d > n.until) return false;
    if (n.count != null && out.length >= n.count) return false;
    if (d >= start) out.push(d);
    return true;
  };
  if (n.freq === 'daily') {
    for (let d = start; ; d = refAddDays(d, n.interval)) if (!push(d)) break;
  } else if (n.freq === 'weekly') {
    const days = n.byWeekday ?? [];
    const startMon = refAddDays(start, -((s.getUTCDay() + 6) % 7));
    for (let d = start; ; d = refAddDays(d, 1)) {
      if (d > hardEnd || (n.until && d > n.until) || (n.count != null && out.length >= n.count)) break;
      const mon = refAddDays(d, -((utc(d).getUTCDay() + 6) % 7));
      const w = Math.round((utc(mon).getTime() - utc(startMon).getTime()) / 86_400_000 / 7);
      if (w % n.interval === 0 && days.includes(utc(d).getUTCDay() as Weekday)) push(d);
    }
  } else {
    const sy = s.getUTCFullYear();
    const sm = s.getUTCMonth() + 1;
    const sd = s.getUTCDate();
    for (let k = 0; ; k++) {
      let y: number;
      let m: number;
      if (n.freq === 'monthly') {
        const total = sm - 1 + k * n.interval;
        y = sy + Math.floor(total / 12);
        m = (total % 12) + 1;
      } else {
        y = sy + k * n.interval;
        m = sm;
      }
      if (y > 9999) break;
      const dt = new Date(0);
      dt.setUTCFullYear(y, m - 1, Math.min(sd, refDim(y, m)));
      if (!push(iso(dt))) break;
    }
  }
  return out;
}

function randomRule(r: () => number): Recurrence {
  const freq = (['daily', 'weekly', 'monthly', 'yearly'] as const)[randInt(r, 0, 3)] ?? 'daily';
  const rec: Recurrence = { freq, interval: randInt(r, 1, freq === 'daily' ? 10 : 4) };
  if (freq === 'weekly' && r() < 0.8) {
    const days = new Set<Weekday>();
    const k = randInt(r, 1, 7);
    for (let i = 0; i < k; i++) days.add(randInt(r, 0, 6) as Weekday);
    rec.byWeekday = [...days];
  }
  const end = r();
  if (end < 0.25) rec.count = randInt(r, 1, 40);
  return rec;
}

// ---------------------------------------------------------------------------------------------

describe('normalizeRecurrence', () => {
  it('fills defaults and returns every key (Firestore-safe, no undefined)', () => {
    expect(normalizeRecurrence({ freq: 'weekly', interval: 1 }, '2026-11-19')).toEqual({
      freq: 'weekly',
      interval: 1,
      byWeekday: [4],
      until: null,
      count: null,
    });
    expect(normalizeRecurrence({ freq: 'daily', interval: 2, byWeekday: [1] }, '2026-11-19')).toEqual({
      freq: 'daily',
      interval: 2,
      byWeekday: null,
      until: null,
      count: null,
    });
  });

  it('sorts and dedupes byWeekday, drops junk, defaults when empty', () => {
    expect(normalizeRecurrence({ freq: 'weekly', interval: 1, byWeekday: [5, 1, 3, 1] }, '2026-11-19').byWeekday).toEqual([
      1, 3, 5,
    ]);
    expect(
      normalizeRecurrence({ freq: 'weekly', interval: 1, byWeekday: [7, -1, 2.5] as unknown as Weekday[] }, '2026-11-19')
        .byWeekday,
    ).toEqual([4]);
    expect(normalizeRecurrence({ freq: 'weekly', interval: 1, byWeekday: [] }, '2026-11-22').byWeekday).toEqual([0]);
  });

  it('coerces interval to an integer >= 1', () => {
    expect(normalizeRecurrence({ freq: 'daily', interval: 0 }, '2026-11-19').interval).toBe(1);
    expect(normalizeRecurrence({ freq: 'daily', interval: -3 }, '2026-11-19').interval).toBe(1);
    expect(normalizeRecurrence({ freq: 'daily', interval: 2.7 }, '2026-11-19').interval).toBe(2);
    expect(normalizeRecurrence({ freq: 'daily', interval: Number.NaN }, '2026-11-19').interval).toBe(1);
  });

  it('falls back to daily for an unknown freq (never hides the series)', () => {
    expect(normalizeRecurrence({ freq: 'hourly' as Recurrence['freq'], interval: 1 }, '2026-11-19').freq).toBe('daily');
  });

  it('keeps until/count exclusive; invalid ones are dropped', () => {
    expect(normalizeRecurrence(rule('daily', { count: 0 }), '2026-11-19').count).toBeNull();
    expect(normalizeRecurrence(rule('daily', { count: 3.9 }), '2026-11-19').count).toBe(3);
    expect(normalizeRecurrence(rule('daily', { until: '2026-02-30' }), '2026-11-19').until).toBeNull();
    // both present: keep the less restrictive one
    const a = normalizeRecurrence(rule('daily', { until: '2026-11-30', count: 5 }), '2026-11-19');
    expect(a).toMatchObject({ until: '2026-11-30', count: null });
    const b = normalizeRecurrence(rule('daily', { until: '2026-11-20', count: 5 }), '2026-11-19');
    expect(b).toMatchObject({ until: null, count: 5 });
  });

  it('raises an until before start to start', () => {
    expect(normalizeRecurrence(rule('daily', { until: '2026-11-01' }), '2026-11-19').until).toBe('2026-11-19');
    expect(occurrenceDates(rule('daily', { until: '2026-11-01' }), '2026-11-19', '2026-11-01', '2026-12-31')).toEqual([
      '2026-11-19',
    ]);
  });

  it('tolerates a null rule at runtime', () => {
    expect(normalizeRecurrence(null as unknown as Recurrence, '2026-11-19')).toEqual({
      freq: 'daily',
      interval: 1,
      byWeekday: null,
      until: null,
      count: null,
    });
  });
});

describe('occurrenceDates — daily', () => {
  it('every day / every 2 days, clipped to range and start', () => {
    expect(occurrenceDates(rule('daily'), '2026-11-19', '2026-11-17', '2026-11-22')).toEqual([
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
    expect(occurrenceDates(rule('daily', { interval: 2 }), '2026-11-19', '2026-11-20', '2026-11-28')).toEqual([
      '2026-11-21',
      '2026-11-23',
      '2026-11-25',
      '2026-11-27',
    ]);
    expect(occurrenceDates(rule('daily'), '2026-11-19', '2026-11-01', '2026-11-18')).toEqual([]);
    expect(occurrenceDates(rule('daily'), '2026-11-19', '2026-11-25', '2026-11-20')).toEqual([]);
  });

  it('honors until (inclusive) and count (from start)', () => {
    expect(occurrenceDates(rule('daily', { until: '2026-11-21' }), '2026-11-19', '2026-11-01', '2026-12-31')).toEqual([
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
    ]);
    expect(occurrenceDates(rule('daily', { count: 3 }), '2026-11-19', '2026-11-20', '2026-12-31')).toEqual([
      '2026-11-20',
      '2026-11-21',
    ]);
    expect(occurrenceDates(rule('daily', { count: 3, interval: 7 }), '2026-11-19', '2026-01-01', '2027-12-31')).toEqual([
      '2026-11-19',
      '2026-11-26',
      '2026-12-03',
    ]);
  });

  it('jumps straight to a far-future window without iterating history', () => {
    const t0 = performance.now();
    const out = occurrenceDates(rule('daily'), '1900-01-01', '2026-11-19', '2026-11-21');
    expect(out).toEqual(['2026-11-19', '2026-11-20', '2026-11-21']);
    // a huge count is resolved in closed form too
    expect(occurrenceDates(rule('daily', { count: 50_000 }), '1900-01-01', '2026-11-19', '2026-11-19')).toEqual([
      '2026-11-19',
    ]);
    expect(occurrenceDates(rule('daily', { count: 46_000 }), '1900-01-01', '2026-11-19', '2026-11-19')).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('occurrenceDates — weekly', () => {
  it('defaults to the start weekday', () => {
    expect(occurrenceDates(rule('weekly'), '2026-11-19', '2026-11-01', '2026-12-10')).toEqual([
      '2026-11-19',
      '2026-11-26',
      '2026-12-03',
      '2026-12-10',
    ]);
  });

  it('every weekday', () => {
    expect(
      occurrenceDates(rule('weekly', { byWeekday: [1, 2, 3, 4, 5] }), '2026-11-19', '2026-11-16', '2026-11-29'),
    ).toEqual(['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
  });

  it('start is an occurrence only if it matches the rule', () => {
    // start Thu, rule Mon+Wed → first occurrence is the next Monday
    expect(occurrenceDates(rule('weekly', { byWeekday: [1, 3] }), '2026-11-19', '2026-11-16', '2026-11-30')).toEqual([
      '2026-11-23',
      '2026-11-25',
      '2026-11-30',
    ]);
    expect(isRuleDate(rule('weekly', { byWeekday: [1, 3] }), '2026-11-19', '2026-11-19')).toBe(false);
  });

  it('Sunday is the LAST day of a Monday-based week', () => {
    // every 2 weeks on Sun+Mon starting Mon Nov 16: Sun Nov 22 is in week 0 (active), Mon Nov 23 in week 1 (inactive)
    expect(
      occurrenceDates(rule('weekly', { interval: 2, byWeekday: [0, 1] }), '2026-11-16', '2026-11-16', '2026-12-13'),
    ).toEqual(['2026-11-16', '2026-11-22', '2026-11-30', '2026-12-06']);
  });

  it('interval > 1 across a year boundary (weeks counted Monday-based from the start week)', () => {
    // start Wed Dec 16 2026; every 2 weeks on Mon, Fri
    const r = rule('weekly', { interval: 2, byWeekday: [1, 5] });
    expect(occurrenceDates(r, '2026-12-16', '2026-12-01', '2027-02-01')).toEqual([
      '2026-12-18', // week 0 (Mon Dec 14 is before start)
      '2026-12-28', // week 2
      '2027-01-01',
      '2027-01-11', // week 4
      '2027-01-15',
      '2027-01-25', // week 6
      '2027-01-29',
    ]);
    expect(isRuleDate(r, '2026-12-16', '2027-01-04')).toBe(false); // week 3
    expect(nextRuleDate(r, '2026-12-16', '2027-01-02')).toBe('2027-01-11');
  });

  it('count skips rule weekdays before start in the first week', () => {
    // start Thu; Mon/Thu/Sat; count 4 → Thu 19, Sat 21, Mon 23, Thu 26
    const r = rule('weekly', { byWeekday: [1, 4, 6], count: 4 });
    expect(occurrenceDates(r, '2026-11-19', '2026-11-01', '2027-01-01')).toEqual([
      '2026-11-19',
      '2026-11-21',
      '2026-11-23',
      '2026-11-26',
    ]);
    // count where start does not match
    const r2 = rule('weekly', { byWeekday: [1], count: 2 });
    expect(occurrenceDates(r2, '2026-11-19', '2026-11-01', '2027-01-01')).toEqual(['2026-11-23', '2026-11-30']);
  });

  it('count + interval across a year boundary', () => {
    const r = rule('weekly', { interval: 3, byWeekday: [4], count: 3 });
    expect(occurrenceDates(r, '2026-12-17', '2026-01-01', '2028-01-01')).toEqual([
      '2026-12-17',
      '2027-01-07',
      '2027-01-28',
    ]);
  });
});

describe('occurrenceDates — monthly', () => {
  it('day-of-month of start', () => {
    expect(occurrenceDates(rule('monthly'), '2026-11-19', '2026-11-01', '2027-02-28')).toEqual([
      '2026-11-19',
      '2026-12-19',
      '2027-01-19',
      '2027-02-19',
    ]);
  });

  it('31st clamps to month end (incl. leap February) and recovers', () => {
    expect(occurrenceDates(rule('monthly'), '2026-01-31', '2026-01-01', '2026-06-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
    expect(occurrenceDates(rule('monthly'), '2028-01-31', '2028-02-01', '2028-03-31')).toEqual([
      '2028-02-29',
      '2028-03-31',
    ]);
    expect(occurrenceDates(rule('monthly'), '2026-01-30', '2026-02-01', '2026-03-31')).toEqual([
      '2026-02-28',
      '2026-03-30',
    ]);
  });

  it('interval and window starting mid-month', () => {
    expect(occurrenceDates(rule('monthly', { interval: 3 }), '2026-01-15', '2026-04-16', '2027-01-31')).toEqual([
      '2026-07-15',
      '2026-10-15',
      '2027-01-15',
    ]);
    expect(isRuleDate(rule('monthly', { interval: 3 }), '2026-01-15', '2026-02-15')).toBe(false);
    expect(isRuleDate(rule('monthly'), '2026-01-31', '2026-02-28')).toBe(true);
    expect(isRuleDate(rule('monthly'), '2026-01-31', '2026-02-27')).toBe(false);
    expect(isRuleDate(rule('monthly'), '2028-01-31', '2028-02-28')).toBe(false); // leap year: Feb 29 is the date
  });

  it('count and until', () => {
    expect(occurrenceDates(rule('monthly', { count: 2 }), '2026-11-19', '2026-01-01', '2030-01-01')).toEqual([
      '2026-11-19',
      '2026-12-19',
    ]);
    expect(
      occurrenceDates(rule('monthly', { until: '2027-01-19' }), '2026-11-19', '2026-01-01', '2030-01-01'),
    ).toEqual(['2026-11-19', '2026-12-19', '2027-01-19']);
    expect(
      occurrenceDates(rule('monthly', { until: '2027-01-18' }), '2026-11-19', '2026-01-01', '2030-01-01'),
    ).toEqual(['2026-11-19', '2026-12-19']);
  });
});

describe('occurrenceDates — yearly', () => {
  it('month/day of start', () => {
    expect(occurrenceDates(rule('yearly'), '2026-11-19', '2026-01-01', '2028-12-31')).toEqual([
      '2026-11-19',
      '2027-11-19',
      '2028-11-19',
    ]);
  });

  it('Feb 29 → Feb 28 in non-leap years', () => {
    expect(occurrenceDates(rule('yearly'), '2024-02-29', '2024-01-01', '2029-12-31')).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
      '2029-02-28',
    ]);
    expect(isRuleDate(rule('yearly'), '2024-02-29', '2025-02-28')).toBe(true);
    expect(isRuleDate(rule('yearly'), '2024-02-29', '2028-02-28')).toBe(false);
    expect(occurrenceDates(rule('yearly', { interval: 4 }), '2024-02-29', '2024-01-01', '2100-12-31').at(-1)).toBe(
      '2100-02-28', // 2100 is not a leap year
    );
  });

  it('interval, count', () => {
    expect(occurrenceDates(rule('yearly', { interval: 2, count: 3 }), '2026-11-19', '2000-01-01', '2100-01-01')).toEqual(
      ['2026-11-19', '2028-11-19', '2030-11-19'],
    );
  });

  it('stops at year 9999 without throwing', () => {
    expect(nextRuleDate(rule('yearly'), '9999-01-01', '9999-01-02')).toBeNull();
    expect(occurrenceDates(rule('yearly'), '9998-05-05', '9998-01-01', '9999-12-31')).toEqual([
      '9998-05-05',
      '9999-05-05',
    ]);
    expect(occurrenceDates(rule('monthly'), '9999-11-30', '9999-01-01', '9999-12-31')).toEqual([
      '9999-11-30',
      '9999-12-30',
    ]);
  });
});

describe('isRuleDate / nextRuleDate', () => {
  it('isRuleDate honors start, until and count', () => {
    const r = rule('daily', { count: 3 });
    expect(isRuleDate(r, '2026-11-19', '2026-11-18')).toBe(false);
    expect(isRuleDate(r, '2026-11-19', '2026-11-19')).toBe(true);
    expect(isRuleDate(r, '2026-11-19', '2026-11-21')).toBe(true);
    expect(isRuleDate(r, '2026-11-19', '2026-11-22')).toBe(false);
    expect(isRuleDate(rule('daily', { until: '2026-11-20' }), '2026-11-19', '2026-11-21')).toBe(false);
    expect(isRuleDate(rule('daily'), '2026-11-19', 'garbage')).toBe(false);
  });

  it('nextRuleDate', () => {
    expect(nextRuleDate(rule('daily'), '2026-11-19', '2026-01-01')).toBe('2026-11-19');
    expect(nextRuleDate(rule('weekly', { byWeekday: [1] }), '2026-11-19', '2026-11-19')).toBe('2026-11-23');
    expect(nextRuleDate(rule('monthly'), '2026-01-31', '2026-02-01')).toBe('2026-02-28');
    expect(nextRuleDate(rule('daily', { count: 2 }), '2026-11-19', '2026-11-21')).toBeNull();
    expect(nextRuleDate(rule('daily', { until: '2026-11-25' }), '2026-11-19', '2026-11-25')).toBe('2026-11-25');
    expect(nextRuleDate(rule('daily', { until: '2026-11-25' }), '2026-11-19', '2026-11-26')).toBeNull();
    expect(nextRuleDate(rule('yearly'), '2024-02-29', '2025-01-01')).toBe('2025-02-28');
  });
});

describe('describeRecurrence', () => {
  const s = '2026-11-19'; // Thursday
  it.each<[Recurrence, string]>([
    [rule('daily'), 'Every day'],
    [rule('daily', { interval: 2 }), 'Every 2 days'],
    [rule('weekly', { byWeekday: [1, 2, 3, 4, 5] }), 'Every weekday'],
    [rule('weekly'), 'Every week on Thursday'],
    [rule('weekly', { byWeekday: [4] }), 'Every week on Thursday'],
    [rule('weekly', { byWeekday: [3, 1] }), 'Every week on Mon, Wed'],
    [rule('weekly', { byWeekday: [0, 6] }), 'Every week on Sat, Sun'],
    [rule('weekly', { interval: 2, byWeekday: [1] }), 'Every 2 weeks on Mon'],
    [rule('weekly', { interval: 2, byWeekday: [1, 2, 3, 4, 5] }), 'Every 2 weeks on Mon, Tue, Wed, Thu, Fri'],
    [rule('monthly'), 'Every month on the 19th'],
    [rule('monthly', { interval: 3 }), 'Every 3 months on the 19th'],
    [rule('yearly'), 'Every year on Nov 19'],
    [rule('yearly', { interval: 2 }), 'Every 2 years on Nov 19'],
    [rule('daily', { until: '2026-12-31' }), 'Every day, until Dec 31, 2026'],
    [rule('weekly', { count: 10 }), 'Every week on Thursday, 10 times'],
    [rule('daily', { count: 1 }), 'Every day, 1 time'],
  ])('%j', (r, text) => expect(describeRecurrence(r, s)).toBe(text));

  it('ordinals', () => {
    const cases: Array<[ISODate, string]> = [
      ['2026-11-01', '1st'],
      ['2026-11-02', '2nd'],
      ['2026-11-03', '3rd'],
      ['2026-11-04', '4th'],
      ['2026-11-11', '11th'],
      ['2026-11-12', '12th'],
      ['2026-11-13', '13th'],
      ['2026-11-21', '21st'],
      ['2026-11-22', '22nd'],
      ['2026-11-23', '23rd'],
      ['2026-10-31', '31st'],
    ];
    for (const [d, o] of cases) expect(describeRecurrence(rule('monthly'), d)).toBe(`Every month on the ${o}`);
  });
});

describe('properties', () => {
  it('matches a brute-force reference for random rules and windows', () => {
    const r = rng(2026);
    for (let i = 0; i < 400; i++) {
      const rec = randomRule(r);
      const start = randomDate(r, 2020, 2030);
      const from = refAddDays(start, randInt(r, -60, 400));
      const to = refAddDays(from, randInt(r, 0, 200));
      const ref = refRuleDates(rec, start, to).filter((d) => d >= from);
      expect(occurrenceDates(rec, start, from, to), JSON.stringify({ rec, start, from, to })).toEqual(ref);
    }
  });

  it('range result equals the union over split sub-ranges', () => {
    const r = rng(99);
    for (let i = 0; i < 300; i++) {
      const rec = randomRule(r);
      if (r() < 0.3) rec.until = randomDate(r, 2026, 2028);
      const start = randomDate(r, 2024, 2027);
      const from = randomDate(r, 2024, 2027);
      const to = refAddDays(from, randInt(r, 0, 300));
      const whole = occurrenceDates(rec, start, from, to);
      const cut = refAddDays(from, randInt(r, 0, Math.max(0, Math.round((utc(to).getTime() - utc(from).getTime()) / 864e5))));
      const left = occurrenceDates(rec, start, from, cut);
      const right = cut < to ? occurrenceDates(rec, start, refAddDays(cut, 1), to) : [];
      expect([...left, ...right]).toEqual(whole);
      // every emitted date is a rule date, ascending, unique
      for (let k = 0; k < whole.length; k++) {
        expect(isRuleDate(rec, start, whole[k] as string)).toBe(true);
        if (k > 0) expect((whole[k - 1] as string) < (whole[k] as string)).toBe(true);
      }
    }
  });

  it('nextRuleDate agrees with occurrenceDates', () => {
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const rec = randomRule(r);
      const start = randomDate(r, 2024, 2027);
      const probe = randomDate(r, 2023, 2028);
      const next = nextRuleDate(rec, start, probe);
      const list = occurrenceDates(rec, start, probe, refAddDays(probe, 4000));
      expect(next).toBe(list[0] ?? null);
    }
  });

  it('compileRecurrence lastE equals the date of the last counted occurrence', () => {
    const r = rng(17);
    for (let i = 0; i < 200; i++) {
      const rec = randomRule(r);
      rec.count = randInt(r, 1, 30);
      const start = randomDate(r, 2024, 2027);
      const all = occurrenceDates(rec, start, start, refAddDays(start, 365 * 130));
      expect(all).toHaveLength(rec.count);
      const c = compileRecurrence(rec, start);
      expect(fromEpochDay(c.lastE)).toBe(all.at(-1));
    }
  });
});
