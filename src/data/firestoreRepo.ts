/**
 * Firestore repository: users/{uid} (UserDoc) and users/{uid}/tasks/{taskId} (Task).
 *
 * Reads: one onSnapshot listener per collection/doc with includeMetadataChanges, applied
 * incrementally (docChanges) onto the current record so unchanged tasks keep their object identity
 * and metadata-only snapshots (pending → acknowledged) don't churn the task map. Firestore ends a
 * listener for good after an error, so a failed listener is re-created with backoff (and right
 * away when the device comes back online / the app is shown again); the last good data stays on
 * screen meanwhile and the first snapshot of the new listener replaces it in full.
 *
 * Writes: optimistic. apply() updates the in-memory record and notifies subscribers synchronously
 * (so back-to-back actions see each other's results). The writes themselves are queued and
 * committed once per microtask, grouped PER DOCUMENT: actions issued back to back for one task
 * (rename then delete, set series start then repeat rule…) become one commit — one
 * latency-compensated snapshot, so the store never flips back to an intermediate state — and
 * independent tasks never share an all-or-nothing batch with an update that may fail because the
 * task was deleted on another device meanwhile (sets and deletes, which can't fail that way, are
 * still packed together, ≤ 450 per batch).
 * Updates are field-level (top-level fields + FieldPath('overrides', date, field)) so two devices
 * editing different fields/occurrences never clobber each other. Firestore's own latency-compensated
 * snapshot then confirms (identical data keeps identity) or reverts a failed write.
 * Every task write also stamps `syncedAt` with the server's commit time (serverTimestamp; not part
 * of Task): the scheduled function re-derives remindAt — a derived field each device writes from its
 * own copy — from the MERGED document of every task written in the last minutes (SPEC §7).
 */
import {
  FieldPath,
  collection,
  deleteDoc,
  deleteField,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import type { DeviceDoc, Settings, Task, UserDoc } from '@shared/types';
import { DELETE_FIELD, type Repo, type RepoOp, type SnapshotMeta, type TaskPatch } from './repo';
import { getFirebase } from './firebase';
import { applyOps, applyTaskPatch, deepEqual, defaultUserDoc, normalizeTask, normalizeUserDoc, serializeTask } from './taskDoc';
import { LISTEN_TASKS, LISTEN_USER, reportListenOk, reportSyncError, reportSyncOk } from './errors';

/** Firestore allows 500 writes per batch; stay clear of the limit. */
const BATCH_LIMIT = 450;
/** Delays before re-creating a failed listener (the last one repeats). */
const RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

type TasksListener = { onChange: (tasks: Record<string, Task>, meta: SnapshotMeta) => void; onError: (e: Error) => void };
type UserListener = { onChange: (doc: UserDoc | null, meta: SnapshotMeta) => void; onError: (e: Error) => void };
type Queued = { op: RepoOp; now: number };

export function createFirestoreRepo(uid: string): Repo {
  return new FirestoreRepo(uid, getFirebase().db);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** [field, value, field, value, …] for WriteBatch.update. updatedAt and syncedAt are always written. */
function encodePatch(patch: TaskPatch, now: number): unknown[] {
  const pairs: unknown[] = [];
  const fields = patch.fields ?? {};
  for (const k of Object.keys(fields) as Array<keyof typeof fields>) {
    if (k === 'updatedAt') continue;
    const v = fields[k];
    if (v === undefined) continue;
    pairs.push(new FieldPath(k), v);
  }
  const ov = patch.overrides ?? {};
  for (const date of Object.keys(ov)) {
    const op = ov[date];
    if (op === undefined) continue;
    if (op === null) {
      pairs.push(new FieldPath('overrides', date), deleteField());
      continue;
    }
    for (const f of Object.keys(op) as Array<keyof typeof op>) {
      const v = op[f];
      if (v === undefined) continue;
      pairs.push(new FieldPath('overrides', date, f), v === DELETE_FIELD ? deleteField() : v);
    }
  }
  pairs.push(new FieldPath('updatedAt'), now);
  pairs.push(new FieldPath('syncedAt'), serverTimestamp());
  return pairs;
}

/** Nested merge payload for users/{uid} (setDoc merge:true deep-merges maps); no undefined values. */
function userPayload(patch: { settings?: Partial<Settings>; summaryAt?: number | null }, now: number): DocumentData {
  const data: DocumentData = { updatedAt: now };
  const s = patch.settings;
  if (s) {
    const settings: DocumentData = {};
    if (s.weekStart !== undefined) settings.weekStart = s.weekStart;
    if (s.timezone !== undefined) settings.timezone = s.timezone;
    if (s.summary) {
      const summary: DocumentData = {};
      if (s.summary.enabled !== undefined) summary.enabled = s.summary.enabled;
      if (s.summary.time !== undefined) summary.time = s.summary.time;
      if (Object.keys(summary).length > 0) settings.summary = summary;
    }
    if (Object.keys(settings).length > 0) data.settings = settings;
  }
  if (patch.summaryAt !== undefined) data.summaryAt = patch.summaryAt;
  return data;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function opId(op: RepoOp): string {
  return op.type === 'set' ? op.task.id : op.id;
}

/** Merges two override patches of one occurrence (b after a); null when they can't be one write. */
function mergeOverridePatch(a: TaskPatch['overrides'], b: TaskPatch['overrides']): TaskPatch['overrides'] | null {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const d of Object.keys(b)) {
    const pb = b[d];
    if (pb === undefined) continue;
    const pa = hasOwn(out, d) ? out[d] : undefined;
    if (pb === null || pa === undefined) out[d] = pb;
    else if (pa === null) return null; // delete the entry, then set fields of it: overlapping paths
    else out[d] = { ...pa, ...pb };
  }
  return out;
}

/**
 * The ops one document received in one flush, reduced to as few writes as possible (in order):
 * a delete drops everything before it, a set absorbs the updates after it, consecutive updates
 * merge into one (later fields win). What is left (rarely more than one write) commits in one batch.
 */
function collapse(items: Queued[]): Queued[] {
  let lastDelete = -1;
  for (let i = 0; i < items.length; i++) if ((items[i] as Queued).op.type === 'delete') lastDelete = i;
  let rest = lastDelete >= 0 ? items.slice(lastDelete) : items.slice();
  if (rest[0]?.op.type === 'delete') {
    // Updates after a delete have nothing to update (and would fail the delete with them); a set
    // re-creates the document and makes the delete redundant.
    const set = rest.findIndex((it) => it.op.type === 'set');
    rest = set === -1 ? rest.slice(0, 1) : rest.slice(set);
  }
  const out: Queued[] = [];
  for (const it of rest) {
    const prev = out[out.length - 1];
    if (prev && it.op.type === 'update') {
      if (prev.op.type === 'set') {
        out[out.length - 1] = { op: { type: 'set', task: applyTaskPatch(prev.op.task, it.op.patch, it.now) }, now: it.now };
        continue;
      }
      if (prev.op.type === 'update') {
        const overrides = mergeOverridePatch(prev.op.patch.overrides, it.op.patch.overrides);
        if (overrides !== null) {
          const patch: TaskPatch = {};
          const fields = { ...prev.op.patch.fields, ...it.op.patch.fields };
          if (Object.keys(fields).length > 0) patch.fields = fields;
          if (overrides) patch.overrides = overrides;
          out[out.length - 1] = { op: { type: 'update', id: it.op.id, patch }, now: it.now };
          continue;
        }
      }
    }
    out.push(it);
  }
  return out;
}

/** A pure remindAt recompute: failing because the task is gone (deleted elsewhere) is expected. */
function isRemindAtOnly(op: RepoOp): boolean {
  if (op.type !== 'update' || op.patch.overrides) return false;
  const keys = Object.keys(op.patch.fields ?? {}).filter((k) => k !== 'updatedAt');
  return keys.length === 1 && keys[0] === 'remindAt';
}

function codeOf(e: unknown): string {
  const c = e != null && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : '';
  return typeof c === 'string' ? c.replace(/^firestore\//, '') : '';
}

class FirestoreRepo implements Repo {
  readonly kind = 'firebase' as const;
  private readonly tasksCol: CollectionReference<DocumentData>;
  private readonly userRef: DocumentReference<DocumentData>;

  private tasks: Record<string, Task> = {};
  /** True once a snapshot arrived, or the listener failed before one did (local writes then show). */
  private tasksLoaded = false;
  /** The next snapshot is the first of a (re-)created listener: it replaces the record in full. */
  private tasksFresh = true;
  private meta: SnapshotMeta = { fromCache: true, hasPendingWrites: false };
  private readonly taskListeners = new Set<TasksListener>();
  private unsubTasks: (() => void) | null = null;
  private tasksAttempt = 0;
  private tasksRetry: ReturnType<typeof setTimeout> | null = null;

  private user: UserDoc | null = null;
  private userLoaded = false;
  private userMeta: SnapshotMeta = { fromCache: true, hasPendingWrites: false };
  private creatingUser = false;
  private readonly userListeners = new Set<UserListener>();
  private unsubUser: (() => void) | null = null;
  private userAttempt = 0;
  private userRetry: ReturnType<typeof setTimeout> | null = null;

  /** Writes waiting for this microtask's commit. */
  private pending: Queued[] = [];
  private flushQueued = false;

  private disposed = false;

  /** Failures of writes issued before sign-out belong to the old session: don't surface them. */
  private readonly onWriteError = (e: unknown): void => {
    if (!this.disposed) reportSyncError(e);
  };

  /** Back online / app shown again: re-create dead listeners right away. */
  private readonly onWake = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this.tasksRetry !== null) this.restart('tasks');
    if (this.userRetry !== null) this.restart('user');
  };

  constructor(
    uid: string,
    private readonly db: Firestore,
  ) {
    this.userRef = doc(db, 'users', uid);
    this.tasksCol = collection(db, 'users', uid, 'tasks');
    if (typeof window !== 'undefined') window.addEventListener('online', this.onWake);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onWake);
  }

  // ------------------------------------------------------------------------------------------
  // Tasks
  // ------------------------------------------------------------------------------------------

  subscribeTasks(onChange: TasksListener['onChange'], onError: TasksListener['onError']): () => void {
    const l: TasksListener = { onChange, onError };
    if (this.disposed) return () => undefined;
    this.taskListeners.add(l);
    if (!this.unsubTasks && this.tasksRetry === null) this.startTasks();
    else if (this.tasksLoaded) {
      queueMicrotask(() => {
        if (this.taskListeners.has(l)) l.onChange(this.tasks, this.meta);
      });
    }
    return () => {
      this.taskListeners.delete(l);
      if (this.taskListeners.size === 0) {
        this.unsubTasks?.();
        this.unsubTasks = null;
        this.clearRetry('tasks');
        this.tasksLoaded = false;
      }
    };
  }

  private startTasks(): void {
    this.tasksFresh = true;
    this.unsubTasks = onSnapshot(this.tasksCol, { includeMetadataChanges: true }, {
      next: (snap) => {
        if (this.disposed) return;
        // The first snapshot of a listener lists every document as 'added': build the record from
        // scratch (documents removed while a failed listener was down disappear), reusing the
        // objects of unchanged tasks.
        const fresh = this.tasksFresh;
        this.tasksFresh = false;
        const old = this.tasks;
        const base = fresh ? {} : old;
        let next: Record<string, Task> | null = fresh ? {} : null;
        for (const ch of snap.docChanges()) {
          const id = ch.doc.id;
          const cur = next ?? base;
          if (ch.type === 'removed') {
            if (hasOwn(cur, id)) delete (next ??= { ...base })[id];
            continue;
          }
          const t = normalizeTask(ch.doc.data(), id);
          const prev = hasOwn(old, id) ? old[id] : undefined;
          if (!t) {
            if (hasOwn(cur, id)) delete (next ??= { ...base })[id];
            continue;
          }
          if (prev && deepEqual(prev, t)) {
            // our own optimistic write confirmed: keep identity
            if (fresh) (next as Record<string, Task>)[id] = prev;
            continue;
          }
          (next ??= { ...base })[id] = t;
        }
        if (next && fresh && sameRecord(old, next)) next = null;
        if (next) this.tasks = next;
        this.tasksLoaded = true;
        this.tasksAttempt = 0;
        this.meta = { fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites };
        reportListenOk(LISTEN_TASKS);
        this.emitTasks();
      },
      error: (e) => {
        if (this.disposed) return;
        // Firestore removed the listener for good. Keep what we have (or, before the first snapshot,
        // an empty record so writes made meanwhile still show) and listen again later.
        this.unsubTasks = null;
        this.tasksLoaded = true;
        const err = toError(e);
        for (const l of [...this.taskListeners]) l.onError(err);
        this.scheduleRetry('tasks');
      },
    });
  }

  private emitTasks(): void {
    for (const l of [...this.taskListeners]) {
      try {
        l.onChange(this.tasks, this.meta);
      } catch (e) {
        l.onError(toError(e));
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Listener retry
  // ------------------------------------------------------------------------------------------

  private scheduleRetry(which: 'tasks' | 'user'): void {
    if (this.disposed) return;
    const listeners = which === 'tasks' ? this.taskListeners.size : this.userListeners.size;
    if (listeners === 0) return;
    this.clearRetry(which);
    const attempt = which === 'tasks' ? this.tasksAttempt++ : this.userAttempt++;
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] as number;
    const timer = setTimeout(() => this.restart(which), delay);
    if (which === 'tasks') this.tasksRetry = timer;
    else this.userRetry = timer;
  }

  private clearRetry(which: 'tasks' | 'user'): void {
    const timer = which === 'tasks' ? this.tasksRetry : this.userRetry;
    if (timer !== null) clearTimeout(timer);
    if (which === 'tasks') this.tasksRetry = null;
    else this.userRetry = null;
  }

  private restart(which: 'tasks' | 'user'): void {
    this.clearRetry(which);
    if (this.disposed) return;
    if (which === 'tasks') {
      if (!this.unsubTasks && this.taskListeners.size > 0) this.startTasks();
    } else if (!this.unsubUser && this.userListeners.size > 0) {
      this.startUser();
    }
  }

  // ------------------------------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------------------------------

  apply(ops: RepoOp[]): void {
    if (this.disposed || ops.length === 0) return;
    const now = Date.now();

    // An update of a document that doesn't exist fails its commit: drop updates of tasks we know
    // are gone (e.g. deleted on another device) — they would be no-ops anyway.
    let effective = ops;
    if (this.tasksLoaded) {
      const created = new Set<string>();
      effective = ops.filter((op) => {
        if (op.type === 'set') created.add(op.task.id);
        if (op.type === 'delete') created.delete(op.id);
        return op.type !== 'update' || hasOwn(this.tasks, op.id) || created.has(op.id);
      });
      if (effective.length === 0) return;
      const next = applyOps(this.tasks, effective, now);
      if (next !== this.tasks) {
        this.tasks = next;
        this.meta = { ...this.meta, hasPendingWrites: true };
        this.emitTasks();
      }
    }

    for (const op of effective) this.pending.push({ op, now });
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Commits the queued writes: one batch per updated document, sets/deletes packed together. */
  private flush(): void {
    this.flushQueued = false;
    const items = this.pending;
    this.pending = [];
    if (items.length === 0) return;
    const byDoc = new Map<string, Queued[]>();
    for (const it of items) {
      const id = opId(it.op);
      const list = byDoc.get(id);
      if (list) list.push(it);
      else byDoc.set(id, [it]);
    }
    let packed: Queued[] = [];
    const commitPacked = (): void => {
      if (packed.length > 0) this.commit(packed);
      packed = [];
    };
    for (const group of byDoc.values()) {
      const writes = collapse(group);
      if (writes.some((w) => w.op.type === 'update')) {
        this.commit(writes);
        continue;
      }
      if (packed.length + writes.length > BATCH_LIMIT) commitPacked();
      packed.push(...writes);
    }
    commitPacked();
  }

  private commit(writes: Queued[]): void {
    const batch = writeBatch(this.db);
    for (const { op, now } of writes) {
      if (op.type === 'set') {
        batch.set(doc(this.tasksCol, op.task.id), { ...serializeTask({ ...op.task, updatedAt: now }), syncedAt: serverTimestamp() });
      } else if (op.type === 'update') {
        const [field, value, ...rest] = encodePatch(op.patch, now);
        batch.update(doc(this.tasksCol, op.id), field as FieldPath, value, ...rest);
      } else {
        batch.delete(doc(this.tasksCol, op.id));
      }
    }
    const quietIfGone = writes.every((w) => isRemindAtOnly(w.op));
    batch.commit().then(reportSyncOk, (e: unknown) => {
      if (quietIfGone && codeOf(e) === 'not-found') return;
      this.onWriteError(e);
    });
  }

  // ------------------------------------------------------------------------------------------
  // User doc
  // ------------------------------------------------------------------------------------------

  subscribeUser(onChange: UserListener['onChange'], onError: UserListener['onError']): () => void {
    const l: UserListener = { onChange, onError };
    if (this.disposed) return () => undefined;
    this.userListeners.add(l);
    if (!this.unsubUser && this.userRetry === null) this.startUser();
    else if (this.userLoaded) {
      queueMicrotask(() => {
        if (this.userListeners.has(l)) l.onChange(this.user, this.userMeta);
      });
    }
    return () => {
      this.userListeners.delete(l);
      if (this.userListeners.size === 0) {
        this.unsubUser?.();
        this.unsubUser = null;
        this.clearRetry('user');
        this.userLoaded = false;
      }
    };
  }

  private startUser(): void {
    this.unsubUser = onSnapshot(this.userRef, { includeMetadataChanges: true }, {
      next: (snap) => {
        if (this.disposed) return;
        const docData = snap.exists() ? normalizeUserDoc(snap.data()) : null;
        const meta: SnapshotMeta = { fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites };
        // Only the server can say a document is missing: a cache miss offline must not overwrite
        // settings saved from another device.
        if (docData === null && !meta.fromCache) this.createUserDoc();
        // Subscribers also hear about cache → server and pending → acknowledged transitions (boot
        // waits for server data before acting on the derived fields).
        const changed =
          !this.userLoaded ||
          !deepEqual(this.user, docData) ||
          this.userMeta.fromCache !== meta.fromCache ||
          this.userMeta.hasPendingWrites !== meta.hasPendingWrites;
        this.userLoaded = true;
        this.userAttempt = 0;
        this.userMeta = meta;
        reportListenOk(LISTEN_USER);
        if (!changed) return;
        this.user = docData;
        for (const l of [...this.userListeners]) {
          try {
            l.onChange(this.user, meta);
          } catch (e) {
            l.onError(toError(e));
          }
        }
      },
      error: (e) => {
        if (this.disposed) return;
        this.unsubUser = null;
        const err = toError(e);
        for (const l of [...this.userListeners]) l.onError(err);
        this.scheduleRetry('user');
      },
    });
  }

  private createUserDoc(): void {
    if (this.creatingUser) return;
    this.creatingUser = true;
    runTransaction(this.db, async (tx) => {
      const snap = await tx.get(this.userRef);
      if (!snap.exists()) tx.set(this.userRef, { ...defaultUserDoc(Date.now()) });
    }).then(
      () => {
        this.creatingUser = false;
      },
      (e: unknown) => {
        this.creatingUser = false;
        if (!this.disposed) reportSyncError(e);
      },
    );
  }

  updateUser(patch: { settings?: Partial<Settings>; summaryAt?: number | null }): void {
    if (this.disposed) return;
    setDoc(this.userRef, userPayload(patch, Date.now()), { merge: true }).then(reportSyncOk, this.onWriteError);
  }

  // ------------------------------------------------------------------------------------------
  // Devices
  // ------------------------------------------------------------------------------------------

  saveDevice(deviceId: string, d: DeviceDoc): Promise<void> {
    return setDoc(doc(this.userRef, 'devices', deviceId), { ...d });
  }

  deleteDevice(deviceId: string): Promise<void> {
    return deleteDoc(doc(this.userRef, 'devices', deviceId));
  }

  dispose(): void {
    if (this.disposed) return;
    // Queued writes still go out (sign-out must not drop the last edits).
    this.flush();
    this.disposed = true;
    this.unsubTasks?.();
    this.unsubUser?.();
    this.unsubTasks = null;
    this.unsubUser = null;
    this.clearRetry('tasks');
    this.clearRetry('user');
    this.taskListeners.clear();
    this.userListeners.clear();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onWake);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onWake);
  }
}

/** Same keys mapped to the same objects. */
function sameRecord(a: Record<string, Task>, b: Record<string, Task>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!hasOwn(b, k) || a[k] !== b[k]) return false;
  return true;
}
