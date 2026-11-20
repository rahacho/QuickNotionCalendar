import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from '@/store/store';
import { activeCell, setActiveCell } from './roving';

/** Review D4: the calendar is ONE tab stop — today when it is on screen, else the first day shown. */
describe('roving tab stop', () => {
  const base = useStore.getState();
  const set = (today: string, ui: Partial<typeof base.ui>) =>
    useStore.setState({ today, ui: { ...base.ui, ...ui }, settings: { ...base.settings, weekStart: 1 } });

  afterEach(() => {
    setActiveCell(null);
    useStore.setState(base, true);
  });

  it('month view: today when its month is shown, else the 1st of the shown month', () => {
    set('2026-11-19', { view: 'month', visibleMonth: '2026-11-01' });
    expect(activeCell()).toBe('2026-11-19');
    set('2026-11-19', { view: 'month', visibleMonth: '2027-02-01' });
    expect(activeCell()).toBe('2027-02-01');
  });

  it('week view: today when in the week shown, else its first day', () => {
    set('2026-11-19', { view: 'week', weekAnchor: '2026-11-17' });
    expect(activeCell()).toBe('2026-11-19');
    set('2026-11-19', { view: 'week', weekAnchor: '2026-11-25' });
    expect(activeCell()).toBe('2026-11-23');
  });

  it('the last day the keyboard used wins until focus leaves the calendar', () => {
    set('2026-11-19', { view: 'month', visibleMonth: '2026-11-01' });
    setActiveCell('2026-11-27');
    expect(activeCell()).toBe('2026-11-27');
    setActiveCell(null);
    expect(activeCell()).toBe('2026-11-19');
  });
});
