// @vitest-environment jsdom
/**
 * FirestoreRepo regression tests (mocked SDK with server semantics) — review findings A2 (one
 * all-or-nothing batch for independent tasks), A5 (back-to-back writes), A6 / E4 (a failed listener).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/types';

interface Call {
  op: 'set' | 'update' | 'delete';
  path: string;
  args: unknown[];
}
type Obs = { next: (s: unknown) => void; error: (e: unknown) => void; dead: boolean };

const sdk = vi.hoisted(() => ({
  /** Documents the "server" has: an update of anything else fails its whole batch (NOT_FOUND). */
  serverDocs: new Set<string>(),
  committed: [] as Call[][],
  rejected: [] as Call[][],
  userWrites: [] as unknown[],
  listeners: new Map<string, Obs[]>(),
}));

vi.mock('@/data/firebase', () => ({ getFirebase: () => ({ db: { kind: 'db' } }) }));
vi.mock('firebase/firestore', () => {
  class FieldPath {
    readonly segments: string[];
    constructor(...s: string[]) {
      this.segments = s;
    }
    toString(): string {
      return this.segments.join('.');
    }
  }
  const ref = (path: string) => ({ path });
  return {
    FieldPath,
    collection: (_db: unknown, ...segs: string[]) => ref(segs.join('/')),
    doc: (base: { path?: string; kind?: string }, ...segs: string[]) =>
      ref(base.kind === 'db' ? segs.join('/') : [base.path, ...segs].join('/')),
    deleteField: () => ({ __delete: true }),
    serverTimestamp: () => ({ __serverTimestamp: true }),
    onSnapshot: (r: { path: string }, _o: unknown, obs: { next: (s: unknown) => void; error: (e: unknown) => void }) => {
      const entry: Obs = { ...obs, dead: false };
      sdk.listeners.set(r.path, [...(sdk.listeners.get(r.path) ?? []), entry]);
      return () => {
        entry.dead = true;
      };
    },
    writeBatch: () => {
      const calls: Call[] = [];
      return {
        set: (r: { path: string }, ...args: unknown[]) => calls.push({ op: 'set', path: r.path, args }),
        update: (r: { path: string }, ...args: unknown[]) => calls.push({ op: 'update', path: r.path, args }),
        delete: (r: { path: string }) => calls.push({ op: 'delete', path: r.path, args: [] }),
        commit: () => {
          if (calls.some((c) => c.op === 'update' && !sdk.serverDocs.has(c.path))) {
            sdk.rejected.push(calls);
            return Promise.reject(Object.assign(new Error('No document to update'), { code: 'not-found' }));
          }
          for (const c of calls) {
            if (c.op === 'set') sdk.serverDocs.add(c.path);
            if (c.op === 'delete') sdk.serverDocs.delete(c.path);
          }
          sdk.committed.push(calls);
          return Promise.resolve();
        },
      };
    },
    runTransaction: async () => undefined,
    setDoc: async (_r: unknown, data: unknown) => {
      sdk.userWrites.push(data);
    },
    deleteDoc: async () => undefined,
  };
});

import { createFirestoreRepo } from '@/data/firestoreRepo';
import { connectRepo } from '@/data/boot';
import { setSyncErrorHandler } from '@/data/errors';
import { createTask, deleteTask, moveAllOverdueToToday, renameTask } from '@/store/actions';
import { createInitialState, useStore } from '@/store/store';
import { clearUndo } from '@/store/undo';

const TASKS = 'users/u1/tasks';

function t(id: string, date: string | null, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    date,
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

const live = (path: string): Obs[] => (sdk.listeners.get(path) ?? []).filter((l) => !l.dead);
const snap = (docs: Task[], meta = { fromCache: false, hasPendingWrites: false }) => ({
  docChanges: () => docs.map((d) => ({ type: 'added', doc: { id: d.id, data: () => structuredClone(d) } })),
  metadata: meta,
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const reached = (): string[] =>
  sdk.committed
    .flat()
    .filter((c) => c.op === 'update')
    .map((c) => c.path)
    .sort();

let errors: string[] = [];
let recovered = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(Date.UTC(2026, 10, 19, 15));
  clearUndo();
  useStore.setState(createInitialState(), true);
  useStore.setState({ mode: 'firebase', authReady: true, user: { uid: 'u1', email: null }, today: '2026-11-19' });
  sdk.serverDocs.clear();
  sdk.committed.length = 0;
  sdk.rejected.length = 0;
  sdk.userWrites.length = 0;
  sdk.listeners.clear();
  errors = [];
  recovered = 0;
  setSyncErrorHandler({ onError: (e) => errors.push(String(e)), onRecovered: () => recovered++ });
});

afterEach(() => {
  setSyncErrorHandler(null);
  vi.useRealTimers();
});

describe('A2: independent tasks never share an all-or-nothing batch', () => {
  it('"Move all to today" still moves the tasks that exist when one was deleted elsewhere', async () => {
    const disconnect = connectRepo(createFirestoreRepo('u1'));
    live(TASKS)[0]!.next(snap([t('a', '2026-11-10'), t('b', '2026-11-12'), t('gone', '2026-11-15')], { fromCache: true, hasPendingWrites: false }));
    sdk.serverDocs.add(`${TASKS}/a`);
    sdk.serverDocs.add(`${TASKS}/b`);
    moveAllOverdueToToday();
    await flush();
    expect(reached()).toEqual([`${TASKS}/a`, `${TASKS}/b`]);
    expect(sdk.rejected.map((b) => b.map((c) => c.path))).toEqual([[`${TASKS}/gone`]]);
    disconnect();
  });

  it('the time-zone recompute reaches every surviving task (server data, one task deleted elsewhere)', async () => {
    const disconnect = connectRepo(createFirestoreRepo('u1'));
    const old = 'Asia/Tokyo';
    const docs = [t('dentist', '2026-11-25', { time: '09:00' }), t('flight', '2026-11-26', { time: '07:00' }), t('gone', '2026-11-27', { time: '10:00' })];
    sdk.serverDocs.add(`${TASKS}/dentist`);
    sdk.serverDocs.add(`${TASKS}/flight`);
    live(TASKS)[0]!.next(snap(docs));
    live('users/u1')[0]!.next({
      exists: () => true,
      data: () => ({ settings: { weekStart: 1, summary: { enabled: false, time: '08:00' }, timezone: old }, summaryAt: null, updatedAt: 1 }),
      metadata: { fromCache: false, hasPendingWrites: false },
    });
    await flush();
    expect(useStore.getState().settings.timezone).not.toBe(old);
    expect(reached()).toEqual([`${TASKS}/dentist`, `${TASKS}/flight`]);
    // A remindAt-only recompute of a task that is gone is expected: no "Couldn't sync" for it.
    expect(errors).toEqual([]);
    disconnect();
  });

  it('sets and deletes still go out together (≤ 450 per batch), updates one document per batch', async () => {
    const repo = createFirestoreRepo('u1');
    repo.subscribeTasks(() => undefined, () => undefined);
    live(TASKS)[0]!.next(snap([t('x', '2026-11-19'), t('y', '2026-11-19')]));
    sdk.serverDocs.add(`${TASKS}/x`);
    sdk.serverDocs.add(`${TASKS}/y`);
    repo.apply([
      { type: 'set', task: t('n1', null) },
      { type: 'update', id: 'x', patch: { fields: { title: 'X' } } },
      { type: 'delete', id: 'y' },
      { type: 'update', id: 'n1', patch: { fields: { title: 'N1' } } },
    ]);
    await flush();
    const batches = sdk.committed.map((b) => b.map((c) => `${c.op}:${c.path.split('/').at(-1)}`).join(' ')).sort();
    expect(batches).toEqual(['set:n1 delete:y', 'update:x']);
    // The set absorbed the later update.
    const set = sdk.committed.flat().find((c) => c.op === 'set');
    expect(set?.args[0]).toMatchObject({ id: 'n1', title: 'N1' });
    repo.dispose();
  });
});

describe('A5: back-to-back writes to one task become one commit', () => {
  it('rename then delete → a single delete; consecutive updates → a single update', async () => {
    const repo = createFirestoreRepo('u1');
    repo.subscribeTasks(() => undefined, () => undefined);
    live(TASKS)[0]!.next(snap([t('a', '2026-11-19'), t('b', '2026-11-19')]));
    sdk.serverDocs.add(`${TASKS}/a`);
    sdk.serverDocs.add(`${TASKS}/b`);
    repo.apply([{ type: 'update', id: 'a', patch: { fields: { title: 'New' } } }]);
    repo.apply([{ type: 'delete', id: 'a' }]);
    repo.apply([{ type: 'update', id: 'b', patch: { fields: { date: '2026-11-20' }, overrides: { '2026-11-20': { done: true } } } }]);
    repo.apply([{ type: 'update', id: 'b', patch: { fields: { title: 'B' }, overrides: { '2026-11-20': { doneAt: 5 } } } }]);
    await flush();
    expect(sdk.committed.map((b) => b.map((c) => `${c.op}:${c.path.split('/').at(-1)}`).join(' ')).sort()).toEqual(['delete:a', 'update:b']);
    const args = sdk.committed.flat().find((c) => c.op === 'update')!.args;
    const pairs = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [String(args[2 * i]), args[2 * i + 1]]));
    expect(pairs).toMatchObject({ date: '2026-11-20', title: 'B', 'overrides.2026-11-20.done': true, 'overrides.2026-11-20.doneAt': 5 });
    repo.dispose();
  });

  it('queued writes still go out when the repo is disposed (sign-out)', () => {
    const repo = createFirestoreRepo('u1');
    repo.apply([{ type: 'set', task: t('last', null) }]);
    repo.dispose();
    expect(sdk.committed.flat().map((c) => c.path)).toEqual([`${TASKS}/last`]);
  });
});

describe('A6 / E4: a failed listener', () => {
  it('re-listens with backoff; the error stays until a snapshot arrives (a write does not clear it)', async () => {
    const disconnect = connectRepo(createFirestoreRepo('u1'));
    const first = live(TASKS)[0]!;
    first.next(snap([t('a', '2026-11-19')]));
    first.error(Object.assign(new Error('boom'), { code: 'resource-exhausted' }));
    first.dead = true; // Firestore ends a listener after error()
    expect(errors).toHaveLength(1);
    expect(useStore.getState().tasks.a).toBeDefined(); // last good data stays

    createTask({ title: 'Local' });
    await flush();
    expect(sdk.committed).toHaveLength(1);
    expect(recovered).toBe(0); // the write succeeded, but other devices' changes still don't arrive

    expect(live(TASKS)).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    const second = live(TASKS);
    expect(second).toHaveLength(1);
    // The new listener's first snapshot replaces the record: 'a' was deleted elsewhere meanwhile.
    const local = Object.values(useStore.getState().tasks).find((x) => x.title === 'Local')!;
    second[0]!.next(snap([t('phone', '2026-11-20'), local], { fromCache: false, hasPendingWrites: false }));
    expect(Object.values(useStore.getState().tasks).map((x) => x.title).sort()).toEqual(['Local', 'phone']);
    expect(recovered).toBe(1);
    disconnect();
  });

  it('backs off further while it keeps failing, and retries at once when the app comes back online', () => {
    const repo = createFirestoreRepo('u1');
    repo.subscribeTasks(() => undefined, () => undefined);
    const fail = (): void => {
      const l = live(TASKS)[0]!;
      l.error(Object.assign(new Error('denied'), { code: 'permission-denied' }));
      l.dead = true;
    };
    fail();
    vi.advanceTimersByTime(999);
    expect(live(TASKS)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    fail();
    vi.advanceTimersByTime(1_999);
    expect(live(TASKS)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(live(TASKS)).toHaveLength(1);
    // Coming back online re-listens right away.
    fail();
    window.dispatchEvent(new Event('online'));
    expect(live(TASKS)).toHaveLength(1);
    repo.dispose();
    vi.advanceTimersByTime(120_000);
    expect(live(TASKS)).toHaveLength(0); // disposed: no more retries
  });

  it('a listener that keeps failing on retry is reported once, not every minute', () => {
    const disconnect = connectRepo(createFirestoreRepo('u1'));
    for (let i = 0; i < 3; i++) {
      const l = live(TASKS)[0]!;
      l.error(Object.assign(new Error('denied'), { code: 'permission-denied' }));
      l.dead = true;
      vi.advanceTimersByTime(60_000);
    }
    expect(errors).toHaveLength(1);
    disconnect();
  });

  it('failing before any data: the store says the load failed (never "loaded, nothing planned"); writes still show', async () => {
    const disconnect = connectRepo(createFirestoreRepo('u1'));
    live(TASKS)[0]!.error(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
    live(TASKS)[0]!.dead = true;
    // App renders "Couldn't load your tasks" for this, not an empty calendar.
    expect(useStore.getState().tasksLoaded).toBe(false);
    expect(useStore.getState().sync.loadFailed).toBe(true);
    const id = createTask({ title: 'Pay rent', date: '2026-11-20' });
    expect(useStore.getState().tasks[id]?.title).toBe('Pay rent');
    // A local write echoed by the repo is not data from the server.
    expect(useStore.getState().tasksLoaded).toBe(false);
    expect(useStore.getState().sync.loadFailed).toBe(true);
    vi.advanceTimersByTime(1_000);
    live(TASKS)[0]!.next(snap([useStore.getState().tasks[id]!], { fromCache: false, hasPendingWrites: false }));
    expect(useStore.getState().sync.loadFailed).toBe(false);
    expect(useStore.getState().tasksLoaded).toBe(true);
    expect(useStore.getState().tasks[id]).toBeDefined();
    disconnect();
  });

  it('only the tasks listener failing marks the load as failed (a user-doc failure keeps the calendar)', () => {
    const disconnect = connectRepo(createFirestoreRepo('u1'));
    const userL = live('users/u1')[0]!;
    userL.error(Object.assign(new Error('boom'), { code: 'unavailable' }));
    userL.dead = true;
    expect(useStore.getState().sync.loadFailed).toBe(false);
    live(TASKS)[0]!.next(snap([t('a', '2026-11-19')]));
    expect(useStore.getState().tasksLoaded).toBe(true);
    expect(useStore.getState().sync.loadFailed).toBe(false);
    disconnect();
  });

  it('deleteTask + rename issued back to back never resurrect the task', async () => {
    const disconnect = connectRepo(createFirestoreRepo('u1'));
    live(TASKS)[0]!.next(snap([t('a', '2026-11-19')]));
    sdk.serverDocs.add(`${TASKS}/a`);
    renameTask('a', 'renamed');
    deleteTask('a');
    await flush();
    expect(sdk.committed.flat().map((c) => `${c.op}:${c.path.split('/').at(-1)}`)).toEqual(['delete:a']);
    expect(useStore.getState().tasks.a).toBeUndefined();
    disconnect();
  });
});
