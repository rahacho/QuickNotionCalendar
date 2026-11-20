// @vitest-environment jsdom
/**
 * Sign-out never strands planned tasks silently (review A7): queued task changes get a moment to
 * reach the server, and if they can't, the user is asked before signing out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInitialState, useStore } from '@/store/store';

const signOutUser = vi.fn(async () => undefined);
const disablePush = vi.fn(async () => undefined);

vi.mock('@/data/env', () => ({ firebaseConfigured: false, firebaseOptions: {} }));
vi.mock('@/data/auth', () => ({
  signOutUser: () => signOutUser(),
  authErrorMessage: () => 'Something went wrong. Try again.',
}));
vi.mock('@/push', () => ({
  pushConfigured: true,
  usePushState: () => 'subscribed',
  enablePush: vi.fn(async () => 'subscribed'),
  disablePush: () => disablePush(),
  showLocalTestNotification: vi.fn(async () => true),
}));

const { SettingsModal } = await import('./SettingsModal');
const { waitForTaskSync } = await import('./waitForTaskSync');

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

function signedIn(sync: { pendingWrites: boolean; online: boolean }): void {
  const base = createInitialState();
  useStore.setState(
    {
      ...base,
      mode: 'firebase',
      authReady: true,
      tasksLoaded: true,
      user: { uid: 'u1', email: 'me@example.com' },
      sync: { ...base.sync, ...sync },
      ui: { ...base.ui, settingsOpen: true },
    },
    true,
  );
}

const setSync = (patch: Partial<{ pendingWrites: boolean; online: boolean }>) =>
  act(() => {
    useStore.setState({ sync: { ...useStore.getState().sync, ...patch } });
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  signOutUser.mockClear();
  disablePush.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('waitForTaskSync', () => {
  it('is immediate when nothing is queued, false at once when offline', async () => {
    signedIn({ pendingWrites: false, online: true });
    await expect(waitForTaskSync(5000)).resolves.toBe(true);
    signedIn({ pendingWrites: true, online: false });
    await expect(waitForTaskSync(5000)).resolves.toBe(false);
  });
});

describe('Settings → Sign out', () => {
  it('signs out right away when every change has synced', async () => {
    signedIn({ pendingWrites: false, online: true });
    render(<SettingsModal />);
    fireEvent.click(screen.getByTestId('sign-out'));
    await flush();
    expect(disablePush).toHaveBeenCalledTimes(1);
    expect(signOutUser).toHaveBeenCalledTimes(1);
  });

  it('waits for queued changes to sync before signing out', async () => {
    signedIn({ pendingWrites: true, online: true });
    render(<SettingsModal />);
    fireEvent.click(screen.getByTestId('sign-out'));
    await flush();
    expect(screen.getByTestId('sign-out').textContent).toBe('Syncing…');
    expect(signOutUser).not.toHaveBeenCalled();
    setSync({ pendingWrites: false });
    await flush();
    expect(signOutUser).toHaveBeenCalledTimes(1);
  });

  it('asks before signing out when changes can’t sync, and Cancel keeps the session', async () => {
    signedIn({ pendingWrites: true, online: true });
    render(<SettingsModal />);
    fireEvent.click(screen.getByTestId('sign-out'));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await flush();
    expect(signOutUser).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-out-pending').textContent).toContain('haven’t synced yet');
    fireEvent.click(screen.getByTestId('sign-out-cancel'));
    await flush();
    expect(signOutUser).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-out')).toBeTruthy();
  });

  it('offline: asks at once; "Sign out anyway" signs out', async () => {
    signedIn({ pendingWrites: true, online: false });
    render(<SettingsModal />);
    fireEvent.click(screen.getByTestId('sign-out'));
    await flush();
    expect(screen.getByTestId('sign-out-pending').textContent).toContain('You’re offline.');
    expect(signOutUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sign-out-confirm'));
    await flush();
    expect(signOutUser).toHaveBeenCalledTimes(1);
  });
});
