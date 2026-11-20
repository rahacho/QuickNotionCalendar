// @vitest-environment jsdom
/**
 * Review E6: signing out turns push off on this device (its device doc can't be deleted once signed
 * out). Signing in again must turn it back on by itself, or the owner's reminders silently stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DeviceDoc } from '@shared/types';
import { createInitialState, useStore } from '@/store/store';

const RESUME_KEY = 'tasks.push.resumeOnSignIn';

const h = vi.hoisted(() => {
  const fakeSub = {
    endpoint: 'https://push.example/device-1',
    options: { applicationServerKey: new ArrayBuffer(65) },
    unsubscribe: async () => true,
  };
  const state = {
    current: null as typeof fakeSub | null,
    record: null as null | { uid: string; endpoint: string; createdAt: number; savedAt: number },
    subscribeFails: false,
  };
  const subscribe = async () => {
    if (state.subscribeFails) throw new Error('NotAllowedError');
    state.current = fakeSub;
    return fakeSub;
  };
  const pushManager = {
    getSubscription: async () => state.current,
    subscribe: (..._args: unknown[]) => subscribe(),
  };
  return {
    state,
    pushManager,
    saveDevice: (..._args: unknown[]) => Promise.resolve(),
    deleteDevice: (..._args: unknown[]) => Promise.resolve(),
  };
});

const saveDevice = vi.fn((_id: string, _doc: DeviceDoc) => h.saveDevice());
const subscribe = vi.spyOn(h.pushManager, 'subscribe');

vi.mock('@/data/boot', () => ({
  getRepo: () => ({ kind: 'firebase', saveDevice, deleteDevice: () => h.deleteDevice() }),
}));

vi.mock('./support', () => ({
  pushConfigured: true,
  vapidKey: new Uint8Array(65),
  environmentState: () => null,
  notificationPermission: () => 'granted',
  requestNotificationPermission: async () => 'granted',
  getActiveRegistration: async () => ({ pushManager: h.pushManager }),
  getDeviceId: () => 'device-1',
  isOurKey: () => true,
  readDeviceRecord: () => h.state.record,
  writeDeviceRecord: (r: typeof h.state.record) => {
    h.state.record = r;
  },
  subscriptionJSON: (sub: { endpoint: string }) => ({ endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
  within: <T,>(p: Promise<T>) => p,
}));

const { disablePush, useBadgeSync, usePushState } = await import('./index');

function signIn(uid: string): void {
  useStore.setState({ mode: 'firebase', authReady: true, user: { uid, email: null }, tasksLoaded: true });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  useStore.setState(createInitialState(), true);
  localStorage.clear();
  h.state.current = null;
  h.state.record = null;
  h.state.subscribeFails = false;
  saveDevice.mockClear();
  subscribe.mockClear();
});

afterEach(() => {
  localStorage.clear();
});

describe('E6: push comes back after sign-out → sign-in on the same device', () => {
  it('permission granted, no subscription, no device record, resume flag set → subscribes, saves, clears the flag', async () => {
    localStorage.setItem(RESUME_KEY, '1');
    signIn('owner');
    const { unmount } = renderHook(() => useBadgeSync());
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(saveDevice).toHaveBeenCalledTimes(1);
    expect(saveDevice.mock.calls[0]?.[0]).toBe('device-1');
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
    expect(h.state.record?.uid).toBe('owner');
    const { result } = renderHook(() => usePushState());
    expect(result.current).toBe('subscribed');
    unmount();
  });

  it('without the flag a device that never had push stays off', async () => {
    signIn('owner');
    const { unmount } = renderHook(() => useBadgeSync());
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(saveDevice).not.toHaveBeenCalled();
    unmount();
  });

  it('sign-out with push on sets the flag; Settings → Turn off clears it', async () => {
    signIn('owner');
    h.state.current = { endpoint: 'https://push.example/device-1', options: { applicationServerKey: new ArrayBuffer(65) }, unsubscribe: async () => true };
    h.state.record = { uid: 'owner', endpoint: 'https://push.example/device-1', createdAt: 1, savedAt: 1 };
    await disablePush({ resumeOnSignIn: true });
    expect(localStorage.getItem(RESUME_KEY)).toBe('1');
    await disablePush();
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it('sign-out on a device where push was off never turns it on later', async () => {
    signIn('owner');
    await disablePush({ resumeOnSignIn: true });
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it('a refused subscribe (no user gesture on WebKit) clears the flag and reports an error, not a silent Off', async () => {
    localStorage.setItem(RESUME_KEY, '1');
    h.state.subscribeFails = true;
    signIn('owner');
    const { unmount } = renderHook(() => useBadgeSync());
    await flush();
    expect(saveDevice).not.toHaveBeenCalled();
    expect(localStorage.getItem(RESUME_KEY)).toBeNull();
    const { result } = renderHook(() => usePushState());
    expect(result.current).toBe('error');
    unmount();
  });
});
