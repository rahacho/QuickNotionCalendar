import { describe, expect, it } from 'vitest';
import type { Occurrence, Task } from '@shared/types';
import { keyBetween } from '@shared/ordering';
import { dropPositionFor } from '../dropPosition';

function occ(key: string, order: string, time: string | null = null): Occurrence {
  return {
    key,
    taskId: key,
    origDate: null,
    date: '2026-11-19',
    endDate: '2026-11-19',
    time,
    title: key,
    order,
    done: false,
    doneAt: null,
    recurring: false,
    multiDay: false,
    task: {} as Task,
  };
}

const a = occ('a', 'a0');
const b = occ('b', 'a1');
const c = occ('c', 'a2');
const t9 = occ('t9', 'a0', '09:00');
const t9b = occ('t9b', 'a5', '09:00');
const t15 = occ('t15', 'a1', '15:00');
const moving = occ('m', 'zz');
const movingTimed = occ('mt', 'zz', '09:00');

describe('dropPositionFor — inbox', () => {
  it('returns the neighbors at the index', () => {
    expect(dropPositionFor([a, b, c], 0, moving, 'inbox')).toEqual({ pos: { prevOrder: null, nextOrder: 'a0' }, index: 0 });
    expect(dropPositionFor([a, b, c], 2, moving, 'inbox')).toEqual({ pos: { prevOrder: 'a1', nextOrder: 'a2' }, index: 2 });
    expect(dropPositionFor([a, b, c], 3, moving, 'inbox')).toEqual({ pos: { prevOrder: 'a2', nextOrder: null }, index: 3 });
  });

  it('clamps out-of-range and non-finite indexes', () => {
    expect(dropPositionFor([a, b], -4, moving, 'inbox').index).toBe(0);
    expect(dropPositionFor([a, b], 99, moving, 'inbox').index).toBe(2);
    expect(dropPositionFor([a, b], Number.NaN, moving, 'inbox').index).toBe(2);
    expect(dropPositionFor([], 0, moving, 'inbox')).toEqual({ pos: { prevOrder: null, nextOrder: null }, index: 0 });
  });
});

describe('dropPositionFor — day', () => {
  const day = [a, b, t9, t9b, t15];

  it('untimed cards land inside the untimed prefix', () => {
    expect(dropPositionFor(day, 1, moving, 'day')).toEqual({ pos: { prevOrder: 'a0', nextOrder: 'a1' }, index: 1 });
    // Dropped among the timed cards → snapped to the end of the untimed ones.
    expect(dropPositionFor(day, 4, moving, 'day')).toEqual({ pos: { prevOrder: 'a1', nextOrder: null }, index: 2 });
  });

  it('timed cards only order among cards with the same time', () => {
    expect(dropPositionFor(day, 0, movingTimed, 'day')).toEqual({ pos: { prevOrder: null, nextOrder: 'a0' }, index: 2 });
    expect(dropPositionFor(day, 3, movingTimed, 'day')).toEqual({ pos: { prevOrder: 'a0', nextOrder: 'a5' }, index: 3 });
    expect(dropPositionFor(day, 5, movingTimed, 'day')).toEqual({ pos: { prevOrder: 'a5', nextOrder: null }, index: 4 });
  });

  it('a timed card with no same-time siblings gets open bounds', () => {
    const lone = occ('x', 'zz', '12:00');
    expect(dropPositionFor(day, 2, lone, 'day').pos).toEqual({ prevOrder: null, nextOrder: null });
  });

  it('positions produce keys that sort between the neighbors', () => {
    const { pos } = dropPositionFor([a, b, c], 1, moving, 'day');
    const k = keyBetween(pos.prevOrder, pos.nextOrder);
    expect(k > 'a0' && k < 'a1').toBe(true);
  });
});
