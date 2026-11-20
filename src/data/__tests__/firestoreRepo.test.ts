import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, UserDoc } from '@shared/types';

// ---- Firestore SDK mock -------------------------------------------------------------------------

interface BatchCall {
  op: 'set' | 'update' | 'delete';
  path: string;
  args: unknown[];
}

const { DELETE, FakeFieldPath } = vi.hoisted(() => {
  class FieldPathMock {
    readonly segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
    toString(): string {
      return this.segments.join('.');
    }
  }
  return { DELETE: { __delete: true }, FakeFieldPath: FieldPathMock };
});

const sdk = vi.hoisted(() => ({
  batches: [] as Array<{ calls: BatchCall[]; commit: ReturnType<typeof vi.fn> }>,
  commitResult: () => Promise.resolve() as Promise<void>,
  listeners: new Map<string, { next: (snap: unknown) => void; error: (e: unknown) => void }>(),
  transactions: 0,
  setDocCalls: [] as Array<{ path: string; data: unknown; opts: unknown }>,
}));

vi.mock('@/data/firebase', () => ({ getFirebase: () => ({ db: { kind: 'db' } }) }));

vi.mock('firebase/firestore', () => {
  const ref = (path: string) => ({ path });
  return {
    FieldPath: FakeFieldPath,
    collection: (_db: unknown, ...segs: string[]) => ref(segs.join('/')),
    doc: (base: { path?: string; kind?: string }, ...segs: string[]) =>
      ref(base.kind === 'db' ? segs.join('/') : [base.path, ...segs].join('/')),
    deleteField: () => DELETE,
    serverTimestamp: () => ({ __serverTimestamp: true }),
    onSnapshot: (r: { path: string }, _opts: unknown, obs: { next: (s: unknown) => void; error: (e: unknown) => void }) => {
      sdk.listeners.set(r.path, obs);
      return () => sdk.listeners.delete(r.path);
    },
    writeBatch: () => {
      const calls: BatchCall[] = [];
      const commit = vi.fn(() => sdk.commitResult());
      sdk.batches.push({ calls, commit });
      return {
        set: (r: { path: string }, ...args: unknown[]) => calls.push({ op: 'set', path: r.path, args }),
        update: (r: { path: string }, ...args: unknown[]) => calls.push({ op: 'update', path: r.path, args }),
        delete: (r: { path: string }) => calls.push({ op: 'delete', path: r.path, args: [] }),
        commit,
      };
    },
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<void>) => {
      sdk.transactions++;
      await fn({ get: async () => ({ exists: () => false }), set: () => undefined });
    },
    setDoc: async (r: { path: string }, data: unknown, opts: unknown) => {
      sdk.setDocCalls.push({ path: r.path, data, opts });
    },
    deleteDoc: async () => undefined,
  };
});

import { createFirestoreRepo } from '@/data/firestoreRepo';
import { DELETE_FIELD } from '@/data/repo';
import { setSyncErrorHandler } from '@/data/errors';

// ---- helpers ------------------------------------------------------------------------------------

function taskDoc(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    date: '2026-11-19',
    endDate: null,
    time: null,
    order: 'a0',
    done: false,
    doneAt: null,
    recurrence: { freq: 'daily', interval: 1, byWeekday: null, until: null, count: null },
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function snapshot(changes: Array<{ type: 'added' | 'modified' | 'removed'; data: Task }>, meta = { fromCache: false, hasPendingWrites: false }) {
  return {
    docChanges: () => changes.map((c) => ({ type: c.type, doc: { id: c.data.id, data: () => structuredClone(c.data) } })),
    metadata: meta,
  };
}

function pairs(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) out[String(args[i])] = args[i + 1];
  return out;
}

beforeEach(() => {
  sdk.batches.length = 0;
  sdk.listeners.clear();
  sdk.transactions = 0;
  sdk.setDocCalls.length = 0;
  sdk.commitResult = () => Promise.resolve();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
});

afterEach(() => {
  vi.useRealTimers();
  setSyncErrorHandler(null);
});

describe('FirestoreRepo', () => {
  it('feeds snapshots incrementally and keeps identity for unchanged docs', () => {
    const repo = createFirestoreRepo('u1');
    const seen: Array<Record<string, Task>> = [];
    repo.subscribeTasks((t) => seen.push(t), () => undefined);
    const l = sdk.listeners.get('users/u1/tasks');
    expect(l).toBeDefined();
    l!.next(snapshot([{ type: 'added', data: taskDoc('a') }, { type: 'added', data: taskDoc('b') }], { fromCache: true, hasPendingWrites: false }));
    expect(Object.keys(seen[0]!).sort()).toEqual(['a', 'b']);
    const b = seen[0]!.b;
    l!.next(snapshot([{ type: 'modified', data: taskDoc('a', { title: 'A' }) }]));
    expect(seen[1]!.b).toBe(b);
    expect(seen[1]!.a?.title).toBe('A');
    // Metadata-only snapshot: same record object.
    l!.next(snapshot([]));
    expect(seen[2]).toBe(seen[1]);
    l!.next(snapshot([{ type: 'removed', data: taskDoc('b') }]));
    expect(Object.keys(seen[3]!)).toEqual(['a']);
    repo.dispose();
  });

  it('encodes updates as field-level FieldPath writes with deleteField, updatedAt and the server-time stamp', async () => {
    const repo = createFirestoreRepo('u1');
    const seen: Array<Record<string, Task>> = [];
    repo.subscribeTasks((t) => seen.push(t), () => undefined);
    sdk.listeners.get('users/u1/tasks')!.next(snapshot([{ type: 'added', data: taskDoc('a', { overrides: { '2026-11-21': { skipped: true } } }) }]));

    repo.apply([
      {
        type: 'update',
        id: 'a',
        patch: {
          fields: { title: 'Renamed', remindAt: 5 },
          overrides: { '2026-11-20': { done: true, doneAt: DELETE_FIELD }, '2026-11-21': null },
        },
      },
    ]);
    // Optimistic, synchronous emission; the commit follows in a microtask.
    expect(seen).toHaveLength(2);
    expect(seen[1]!.a).toMatchObject({ title: 'Renamed', remindAt: 5, updatedAt: 1000, overrides: { '2026-11-20': { done: true } } });
    expect(sdk.batches).toHaveLength(0);
    await Promise.resolve();

    expect(sdk.batches).toHaveLength(1);
    const call = sdk.batches[0]!.calls[0]!;
    expect(call).toMatchObject({ op: 'update', path: 'users/u1/tasks/a' });
    expect(pairs(call.args)).toEqual({
      title: 'Renamed',
      remindAt: 5,
      'overrides.2026-11-20.done': true,
      'overrides.2026-11-20.doneAt': DELETE,
      'overrides.2026-11-21': DELETE,
      updatedAt: 1000,
      // The commit time on the server: the scheduled function re-derives remindAt of recently written tasks.
      syncedAt: { __serverTimestamp: true },
    });
    expect(sdk.batches[0]!.commit).toHaveBeenCalledTimes(1);

    // Firestore's latency-compensated snapshot of the same data keeps the optimistic object.
    const optimistic = seen[1]!.a;
    sdk.listeners.get('users/u1/tasks')!.next(
      snapshot([{ type: 'modified', data: { ...optimistic! } }], { fromCache: false, hasPendingWrites: true }),
    );
    expect(seen[2]!.a).toBe(optimistic);
    repo.dispose();
  });

  it('writes full docs on set, drops updates of unknown docs, and chunks big batches', async () => {
    const repo = createFirestoreRepo('u1');
    repo.subscribeTasks(() => undefined, () => undefined);
    sdk.listeners.get('users/u1/tasks')!.next(snapshot([]));
    repo.apply([{ type: 'update', id: 'ghost', patch: { fields: { title: 'x' } } }]);
    await Promise.resolve();
    expect(sdk.batches).toHaveLength(0);

    const ops = Array.from({ length: 1000 }, (_, i) => ({ type: 'set' as const, task: taskDoc(`t${i}`) }));
    repo.apply(ops);
    await Promise.resolve();
    expect(sdk.batches.map((b) => b.calls.length)).toEqual([450, 450, 100]);
    const first = sdk.batches[0]!.calls[0]!;
    expect(first.op).toBe('set');
    expect(first.args[0]).toMatchObject({ id: 't0', updatedAt: 1000, recurrence: { byWeekday: null }, syncedAt: { __serverTimestamp: true } });
    repo.dispose();
  });

  it('reports failed commits (but not after dispose)', async () => {
    const onError = vi.fn();
    setSyncErrorHandler({ onError, onRecovered: () => undefined });
    sdk.commitResult = () => Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    const repo = createFirestoreRepo('u1');
    repo.apply([{ type: 'set', task: taskDoc('a') }]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    repo.dispose();
    repo.apply([{ type: 'set', task: taskDoc('b') }]);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('creates the user doc only when the SERVER says it is missing', async () => {
    const repo = createFirestoreRepo('u1');
    const docs: Array<UserDoc | null> = [];
    repo.subscribeUser((d) => docs.push(d), () => undefined);
    const l = sdk.listeners.get('users/u1')!;
    l.next({ exists: () => false, data: () => undefined, metadata: { fromCache: true, hasPendingWrites: false } });
    expect(sdk.transactions).toBe(0);
    expect(docs).toEqual([null]);
    l.next({ exists: () => false, data: () => undefined, metadata: { fromCache: false, hasPendingWrites: false } });
    expect(sdk.transactions).toBe(1);
    l.next({
      exists: () => true,
      data: () => ({ settings: { weekStart: 0, summary: { enabled: false, time: '07:00' }, timezone: 'Europe/Paris' }, summaryAt: null, updatedAt: 3 }),
      metadata: { fromCache: false, hasPendingWrites: false },
    });
    expect(docs.at(-1)?.settings).toEqual({ weekStart: 0, summary: { enabled: false, time: '07:00' }, timezone: 'Europe/Paris' });
    repo.dispose();
  });

  it('updateUser merges only the given leaves', () => {
    const repo = createFirestoreRepo('u1');
    repo.updateUser({ settings: { summary: { time: '06:00' } as never, timezone: 'Asia/Tokyo' }, summaryAt: 9 });
    expect(sdk.setDocCalls).toEqual([
      {
        path: 'users/u1',
        data: { updatedAt: 1000, settings: { timezone: 'Asia/Tokyo', summary: { time: '06:00' } }, summaryAt: 9 },
        opts: { merge: true },
      },
    ]);
    repo.dispose();
  });
});
