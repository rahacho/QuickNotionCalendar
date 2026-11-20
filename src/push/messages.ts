/**
 * postMessage protocol between the service worker (src/sw.ts) and pages (src/push, src/pwa).
 * Kept free of DOM / WebWorker-only types so both tsconfigs can import it.
 */

/** Worker → page: open the task deep link `url` (from a notification click). */
export interface OpenUrlMessage {
  type: 'open';
  url: string;
}

/** Worker → page: the browser rotated the push subscription; re-save this device's doc. */
export interface SubscriptionChangedMessage {
  type: 'push-subscription-changed';
}

export type SWToClientMessage = OpenUrlMessage | SubscriptionChangedMessage;

/** Page → worker: activate the waiting worker (sent by workbox-window's messageSkipWaiting()). */
export const SKIP_WAITING = 'SKIP_WAITING';

export function isSWToClientMessage(data: unknown): data is SWToClientMessage {
  if (!data || typeof data !== 'object') return false;
  const m = data as { type?: unknown; url?: unknown };
  return (m.type === 'open' && typeof m.url === 'string') || m.type === 'push-subscription-changed';
}
