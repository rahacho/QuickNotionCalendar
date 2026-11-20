/**
 * Firebase web config from Vite env. Kept free of Firebase runtime imports so the store (and local
 * mode) can decide the app mode without pulling the SDK into the bundle.
 */
import type { FirebaseOptions } from 'firebase/app';

function envString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// Each variable is read with a literal `import.meta.env.X` so Vite can statically replace it.
export const firebaseOptions: FirebaseOptions = {
  apiKey: envString(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: envString(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN) || undefined,
  projectId: envString(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: envString(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET) || undefined,
  messagingSenderId: envString(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID) || undefined,
  appId: envString(import.meta.env.VITE_FIREBASE_APP_ID) || undefined,
};

/** True when the build has a Firebase project configured; otherwise the app runs in local mode. */
export const firebaseConfigured: boolean = !!firebaseOptions.apiKey && !!firebaseOptions.projectId;
