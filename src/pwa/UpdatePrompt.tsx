/**
 * Service-worker registration + the "new version" prompt (SPEC §7).
 *
 * Prompt flow (never reloads on its own while you're working):
 *  1. A new build installs in the background and waits.
 *  2. Toast "A new version is available · Reload". Tapping Reload activates it and reloads this page.
 *     Ignored → it comes back the next time the app returns to the foreground.
 *  3. Another open tab/window that didn't ask for the update gets "Tasks was updated · Reload"
 *     instead of a surprise reload.
 * Updates are checked when the app returns to the foreground and hourly while it stays open.
 * Renders nothing; mount once (App does). No-op in dev (the plugin serves a stub register module).
 */
import { useEffect } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { useStore } from '@/store/store';
import { dismissToast, showToast } from '@/store/actions';

/** Long toast (30 s instead of the usual 5 s); if ignored it returns the next time the app is foregrounded. */
const UPDATE_TOAST_MS = 30_000;
const UPDATE_CHECK_EVERY_MS = 60 * 60 * 1000;
/** If the new worker hasn't taken over this long after "Reload", reload anyway. */
const RELOAD_FALLBACK_MS = 4000;

let started = false;

function startUpdateFlow(): void {
  if (started || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  started = true;

  let registration: ServiceWorkerRegistration | undefined;
  /** A new version is waiting (or already took over another tab) and this page runs the old one. */
  let pending: 'waiting' | 'activated' | null = null;
  let reloading = false;
  let toastId: string | null = null;

  const toastShown = (): boolean => toastId !== null && useStore.getState().toasts.some((t) => t.id === toastId);

  const reloadNow = (): void => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };

  const applyUpdate = (): void => {
    if (pending === 'activated') {
      reloadNow();
      return;
    }
    reloading = true;
    // Activates the waiting worker; registerSW reloads (via onNeedReload) once it controls the page.
    void updateSW(true);
    window.setTimeout(() => {
      reloading = false;
      reloadNow();
    }, RELOAD_FALLBACK_MS);
  };

  const prompt = (): void => {
    if (!pending || reloading || toastShown()) return;
    toastId = showToast(pending === 'activated' ? 'Tasks was updated' : 'A new version is available', {
      action: { label: 'Reload', run: applyUpdate },
      duration: UPDATE_TOAST_MS,
    });
  };

  const updateSW = registerSW({
    onNeedRefresh() {
      if (pending !== 'activated') pending = 'waiting';
      prompt();
    },
    onNeedReload() {
      // The new worker now controls this page: reload if the user asked for it, otherwise ask.
      if (reloading) {
        reloading = false;
        reloadNow();
        return;
      }
      pending = 'activated';
      if (toastId) {
        dismissToast(toastId);
        toastId = null;
      }
      prompt();
    },
    onRegisteredSW(_url, r) {
      registration = r;
    },
    onRegisterError() {
      // No SW (private mode, unsupported, blocked): the app still works online.
    },
  });

  const check = (): void => {
    if (!registration || reloading || registration.installing) return;
    if (typeof navigator.onLine === 'boolean' && !navigator.onLine) return;
    registration.update().catch(() => undefined);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    check();
    prompt();
  });
  window.setInterval(check, UPDATE_CHECK_EVERY_MS);
}

export function UpdatePrompt() {
  useEffect(() => {
    // Page-lifetime singleton: registration and its listeners live as long as the page.
    startUpdateFlow();
  }, []);
  return null;
}
