/// <reference lib="webworker" />
/**
 * Service worker (SPEC §7), built by vite-plugin-pwa (injectManifest) into dist/sw.js.
 *
 *  - Precaches the app shell + lazy chunks; old precaches are cleaned up.
 *  - SPA navigation fallback → index.html (except Firebase's reserved /__/ URLs and file-like paths).
 *  - Update flow is a prompt: a new worker waits until the page posts {type:'SKIP_WAITING'}
 *    (UpdatePrompt → "Reload"). clientsClaim() makes the very first install control the open page,
 *    so the app works offline from the first visit.
 *  - push → ALWAYS shows a notification (iOS revokes subscriptions that receive silent pushes) and
 *    sets the Home Screen badge when the Badging API exists.
 *  - notificationclick → focuses an open window and tells it which task to open, or opens a new one.
 *  - pushsubscriptionchange → re-subscribes with the same key and asks open pages to re-save the device.
 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import type { PushPayload } from '@shared/types';
import { SKIP_WAITING, type SWToClientMessage } from './push/messages';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> };

const ICON = '/pwa-192.png';
const BADGE = '/badge-96.png';
const DEFAULT_TITLE = 'Tasks';

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (data && typeof data === 'object' && (data as { type?: unknown }).type === SKIP_WAITING) {
    event.waitUntil(self.skipWaiting());
  }
});

clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [
      /^\/__\//, // Firebase Hosting reserved URLs (auth handler, init.json, …)
      /\/[^/?]+\.[a-z0-9]+$/i, // file-like paths (robots.txt, images, …) are never app routes
    ],
  }),
);

// ---------------------------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------------------------

/** Parses a push message defensively: whatever arrives, there is always something to show. */
function parsePayload(data: PushMessageData | null): PushPayload {
  const fallback: PushPayload = { title: DEFAULT_TITLE, body: '', badge: -1, tag: '', url: '/' };
  if (!data) return fallback;
  let raw: unknown;
  try {
    raw = data.json();
  } catch {
    let text = '';
    try {
      text = data.text();
    } catch {
      text = '';
    }
    return { ...fallback, body: text.slice(0, 500) };
  }
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<Record<keyof PushPayload, unknown>>;
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const title = str(r.title, 200).trim();
  return {
    title: title || DEFAULT_TITLE,
    body: str(r.body, 1000),
    badge: typeof r.badge === 'number' && Number.isFinite(r.badge) && r.badge >= 0 ? Math.floor(r.badge) : -1,
    tag: str(r.tag, 200),
    url: str(r.url, 2000) || '/',
  };
}

/** Same-origin absolute URL inside the worker's scope; anything else falls back to the app root. */
function safeUrl(raw: unknown): string {
  const scope = self.registration.scope;
  if (typeof raw !== 'string' || raw === '') return scope;
  try {
    const url = new URL(raw, scope);
    return url.origin === self.location.origin && url.href.startsWith(scope) ? url.href : scope;
  } catch {
    return scope;
  }
}

async function setBadge(count: number): Promise<void> {
  if (count < 0) return;
  const nav = self.navigator;
  try {
    if (count > 0 && 'setAppBadge' in nav) await nav.setAppBadge(count);
    else if (count === 0 && 'clearAppBadge' in nav) await nav.clearAppBadge();
  } catch {
    // Badging is best-effort (needs an installed app + permission on some platforms).
  }
}

async function handlePush(data: PushMessageData | null): Promise<void> {
  const p = parsePayload(data);
  const options: NotificationOptions & { renotify?: boolean } = {
    body: p.body,
    icon: ICON,
    badge: BADGE,
    data: { url: safeUrl(p.url) },
  };
  if (p.tag) {
    options.tag = p.tag;
    // A replaced notification with the same tag should still alert (Chromium; ignored elsewhere).
    options.renotify = true;
  }
  await Promise.all([
    self.registration.showNotification(p.title, options).catch(() => undefined),
    setBadge(p.badge),
  ]);
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data));
});

// ---------------------------------------------------------------------------------------------
// Notification click
// ---------------------------------------------------------------------------------------------

async function focusOrOpen(url: string): Promise<void> {
  const scope = self.registration.scope;
  const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((w) =>
    w.url.startsWith(scope),
  );
  const target =
    windows.find((w) => w.focused) ?? windows.find((w) => w.visibilityState === 'visible') ?? windows[0] ?? null;
  if (target) {
    const message: SWToClientMessage = { type: 'open', url };
    target.postMessage(message);
    try {
      await target.focus();
    } catch {
      // Focus can be refused (no user activation on some platforms); the message is delivered anyway.
    }
    return;
  }
  try {
    await self.clients.openWindow(url);
  } catch {
    // Nothing else to do: the platform refused to open a window.
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const url = safeUrl(data && typeof data === 'object' ? (data as { url?: unknown }).url : undefined);
  event.waitUntil(focusOrOpen(url));
});

// ---------------------------------------------------------------------------------------------
// Subscription rotation
// ---------------------------------------------------------------------------------------------

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      if (!event.newSubscription) {
        const key = event.oldSubscription?.options.applicationServerKey ?? null;
        if (key) {
          await self.registration.pushManager
            .subscribe({ userVisibleOnly: true, applicationServerKey: key })
            .catch(() => null);
        }
      }
      // The page owns the Firestore device doc (it has the signed-in user): ask open pages to re-save it.
      // With no page open, the next app launch notices the changed endpoint and re-saves it then.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const message: SWToClientMessage = { type: 'push-subscription-changed' };
      for (const w of windows) w.postMessage(message);
    })(),
  );
});
