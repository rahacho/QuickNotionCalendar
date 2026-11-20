import { describe, expect, it } from 'vitest';
import {
  MAX_EPOCH_DAY,
  MIN_EPOCH_DAY,
  addDays,
  addMonths,
  civilFromDays,
  compareDates,
  daysFromCivil,
  daysInMonth,
  diffDays,
  eachDay,
  endOfMonth,
  fromEpochDay,
  hmToMinutes,
  isHM,
  isValidISODate,
  maxDate,
  minDate,
  minutesToHM,
  parseISODate,
  startOfMonth,
  startOfWeek,
  toEpochDay,
  toISODate,
  todayISO,
  weekDates,
  weekday,
} from '../dates';
import { randInt, randomDate, refAddDays, rng } from './helpers';

describe('epoch day conversion', () => {
  it('anchors 1970-01-01 at 0 and the representable bounds', () => {
    expect(toEpochDay('1970-01-01')).toBe(0);
    expect(toEpochDay('1970-01-02')).toBe(1);
    expect(toEpochDay('1969-12-31')).toBe(-1);
    expect(toEpochDay('0000-01-01')).toBe(MIN_EPOCH_DAY);
    expect(toEpochDay('9999-12-31')).toBe(MAX_EPOCH_DAY);
    expect(fromEpochDay(MIN_EPOCH_DAY)).toBe('0000-01-01');
    expect(fromEpochDay(MAX_EPOCH_DAY)).toBe('9999-12-31');
  });

  it('matches Date.UTC for random dates (incl. years < 100)', () => {
    const r = rng(1);
    for (let i = 0; i < 2000; i++) {
      const d = randomDate(r, 0, 9999);
      const [y, m, day] = d.split('-').map(Number) as [number, number, number];
      const dt = new Date(0);
      dt.setUTCFullYear(y, m - 1, day);
      expect(toEpochDay(d)).toBe(Math.round(dt.getTime() / 86_400_000));
      expect(fromEpochDay(toEpochDay(d))).toBe(d);
      expect(civilFromDays(daysFromCivil(y, m, day))).toEqual([y, m, day]);
    }
  });

  it('rejects out-of-range epoch days', () => {
    expect(() => fromEpochDay(MAX_EPOCH_DAY + 1)).toThrow(RangeError);
    expect(() => fromEpochDay(MIN_EPOCH_DAY - 1)).toThrow(RangeError);
    expect(() => fromEpochDay(1.5)).toThrow(RangeError);
  });
});

describe('isValidISODate', () => {
  it.each([
    ['2026-11-19', true],
    ['2024-02-29', true],
    ['2000-02-29', true],
    ['1900-02-29', false],
    ['2026-02-29', false],
    ['2026-04-31', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-11-00', false],
    ['2026-1-19', false],
    ['2026/11/19', false],
    ['2026-11-19T00:00', false],
    [' 2026-11-19', false],
    ['', false],
    ['abcd-ef-gh', false],
    ['0000-01-01', true],
    ['9999-12-31', true],
  ])('%s → %s', (s, ok) => {
    expect(isValidISODate(s)).toBe(ok);
  });

  it('tolerates non-string input at runtime', () => {
    expect(isValidISODate(null as unknown as string)).toBe(false);
    expect(isValidISODate(20261119 as unknown as string)).toBe(false);
  });
});

describe('addDays / diffDays', () => {
  it('handles month, year and leap boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-19', 0)).toBe('2026-11-19');
    expect(addDays('2026-11-19', -365)).toBe('2025-11-19');
    expect(addDays('2026-11-19', 36_500)).toBe('2126-10-26');
  });

  it('is DST-proof (no local-time arithmetic) around US/EU transitions', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(diffDays('2026-03-09', '2026-03-08')).toBe(1);
    expect(diffDays('2026-11-02', '2026-11-01')).toBe(1);
  });

  it('diffDays is a − b', () => {
    expect(diffDays('2026-11-21', '2026-11-19')).toBe(2);
    expect(diffDays('2026-11-19', '2026-11-21')).toBe(-2);
    expect(diffDays('2027-01-01', '2026-01-01')).toBe(365);
    expect(diffDays('2025-01-01', '2024-01-01')).toBe(366);
  });

  it('round-trips random dates (property)', () => {
    const r = rng(42);
    for (let i = 0; i < 3000; i++) {
      const d = randomDate(r);
      const n = randInt(r, -20_000, 20_000);
      const e = addDays(d, n);
      expect(isValidISODate(e)).toBe(true);
      expect(diffDays(e, d)).toBe(n);
      expect(addDays(e, -n)).toBe(d);
      expect(e).toBe(refAddDays(d, n));
    }
  });

  it('throws on invalid input', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-11-19', 1.5)).toThrow(RangeError);
    expect(() => addDays('2026-11-19', Number.NaN)).toThrow(RangeError);
    expect(() => addDays('9999-12-31', 1)).toThrow(RangeError);
    expect(() => diffDays('x', '2026-11-19')).toThrow(RangeError);
  });
});

describe('addMonths', () => {
  it('clamps to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-11-19', 1)).toBe('2026-12-19');
    expect(addMonths('2026-12-19', 1)).toBe('2027-01-19');
    expect(addMonths('2026-01-19', -1)).toBe('2025-12-19');
    expect(addMonths('2026-11-19', 0)).toBe('2026-11-19');
    expect(addMonths('2026-11-19', 24)).toBe('2028-11-19');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2024-02-29', 48)).toBe('2028-02-29');
  });

  it('property: day is min(original day, days in target month)', () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      const d = randomDate(r);
      const n = randInt(r, -240, 240);
      const out = addMonths(d, n);
      const [y, m, day] = d.split('-').map(Number) as [number, number, number];
      const [oy, om, od] = out.split('-').map(Number) as [number, number, number];
      expect(oy * 12 + om - (y * 12 + m)).toBe(n);
      expect(od).toBe(Math.min(day, daysInMonth(oy, om)));
    }
  });
});

describe('compare / min / max', () => {
  it('orders dates', () => {
    expect(compareDates('2026-11-19', '2026-11-20')).toBe(-1);
    expect(compareDates('2026-11-20', '2026-11-19')).toBe(1);
    expect(compareDates('2026-11-19', '2026-11-19')).toBe(0);
    expect(compareDates('2025-12-31', '2026-01-01')).toBe(-1);
    expect(minDate('2026-11-19', '2026-01-01')).toBe('2026-01-01');
    expect(maxDate('2026-11-19', '2026-01-01')).toBe('2026-11-19');
    expect(['2026-11-19', '2025-01-01', '2026-02-03'].sort(compareDates)).toEqual([
      '2025-01-01',
      '2026-02-03',
      '2026-11-19',
    ]);
  });
});

describe('weekday / startOfWeek / weekDates', () => {
  it('knows weekdays', () => {
    expect(weekday('2026-11-19')).toBe(4); // Thursday (owner screenshot)
    expect(weekday('2026-11-22')).toBe(0); // Sunday
    expect(weekday('2026-11-23')).toBe(1);
    expect(weekday('1970-01-01')).toBe(4);
    expect(weekday('1969-12-28')).toBe(0);
    expect(weekday('2000-01-01')).toBe(6);
    expect(weekday('0001-01-01')).toBe(1);
  });

  it('matches Date.getUTCDay for random dates', () => {
    const r = rng(3);
    for (let i = 0; i < 500; i++) {
      const d = randomDate(r);
      const [y, m, day] = d.split('-').map(Number) as [number, number, number];
      const dt = new Date(0);
      dt.setUTCFullYear(y, m - 1, day);
      expect(weekday(d)).toBe(dt.getUTCDay());
    }
  });

  it('startOfWeek for Monday and Sunday starts', () => {
    expect(startOfWeek('2026-11-19', 1)).toBe('2026-11-16');
    expect(startOfWeek('2026-11-16', 1)).toBe('2026-11-16');
    expect(startOfWeek('2026-11-22', 1)).toBe('2026-11-16');
    expect(startOfWeek('2026-11-19', 0)).toBe('2026-11-15');
    expect(startOfWeek('2026-11-22', 0)).toBe('2026-11-22');
    expect(startOfWeek('2026-01-01', 1)).toBe('2025-12-29');
    expect(startOfWeek('2026-11-01', 1)).toBe('2026-10-26'); // first grid row of the screenshot
  });

  it('weekDates returns 7 consecutive dates', () => {
    expect(weekDates('2026-11-30')).toEqual([
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
      '2026-12-05',
      '2026-12-06',
    ]);
    expect(weekDates('2026-12-28').at(-1)).toBe('2027-01-03');
  });
});

describe('month helpers', () => {
  it('start/end of month', () => {
    expect(startOfMonth('2026-11-19')).toBe('2026-11-01');
    expect(endOfMonth('2026-11-19')).toBe('2026-11-30');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
    expect(endOfMonth('2026-12-01')).toBe('2026-12-31');
  });

  it('daysInMonth', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError);
    expect(() => daysInMonth(2026, 0)).toThrow(RangeError);
  });
});

describe('eachDay', () => {
  it('is inclusive and handles empty/single ranges', () => {
    expect(eachDay('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(eachDay('2026-11-19', '2026-11-19')).toEqual(['2026-11-19']);
    expect(eachDay('2026-11-20', '2026-11-19')).toEqual([]);
    expect(eachDay('2024-02-27', '2024-03-01')).toHaveLength(4);
  });
});

describe('HM helpers', () => {
  it('isHM is strict 24h HH:mm', () => {
    for (const ok of ['00:00', '09:05', '12:00', '23:59', '15:30']) expect(isHM(ok)).toBe(true);
    for (const bad of ['24:00', '9:05', '09:5', '12:60', '1200', '12:00:00', '', ' 12:00', 'ab:cd']) {
      expect(isHM(bad)).toBe(false);
    }
    expect(isHM(null as unknown as string)).toBe(false);
  });

  it('hmToMinutes / minutesToHM round-trip and wrap', () => {
    expect(hmToMinutes('00:00')).toBe(0);
    expect(hmToMinutes('15:30')).toBe(930);
    expect(hmToMinutes('23:59')).toBe(1439);
    expect(() => hmToMinutes('24:00')).toThrow(RangeError);
    expect(minutesToHM(0)).toBe('00:00');
    expect(minutesToHM(930)).toBe('15:30');
    expect(minutesToHM(1439)).toBe('23:59');
    expect(minutesToHM(1440)).toBe('00:00');
    expect(minutesToHM(1500)).toBe('01:00');
    expect(minutesToHM(-30)).toBe('23:30');
    expect(minutesToHM(61.9)).toBe('01:01');
    expect(() => minutesToHM(Number.NaN)).toThrow(RangeError);
    for (let m = 0; m < 1440; m += 7) expect(hmToMinutes(minutesToHM(m))).toBe(m);
  });
});

describe('local-time bridges', () => {
  it('toISODate reads local calendar fields', () => {
    expect(toISODate(new Date(2026, 10, 19, 23, 59, 59))).toBe('2026-11-19');
    expect(toISODate(new Date(2026, 10, 19, 0, 0, 0))).toBe('2026-11-19');
    expect(toISODate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(() => toISODate(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('parseISODate is local midnight and round-trips (also for years < 100)', () => {
    const d = parseISODate('2026-11-19');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(19);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(toISODate(parseISODate('0050-03-04'))).toBe('0050-03-04');
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const s = randomDate(r);
      expect(toISODate(parseISODate(s))).toBe(s);
    }
    expect(() => parseISODate('2026-02-30')).toThrow(RangeError);
  });

  it('todayISO uses the given instant or now', () => {
    expect(todayISO(new Date(2026, 10, 19, 10))).toBe('2026-11-19');
    expect(isValidISODate(todayISO())).toBe(true);
    expect(todayISO()).toBe(toISODate(new Date()));
  });
});
