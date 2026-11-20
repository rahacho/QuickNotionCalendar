/**
 * Web Push on this device + Home Screen badge (SPEC §7).
 *
 *  - usePushState(): live state for Settings → Notifications
 *      unsupported   no push here (or this build has no Firebase / VAPID key → see `pushConfigured`)
 *      needs-install iOS/iPadOS in a browser tab: push needs the Home Screen app (Share → Add to Home Screen)
 *      default       can be enabled (permission not granted yet, or granted but not subscribed)
 *      denied        notifications blocked for this site/app in system settings
 *      subscribed    this device receives pushes
 *      error         the last enable attempt failed (try again)
 *  - enablePush(): call from a click. Permission → PushManager.subscribe(VAPID) → repo.saveDevice(deviceId).
 *  - disablePush(): unsubscribe + delete this device's doc. `{ resumeOnSignIn: true }` (sign-out) also
 *    remembers that push was on here, so the next sign-in on this device turns it back on by itself.
 *  - useBadgeSync(): mounted once by App. Keeps the app-icon badge = today's open + overdue, and also
 *    wires the service worker's messages (notification click → open that task's peek; subscription
 *    rotated → re-save) and keeps this device's Firestore doc current (endpoint/key/account changes).
 *  - showLocalTestNotification(): a local notification to check that alerts appear on this device.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { DeviceDoc } from '@shared/types';
import { getRepo } from '@/data/boot';
import { useStore } from '@/store/store';
import { badgeCountOf, useBadgeCount } from '@/store/selectors';
import { platform } from '@/lib/platform';
import { isStandalone } from '@/hooks/useIsStandalone';
import { isSWToClientMessage } from './messages';
import { openTaskLink } from './openLink';
import {
  environmentState,
  getActiveRegistration,
  getDeviceId,
  isOurKey,
  notificationPermission,
  readDeviceRecord,
  requestNotificationPermission,
  subscriptionJSON,
  vapidKey,
  within,
  writeDeviceRecord,
} from './support';

export { pushConfigured } from './support';
export { getDeviceId } from './support';

export type PushState = 'unsupported' | 'needs-install' | 'default' | 'denied' | 'subscribed' | 'error';

const NOTIFICATION_ICON = '/pwa-192.png';
const NOTIFICATION_BADGE = '/badge-96.png';
/** Firestore resolves a write only when the server acks it; offline it's queued — don't block the UI on that. */
const SAVE_WAIT_MS = 8000;
/** Re-save the device doc at least this often (keeps updatedAt fresh, heals a pruned doc). */
const RESAVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Set by a sign-out while push was on: the next sign-in here re-enables it (reminders never just stop). */
const RESUME_KEY = 'tasks.push.resumeOnSignIn';

function readResume(): boolean {
  try {
    return localStorage.getItem(RESUME_KEY) === '1';
  } catch {
    return false;
  }
}

function writeResume(on: boolean): void {
  try {
    if (on) localStorage.setItem(RESUME_KEY, '1');
    else localStorage.removeItem(RESUME_KEY);
  } catch {
    // Storage unavailable: the Tasks list's "Reminders are off" hint still points the way back.
  }
}

// =============================================================================================
// State store (module-level, shared by every usePushState() consumer)
// =============================================================================================

let state: PushState = initialState();
/** The last enable/upkeep attempt failed; kept until a later attempt succeeds or the state changes underneath. */
let failed = false;
const listeners = new Set<() => void>();
let wired = false;

function initialState(): PushState {
  const env = environmentState();
  if (env) return env;
  return notificationPermission() === 'granted' && readDeviceRecord() ? 'subscribed' : 'default';
}

function setState(next: PushState): void {
  if (next === state) return;
  state = next;
  for (const l of [...listeners]) l();
}

/** Recomputes the state from the environment + the actual push subscription. */
export async function refreshPushState(): Promise<PushState> {
  const env = environmentState();
  if (env) {
    if (env === 'denied') failed = false;
    setState(env);
    return env;
  }
  let subscribed = false;
  if (notificationPermission() === 'granted') {
    const reg = await getActiveRegistration(4000);
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    subscribed = !!sub && isOurKey(sub.options.applicationServerKey);
  }
  const next: PushState = subscribed ? 'subscribed' : failed ? 'error' : 'default';
  if (subscribed) failed = false;
  setState(next);
  return next;
}

function wire(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  // Permission can change in system settings while the app is in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshPushState();
  });
  try {
    void navigator.permissions
      ?.query({ name: 'notifications' })
      .then((status) => {
        status.addEventListener('change', () => void refreshPushState());
      })
      .catch(() => undefined);
  } catch {
    // Permissions API unavailable — visibilitychange covers it.
  }
  void refreshPushState();
}

function subscribeState(listener: () => void): () => void {
  listeners.add(listener);
  wire();
  return () => {
    listeners.delete(listener);
  };
}

export function usePushState(): PushState {
  return useSyncExternalStore(
    subscribeState,
    () => state,
    () => 'unsupported',
  );
}

// =============================================================================================
// Enable / disable
// =============================================================================================

/** A subscription for our VAPID key: reuses a matching one, replaces a stale-key one, else subscribes. */
async function ensureSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  if (!vapidKey) throw new Error('missing-vapid-key');
  let sub = await reg.pushManager.getSubscription();
  if (sub && !isOurKey(sub.options.applicationServerKey)) {
    // The server key changed (rotated VAPID keys): the old subscription can never be used again.
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey });
}

/** Writes users/{uid}/devices/{deviceId}. Throws when signed out or when Firestore rejects the write. */
async function saveDevice(sub: PushSubscription): Promise<void> {
  const repo = getRepo();
  const user = useStore.getState().user;
  if (!repo || repo.kind !== 'firebase' || !user) throw new Error('not-signed-in');
  const subscription = subscriptionJSON(sub);
  if (!subscription) throw new Error('incomplete-subscription');
  const prev = readDeviceRecord();
  const now = Date.now();
  const createdAt = prev && prev.uid === user.uid && prev.createdAt > 0 ? prev.createdAt : now;
  const doc: DeviceDoc = {
    subscription,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 500),
    createdAt,
    updatedAt: now,
  };
  await within(repo.saveDevice(getDeviceId(), doc), SAVE_WAIT_MS, () => undefined);
  writeDeviceRecord({ uid: user.uid, endpoint: subscription.endpoint, createdAt, savedAt: now });
}

let enabling: Promise<PushState> | null = null;

/**
 * Turns on push for this device. MUST be called from a user gesture (click/tap): the permission
 * prompt is requested synchronously, before anything else is awaited (Safari requirement).
 */
export function enablePush(): Promise<PushState> {
  if (enabling) return enabling;
  const env = environmentState();
  if (env) {
    setState(env);
    return Promise.resolve(env);
  }
  const permission: Promise<NotificationPermission> =
    Notification.permission === 'granted' ? Promise.resolve('granted') : requestNotificationPermission();

  enabling = (async (): Promise<PushState> => {
    const result = await permission;
    if (result !== 'granted') {
      failed = false;
      const next: PushState = result === 'denied' ? 'denied' : 'default';
      setState(next);
      return next;
    }
    try {
      const reg = await getActiveRegistration();
      if (!reg) throw new Error('no-service-worker');
      const sub = await ensureSubscription(reg);
      await saveDevice(sub);
      failed = false;
      setState('subscribed');
      return 'subscribed';
    } catch {
      failed = true;
      // Permission might have been revoked mid-way; otherwise this is a real failure.
      const env2 = environmentState();
      const next: PushState = env2 ?? 'error';
      setState(next);
      return next;
    }
  })().finally(() => {
    enabling = null;
  });
  return enabling;
}

/**
 * Turns push off for this device: unsubscribes and deletes its device doc. Never throws.
 * `resumeOnSignIn` (sign-out): if push was on here, the next sign-in turns it back on (upkeep);
 * a plain call (Settings → Turn off) forgets any such intent.
 */
export async function disablePush(opts?: { resumeOnSignIn?: boolean }): Promise<void> {
  if (enabling) await enabling.catch(() => undefined);
  const record = readDeviceRecord();
  let hadSubscription = false;
  try {
    const reg = await getActiveRegistration(4000);
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    hadSubscription = sub !== null;
    if (sub) await sub.unsubscribe().catch(() => false);
  } catch {
    // Best effort: the server prunes dead subscriptions on its own (404/410).
  }
  const repo = getRepo();
  const user = useStore.getState().user;
  if (repo && repo.kind === 'firebase' && user && (!record || record.uid === user.uid)) {
    await within(repo.deleteDevice(getDeviceId()), SAVE_WAIT_MS, () => undefined).catch(() => undefined);
  }
  writeResume(opts?.resumeOnSignIn === true && (record !== null || hadSubscription));
  writeDeviceRecord(null);
  failed = false;
  await refreshPushState();
}

// =============================================================================================
// Upkeep: keep this device's doc in sync with its subscription and the signed-in account
// =============================================================================================

let upkeepRunning = false;

async function upkeep(force: boolean): Promise<void> {
  if (upkeepRunning || enabling) return;
  const s = useStore.getState();
  const repo = getRepo();
  if (!s.user || !repo || repo.kind !== 'firebase') return;
  if (environmentState() !== null || notificationPermission() !== 'granted') return;
  const record = readDeviceRecord();
  /** Push was on when this device signed out: turn it back on for this sign-in. */
  const resume = readResume();
  upkeepRunning = true;
  try {
    const reg = await getActiveRegistration();
    if (!reg) return;
    let sub = await reg.pushManager.getSubscription().catch(() => null);
    const wasEnabled = record !== null;
    if (!sub && !wasEnabled && !resume) return; // push was never turned on here
    if (!sub || !isOurKey(sub.options.applicationServerKey)) {
      // Lost or stale-key subscription on a device that had push on: renew it silently (permission is
      // granted). WebKit may refuse without a user gesture → 'error' (Settings offers Try again).
      sub = await ensureSubscription(reg);
    }
    const endpointChanged = !record || record.endpoint !== sub.endpoint;
    const accountChanged = !record || record.uid !== s.user.uid;
    const stale = !record || Date.now() - record.savedAt > RESAVE_AFTER_MS;
    if (force || resume || endpointChanged || accountChanged || stale) await saveDevice(sub);
    if (resume) writeResume(false);
    failed = false;
    setState('subscribed');
  } catch {
    if (resume) writeResume(false);
    failed = true;
    setState(environmentState() ?? 'error');
  } finally {
    upkeepRunning = false;
  }
}

// =============================================================================================
// Badge
// =============================================================================================

let lastBadge: number | null = null;

function badgePermitted(): boolean {
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return false;
  // iOS/iPadOS (and macOS Safari web apps) only badge with notification permission; installed
  // Chromium apps badge without it.
  if (notificationPermission() === 'granted') return true;
  return isStandalone() && !platform.isIOS;
}

function applyBadge(count: number, force = false): void {
  if (!badgePermitted()) return;
  if (!force && count === lastBadge) return;
  lastBadge = count;
  const p = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  p.catch(() => {
    lastBadge = null; // retry next time
  });
}

/**
 * Mounted once (App). Badge = today's open tasks + overdue; also wires service-worker messages and
 * device-doc upkeep (see header).
 */
export function useBadgeSync(): void {
  const count = useBadgeCount();
  const loaded = useStore((s) => s.tasksLoaded);
  const uid = useStore((s) => s.user?.uid ?? null);

  // Badge follows the data (and today's rollover, which changes the count).
  useEffect(() => {
    if (!loaded) return;
    applyBadge(uid ? count : 0);
  }, [count, loaded, uid]);

  // A push received in the background may have set a different number: re-assert on resume.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      const s = useStore.getState();
      if (!s.tasksLoaded) return;
      applyBadge(s.user ? badgeCountOf(s.tasks, s.today) : 0, true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Service-worker → page messages.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    const onMessage = (e: MessageEvent): void => {
      if (e.origin && e.origin !== window.location.origin) return;
      const data: unknown = e.data;
      if (!isSWToClientMessage(data)) return;
      if (data.type === 'open') openTaskLink(data.url);
      else void upkeep(true);
    };
    container.addEventListener('message', onMessage);
    // Deliver messages queued before this listener existed (addEventListener doesn't start the queue).
    container.startMessages();
    return () => container.removeEventListener('message', onMessage);
  }, []);

  // Device doc upkeep once per signed-in account per launch (after the first snapshot).
  useEffect(() => {
    if (!loaded || !uid) return;
    void upkeep(false);
  }, [loaded, uid]);
}

/**
 * Local test notification (Settings → "Send a test notification"). Call from a click: asks for
 * permission first if needed. Resolves true when a notification was shown.
 */
export async function showLocalTestNotification(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  let permission = Notification.permission;
  if (permission === 'default') permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    void refreshPushState();
    return false;
  }
  const title = 'Tasks';
  const body = 'Notifications are working on this device.';
  try {
    const reg = await getActiveRegistration(4000);
    if (reg) {
      await reg.showNotification(title, {
        body,
        tag: 'tasks-test',
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_BADGE,
        data: { url: '/' },
      });
      return true;
    }
    if (!platform.isIOS) {
      new Notification(title, { body, icon: NOTIFICATION_ICON, tag: 'tasks-test' });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
