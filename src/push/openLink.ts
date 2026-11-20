/**
 * Opens the task a notification points at (`/?task=ID&occ=DATE`) in the running app, when the
 * service worker forwards a notification click to an already-open window. (A cold launch goes
 * through App's URL deep link instead.)
 */
import type { ISODate, Task } from '@shared/types';
import { isValidISODate } from '@shared/dates';
import { getOccurrence } from '@shared/occurrences';
import { useStore } from '@/store/store';
import { openPeek, showToast } from '@/store/actions';

/** How long to wait for the task to arrive (signed-in snapshot, first load) before giving up. */
const WAIT_MS = 6000;

let cancelPending: (() => void) | null = null;

/**
 * Maps `occ` (the occurrence's original rule date, or the date it was moved to) to the peek ref's
 * origDate. null → non-recurring; undefined → that occurrence doesn't exist (any more).
 */
export function resolveOrigDate(task: Task, occ: string | null): ISODate | null | undefined {
  if (!task.recurrence) return null;
  if (!occ || !isValidISODate(occ)) return undefined;
  if (getOccurrence(task, occ)) return occ;
  for (const [orig, ov] of Object.entries(task.overrides)) {
    if (ov.date === occ && !ov.skipped && getOccurrence(task, orig)) return orig;
  }
  return undefined;
}

/** Parses an app URL into {taskId, occ}; null when it isn't a same-origin task link. */
export function parseTaskLink(url: string, base: string = window.location.href): { taskId: string; occ: string | null } | null {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  if (u.origin !== new URL(base).origin) return null;
  const taskId = u.searchParams.get('task');
  if (!taskId || taskId.length > 128) return null;
  return { taskId, occ: u.searchParams.get('occ') };
}

/** Opens the peek for `url`'s task once it is available; toasts if it no longer exists. */
export function openTaskLink(url: string): void {
  const link = parseTaskLink(url);
  if (!link) return;
  cancelPending?.();
  cancelPending = null;

  type Outcome = 'opened' | 'missing' | 'wait';
  const attempt = (): Outcome => {
    const s = useStore.getState();
    if (!s.tasksLoaded) return 'wait';
    const task = s.tasks[link.taskId];
    if (!task) return 'wait';
    const origDate = resolveOrigDate(task, link.occ);
    if (origDate === undefined) return 'missing';
    openPeek({ taskId: link.taskId, origDate });
    return 'opened';
  };

  const first = attempt();
  if (first === 'opened') return;
  if (first === 'missing') {
    showToast('That task no longer exists');
    return;
  }

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    unsubscribe();
    window.clearTimeout(timer);
    if (cancelPending === finish) cancelPending = null;
  };
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.tasks === prev.tasks && s.tasksLoaded === prev.tasksLoaded) return;
    const outcome = attempt();
    if (outcome === 'wait') return;
    finish();
    if (outcome === 'missing') showToast('That task no longer exists');
  });
  const timer = window.setTimeout(() => {
    if (finished) return;
    finish();
    // Signed out / still loading: stay quiet; otherwise the task is really gone.
    const s = useStore.getState();
    if (s.tasksLoaded && s.user) showToast('That task no longer exists');
  }, WAIT_MS);
  cancelPending = finish;
}
