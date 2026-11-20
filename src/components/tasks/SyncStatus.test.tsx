// @vitest-environment jsdom
/**
 * Review E6: when this device can't get reminders the owner planned (push off / blocked / a failed
 * re-enable after signing in again), the Tasks list says so and leads to Settings — never silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@shared/types';
import { createInitialState, useStore } from '@/store/store';

const push = vi.hoisted(() => ({ state: 'default' as string, configured: true }));

vi.mock('@/data/env', () => ({ firebaseConfigured: false, firebaseOptions: {} }));
vi.mock('@/push', () => ({
  get pushConfigured() {
    return push.configured;
  },
  usePushState: () => push.state,
}));

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

const { SyncStatus } = await import('./SyncStatus');

function task(over: Partial<Task>): Task {
  return {
    id: 't1',
    title: 'Dentist',
    date: '2026-11-20',
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

function state(opts: { summary: boolean; tasks?: Task[] }): void {
  const base = createInitialState();
  useStore.setState(
    {
      ...base,
      mode: 'firebase',
      authReady: true,
      tasksLoaded: true,
      user: { uid: 'u1', email: null },
      settings: { ...base.settings, summary: { ...base.settings.summary, enabled: opts.summary } },
      tasks: Object.fromEntries((opts.tasks ?? []).map((t) => [t.id, t])),
    },
    true,
  );
}

const hint = () => screen.queryByTestId('push-off-hint');

beforeEach(() => {
  push.state = 'default';
  push.configured = true;
});

afterEach(() => {
  cleanup();
});

describe('push-off hint', () => {
  it('shows while push is off here and the morning summary is on; opens Settings', () => {
    state({ summary: true });
    render(<SyncStatus />);
    expect(hint()?.textContent).toContain('Reminders are off on this device');
    fireEvent.click(hint() as HTMLElement);
    expect(useStore.getState().ui.settingsOpen).toBe(true);
  });

  it('shows for a failed re-enable (error) and for blocked notifications', () => {
    state({ summary: true });
    push.state = 'error';
    const { unmount } = render(<SyncStatus />);
    expect(hint()).not.toBeNull();
    unmount();
    push.state = 'denied';
    render(<SyncStatus />);
    expect(hint()?.textContent).toContain('Notifications are blocked on this device');
  });

  it('summary off: shown only when an open task alerts on its own (timed, or a reminder at a clock time)', () => {
    const shown = (t: Task): boolean => {
      state({ summary: false, tasks: [t] });
      const r = render(<SyncStatus />);
      const on = hint() !== null;
      r.unmount();
      return on;
    };
    expect(shown(task({}))).toBe(false);
    expect(shown(task({ time: '15:00' }))).toBe(true);
    expect(shown(task({ time: '15:00', reminder: { kind: 'none' } }))).toBe(false);
    expect(shown(task({ reminder: { kind: 'at', time: '08:00', daysBefore: 0 } }))).toBe(true);
    expect(shown(task({ time: '15:00', done: true }))).toBe(false);
    expect(shown(task({ date: null }))).toBe(false);
  });

  it('hidden when push is on, unsupported here, or not configured (local mode)', () => {
    state({ summary: true });
    push.state = 'subscribed';
    const a = render(<SyncStatus />);
    expect(hint()).toBeNull();
    a.unmount();
    push.state = 'unsupported';
    const b = render(<SyncStatus />);
    expect(hint()).toBeNull();
    b.unmount();
    push.state = 'default';
    push.configured = false;
    render(<SyncStatus />);
    expect(hint()).toBeNull();
  });
});
