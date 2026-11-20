/**
 * Email + password auth. The Firebase SDK is loaded on demand so local mode never downloads it.
 */
import { firebaseConfigured } from './env';

async function sdk() {
  if (!firebaseConfigured) throw Object.assign(new Error('Sync is not configured for this build.'), { code: 'app/not-configured' });
  const [{ getFirebase }, authMod] = await Promise.all([import('./firebase'), import('firebase/auth')]);
  return { auth: getFirebase().auth, authMod };
}

export async function signIn(email: string, password: string): Promise<void> {
  const { auth, authMod } = await sdk();
  await authMod.signInWithEmailAndPassword(auth, email.trim(), password);
}

export async function signUp(email: string, password: string): Promise<void> {
  const { auth, authMod } = await sdk();
  await authMod.createUserWithEmailAndPassword(auth, email.trim(), password);
}

export async function signOutUser(): Promise<void> {
  const { auth, authMod } = await sdk();
  await authMod.signOut(auth);
}

export async function resetPassword(email: string): Promise<void> {
  const { auth, authMod } = await sdk();
  await authMod.sendPasswordResetEmail(auth, email.trim());
}

const MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'That email address doesn’t look right.',
  'auth/missing-email': 'Enter your email address.',
  'auth/missing-password': 'Enter your password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/invalid-login-credentials': 'Incorrect email or password.',
  'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
  'auth/weak-password': 'Use a password with at least 6 characters.',
  'auth/password-does-not-meet-requirements': 'That password doesn’t meet the requirements.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/network-request-failed': 'Can’t reach the server. Check your connection and try again.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/operation-not-allowed': 'Email sign-in isn’t enabled for this project.',
  'auth/admin-restricted-operation': 'New accounts can’t be created right now.',
  'auth/quota-exceeded': 'Too many requests right now. Try again later.',
  'auth/expired-action-code': 'This link has expired. Request a new one.',
  'auth/invalid-action-code': 'This link is invalid or was already used.',
  'auth/requires-recent-login': 'Please sign in again to continue.',
  'auth/user-token-expired': 'Your session expired. Please sign in again.',
  'auth/internal-error': 'Something went wrong. Try again.',
  'auth/invalid-api-key': 'This app isn’t configured correctly (invalid API key).',
  'auth/app-not-authorized': 'This domain isn’t authorized for sign-in.',
  'auth/unauthorized-domain': 'This domain isn’t authorized for sign-in.',
  'app/not-configured': 'Sync is not configured for this build.',
};

/** Friendly text for a Firebase auth error (or any error). */
export function authErrorMessage(e: unknown): string {
  const code =
    e != null && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string'
      ? (e as { code: string }).code
      : '';
  const known = MESSAGES[code];
  if (known) return known;
  if (code.startsWith('auth/')) return 'Something went wrong. Try again.';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'You’re offline. Connect to the internet and try again.';
  }
  return 'Something went wrong. Try again.';
}
