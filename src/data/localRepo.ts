/**
 * Local-mode repository (no Firebase env: dev, E2E, tests).
 *
 * - The in-memory record is replaced synchronously on every write and subscribers are notified
 *   synchronously (instant UI); unchanged tasks keep their object identity.
 * - Persistence: IndexedDB via idb-keyval, one key per document ("task:<id>", "user",
 *   "device:<id>") in database "tasks-local-<namespace>". Each apply() is one IDB transaction, in
 *   call order. Once the database is open (after hydration) the transaction is created
 *   synchronously inside apply(), so a reload or app close right after a change still commits it
 *   (an awaited open first left a few milliseconds in which the change could be lost).
 * - Other tabs: a BroadcastChannel('tasks-local-<namespace>') carries the resulting documents.
 * - The first subscribe callback fires after hydration from IndexedDB. Writes made before that are
 *   kept (they win over the hydrated copies).
 */
import { createStore, entries, promisifyRequest, type UseStore } from 'idb-keyval';
import type { DeviceDoc, Settings, Task, UserDoc } from '@shared/types';
import type { Repo, RepoOp, SnapshotMeta } from './repo';
import { applyOps, defaultUserDoc, mergeSettings, normalizeTask, normalizeUserDoc, serializeTask } from './taskDoc';
import { reportSyncError, reportSyncOk } from './errors';

const TASK_PREFIX = 'task:';
const USER_KEY = 'user';
const DEVICE_PREFIX = 'device:';
const META: SnapshotMeta = { fromCache: false, hasPendingWrites: false };

type Message =
  | { kind: 'tasks'; from: string; sets: Task[]; deletes: string[] }
  | { kind: 'user'; from: string; doc: UserDoc };

type TasksListener = { onChange: (tasks: Record<string, Task>, meta: SnapshotMeta) => void; onError: (e: Error) => void };
type UserListener = { onChange: (doc: UserDoc | null, meta: SnapshotMeta) => void; onError: (e: Error) => void };

export interface LocalRepo extends Repo {
  readonly kind: 'local';
  /** Resolves once hydration and every write issued so far have reached IndexedDB. */
  flush(): Promise<void>;
}

export function createLocalRepo(namespace = 'default'): LocalRepo {
  return new LocalRepoImpl(namespace);
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

class LocalRepoImpl implements LocalRepo {
  readonly kind = 'local' as const;
  private tasks: Record<string, Task> = {};
  private user: UserDoc | null = null;
  private hydrated = false;
  private disposed = false;
  /** Ids written (locally or by another tab) before hydration finished: their hydrated copy is stale. */
  private readonly touched = new Set<string>();
  private userTouched = false;
  private readonly taskListeners = new Set<TasksListener>();
  private readonly userListeners = new Set<UserListener>();
  private readonly idb: UseStore | null;
  private readonly channel: BroadcastChannel | null;
  private readonly instanceId = Math.random().toString(36).slice(2);
  private chain: Promise<void> = Promise.resolve();
  /** The open database, once known: lets a write create its transaction synchronously. */
  private db: IDBDatabase | null = null;
  /** Writes queued behind the async path whose transaction doesn't exist yet (keeps call order). */
  private queued = 0;

  constructor(namespace: string) {
    const name = `tasks-local-${namespace}`;
    let idb: UseStore | null = null;
    try {
      if (typeof indexedDB !== 'undefined') idb = createStore(name, 'kv');
    } catch {
      idb = null;
    }
    this.idb = idb;
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(name);
        channel.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
      }
    } catch {
      channel = null;
    }
    this.channel = channel;
    this.chain = this.hydrate();
  }

  // ------------------------------------------------------------------------------------------
  // Hydration
  // ------------------------------------------------------------------------------------------

  private async hydrate(): Promise<void> {
    // Always asynchronous, even without IndexedDB: the constructor finishes first.
    await Promise.resolve();
    let rows: Array<[IDBValidKey, unknown]> = [];
    let readOk = true;
    if (this.idb) {
      try {
        rows = await entries<IDBValidKey, unknown>(this.idb);
        await this.idb('readonly', (store) => {
          this.db = store.transaction.db;
          return Promise.resolve();
        });
      } catch (e) {
        readOk = false;
        reportSyncError(e);
      }
    }
    if (this.disposed) return;
    const tasks: Record<string, Task> = { ...this.tasks };
    let user: UserDoc | null = this.user;
    for (const [key, value] of rows) {
      if (typeof key !== 'string') continue;
      if (key.startsWith(TASK_PREFIX)) {
        const id = key.slice(TASK_PREFIX.length);
        if (!id || this.touched.has(id)) continue;
        const t = normalizeTask(value, id);
        if (t) tasks[id] = t;
      } else if (key === USER_KEY && !this.userTouched) {
        user = normalizeUserDoc(value);
      }
    }
    this.tasks = tasks;
    this.hydrated = true;
    this.touched.clear();
    if (user === null) {
      user = defaultUserDoc(Date.now());
      // Only persist when we know the store really has no user doc (a failed read must not
      // overwrite saved settings).
      if (readOk) this.persistNow([[USER_KEY, user]], []);
    }
    this.user = user;
    this.emitTasks();
    this.emitUser();
  }

  // ------------------------------------------------------------------------------------------
  // Subscriptions
  // ------------------------------------------------------------------------------------------

  subscribeTasks(onChange: TasksListener['onChange'], onError: TasksListener['onError']): () => void {
    const l: TasksListener = { onChange, onError };
    this.taskListeners.add(l);
    if (this.hydrated) {
      queueMicrotask(() => {
        if (this.taskListeners.has(l)) l.onChange(this.tasks, META);
      });
    }
    return () => {
      this.taskListeners.delete(l);
    };
  }

  subscribeUser(onChange: UserListener['onChange'], onError: UserListener['onError']): () => void {
    const l: UserListener = { onChange, onError };
    this.userListeners.add(l);
    if (this.hydrated) {
      queueMicrotask(() => {
        if (this.userListeners.has(l)) l.onChange(this.user, META);
      });
    }
    return () => {
      this.userListeners.delete(l);
    };
  }

  private emitTasks(): void {
    if (!this.hydrated) return;
    for (const l of [...this.taskListeners]) {
      try {
        l.onChange(this.tasks, META);
      } catch (e) {
        l.onError(toError(e));
      }
    }
  }

  private emitUser(): void {
    if (!this.hydrated) return;
    for (const l of [...this.userListeners]) {
      try {
        l.onChange(this.user, META);
      } catch (e) {
        l.onError(toError(e));
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------------------------------

  apply(ops: RepoOp[]): void {
    if (this.disposed || ops.length === 0) return;
    const now = Date.now();
    const prev = this.tasks;
    const next = applyOps(prev, ops, now);
    if (next === prev) return;
    const ids = new Set(ops.map((op) => (op.type === 'set' ? op.task.id : op.id)));
    const sets: Task[] = [];
    const deletes: string[] = [];
    for (const id of ids) {
      const t = next[id];
      if (t) {
        if (t !== prev[id]) sets.push(serializeTask(t));
      } else if (prev[id]) {
        deletes.push(id);
      }
      if (!this.hydrated) this.touched.add(id);
    }
    this.tasks = next;
    this.emitTasks();
    this.persistNow(
      sets.map((t) => [TASK_PREFIX + t.id, t]),
      deletes.map((id) => TASK_PREFIX + id),
    );
    this.broadcast({ kind: 'tasks', from: this.instanceId, sets, deletes });
  }

  updateUser(patch: { settings?: Partial<Settings>; summaryAt?: number | null }): void {
    if (this.disposed) return;
    const now = Date.now();
    const base = this.user ?? defaultUserDoc(now);
    const doc: UserDoc = {
      settings: mergeSettings(base.settings, patch.settings),
      summaryAt: patch.summaryAt !== undefined ? patch.summaryAt : base.summaryAt,
      updatedAt: now,
    };
    this.user = doc;
    if (!this.hydrated) this.userTouched = true;
    this.emitUser();
    this.persistNow([[USER_KEY, doc]], []);
    this.broadcast({ kind: 'user', from: this.instanceId, doc });
  }

  saveDevice(deviceId: string, doc: DeviceDoc): Promise<void> {
    return this.enqueue([[DEVICE_PREFIX + deviceId, doc]], []);
  }

  deleteDevice(deviceId: string): Promise<void> {
    return this.enqueue([], [DEVICE_PREFIX + deviceId]);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.taskListeners.clear();
    this.userListeners.clear();
    try {
      this.channel?.close();
    } catch {
      // already closed
    }
  }

  // ------------------------------------------------------------------------------------------
  // Persistence / cross-tab
  // ------------------------------------------------------------------------------------------

  /** Queues one IDB transaction after the previous ones; failures go to the sync error sink. */
  private persistNow(puts: Array<[string, unknown]>, dels: string[]): void {
    this.enqueue(puts, dels).catch(reportSyncError);
  }

  private enqueue(puts: Array<[string, unknown]>, dels: string[]): Promise<void> {
    const idb = this.idb;
    if (!idb || (puts.length === 0 && dels.length === 0)) return Promise.resolve();
    const fill = (store: IDBObjectStore): Promise<void> => {
      for (const [k, v] of puts) store.put(v, k);
      for (const k of dels) store.delete(k);
      const done = promisifyRequest(store.transaction).then(() => undefined);
      // Hand it to the database now rather than when this task ends: a reload / app close right
      // after a change otherwise may drop the still-uncommitted transaction (seen in Chromium).
      try {
        store.transaction.commit?.();
      } catch {
        // Already committing / older engine without commit(): auto-commit still applies.
      }
      return done;
    };
    // Fast path: nothing is waiting on the async path, so a transaction created now is ordered after
    // every earlier one (IndexedDB runs overlapping readwrite transactions in creation order).
    if (this.db && this.queued === 0) {
      try {
        const store = this.db.transaction('kv', 'readwrite').objectStore('kv');
        const p = fill(store).then(() => reportSyncOk());
        const prev = this.chain;
        this.chain = Promise.all([prev, p.catch(() => undefined)]).then(() => undefined);
        return p;
      } catch {
        this.db = null; // closed connection: fall back to idb-keyval (it reopens)
      }
    }
    this.queued++;
    let counted = true;
    const created = (): void => {
      if (counted) {
        counted = false;
        this.queued--;
      }
    };
    const run = (): Promise<void> =>
      idb('readwrite', (store) => {
        created();
        return fill(store);
      })
        .then(() => reportSyncOk())
        .finally(created);
    const p = this.chain.then(run, run);
    // Keep the chain alive after a failure; the caller handles the error of its own write.
    this.chain = p.catch(() => undefined);
    return p;
  }

  private broadcast(msg: Message): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage(msg);
    } catch {
      // Uncloneable payload or closed channel: other tabs will catch up on reload.
    }
  }

  private onMessage(data: unknown): void {
    if (this.disposed || data == null || typeof data !== 'object') return;
    const msg = data as Message;
    if (msg.from === this.instanceId) return;
    if (msg.kind === 'tasks' && Array.isArray(msg.sets) && Array.isArray(msg.deletes)) {
      const next = { ...this.tasks };
      for (const raw of msg.sets) {
        const id = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : null;
        if (!id) continue;
        const t = normalizeTask(raw, id);
        if (t) next[id] = t;
        if (!this.hydrated) this.touched.add(id);
      }
      for (const id of msg.deletes) {
        if (typeof id !== 'string') continue;
        delete next[id];
        if (!this.hydrated) this.touched.add(id);
      }
      this.tasks = next;
      this.emitTasks();
    } else if (msg.kind === 'user') {
      const doc = normalizeUserDoc(msg.doc);
      if (!doc) return;
      this.user = doc;
      if (!this.hydrated) this.userTouched = true;
      this.emitUser();
    }
  }
}
