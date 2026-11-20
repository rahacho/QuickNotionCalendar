import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task, UserDoc } from '@shared/types';
import { createLocalRepo, type LocalRepo } from '@/data/localRepo';
import { DELETE_FIELD } from '@/data/repo';
import { until } from '@/store/__tests__/helpers';

const repos: LocalRepo[] = [];
let n = 0;

function ns(): string {
  return `repo-test-${Date.now()}-${++n}`;
}

function make(namespace: string): LocalRepo {
  const r = createLocalRepo(namespace);
  repos.push(r);
  return r;
}

afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

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
    recurrence: { freq: 'daily', interval: 1, byWeekday: null, until: null, count: null },
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function watch(repo: LocalRepo): { latest: () => Record<string, Task> | null; calls: () => number } {
  let latest: Record<string, Task> | null = null;
  let calls = 0;
  repo.subscribeTasks(
    (t) => {
      latest = t;
      calls++;
    },
    () => undefined,
  );
  return { latest: () => latest, calls: () => calls };
}

describe('LocalRepo', () => {
  it('fires the first callback after hydration, then synchronously on every write', async () => {
    const repo = make(ns());
    const w = watch(repo);
    expect(w.calls()).toBe(0);
    await until(() => w.calls() === 1);
    expect(w.latest()).toEqual({});
    repo.apply([{ type: 'set', task: task('a') }]);
    expect(w.calls()).toBe(2);
    expect(w.latest()?.a?.title).toBe('a');
  });

  it('applies field-level updates incl. override FieldPath semantics and keeps untouched identity', async () => {
    const repo = make(ns());
    const w = watch(repo);
    await until(() => w.calls() === 1);
    repo.apply([{ type: 'set', task: task('a') }, { type: 'set', task: task('b') }]);
    const b1 = w.latest()?.b;
    repo.apply([
      {
        type: 'update',
        id: 'a',
        patch: { fields: { title: 'A' }, overrides: { '2026-11-20': { done: true, doneAt: 5 }, '2026-11-21': { skipped: true } } },
      },
    ]);
    expect(w.latest()?.b).toBe(b1);
    expect(w.latest()?.a?.overrides).toEqual({ '2026-11-20': { done: true, doneAt: 5 }, '2026-11-21': { skipped: true } });
    repo.apply([{ type: 'update', id: 'a', patch: { overrides: { '2026-11-20': { doneAt: DELETE_FIELD }, '2026-11-21': null } } }]);
    expect(w.latest()?.a?.overrides).toEqual({ '2026-11-20': { done: true } });
    const before = w.calls();
    repo.apply([{ type: 'update', id: 'missing', patch: { fields: { title: 'x' } } }]);
    expect(w.calls()).toBe(before);
  });

  it('persists to IndexedDB: a new instance hydrates the same data', async () => {
    const name = ns();
    const repo = make(name);
    const w = watch(repo);
    await until(() => w.calls() === 1);
    repo.apply([{ type: 'set', task: task('a', { title: 'persisted' }) }, { type: 'set', task: task('b') }]);
    repo.apply([{ type: 'delete', id: 'b' }]);
    repo.updateUser({ settings: { weekStart: 0 } });
    await repo.flush();
    repo.dispose();

    const again = make(name);
    const w2 = watch(again);
    let user: UserDoc | null = null;
    again.subscribeUser((d) => {
      user = d;
    }, () => undefined);
    await until(() => w2.calls() === 1 && user !== null);
    expect(Object.keys(w2.latest() ?? {})).toEqual(['a']);
    expect(w2.latest()?.a?.title).toBe('persisted');
    expect((user as UserDoc | null)?.settings.weekStart).toBe(0);
  });

  it('a write after loading is in IndexedDB as soon as apply() returns (a reload right after keeps it)', async () => {
    const name = ns();
    const repo = make(name);
    const w = watch(repo);
    await until(() => w.calls() === 1);
    await repo.flush();
    repo.apply([{ type: 'set', task: task('fresh', { title: 'typed just now' }) }]);
    // A transaction already exists (created synchronously): a read issued right now on the same
    // connection is ordered after it. (Before the fix the write's transaction only appeared a few
    // microtasks later, so this read ran first and saw nothing.) Test-only peek at the handle.
    const db = (repo as unknown as { db: IDBDatabase | null }).db;
    expect(db).not.toBeNull();
    const get = (db as IDBDatabase).transaction('kv', 'readonly').objectStore('kv').get('task:fresh');
    const seen = await new Promise<unknown>((resolve, reject) => {
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    expect((seen as Task | undefined)?.title).toBe('typed just now');
  });

  it('writes queued before loading and writes after it land in call order', async () => {
    const name = ns();
    const repo = make(name);
    repo.apply([{ type: 'set', task: task('x', { title: 'first' }) }]); // before hydration: async path
    const w = watch(repo);
    await until(() => w.calls() === 1);
    repo.apply([{ type: 'update', id: 'x', patch: { fields: { title: 'second' } } }]);
    repo.apply([{ type: 'update', id: 'x', patch: { fields: { title: 'third' } } }]);
    await repo.flush();
    repo.dispose();
    const again = make(name);
    const w2 = watch(again);
    await until(() => w2.calls() === 1);
    expect(w2.latest()?.x?.title).toBe('third');
  });

  it('creates a default user doc on first load and merges settings deeply', async () => {
    const repo = make(ns());
    let user: UserDoc | null = null;
    repo.subscribeUser((d) => {
      user = d;
    }, () => undefined);
    await until(() => user !== null);
    const u = user as unknown as UserDoc;
    expect(u.settings.weekStart).toBe(1);
    expect(u.settings.summary).toEqual({ enabled: true, time: '08:00' });
    expect(typeof u.settings.timezone).toBe('string');
    repo.updateUser({ settings: { summary: { time: '06:45' } as never }, summaryAt: 123 });
    const v = user as unknown as UserDoc;
    expect(v.settings.summary).toEqual({ enabled: true, time: '06:45' });
    expect(v.summaryAt).toBe(123);
  });

  it('syncs other tabs over BroadcastChannel', async () => {
    const name = ns();
    const a = make(name);
    const b = make(name);
    const wa = watch(a);
    const wb = watch(b);
    await until(() => wa.calls() === 1 && wb.calls() === 1);
    a.apply([{ type: 'set', task: task('x', { title: 'from A' }) }]);
    await until(() => wb.latest()?.x?.title === 'from A');
    b.apply([{ type: 'delete', id: 'x' }]);
    await until(() => wa.latest()?.x === undefined);
  });

  it('writes made before hydration win over the stored copies', async () => {
    const name = ns();
    const first = make(name);
    const w1 = watch(first);
    await until(() => w1.calls() === 1);
    first.apply([{ type: 'set', task: task('a', { title: 'old' }) }]);
    await first.flush();
    first.dispose();

    const second = make(name);
    second.apply([{ type: 'set', task: task('a', { title: 'new' }) }]);
    const w2 = watch(second);
    await until(() => w2.calls() === 1);
    expect(w2.latest()?.a?.title).toBe('new');
  });

  it('ignores writes after dispose', async () => {
    const repo = make(ns());
    const w = watch(repo);
    await until(() => w.calls() === 1);
    repo.dispose();
    repo.apply([{ type: 'set', task: task('a') }]);
    expect(w.calls()).toBe(1);
  });
});
