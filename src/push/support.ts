/**
 * Low-level helpers for Web Push on this device: environment detection, the VAPID key, the
 * service-worker registration, the per-device id and the local record of what was saved to Firestore.
 * No React, no store.
 */
import type { DeviceDoc } from '@shared/types';
import { firebaseConfigured } from '@/data/env';
import { platform } from '@/lib/platform';
import { isStandalone } from '@/hooks/useIsStandalone';

// ---------------------------------------------------------------------------------------------
// VAPID public key
// ---------------------------------------------------------------------------------------------

/** base64url → bytes (null when malformed). */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  const clean = s.trim();
  if (clean === '' || /[^A-Za-z0-9\-_=]/.test(clean)) return null;
  try {
    const b64 = clean.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** bytes → base64url without padding. */
export function bytesToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readVapidKey(): Uint8Array<ArrayBuffer> | null {
  const raw: unknown = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (typeof raw !== 'string') return null;
  const bytes = base64UrlToBytes(raw);
  // An uncompressed P-256 public key: 65 bytes, 0x04 prefix (what `web-push generate-vapid-keys` prints).
  return bytes && bytes.length === 65 && bytes[0] === 4 ? bytes : null;
}

export const vapidKey: Uint8Array<ArrayBuffer> | null = readVapidKey();

/** Push can work in this build: Firebase sync is configured and a valid VAPID public key is present. */
export const pushConfigured: boolean = firebaseConfigured && vapidKey !== null;

/** True when `key` (a subscription's applicationServerKey) is our VAPID key. Unknown (null) counts as a match. */
export function isOurKey(key: ArrayBuffer | null | undefined): boolean {
  if (!vapidKey) return false;
  if (key == null) return true;
  const a = new Uint8Array(key);
  if (a.length !== vapidKey.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== vapidKey[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

/** iOS/iPadOS version as major + minor/100 (16.4 → 16.04), or null when it can't be read. */
export function iosVersion(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): number | null {
  const m = /\bOS (\d+)[_.](\d+)/.exec(ua) ?? /\bVersion\/(\d+)\.(\d+)/.exec(ua);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 100;
}

/** iOS / iPadOS Safari (not Chrome/Firefox/Edge/in-app browsers, which wrap WebKit under other names). */
export function isIOSSafari(): boolean {
  if (!platform.isIOS || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|YaBrowser|Instagram|FBAN|FBAV|Line\//.test(ua);
}

/** Web Push on iOS exists only for Home Screen apps, from iOS 16.4. */
function iosSupportsWebPush(): boolean {
  const v = iosVersion();
  return v === null || v >= 16.04;
}

/**
 * The environment's answer before looking at the subscription:
 *  'unsupported' | 'needs-install' | 'denied', or null when the device can do push (default/subscribed TBD).
 */
export function environmentState(): 'unsupported' | 'needs-install' | 'denied' | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if (!pushConfigured) return 'unsupported';
  if (platform.isIOS && !isStandalone()) return iosSupportsWebPush() ? 'needs-install' : 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
}

/**
 * Notification.requestPermission() that works with both the promise and the legacy callback form.
 * Call it synchronously from the click handler (Safari only prompts inside a user gesture).
 */
export function requestNotificationPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (p: NotificationPermission): void => {
      if (settled) return;
      settled = true;
      resolve(p);
    };
    try {
      const result = Notification.requestPermission(done);
      if (result && typeof result.then === 'function') result.then(done, () => done(Notification.permission));
    } catch {
      done(Notification.permission);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------------------------

/** Resolves with `p`, or with `fallback()` after `ms` (the original promise keeps running). */
export function within<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The active service-worker registration (waits for a first install), or null (dev / no SW / timeout). */
export async function getActiveRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const sw = navigator.serviceWorker;
  const existing = await sw.getRegistration().catch(() => undefined);
  if (existing?.active) return existing;
  // The dev server never registers a worker; in production it may still be registering/installing.
  if (!existing && !import.meta.env.PROD) return null;
  return within<ServiceWorkerRegistration | null>(sw.ready, timeoutMs, () => null).catch(() => null);
}

// ---------------------------------------------------------------------------------------------
// Device id + local record
// ---------------------------------------------------------------------------------------------

const DEVICE_ID_KEY = 'tasks.deviceId';
const RECORD_KEY = 'tasks.push';

let memoryDeviceId: string | null = null;

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Stable per-device id (localStorage 'tasks.deviceId'); the Firestore doc id under users/{uid}/devices. */
export function getDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored && /^[A-Za-z0-9-]{8,64}$/.test(stored)) return stored;
    const id = uuid();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    memoryDeviceId ??= uuid();
    return memoryDeviceId;
  }
}

/** What this device last wrote to users/{uid}/devices/{deviceId}. Present ⇔ push was enabled here. */
export interface DeviceRecord {
  uid: string;
  endpoint: string;
  createdAt: number;
  savedAt: number;
}

export function readDeviceRecord(): DeviceRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<DeviceRecord>;
    if (typeof r.uid !== 'string' || typeof r.endpoint !== 'string') return null;
    const createdAt = typeof r.createdAt === 'number' ? r.createdAt : 0;
    const savedAt = typeof r.savedAt === 'number' ? r.savedAt : 0;
    return { uid: r.uid, endpoint: r.endpoint, createdAt, savedAt };
  } catch {
    return null;
  }
}

export function writeDeviceRecord(r: DeviceRecord | null): void {
  try {
    if (r) localStorage.setItem(RECORD_KEY, JSON.stringify(r));
    else localStorage.removeItem(RECORD_KEY);
  } catch {
    // Private mode / storage blocked: the next launch simply re-saves the device.
  }
}

/** PushSubscription → DeviceDoc.subscription (null if the browser returned something incomplete). */
export function subscriptionJSON(sub: PushSubscription): DeviceDoc['subscription'] | null {
  let json: PushSubscriptionJSON = {};
  try {
    json = sub.toJSON();
  } catch {
    json = {};
  }
  const endpoint = json.endpoint ?? sub.endpoint;
  const key = (name: PushEncryptionKeyName): string | null => {
    const fromJson = json.keys?.[name];
    if (typeof fromJson === 'string' && fromJson !== '') return fromJson;
    const raw = sub.getKey(name);
    return raw ? bytesToBase64Url(raw) : null;
  };
  const p256dh = key('p256dh');
  const auth = key('auth');
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, expirationTime: json.expirationTime ?? sub.expirationTime ?? null, keys: { p256dh, auth } };
}
