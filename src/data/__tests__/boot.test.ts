// @vitest-environment jsdom
/**
 * connectRepo (boot.ts) regression tests — review findings A1 (derived remindAt / summaryAt written
 * from stale copies) and B4 (time zone only synced on a cold start).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, Task, UserDoc } from '@shared/types';
import { computeRemindAt, nextSummaryAt, zonedInstant } from '@shared/reminders';
import type { Repo, RepoOp, SnapshotMeta } from '@/data/repo';
import { applyOps } from '@/data/taskDoc';
import { connectRepo } from '@/data/boot';
import { createInitialState, useStore } from '@/store/store';
import { clearUndo } from '@/store/undo';

const zone = vi.hoisted(() => ({ current: 'America/New_York' }));
vi.mock('@/data/taskDoc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/taskDoc')>()),
  deviceTimeZone: () => zone.current,
}));

const CACHE: SnapshotMeta = { fromCache: true, hasPendingWrites: false };
const SERVER: SnapshotMeta = { fromCache: false, hasPendingWrites: false };
const NOW = Date.UTC(2026, 10, 19, 15, 0, 0); // 10:00 New York

/** A Firestore-like repo whose snapshots the test delivers by hand. */
class ManualRepo implements Repo {
  readonly kind: 'firebase' | 'local';
  ops: RepoOp[] = [];
  userPatches: Array<{ settings?: Partial<Settings>; summaryAt?: number | null }> = [];
  tasks: Record<string, Task> = {};
  private onTasks: ((t: Record<string, Task>, m: SnapshotMeta) => void) | null = null;
  private onUser: ((d: UserDoc | null, m?: SnapshotMeta) => void) | null = null;
  constructor(kind: 'firebase' | 'local' = 'firebase') {
    this.kind = kind;
  }
  subscribeTasks(onChange: (t: Record<string, Task>, m: SnapshotMeta) => void): () => void {
    this.onTasks = onChange;
    return () => undefined;
  }
  subscribeUser(onChange: (d: UserDoc | null, m?: SnapshotMeta) => void): () => void {
    this.onUser = onChange;
    return () => undefined;
  }
  emitTasks(tasks: Task[], meta: SnapshotMeta): void {
    this.tasks = Object.fromEntries(tasks.map((t) => [t.id, t]));
    this.onTasks?.(this.tasks, meta);
  }
  emitUser(doc: UserDoc, meta: SnapshotMeta): void {
    this.onUser?.(doc, meta);
  }
  apply(ops: RepoOp[]): void {
    this.ops.push(...ops);
    this.tasks = applyOps(this.tasks, ops, Date.now());
    this.onTasks?.(this.tasks, { fromCache: false, hasPendingWrites: true });
  }
  updateUser(patch: { settings?: Partial<Settings>; summaryAt?: number | null }): void {
    this.userPatches.push(patch);
  }
  saveDevice(): Promise<void> {
    return Promise.resolve();
  }
  deleteDevice(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): void {}
}

function mk(over: Partial<Task>): Task {
  return {
    id: 'dentist',
    title: 'Dentist',
    date: '2026-11-25',
    endDate: null,
    time: '09:00',
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

function user(timezone: string, summary = { enabled: true, time: '08:00' }, summaryAt: number | null = null): UserDoc {
  return { settings: { weekStart: 1, summary, timezone }, summaryAt, updatedAt: 1 };
}

/** Pretends the device is in `tz`. */
function deviceZone(tz: string): void {
  zone.current = tz;
}

const remindAtPatches = (repo: ManualRepo) =>
  repo.ops.filter((o) => o.type === 'update').map((o) => (o.type === 'update' ? [o.id, o.patch.fields?.remindAt] : null));

let disconnect: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  clearUndo();
  useStore.setState(createInitialState(), true);
  useStore.setState({ mode: 'firebase', authReady: true, user: { uid: 'u1', email: null } });
});

afterEach(() => {
  disconnect?.();
  disconnect = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('A1: time-zone sync waits for server data', () => {
  it('a cached (possibly stale) snapshot never triggers the time-zone rewrite', () => {
    deviceZone('Europe/London');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    const cached = mk({ date: '2026-11-25' });
    cached.remindAt = computeRemindAt(cached, 'America/New_York', NOW);
    repo.emitTasks([cached], CACHE);
    repo.emitUser(user('America/New_York'), CACHE);
    expect(repo.ops).toEqual([]);
    expect(repo.userPatches).toEqual([]);
    expect(useStore.getState().settings.timezone).toBe('America/New_York');

    // Server truth: the task was moved to Nov 20 on another device (already in London time).
    const server = mk({ date: '2026-11-20' });
    server.remindAt = computeRemindAt(server, 'America/New_York', NOW);
    repo.emitTasks([server], SERVER);
    expect(repo.userPatches).toEqual([]); // the user doc is still the cached one
    repo.emitUser(user('America/New_York'), SERVER);
    expect(useStore.getState().settings.timezone).toBe('Europe/London');
    // The zone change (and the summaryAt computed in it) is the last write to the user doc.
    expect(repo.userPatches.at(-1)).toEqual({
      settings: { timezone: 'Europe/London' },
      summaryAt: nextSummaryAt({ weekStart: 1, summary: { enabled: true, time: '08:00' }, timezone: 'Europe/London' }, NOW),
    });
    // remindAt is computed from the SERVER copy (Nov 20), in the new zone.
    expect(remindAtPatches(repo)).toEqual([['dentist', zonedInstant('2026-11-20', '09:00', 'Europe/London')]]);
  });

  it('a server user doc without a time zone (read as UTC, like the function does) gets the device zone', () => {
    deviceZone('Asia/Tokyo');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    repo.emitTasks([], SERVER);
    repo.emitUser(user('UTC'), SERVER);
    expect(useStore.getState().settings.timezone).toBe('Asia/Tokyo');
  });
});

describe('A1: derived fields left wrong by a merge are repaired from server data', () => {
  it('a too-late remindAt (merge of two devices’ edits) is lowered; due / correct / too-early ones are left alone', () => {
    deviceZone('America/New_York');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    repo.emitUser(user('America/New_York', { enabled: false, time: '08:00' }), SERVER);
    const merged = mk({ id: 'merged', date: '2026-11-20', time: '10:00', remindAt: zonedInstant('2026-11-25', '10:00', 'America/New_York') });
    const missing = mk({ id: 'missing', date: '2026-11-21', remindAt: null });
    const due = mk({ id: 'due', date: '2026-11-19', time: '09:59', remindAt: NOW - 60_000 });
    const ok = mk({ id: 'ok', date: '2026-11-22' });
    ok.remindAt = computeRemindAt(ok, 'America/New_York', NOW);
    const early = mk({ id: 'early', date: '2026-11-23', remindAt: zonedInstant('2026-11-20', '09:00', 'America/New_York') });
    repo.emitTasks([merged, missing, due, ok, early], SERVER);
    expect(remindAtPatches(repo)).toEqual([
      ['merged', zonedInstant('2026-11-20', '10:00', 'America/New_York')],
      ['missing', zonedInstant('2026-11-21', '09:00', 'America/New_York')],
    ]);
    // The repaired versions are not "repaired" again (no loop), and nothing is written twice.
    repo.emitTasks(Object.values(repo.tasks), SERVER);
    expect(repo.ops).toHaveLength(2);
  });

  it('cached or pending snapshots are never used for repairs; local mode never repairs', () => {
    deviceZone('America/New_York');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    repo.emitUser(user('America/New_York', { enabled: false, time: '08:00' }), SERVER);
    const wrong = mk({ remindAt: null, date: '2026-11-20' });
    repo.emitTasks([wrong], CACHE);
    repo.emitTasks([wrong], { fromCache: false, hasPendingWrites: true });
    expect(repo.ops).toEqual([]);
    disconnect();

    const local = new ManualRepo('local');
    disconnect = connectRepo(local);
    local.emitUser(user('America/New_York'), SERVER);
    local.emitTasks([wrong], SERVER);
    expect(local.ops).toEqual([]);
    expect(local.userPatches).toEqual([]);
  });

  it('summary ON on the server but summaryAt null (written from a stale "off" cache) is re-armed', () => {
    deviceZone('America/New_York');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    repo.emitTasks([], SERVER);
    repo.emitUser(user('America/New_York', { enabled: false, time: '08:00' }, null), CACHE);
    expect(repo.userPatches).toEqual([]);
    const server = user('America/New_York', { enabled: true, time: '08:00' }, null);
    repo.emitUser(server, SERVER);
    expect(repo.userPatches).toEqual([{ summaryAt: nextSummaryAt(server.settings, NOW) }]);
    // Consistent (or due) values are left alone.
    repo.userPatches.length = 0;
    repo.emitUser({ ...server, summaryAt: nextSummaryAt(server.settings, NOW) }, SERVER);
    repo.emitUser({ ...server, summaryAt: NOW - 1 }, SERVER);
    expect(repo.userPatches).toEqual([]);
  });

  it('a device whose clock is behind never re-arms the summary that just went out', () => {
    deviceZone('America/New_York');
    const eight = zonedInstant('2026-11-20', '08:00', 'America/New_York');
    const settings = { weekStart: 1 as const, summary: { enabled: true, time: '08:00' }, timezone: 'America/New_York' };
    // The function sent today's summary at 08:00:05 and moved summaryAt to tomorrow; this phone's
    // clock still reads 07:59:51 when that snapshot arrives.
    vi.setSystemTime(eight - 9_000);
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    repo.emitTasks([], SERVER);
    repo.emitUser({ settings, summaryAt: nextSummaryAt(settings, eight), updatedAt: 1 }, SERVER);
    expect(repo.userPatches).toEqual([]);
  });
});

describe('B4: the time zone follows the device when the app is resumed after travel', () => {
  it('resume / focus in a new zone updates settings.timezone and every remindAt', () => {
    deviceZone('America/New_York');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    const t = mk({ date: '2026-11-25' });
    t.remindAt = computeRemindAt(t, 'America/New_York', NOW);
    repo.emitTasks([t], SERVER);
    repo.emitUser(user('America/New_York', { enabled: false, time: '08:00' }), SERVER);
    expect(repo.userPatches).toEqual([]);

    deviceZone('Europe/London');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useStore.getState().settings.timezone).toBe('Europe/London');
    expect(repo.userPatches.at(-1)?.settings).toEqual({ timezone: 'Europe/London' });
    expect(remindAtPatches(repo)).toEqual([['dentist', zonedInstant('2026-11-25', '09:00', 'Europe/London')]]);
  });

  it("a device that did not move doesn't fight the zone another device set", () => {
    deviceZone('America/New_York');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    repo.emitTasks([], SERVER);
    repo.emitUser(user('America/New_York'), SERVER);
    // The phone abroad pushed London.
    repo.emitUser(user('Europe/London'), SERVER);
    window.dispatchEvent(new Event('focus'));
    expect(useStore.getState().settings.timezone).toBe('Europe/London');
    expect(repo.userPatches.filter((p) => p.settings)).toEqual([]);
  });

  it('nothing happens before server data has arrived (offline launch)', () => {
    deviceZone('America/New_York');
    const repo = new ManualRepo();
    disconnect = connectRepo(repo);
    repo.emitTasks([], CACHE);
    repo.emitUser(user('Asia/Tokyo'), CACHE);
    window.dispatchEvent(new Event('focus'));
    expect(repo.userPatches).toEqual([]);
  });
});
