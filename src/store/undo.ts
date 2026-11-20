/**
 * Undo / redo stacks (max 50 entries each). Each entry holds full snapshots of the task docs an
 * action touched (as they were BEFORE it) and the ids it created; restoring is one repo.apply batch
 * (set the snapshots, delete the created docs) — see actions.undo(). Restoring an entry yields its
 * inverse (the docs as they were just before the restore), which goes on the other stack.
 * An entry undone OUT OF ORDER (its toast's Undo while later steps touched the same task) has the
 * later entries rebased (rewriteUndo) so none of them can bring its change back.
 */
import type { Task } from '@shared/types';

export const UNDO_LIMIT = 50;

export interface UndoEntry {
  readonly id: number;
  /** Rewritten only by rewriteUndo (an earlier step was undone out of order). */
  before: readonly Task[];
  created: readonly string[];
  /** What the action did, for the "Undid: …" toast — e.g. 'added “Buy milk”'. */
  readonly label: string;
  /** Toast offering this entry's Undo, dismissed when the entry is undone another way (⌘Z). */
  toastId: string | null;
}

let seq = 0;
const stack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

function push(on: UndoEntry[], before: readonly Task[], created: readonly string[], label: string): UndoEntry {
  const entry: UndoEntry = { id: ++seq, before, created, label, toastId: null };
  on.push(entry);
  if (on.length > UNDO_LIMIT) on.splice(0, on.length - UNDO_LIMIT);
  return entry;
}

function take(from: UndoEntry[], id?: number): UndoEntry | null {
  if (id === undefined) return from.pop() ?? null;
  const i = from.findIndex((e) => e.id === id);
  if (i === -1) return null;
  return from.splice(i, 1)[0] ?? null;
}

export function pushUndo(before: readonly Task[], created: readonly string[], label = ''): UndoEntry {
  return push(stack, before, created, label);
}

/** Removes and returns the given entry (toast Undo) or the most recent one (⌘Z); null if gone. */
export function takeUndo(id?: number): UndoEntry | null {
  return take(stack, id);
}

/** The most recent undo entry, left in place. */
export function peekUndo(): UndoEntry | null {
  return stack[stack.length - 1] ?? null;
}

/** Undo entries recorded after entry `id` (oldest first): later steps that are still undoable. */
export function undoEntriesAfter(id: number): UndoEntry[] {
  return stack.filter((e) => e.id > id);
}

/**
 * Replaces what an undo entry restores. An entry left with nothing to restore is removed from the
 * stack; returns whether it is still there.
 */
export function rewriteUndo(entry: UndoEntry, before: readonly Task[], created: readonly string[]): boolean {
  const i = stack.indexOf(entry);
  if (i === -1) return false;
  if (before.length === 0 && created.length === 0) {
    stack.splice(i, 1);
    return false;
  }
  entry.before = before;
  entry.created = created;
  return true;
}

export function pushRedo(before: readonly Task[], created: readonly string[], label = ''): UndoEntry {
  return push(redoStack, before, created, label);
}

/** Removes and returns the given redo entry (toast Redo) or the most recent one; null if gone. */
export function takeRedo(id?: number): UndoEntry | null {
  return take(redoStack, id);
}

/** A new change makes everything that was undone before it unredoable. Returns the dropped entries. */
export function clearRedo(): UndoEntry[] {
  return redoStack.splice(0);
}

/** Forgets both stacks (sign-in/out). Returns the dropped entries. */
export function clearUndo(): UndoEntry[] {
  return [...stack.splice(0), ...redoStack.splice(0)];
}

export function undoDepth(): number {
  return stack.length;
}

export function redoDepth(): number {
  return redoStack.length;
}
