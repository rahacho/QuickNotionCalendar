// @vitest-environment jsdom
/**
 * Custom repeat panel (review B2): browsing the unit <select> writes nothing; the unit applies with
 * Done / the next applied control / closing the panel.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getOccurrence } from '@shared/occurrences';
import { createTask } from '@/store/actions';
import { useStore } from '@/store/store';
import { setup, task, teardownAll } from '@/store/__tests__/helpers';
import { RepeatEditor } from './RepeatEditor';
import { resetRepeatMemory } from './pickerUtils';

vi.mock('@/data/env', () => ({ firebaseConfigured: false, firebaseOptions: {} }));

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  teardownAll();
  resetRepeatMemory();
  vi.restoreAllMocks();
});

async function renderCustom() {
  await setup();
  const id = createTask({ title: 'Team sync', date: '2026-11-05', recurrence: { freq: 'weekly', interval: 1, byWeekday: [4] } });
  useStore.setState({ ui: { ...useStore.getState().ui, peek: { taskId: id, origDate: '2026-12-03' } } });
  const occ = getOccurrence(task(id), '2026-12-03');
  if (!occ) throw new Error('no occurrence');
  const onDone = vi.fn();
  const view = render(<RepeatEditor occ={occ} initialView="custom" onDone={onDone} />);
  return { id, onDone, view };
}

describe('CustomRepeat unit select', () => {
  it('weeks → months → weeks then Done changes nothing', async () => {
    const { id, onDone } = await renderCustom();
    const before = task(id);
    const unit = screen.getByTestId('repeat-freq');
    act(() => {
      fireEvent.change(unit, { target: { value: 'monthly' } });
    });
    expect(task(id)).toBe(before); // nothing written while browsing
    expect(screen.getByTestId('repeat-summary').textContent).toBe('Every month on the 3rd');
    act(() => {
      fireEvent.change(unit, { target: { value: 'weekly' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('repeat-custom-done'));
    });
    expect(onDone).toHaveBeenCalled();
    expect(task(id).date).toBe('2026-11-05');
    expect(task(id).recurrence).toMatchObject({ freq: 'weekly', interval: 1, byWeekday: [4] });
  });

  it('a unit left on "months" applies when the panel closes', async () => {
    const { id, view } = await renderCustom();
    act(() => {
      fireEvent.change(screen.getByTestId('repeat-freq'), { target: { value: 'monthly' } });
    });
    expect(task(id).recurrence?.freq).toBe('weekly');
    view.unmount();
    expect(task(id).recurrence?.freq).toBe('monthly');
    // Moved only to the first "3rd" on/after today (Nov 19), i.e. the viewed Dec 3 itself.
    expect(task(id).date).toBe('2026-12-03');
  });
});
