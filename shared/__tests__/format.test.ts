import { describe, expect, it } from 'vitest';
import {
  formatDateLong,
  formatDateMedium,
  formatDateShort,
  formatMonthYear,
  formatRange,
  formatReminder,
  formatTime,
  formatWeekdayShort,
  parseDateInput,
  parseTimeInput,
} from '../format';
import { minutesToHM } from '../dates';

describe('formatTime', () => {
  it.each([
    ['15:00', '3:00 PM'],
    ['12:00', '12:00 PM'],
    ['09:05', '9:05 AM'],
    ['00:00', '12:00 AM'],
    ['00:30', '12:30 AM'],
    ['11:59', '11:59 AM'],
    ['12:01', '12:01 PM'],
    ['23:59', '11:59 PM'],
    ['13:00', '1:00 PM'],
  ])('%s → %s', (t, s) => expect(formatTime(t)).toBe(s));

  it('returns empty string for invalid input', () => {
    expect(formatTime('24:00')).toBe('');
    expect(formatTime('9:00')).toBe('');
    expect(formatTime('')).toBe('');
  });
});

describe('parseTimeInput', () => {
  it.each([
    ['3pm', '15:00'],
    ['3 pm', '15:00'],
    ['3PM', '15:00'],
    ['3 P.M.', '15:00'],
    ['3p', '15:00'],
    ['3:30 pm', '15:30'],
    ['3:30pm', '15:30'],
    ['3.30pm', '15:30'],
    ['15:00', '15:00'],
    ['1530', '15:30'],
    ['0930', '09:30'],
    ['930', '09:30'],
    ['930am', '09:30'],
    ['330pm', '15:30'],
    ['9', '09:00'],
    ['09', '09:00'],
    ['21', '21:00'],
    ['0', '00:00'],
    ['noon', '12:00'],
    ['Noon', '12:00'],
    ['midnight', '00:00'],
    ['12am', '00:00'],
    ['12:15 am', '00:15'],
    ['12pm', '12:00'],
    ['12:45pm', '12:45'],
    ['11:59 pm', '23:59'],
    ['  7:05 am  ', '07:05'],
    ['23:59', '23:59'],
    ['00:00', '00:00'],
  ])('%j → %s', (s, hm) => expect(parseTimeInput(s)).toBe(hm));

  it.each(['', '   ', '24:00', '25', '13pm', '0am', '12:60', '3:5', '2400', '99:99', 'abc', '3pmm', '1:2:3', '123:45', '-1'])(
    'rejects %j',
    (s) => expect(parseTimeInput(s)).toBeNull(),
  );

  it('round-trips every formatted time', () => {
    for (let m = 0; m < 1440; m++) {
      const hm = minutesToHM(m);
      expect(parseTimeInput(formatTime(hm))).toBe(hm);
      expect(parseTimeInput(hm)).toBe(hm);
    }
  });
});

describe('date formatters', () => {
  it('formats in Notion wording', () => {
    expect(formatDateLong('2026-11-19')).toBe('November 19, 2026');
    expect(formatDateShort('2026-11-19')).toBe('Nov 19');
    expect(formatDateShort('2026-09-01')).toBe('Sep 1');
    expect(formatDateMedium('2026-11-19')).toBe('Nov 19, 2026');
    expect(formatWeekdayShort('2026-11-19')).toBe('Thu, Nov 19');
    expect(formatWeekdayShort('2026-11-22')).toBe('Sun, Nov 22');
    expect(formatMonthYear('2026-11-19')).toBe('November 2026');
    expect(formatMonthYear('2027-01-01')).toBe('January 2027');
  });

  it('returns empty string for invalid dates', () => {
    expect(formatDateLong('nope')).toBe('');
    expect(formatDateShort('2026-02-30')).toBe('');
    expect(formatDateMedium('')).toBe('');
    expect(formatWeekdayShort('2026-13-01')).toBe('');
    expect(formatMonthYear('x')).toBe('');
  });
});

describe('formatRange', () => {
  it.each([
    ['2026-11-19', '2026-11-21', 'Nov 19 → 21'],
    ['2026-11-30', '2026-12-02', 'Nov 30 → Dec 2'],
    ['2026-12-30', '2027-01-02', 'Dec 30, 2026 → Jan 2, 2027'],
    ['2026-11-19', '2026-11-19', 'Nov 19'],
    ['2026-11-21', '2026-11-19', 'Nov 19 → 21'],
  ])('%s → %s = %s', (a, b, s) => expect(formatRange(a, b)).toBe(s));

  it('degrades gracefully on invalid bounds', () => {
    expect(formatRange('2026-11-19', 'bad')).toBe('Nov 19');
    expect(formatRange('bad', 'bad')).toBe('');
  });
});

describe('formatReminder', () => {
  it('labels every reminder kind', () => {
    expect(formatReminder({ kind: 'default' }, true)).toBe('At time of task');
    expect(formatReminder({ kind: 'default' }, false)).toBe('Default');
    expect(formatReminder({ kind: 'none' }, true)).toBe('None');
    expect(formatReminder({ kind: 'none' }, false)).toBe('None');
    expect(formatReminder({ kind: 'offset', minutes: 0 }, true)).toBe('At time of task');
    expect(formatReminder({ kind: 'offset', minutes: 1 }, true)).toBe('1 minute before');
    expect(formatReminder({ kind: 'offset', minutes: 10 }, true)).toBe('10 minutes before');
    expect(formatReminder({ kind: 'offset', minutes: 60 }, true)).toBe('1 hour before');
    expect(formatReminder({ kind: 'offset', minutes: 120 }, true)).toBe('2 hours before');
    expect(formatReminder({ kind: 'offset', minutes: 90 }, true)).toBe('90 minutes before');
    expect(formatReminder({ kind: 'offset', minutes: 1440 }, true)).toBe('1 day before');
    expect(formatReminder({ kind: 'offset', minutes: 2880 }, true)).toBe('2 days before');
    expect(formatReminder({ kind: 'offset', minutes: 10_080 }, true)).toBe('1 week before');
    expect(formatReminder({ kind: 'offset', minutes: -15 }, true)).toBe('15 minutes after');
    expect(formatReminder({ kind: 'offset', minutes: 10 }, false)).toBe('Default');
    expect(formatReminder({ kind: 'at', time: '09:00', daysBefore: 0 }, false)).toBe('On day (9:00 AM)');
    expect(formatReminder({ kind: 'at', time: '09:00', daysBefore: 1 }, true)).toBe('1 day before (9:00 AM)');
    expect(formatReminder({ kind: 'at', time: '18:30', daysBefore: 2 }, false)).toBe('2 days before (6:30 PM)');
    expect(formatReminder({ kind: 'at', time: 'bad', daysBefore: 1 }, false)).toBe('1 day before');
  });
});

describe('parseDateInput', () => {
  const today = '2026-11-19'; // Thursday

  it.each([
    ['today', '2026-11-19'],
    ['Today', '2026-11-19'],
    ['tomorrow', '2026-11-20'],
    ['tmrw', '2026-11-20'],
    ['yesterday', '2026-11-18'],
    ['fri', '2026-11-20'],
    ['Friday', '2026-11-20'],
    ['thu', '2026-11-19'],
    ['wed', '2026-11-25'],
    ['mon', '2026-11-23'],
    ['su', '2026-11-22'],
    ['tues', '2026-11-24'],
    ['thurs', '2026-11-19'],
    ['Nov 19', '2026-11-19'],
    ['nov 21', '2026-11-21'],
    ['November 19', '2026-11-19'],
    ['Nov. 19', '2026-11-19'],
    ['Nov 19th', '2026-11-19'],
    ['Nov 19, 2026', '2026-11-19'],
    ['Nov 19 2027', '2027-11-19'],
    ['19 Nov', '2026-11-19'],
    ['19 November 2028', '2028-11-19'],
    ['Sept 3', '2027-09-03'],
    ['sep 3', '2027-09-03'],
    ['11/19', '2026-11-19'],
    ['11/19/2026', '2026-11-19'],
    ['11/19/26', '2026-11-19'],
    ['11-19-2026', '2026-11-19'],
    ['2026-11-19', '2026-11-19'],
    ['2026/11/19', '2026-11-19'],
    ['2026-1-5', '2026-01-05'],
    // no year → earliest match on/after today − 31 days
    ['Jan 5', '2027-01-05'],
    ['1/5', '2027-01-05'],
    ['Nov 10', '2026-11-10'],
    ['Oct 19', '2026-10-19'],
    ['Oct 18', '2027-10-18'],
    ['Dec 25', '2026-12-25'],
    ['May 1', '2027-05-01'],
    ['Apr 30', '2027-04-30'],
    ['Feb 29', '2028-02-29'],
  ])('%j → %s', (s, d) => expect(parseDateInput(s, today)).toBe(d));

  it.each(['', 'blah', 'Feb 30', '13/1', '2026-02-30', 'Feb 29 2026', 'x', 's', 't', '11/31/2026', 'Novv 3', '32 Jan'])(
    'rejects %j',
    (s) => expect(parseDateInput(s, today)).toBeNull(),
  );

  it('weekday names resolve on or after today across a year boundary', () => {
    expect(parseDateInput('fri', '2026-12-31')).toBe('2027-01-01');
    expect(parseDateInput('thu', '2026-12-31')).toBe('2026-12-31');
  });

  it('returns null for an invalid today', () => {
    expect(parseDateInput('today', 'bad')).toBeNull();
  });
});
