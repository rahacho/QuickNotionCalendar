/**
 * FirestoreRepo against the REAL firebase SDK (offline, memory cache; no emulator) — review finding
 * A5: back-to-back writes to one task used to raise one latency-compensated snapshot per commit,
 * so the store went new → OLD → new (a just-deleted task re-appeared for a moment).
 */
import { describe, expect, it, vi } from 'vitest';
import { initializeApp } from 'firebase/app';
import { disableNetwork, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import type { Task } from '@shared/types';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/data/firebase', () => ({ getFirebase: () => ({ db: holder.db }) }));

import { createFirestoreRepo } from '@/data/firestoreRepo';

const app = initializeApp({ apiKey: 'fake', projectId: 'demo-regress-core', appId: '1:1:web:1' }, 'regress-core');
const db: Firestore = initializeFirestore(app, { localCache: memoryLocalCache() });
holder.db = db;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T1',
    title: 'Old title',
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FirestoreRepo with the real SDK', () => {
  it('a task renamed then deleted never re-appears', async () => {
    await disableNetwork(db);
    const repo = createFirestoreRepo('u-flicker');
    const history: Array<Record<string, Task>> = [];
    repo.subscribeTasks((t) => history.push(t), (e) => {
      throw e;
    });
    await wait(50);
    repo.apply([{ type: 'set', task: task() }]);
    await wait(50);
    expect(history.at(-1)?.T1?.title).toBe('Old title');

    const mark = history.length;
    repo.apply([{ type: 'update', id: 'T1', patch: { fields: { title: 'New title' } } }]);
    repo.apply([{ type: 'delete', id: 'T1' }]);
    await wait(100);

    const after = history.slice(mark).map((t) => (t.T1 ? t.T1.title : '<deleted>'));
    expect(after.at(-1)).toBe('<deleted>');
    const firstDeleted = after.indexOf('<deleted>');
    expect(after.slice(firstDeleted).every((x) => x === '<deleted>')).toBe(true);
    repo.dispose();
  });

  it('two writes to one occurrence that cannot merge go out in one batch, applied in order', async () => {
    await disableNetwork(db);
    const repo = createFirestoreRepo('u-multi');
    const history: Array<Record<string, Task>> = [];
    repo.subscribeTasks((t) => history.push(t), (e) => {
      throw e;
    });
    await wait(50);
    repo.apply([{ type: 'set', task: task({ overrides: { '2026-11-20': { done: true, doneAt: 1 } } }) }]);
    await wait(50);
    const mark = history.length;
    // Remove the whole entry, then set one field of it (overlapping field paths: two writes).
    repo.apply([{ type: 'update', id: 'T1', patch: { overrides: { '2026-11-20': null } } }]);
    repo.apply([{ type: 'update', id: 'T1', patch: { overrides: { '2026-11-20': { skipped: true } } } }]);
    await wait(100);
    const seen = history.slice(mark).map((t) => JSON.stringify(t.T1?.overrides));
    expect(seen.at(-1)).toBe(JSON.stringify({ '2026-11-20': { skipped: true } }));
    // Never back to the state between the two writes once the final one showed.
    const final = seen.indexOf(seen.at(-1) as string);
    expect(seen.slice(final).every((x) => x === seen.at(-1))).toBe(true);
    repo.dispose();
  });
});
