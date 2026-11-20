// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { weekDates } from '@shared/dates';
import { createTask, renameTask, setDragging, showToast } from '@/store/actions';
import { createInitialState, useStore } from '@/store/store';
import {
  useBadgeCount,
  useInboxTasks,
  useOccurrence,
  useOccurrencesInRange,
  useTask,
  useTaskGroups,
  useTasksList,
  useWeekLayout,
} from '@/store/selectors';
import { startClock } from '@/store/clock';
import { bootData, getRepo } from '@/data/boot';
import { setup, teardownAll, until } from './helpers';

// Local mode regardless of any Firebase config in the developer's .env files.
vi.mock('@/data/env', () => ({ firebaseConfigured: false, firebaseOptions: {} }));

describe('selector hooks (React)', () => {
  beforeEach(async () => {
    await setup();
  });
  afterEach(() => {
    teardownAll();
    vi.restoreAllMocks();
  });

  it('do not re-render on unrelated store changes and never warn about unstable snapshots', () => {
    const errors = vi.spyOn(console, 'error');
    const id = createTask({ title: 'a', date: '2026-11-19' });
    let renders = 0;
    const days = weekDates('2026-11-16');
    const { result } = renderHook(() => {
      renders++;
      return {
        groups: useTaskGroups(),
        layout: useWeekLayout(days),
        inbox: useInboxTasks(),
        range: useOccurrencesInRange('2026-11-16', '2026-11-22'),
        list: useTasksList(),
        badge: useBadgeCount(),
        task: useTask(id),
        occ: useOccurrence({ taskId: id, origDate: null }),
      };
    });
    const first = result.current;
    const rendersAfterMount = renders;
    expect(first.layout.singles['2026-11-19']?.[0]).toBe(first.occ);
    expect(first.badge).toBe(1);

    act(() => {
      showToast('unrelated');
      setDragging({ occKey: id, source: 'calendar', recurring: false });
      setDragging(null);
    });
    expect(renders).toBe(rendersAfterMount);

    act(() => {
      renameTask(id, 'b');
    });
    expect(renders).toBeGreaterThan(rendersAfterMount);
    expect(result.current.occ?.title).toBe('b');
    expect(result.current.layout).not.toBe(first.layout);
    expect(result.current.inbox).toBe(first.inbox);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('bootData (local mode)', () => {
  afterEach(() => {
    teardownAll();
  });

  it('signs in the local user, loads tasks, tracks online state, and cleans up', async () => {
    useStore.setState(createInitialState(), true);
    const cleanup = bootData();
    expect(useStore.getState()).toMatchObject({ mode: 'local', authReady: true, user: { uid: 'local', email: null } });
    await until(() => useStore.getState().tasksLoaded);
    expect(getRepo()?.kind).toBe('local');

    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(useStore.getState().sync.online).toBe(false);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(useStore.getState().sync.online).toBe(true);

    cleanup();
    expect(getRepo()).toBeNull();
    online.mockRestore();
  });
});

describe('startClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rolls today over at local midnight and on resume', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 19, 23, 59, 58));
    useStore.setState({ today: '2000-01-01' });
    const stop = startClock();
    expect(useStore.getState().today).toBe('2026-11-19');
    vi.advanceTimersByTime(3000);
    expect(useStore.getState().today).toBe('2026-11-20');

    // Device slept through a whole day; resuming refreshes immediately.
    vi.setSystemTime(new Date(2026, 10, 22, 8, 0, 0));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useStore.getState().today).toBe('2026-11-22');

    stop();
    vi.setSystemTime(new Date(2026, 10, 25, 8, 0, 0));
    window.dispatchEvent(new Event('focus'));
    expect(useStore.getState().today).toBe('2026-11-22');
  });
});
