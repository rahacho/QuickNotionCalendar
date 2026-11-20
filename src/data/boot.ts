/**
 * Wires auth → repo → store.
 *  - Local mode (no Firebase env): user {uid:'local'}, authReady, LocalRepo.
 *  - Firebase mode: the SDK is loaded on demand; onAuthStateChanged drives user/authReady; a
 *    signed-in user gets a Firestore repo whose task/user snapshots feed the store; signing out
 *    disposes it and clears every per-account piece of state.
 *  - Time zone: once the user doc AND the tasks have come from the SERVER (never from the offline
 *    cache, whose copies may be stale), a device time zone that differs from settings.timezone is
 *    written back (updateSettings recomputes summaryAt and every remindAt). Checked again whenever
 *    the app is resumed or focused after the device itself changed zone (travel).
 *  - Derived fields (Firestore mode): remindAt / summaryAt are written by every device from its own
 *    copy, so a field-level merge can leave them wrong. Server-confirmed snapshots are checked and a
 *    missing or too-late remindAt is repaired, and a summaryAt missing while the summary is on is
 *    re-armed. The scheduled function is the authority (it re-derives remindAt of every task written
 *    in the last minutes, and repairs summaryAt every minute): a non-missing summaryAt is left to it,
 *    since this device's clock may be off and re-arm a summary that just went out.
 *  - A tasks listener that fails before ANY data arrived leaves tasksLoaded false and sets
 *    sync.loadFailed: App shows "Couldn't load your tasks" (never an empty calendar), until a snapshot
 *    arrives (the repo keeps re-listening).
 *  - navigator.onLine + online/offline events → store.sync.online.
 */
import type { Task, UserDoc } from '@shared/types';
import { computeRemindAt, repairedRemindAt } from '@shared/reminders';
import { useStore, type AppState } from '@/store/store';
import { resetSession, showToast, updateSettings } from '@/store/actions';
import { firebaseConfigured } from './env';
import { getRepo, setCurrentRepo } from './current';
import { createLocalRepo } from './localRepo';
import {
  LISTEN_TASKS,
  LISTEN_USER,
  forgetListener,
  isListenerDown,
  reportListenError,
  reportSyncError,
  setSyncErrorHandler,
  syncErrorReason,
} from './errors';
import { deepEqual, deviceTimeZone, safeNextSummaryAt } from './taskDoc';
import type { Repo, RepoOp, SnapshotMeta } from './repo';

export { getRepo };

/** The same failure reported repeatedly (e.g. every write while permission is denied) toasts once per window. */
const TOAST_DEDUPE_MS = 8000;

function installSyncErrorHandler(): () => void {
  let lastMessage = '';
  let lastAt = 0;
  setSyncErrorHandler({
    onError(e) {
      const reason = syncErrorReason(e);
      const s = useStore.getState();
      if (s.sync.error !== reason) useStore.setState({ sync: { ...s.sync, error: reason } });
      const message = `Couldn't sync — ${reason}`;
      const now = Date.now();
      if (message !== lastMessage || now - lastAt > TOAST_DEDUPE_MS) {
        lastMessage = message;
        lastAt = now;
        showToast(message);
      }
    },
    onRecovered() {
      const s = useStore.getState();
      if (s.sync.error !== null) useStore.setState({ sync: { ...s.sync, error: null } });
      lastMessage = '';
    },
  });
  return () => setSyncErrorHandler(null);
}

function trackOnline(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const update = (): void => {
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const s = useStore.getState();
    if (s.sync.online !== online) useStore.setState({ sync: { ...s.sync, online } });
  };
  update();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}

/**
 * Makes `repo` the active repository and feeds its snapshots into the store. Returns a cleanup
 * that unsubscribes and disposes it. `isActive` filters listener errors raised while the session
 * is being torn down (e.g. permission-denied right after sign-out).
 */
export function connectRepo(repo: Repo, isActive: () => boolean = () => true): () => void {
  setCurrentRepo(repo);
  const firebase = repo.kind === 'firebase';
  let userDoc: UserDoc | null = null;
  let userMeta: SnapshotMeta = { fromCache: true, hasPendingWrites: false };
  let tasksMeta: SnapshotMeta = { fromCache: true, hasPendingWrites: false };
  /** The boot-time zone check ran (on server data). */
  let tzSynced = false;
  /** The device's zone when last checked: a resumed app pushes its zone only if the DEVICE moved. */
  let lastDeviceTz: string | null = null;
  /** Task versions whose remindAt was already checked against the merged document. */
  let checked = new WeakSet<Task>();
  let closed = false;

  /** Both listeners deliver what the server has (not a possibly stale offline copy). */
  const serverReady = (): boolean =>
    !closed && userDoc !== null && !userMeta.fromCache && !tasksMeta.fromCache && useStore.getState().tasksLoaded;

  const syncTimeZone = (): void => {
    if (!serverReady()) return;
    const tz = deviceTimeZone();
    const travelled = lastDeviceTz !== null && lastDeviceTz !== tz;
    const boot = !tzSynced;
    tzSynced = true;
    lastDeviceTz = tz;
    if ((boot || travelled) && useStore.getState().settings.timezone !== tz) updateSettings({ timezone: tz });
  };

  /** Lowers / fills remindAt values that disagree with the merged task (never touches due ones). */
  const repairRemindAts = (): void => {
    if (!firebase || !serverReady() || tasksMeta.hasPendingWrites) return;
    const now = Date.now();
    const tz = useStore.getState().settings.timezone;
    const ops: RepoOp[] = [];
    for (const t of Object.values(useStore.getState().tasks)) {
      if (checked.has(t)) continue;
      checked.add(t);
      let computed: number | null;
      try {
        computed = computeRemindAt(t, tz, now);
      } catch {
        continue;
      }
      const remindAt = repairedRemindAt(t.remindAt, computed, now);
      if (remindAt !== undefined) ops.push({ type: 'update', id: t.id, patch: { fields: { remindAt } } });
    }
    if (ops.length > 0) repo.apply(ops);
  };

  /**
   * The summary is on but summaryAt is missing (written from a stale "off" copy): re-arm it. Any
   * other value is left to the scheduled function, which repairs it every minute with an accurate
   * clock (re-computing it here with a clock that is behind would re-arm the summary that just went out).
   */
  const repairSummaryAt = (): void => {
    if (!firebase || closed || userDoc === null || userMeta.fromCache || userMeta.hasPendingWrites) return;
    if (userDoc.summaryAt !== null) return;
    const expected = safeNextSummaryAt(userDoc.settings, Date.now());
    if (expected !== null) repo.updateUser({ summaryAt: expected });
  };

  const onListenError =
    (key: string) =>
    (e: Error): void => {
      if (closed || !isActive()) return;
      if (firebase) reportListenError(key, e);
      else reportSyncError(e);
      // Never leave the UI on the loading screen — nor show an empty calendar as if nothing were
      // planned — because the tasks never arrived: App says so (with Try again) instead.
      const s = useStore.getState();
      if (key === LISTEN_TASKS && !s.tasksLoaded && !s.sync.loadFailed) useStore.setState({ sync: { ...s.sync, loadFailed: true } });
    };

  const unsubTasks = repo.subscribeTasks((tasks, meta) => {
    if (closed) return;
    tasksMeta = meta;
    const s = useStore.getState();
    const patch: Partial<AppState> = {};
    if (s.tasks !== tasks) patch.tasks = tasks;
    // Still down without ever delivering: this is only the repo echoing a local write, not data.
    const loadFailed = s.sync.loadFailed && isListenerDown(LISTEN_TASKS);
    if (!s.tasksLoaded && !loadFailed) patch.tasksLoaded = true;
    if (s.sync.pendingWrites !== meta.hasPendingWrites || s.sync.fromCache !== meta.fromCache || s.sync.loadFailed !== loadFailed) {
      patch.sync = { ...s.sync, pendingWrites: meta.hasPendingWrites, fromCache: meta.fromCache, loadFailed };
    }
    if (Object.keys(patch).length > 0) useStore.setState(patch);
    syncTimeZone();
    repairRemindAts();
  }, onListenError(LISTEN_TASKS));

  const unsubUser = repo.subscribeUser((doc, meta) => {
    if (closed) return;
    const prevTz = userDoc?.settings.timezone;
    userDoc = doc;
    userMeta = meta ?? { fromCache: false, hasPendingWrites: false };
    if (doc && !deepEqual(useStore.getState().settings, doc.settings)) useStore.setState({ settings: doc.settings });
    // remindAt depends on the zone: everything needs a fresh look under a new one.
    if (doc && prevTz !== undefined && prevTz !== doc.settings.timezone) checked = new WeakSet();
    // Repair first: a time-zone change written right after supersedes it (same field, last write wins).
    repairSummaryAt();
    syncTimeZone();
    repairRemindAts();
  }, onListenError(LISTEN_USER));

  // Travel while the app stays alive (iOS resumes a suspended home-screen app; a laptop tab stays
  // open): re-check the zone whenever the app comes back.
  const onResume = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    syncTimeZone();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onResume);

  return () => {
    if (closed) return;
    closed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onResume);
    unsubTasks();
    unsubUser();
    repo.dispose();
    forgetListener(LISTEN_TASKS);
    forgetListener(LISTEN_USER);
    if (getRepo() === repo) setCurrentRepo(null);
  };
}

/** Wires auth → repo → store; local mode when !firebaseConfigured. Returns cleanup. */
export function bootData(): () => void {
  const cleanups: Array<() => void> = [installSyncErrorHandler(), trackOnline()];
  const cleanup = (): void => {
    for (const fn of cleanups.splice(0).reverse()) fn();
  };

  if (!firebaseConfigured) {
    const s = useStore.getState();
    if (s.mode !== 'local' || !s.authReady || s.user?.uid !== 'local') {
      useStore.setState({ mode: 'local', authReady: true, user: { uid: 'local', email: null } });
    }
    cleanups.push(connectRepo(createLocalRepo()));
    return cleanup;
  }

  if (useStore.getState().mode !== 'firebase') useStore.setState({ mode: 'firebase' });
  let cancelled = false;
  let currentUid: string | null | undefined;
  let detach: (() => void) | null = null;
  let unsubAuth: (() => void) | null = null;

  cleanups.push(() => {
    cancelled = true;
    unsubAuth?.();
    unsubAuth = null;
    detach?.();
    detach = null;
  });

  Promise.all([import('./firebase'), import('firebase/auth'), import('./firestoreRepo')]).then(
    ([fb, authMod, fr]) => {
      if (cancelled) return;
      const { auth } = fb.getFirebase();
      unsubAuth = authMod.onAuthStateChanged(
        auth,
        (user) => {
          if (cancelled) return;
          const uid = user?.uid ?? null;
          if (uid === currentUid) {
            const s = useStore.getState();
            const email = user?.email ?? null;
            if (user && s.user?.email !== email) useStore.setState({ user: { uid: user.uid, email } });
            if (!s.authReady) useStore.setState({ authReady: true });
            return;
          }
          detach?.();
          detach = null;
          currentUid = uid;
          resetSession();
          if (!user) {
            useStore.setState({ user: null, authReady: true });
            return;
          }
          useStore.setState({ user: { uid: user.uid, email: user.email ?? null }, authReady: true });
          detach = connectRepo(fr.createFirestoreRepo(user.uid), () => !cancelled && auth.currentUser?.uid === user.uid);
        },
        (e) => {
          if (cancelled) return;
          useStore.setState({ authReady: true });
          reportSyncError(e);
        },
      );
    },
    (e: unknown) => {
      if (cancelled) return;
      // The SDK couldn't load (offline first launch without a cached build): show the sign-in
      // screen with an explanation rather than an endless spinner.
      useStore.setState({ authReady: true, user: null });
      showToast(`Couldn't load sync — ${syncErrorReason(e)}`);
    },
  );

  return cleanup;
}
