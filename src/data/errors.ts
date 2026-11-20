/**
 * Sync error sink. Repos report failed writes / listeners here; boot.ts installs the handler that
 * turns them into store.sync.error + a "Couldn't sync — <reason>" toast. Keeps data/ free of
 * store imports (no module cycles).
 */
export interface SyncErrorHandler {
  onError(e: unknown): void;
  onRecovered(): void;
}

let handler: SyncErrorHandler | null = null;
/** Listener keys: the active repo's tasks collection / user document listeners. */
export const LISTEN_TASKS = 'tasks';
export const LISTEN_USER = 'user';
/** Listeners (by key) that failed and have not delivered a snapshot since. */
const brokenListeners = new Set<string>();

export function setSyncErrorHandler(h: SyncErrorHandler | null): void {
  handler = h;
}

export function reportSyncError(e: unknown): void {
  handler?.onError(e);
}

/**
 * A write succeeded after an earlier failure: clears the sticky error state — unless a listener is
 * still down (a successful write says nothing about whether other devices' changes arrive).
 */
export function reportSyncOk(): void {
  if (brokenListeners.size === 0) handler?.onRecovered();
}

/** Reading your own data is only refused when the account has no `allow/{uid}` entry (firestore.rules). */
export const NOT_ALLOWLISTED = "this account isn't allowlisted yet (docs/DEPLOY.md, step 10)";

/**
 * A snapshot listener failed: the error stays until that listener delivers a snapshot again. Its
 * re-listen attempts failing again while it is still down are not reported again (no toast per retry).
 */
export function reportListenError(key: string, e: unknown): void {
  if (brokenListeners.has(key)) return;
  brokenListeners.add(key);
  handler?.onError(codeOf(e) === 'permission-denied' ? new Error(NOT_ALLOWLISTED) : e);
}

/** The listener `key` delivered a snapshot: clears the error once no listener is down. */
export function reportListenOk(key: string): void {
  if (!brokenListeners.delete(key)) return;
  if (brokenListeners.size === 0) handler?.onRecovered();
}

/** Forgets a listener without reporting anything (its repo was disposed: sign-out, account switch). */
export function forgetListener(key: string): void {
  brokenListeners.delete(key);
}

/** True while the listener `key` is down. */
export function isListenerDown(key: string): boolean {
  return brokenListeners.has(key);
}

function codeOf(e: unknown): string {
  if (e != null && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code.replace(/^firestore\//, '');
  }
  return '';
}

/** Short, lowercase reason for a sync failure ("Couldn't sync — <reason>"). */
export function syncErrorReason(e: unknown): string {
  switch (codeOf(e)) {
    case 'permission-denied':
      return 'permission denied';
    case 'unauthenticated':
      return 'please sign in again';
    case 'not-found':
      return 'the task no longer exists';
    case 'resource-exhausted':
      return 'storage quota exceeded';
    case 'invalid-argument':
      return 'invalid data';
    case 'unavailable':
    case 'deadline-exceeded':
      return "can't reach the server";
    case 'failed-precondition':
      return 'offline storage is unavailable';
    case 'aborted':
      return 'the change conflicted, try again';
    default: {
      if (e instanceof Error) {
        if (e.name === 'QuotaExceededError') return 'storage quota exceeded';
        const msg = e.message.replace(/^Firebase(Error)?:\s*/i, '').replace(/\s*\([^)]*\)\.?$/, '').trim();
        if (msg) return msg.length > 80 ? `${msg.slice(0, 79)}…` : msg;
      }
      return 'unknown error';
    }
  }
}
