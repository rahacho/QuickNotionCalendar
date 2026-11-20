/**
 * Repository contract (SPEC §4.2). Two implementations share it:
 *  - firestoreRepo.ts — Firestore with persistent offline cache (signed-in sync)
 *  - localRepo.ts     — IndexedDB + BroadcastChannel (local mode: no Firebase env, dev/E2E/tests)
 *
 * Writes are fire-and-forget and optimistic: `apply` updates the repo's in-memory view and notifies
 * task subscribers synchronously, then persists. Failures surface through data/errors.ts
 * (→ store.sync.error + a "Couldn't sync — …" toast), never through a rejected promise. Subscribers'
 * onError hears about failed listeners (the subscriber reports them; a Firestore repo re-listens).
 */
import type { DeviceDoc, ISODate, OccurrenceOverride, Settings, Task, UserDoc } from '@shared/types';

/** Marks an override field for deletion in an OverridePatch. */
export const DELETE_FIELD: unique symbol = Symbol('DELETE_FIELD');

export type OverridePatch = { [K in keyof OccurrenceOverride]?: OccurrenceOverride[K] | typeof DELETE_FIELD };

export interface TaskPatch {
  /** Top-level fields to set (updatedAt is added by the repo). */
  fields?: Partial<Omit<Task, 'id' | 'overrides' | 'createdAt'>>;
  /** Per occurrence (keyed by original rule date); null deletes the whole entry. */
  overrides?: Record<ISODate, OverridePatch | null>;
}

export type RepoOp = { type: 'set'; task: Task } | { type: 'update'; id: string; patch: TaskPatch } | { type: 'delete'; id: string };

export interface SnapshotMeta {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export interface Repo {
  readonly kind: 'firebase' | 'local';
  subscribeTasks(onChange: (tasks: Record<string, Task>, meta: SnapshotMeta) => void, onError: (e: Error) => void): () => void;
  /**
   * `meta` says whether the document came from the offline cache (Firestore; local mode: never).
   * Both repos always pass it; it is optional only so a minimal Repo (tests) may omit it, which
   * counts as server data.
   */
  subscribeUser(onChange: (doc: UserDoc | null, meta?: SnapshotMeta) => void, onError: (e: Error) => void): () => void;
  /**
   * Fire-and-forget; errors → store.sync.error + toast. Applied to the in-memory view at once and
   * in order. Persisted per DOCUMENT (Firestore: the ops one task gets in one tick commit together;
   * different tasks commit independently, so one task deleted elsewhere can't sink the others).
   */
  apply(ops: RepoOp[]): void;
  /** Merge; settings merged deeply (summary sub-object too). */
  updateUser(patch: { settings?: Partial<Settings>; summaryAt?: number | null }): void;
  saveDevice(deviceId: string, doc: DeviceDoc): Promise<void>;
  deleteDevice(deviceId: string): Promise<void>;
  dispose(): void;
}
