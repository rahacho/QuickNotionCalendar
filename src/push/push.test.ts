// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/types';
import { createInitialState, useStore } from '@/store/store';
import { base64UrlToBytes, bytesToBase64Url, iosVersion, subscriptionJSON } from './support';
import { isSWToClientMessage } from './messages';
import { openTaskLink, parseTaskLink, resolveOrigDate } from './openLink';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    date: '2026-11-19',
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

describe('support', () => {
  it('round-trips base64url and rejects garbage', () => {
    const key = 'BKYU4IZEU17xK7-rSC5O-K46Bv4lnEiEIpQL450aeD2atZEVLuztiCAUNYHSp3_MPSBMyQkuHhJInlOKo1Hx3FY';
    const bytes = base64UrlToBytes(key);
    expect(bytes?.length).toBe(65);
    expect(bytes?.[0]).toBe(4);
    expect(bytesToBase64Url(bytes as Uint8Array)).toBe(key);
    expect(base64UrlToBytes('not base64 !!')).toBeNull();
    expect(base64UrlToBytes('')).toBeNull();
  });

  it('reads the iOS version from Safari user agents', () => {
    expect(iosVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1')).toBe(17.04);
    expect(iosVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 16_3_1 like Mac OS X) AppleWebKit/605.1.15')).toBe(16.03);
    expect(iosVersion('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/16.4 Safari/605.1.15')).toBe(16.04);
    expect(iosVersion('Mozilla/5.0 (X11; Linux x86_64)')).toBeNull();
  });

  it('serialises a PushSubscription for the device doc', () => {
    const fromJson = {
      endpoint: 'https://push.example/1',
      expirationTime: null,
      toJSON: () => ({ endpoint: 'https://push.example/1', expirationTime: null, keys: { p256dh: 'P', auth: 'A' } }),
      getKey: () => null,
    } as unknown as PushSubscription;
    expect(subscriptionJSON(fromJson)).toEqual({ endpoint: 'https://push.example/1', expirationTime: null, keys: { p256dh: 'P', auth: 'A' } });

    const fromKeys = {
      endpoint: 'https://push.example/2',
      expirationTime: 123,
      toJSON: () => ({}),
      getKey: (name: string) => new Uint8Array(name === 'auth' ? [1, 2, 3] : [4, 5, 6]).buffer,
    } as unknown as PushSubscription;
    expect(subscriptionJSON(fromKeys)).toEqual({ endpoint: 'https://push.example/2', expirationTime: 123, keys: { p256dh: 'BAUG', auth: 'AQID' } });

    const broken = { endpoint: '', toJSON: () => ({}), getKey: () => null } as unknown as PushSubscription;
    expect(subscriptionJSON(broken)).toBeNull();
  });

  it('recognises worker → page messages', () => {
    expect(isSWToClientMessage({ type: 'open', url: '/?task=a' })).toBe(true);
    expect(isSWToClientMessage({ type: 'push-subscription-changed' })).toBe(true);
    expect(isSWToClientMessage({ type: 'open' })).toBe(false);
    expect(isSWToClientMessage('open')).toBe(false);
    expect(isSWToClientMessage(null)).toBe(false);
  });
});

describe('notification deep links', () => {
  const weekly = task('rep', {
    recurrence: { freq: 'daily', interval: 1 },
    overrides: { '2026-11-20': { date: '2026-11-22' }, '2026-11-21': { skipped: true } },
  });

  it('parses same-origin task links only', () => {
    const base = 'https://tasks.example/';
    expect(parseTaskLink('/?task=abc&occ=2026-11-19', base)).toEqual({ taskId: 'abc', occ: '2026-11-19' });
    expect(parseTaskLink('https://tasks.example/?task=abc', base)).toEqual({ taskId: 'abc', occ: null });
    expect(parseTaskLink('https://evil.example/?task=abc', base)).toBeNull();
    expect(parseTaskLink('/', base)).toBeNull();
  });

  it('maps occ (rule date or moved-to date) to the occurrence', () => {
    expect(resolveOrigDate(task('one'), '2026-11-19')).toBeNull();
    expect(resolveOrigDate(task('one'), null)).toBeNull();
    expect(resolveOrigDate(weekly, '2026-11-19')).toBe('2026-11-19');
    expect(resolveOrigDate(weekly, '2026-11-20')).toBe('2026-11-20'); // original rule date of a moved occurrence
    expect(resolveOrigDate(weekly, '2026-11-22')).toBe('2026-11-22'); // the 22nd's own occurrence wins
    expect(resolveOrigDate(weekly, '2026-11-21')).toBeUndefined(); // deleted occurrence
    expect(resolveOrigDate(weekly, 'garbage')).toBeUndefined();
  });

  describe('openTaskLink', () => {
    beforeEach(() => {
      useStore.setState(createInitialState(), true);
      useStore.setState({ mode: 'local', authReady: true, user: { uid: 'local', email: null }, tasksLoaded: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens the peek for an existing task', () => {
      useStore.setState({ tasks: { a: task('a') } });
      openTaskLink('/?task=a&occ=2026-11-19');
      expect(useStore.getState().ui.peek).toEqual({ taskId: 'a', origDate: null });
    });

    it('opens a repeating occurrence by its original date', () => {
      useStore.setState({ tasks: { rep: weekly } });
      openTaskLink('/?task=rep&occ=2026-11-20');
      expect(useStore.getState().ui.peek).toEqual({ taskId: 'rep', origDate: '2026-11-20' });
    });

    it('waits for a task that is still syncing, then opens it', () => {
      vi.useFakeTimers();
      openTaskLink('/?task=late');
      expect(useStore.getState().ui.peek).toBeNull();
      useStore.setState({ tasks: { late: task('late') } });
      expect(useStore.getState().ui.peek).toEqual({ taskId: 'late', origDate: null });
      vi.advanceTimersByTime(10_000);
      expect(useStore.getState().toasts).toHaveLength(0);
    });

    it('tells you when the task no longer exists', () => {
      vi.useFakeTimers();
      openTaskLink('/?task=gone');
      vi.advanceTimersByTime(6_100);
      expect(useStore.getState().toasts.map((t) => t.message)).toEqual(['That task no longer exists']);
      expect(useStore.getState().ui.peek).toBeNull();
    });

    it('tells you immediately when the occurrence was deleted', () => {
      useStore.setState({ tasks: { rep: weekly } });
      openTaskLink('/?task=rep&occ=2026-11-21');
      expect(useStore.getState().toasts.map((t) => t.message)).toEqual(['That task no longer exists']);
    });

    it('ignores links that are not task links', () => {
      openTaskLink('/');
      openTaskLink('https://evil.example/?task=a');
      expect(useStore.getState().ui.peek).toBeNull();
      expect(useStore.getState().toasts).toHaveLength(0);
    });
  });
});
