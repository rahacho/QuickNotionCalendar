import { describe, expect, it } from 'vitest';
import { compareInDay, compareInbox, isValidOrderKey, keyAtEnd, keyAtStart, keyBetween } from '../ordering';
import { singleOccurrence } from '../occurrences';
import type { Occurrence } from '../types';
import { mkTask, randInt, rng } from './helpers';

function occ(p: Partial<Occurrence> & { key: string }): Occurrence {
  const base = singleOccurrence(mkTask({ id: p.key, date: '2026-11-19' }));
  const merged = { ...base, ...p };
  merged.multiDay = merged.endDate != null && merged.date != null && merged.endDate > merged.date;
  return merged;
}

describe('keyBetween', () => {
  it('generates ordered keys in the normal cases', () => {
    const k = keyBetween(null, null);
    expect(k).toBe('a0');
    const after = keyBetween('a0', null);
    expect(after > 'a0').toBe(true);
    const before = keyBetween(null, 'a0');
    expect(before < 'a0').toBe(true);
    const mid = keyBetween('a0', 'a1');
    expect(mid > 'a0' && mid < 'a1').toBe(true);
    expect(keyAtStart(null)).toBe('a0');
    expect(keyAtEnd(null)).toBe('a0');
    expect(keyAtStart('a0') < 'a0').toBe(true);
    expect(keyAtEnd('a0') > 'a0').toBe(true);
  });

  it('never throws: equal bounds → just above a', () => {
    const k = keyBetween('a0', 'a0');
    expect(k > 'a0').toBe(true);
    expect(k < 'a1').toBe(true);
    expect(isValidOrderKey(k)).toBe(true);
  });

  it('never throws: reversed bounds → after a', () => {
    const k = keyBetween('a5', 'a2');
    expect(k > 'a5').toBe(true);
    expect(isValidOrderKey(k)).toBe(true);
  });

  it('never throws: malformed bounds are treated as open', () => {
    for (const bad of ['', 'a', '!!', 'a00', 'A00000000000000000000000000', 'é1', ' a0', 'a0 ']) {
      expect(isValidOrderKey(bad)).toBe(false);
      expect(() => keyBetween(bad, 'a1')).not.toThrow();
      expect(keyBetween(bad, 'a1') < 'a1').toBe(true);
      expect(keyBetween('a1', bad) > 'a1').toBe(true);
      expect(isValidOrderKey(keyBetween(bad, bad))).toBe(true);
    }
    expect(keyBetween(undefined as unknown as null, 5 as unknown as null)).toBe('a0');
  });

  it('property: repeated inserts at random positions keep a strictly sorted, valid list', () => {
    const r = rng(8);
    const list: string[] = [];
    for (let i = 0; i < 600; i++) {
      const pos = randInt(r, 0, list.length);
      const k = keyBetween(list[pos - 1] ?? null, list[pos] ?? null);
      expect(isValidOrderKey(k)).toBe(true);
      list.splice(pos, 0, k);
    }
    for (let i = 1; i < list.length; i++) expect((list[i - 1] as string) < (list[i] as string)).toBe(true);
  });

  it('property: inserting between duplicates lands between them and the next distinct key', () => {
    const r = rng(9);
    for (let i = 0; i < 100; i++) {
      let a = keyBetween(null, null);
      for (let j = randInt(r, 0, 20); j > 0; j--) a = keyBetween(a, null);
      const next = keyBetween(a, null);
      const k = keyBetween(a, a);
      expect(k > a && k < next).toBe(true);
    }
  });
});

describe('compareInDay', () => {
  it('multi-day first (earlier start, then longer), then untimed by order, then timed by time', () => {
    const items = [
      occ({ key: 't2', time: '15:00', order: 'a0' }),
      occ({ key: 'u2', order: 'a2' }),
      occ({ key: 'm2', date: '2026-11-18', endDate: '2026-11-20' }),
      occ({ key: 't1', time: '09:00', order: 'a9' }),
      occ({ key: 'u1', order: 'a1' }),
      occ({ key: 'm1', date: '2026-11-17', endDate: '2026-11-19' }),
      occ({ key: 'm3', date: '2026-11-18', endDate: '2026-11-25' }),
      occ({ key: 't3', time: '15:00', order: 'a1' }),
    ];
    expect(items.sort(compareInDay).map((o) => o.key)).toEqual(['m1', 'm3', 'm2', 'u1', 'u2', 't1', 't2', 't3']);
  });

  it('falls back to key for full ties and is antisymmetric', () => {
    const a = occ({ key: 'a', order: 'a0' });
    const b = occ({ key: 'b', order: 'a0' });
    expect(compareInDay(a, b)).toBe(-1);
    expect(compareInDay(b, a)).toBe(1);
    expect(compareInDay(a, a)).toBe(0);
  });

  it('uses code-unit (not locale) order for keys: "Zz" < "a0"', () => {
    const a = occ({ key: 'x', order: 'a0' });
    const b = occ({ key: 'y', order: 'Zz' });
    expect(compareInDay(b, a)).toBeLessThan(0);
  });

  it('property: total order (antisymmetric + transitive on random sets)', () => {
    const r = rng(12);
    const pool: Occurrence[] = [];
    for (let i = 0; i < 60; i++) {
      const kind = randInt(r, 0, 2);
      pool.push(
        occ({
          key: `k${i}`,
          order: `a${randInt(r, 0, 5)}`,
          time: kind === 2 ? `${String(randInt(r, 8, 10)).padStart(2, '0')}:00` : null,
          date: kind === 0 ? `2026-11-1${randInt(r, 5, 9)}` : '2026-11-19',
          endDate: kind === 0 ? `2026-11-2${randInt(r, 0, 3)}` : '2026-11-19',
        }),
      );
    }
    for (const a of pool) {
      for (const b of pool) {
        expect(Math.sign(compareInDay(a, b)) + Math.sign(compareInDay(b, a))).toBe(0);
        if (a !== b) expect(compareInDay(a, b)).not.toBe(0);
      }
    }
    const sorted = [...pool].sort(compareInDay);
    for (let i = 1; i < sorted.length; i++) expect(compareInDay(sorted[i - 1] as Occurrence, sorted[i] as Occurrence)).toBeLessThan(0);
  });
});

describe('compareInbox', () => {
  it('orders by order then id', () => {
    const ts = [
      mkTask({ id: 'c', order: 'a1' }),
      mkTask({ id: 'b', order: 'a0' }),
      mkTask({ id: 'a', order: 'a1' }),
      mkTask({ id: 'd', order: 'Zz' }),
    ];
    expect(ts.sort(compareInbox).map((t) => t.id)).toEqual(['d', 'b', 'a', 'c']);
  });
});
