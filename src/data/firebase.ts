/**
 * Firebase singletons (lazy). Only imported (dynamically) when the build has a Firebase config, so
 * local mode never downloads the SDK.
 *
 * - Auth persists in IndexedDB first (iOS home-screen apps keep their own storage partition, and
 *   IndexedDB survives app restarts there), falling back to localStorage.
 * - Firestore uses the persistent multi-tab cache so queued writes survive reloads/offline and two
 *   open tabs share one cache; if IndexedDB is unavailable (private mode, old WebKit) it falls back
 *   to an in-memory cache instead of failing.
 */
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { browserLocalPersistence, getAuth, indexedDBLocalPersistence, initializeAuth, type Auth } from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { firebaseConfigured, firebaseOptions } from './env';

export { firebaseConfigured };

let instance: { app: FirebaseApp; auth: Auth; db: Firestore } | null = null;

function createApp(): FirebaseApp {
  // A hot-reloaded module may find the default app already initialized.
  if (getApps().length > 0) return getApp();
  return initializeApp(firebaseOptions);
}

function createAuth(app: FirebaseApp): Auth {
  try {
    return initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  } catch {
    // auth/already-initialized (hot reload): reuse the existing instance.
    return getAuth(app);
  }
}

function createDb(app: FirebaseApp): Firestore {
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    try {
      return initializeFirestore(app, { localCache: memoryLocalCache() });
    } catch {
      // Already initialized (hot reload): reuse it.
      return getFirestore(app);
    }
  }
}

/** Lazy singleton; throws when Firebase is not configured (callers check firebaseConfigured). */
export function getFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore } {
  if (instance) return instance;
  if (!firebaseConfigured) throw new Error('Firebase is not configured');
  const app = createApp();
  instance = { app, auth: createAuth(app), db: createDb(app) };
  return instance;
}
