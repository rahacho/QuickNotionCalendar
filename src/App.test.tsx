// @vitest-environment jsdom
/**
 * Review A6 (gap): when the tasks listener fails before ANY data arrived (an account that isn't
 * allowlisted, a quota, a broken offline store), the app must say "Couldn't load your tasks" with a
 * way out — never a normal, empty calendar whose Tasks list says "Nothing planned".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInitialState, useStore } from '@/store/store';

const auth = vi.hoisted(() => ({ signOutUser: vi.fn(async () => undefined) }));

vi.mock('@/data/env', () => ({ firebaseConfigured: false, firebaseOptions: {} }));
vi.mock('@/data/boot', () => ({ bootData: () => () => undefined }));
vi.mock('@/data/auth', () => ({
  signOutUser: () => auth.signOutUser(),
  authErrorMessage: () => 'Something went wrong.',
}));
vi.mock('@/push', () => ({ useBadgeSync: () => undefined, pushConfigured: false, usePushState: () => 'unsupported' }));
vi.mock('@/pwa/UpdatePrompt', () => ({ UpdatePrompt: () => null }));
vi.mock('@/pwa/InstallHint', () => ({ InstallHint: () => null }));

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

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;

const { App } = await import('./App');

const NOT_ALLOWLISTED = "this account isn't allowlisted yet (docs/DEPLOY.md, step 10)";

function failedLoad(): void {
  const base = createInitialState();
  useStore.setState(
    {
      ...base,
      mode: 'firebase',
      authReady: true,
      user: { uid: 'u1', email: 'owner@example.com' },
      tasksLoaded: false,
      sync: { ...base.sync, error: NOT_ALLOWLISTED, loadFailed: true },
    },
    true,
  );
}

beforeEach(() => {
  auth.signOutUser.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('A6: a load that failed before any data', () => {
  it('says so, with the reason, Try again and Sign out — no empty calendar, no "Nothing planned"', () => {
    failedLoad();
    render(<App />);
    const state = screen.getByTestId('load-failed');
    expect(state.textContent).toContain('Couldn’t load your tasks');
    expect(state.textContent).toContain("This account isn't allowlisted yet (docs/DEPLOY.md, step 10).");
    expect(state.textContent).toContain('Signed in as owner@example.com');
    expect(screen.getByTestId('load-retry').textContent).toBe('Try again');
    expect(screen.queryByTestId('calendar')).toBeNull();
    expect(screen.queryByTestId('tasks-sidebar')).toBeNull();
    expect(document.body.textContent).not.toContain('Nothing planned');

    fireEvent.click(screen.getByTestId('load-sign-out'));
    expect(auth.signOutUser).toHaveBeenCalledTimes(1);
  });

  it('gives way to the app by itself once the tasks arrive', () => {
    failedLoad();
    render(<App />);
    expect(screen.getByTestId('load-failed')).toBeTruthy();
    act(() => {
      const s = useStore.getState();
      useStore.setState({ tasksLoaded: true, sync: { ...s.sync, error: null, loadFailed: false } });
    });
    expect(screen.queryByTestId('load-failed')).toBeNull();
    expect(screen.getByTestId('calendar')).toBeTruthy();
  });
});
