import { useEffect, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { CloudOff } from 'lucide-react';
import { useStore } from '@/store/store';
import {
  closeComposer,
  closePeek,
  goNext,
  goPrev,
  goToday,
  setDrawer,
  setSettingsOpen,
  setSheet,
  setView,
  toggleLeft,
  toggleRight,
  undo,
  redo,
  showToast,
} from '@/store/actions';
import { startClock } from '@/store/clock';
import { bootData } from '@/data/boot';
import { authErrorMessage, signOutUser } from '@/data/auth';
import { DndProvider } from '@/dnd';
import { useApplyTheme } from '@/hooks/useTheme';
import { useHotkeys } from '@/hooks/useHotkeys';
import { computeLayoutMode, useLayoutMode } from '@/hooks/useLayoutMode';
import { hasOpenLayers } from '@/lib/layers';
import { platform } from '@/lib/platform';
import { useBadgeSync } from '@/push';
import { openTaskLink } from '@/push/openLink';
import { AppShell } from '@/components/layout/AppShell';
import { AppShellView } from '@/components/layout/AppShellView';
import { Toaster } from '@/components/ui/Toaster';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { CalendarView } from '@/components/calendar/CalendarView';
import { TasksSidebar } from '@/components/tasks/TasksSidebar';
import { InboxPanel } from '@/components/inbox/InboxPanel';
import { InboxSheet } from '@/components/inbox/InboxSheet';
import { TaskPeek } from '@/components/peek/TaskPeek';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { AuthScreen } from '@/components/auth/AuthScreen';
import { QuickAddSheet } from '@/components/quickadd/QuickAddSheet';
import { UpdatePrompt } from '@/pwa/UpdatePrompt';
import { InstallHint } from '@/pwa/InstallHint';
import styles from './App.module.css';

export function App() {
  useApplyTheme();
  useBadgeSync();
  useEffect(() => startClock(), []);
  useEffect(() => bootData(), []);
  useIOSGestureGuard();
  useDeepLink();
  useGlobalHotkeys();

  const mode = useStore((s) => s.mode);
  const authReady = useStore((s) => s.authReady);
  const signedIn = useStore((s) => s.user !== null);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const loadFailed = useStore((s) => s.sync.loadFailed);

  let body;
  if (mode === 'firebase' && authReady && !signedIn) {
    body = (
      <>
        <AuthScreen />
        <Toaster />
      </>
    );
  } else if (loadFailed && !tasksLoaded) {
    body = <LoadFailedFrame />;
  } else if (!tasksLoaded || (mode === 'firebase' && !authReady)) {
    body = <LoadingFrame />;
  } else {
    body = (
      <DndProvider>
        <AppShell
          left={<TasksSidebar />}
          center={<CalendarView />}
          right={<InboxPanel />}
          phoneSheet={<InboxSheet />}
          overlays={
            <>
              <TaskPeek />
              <SettingsModal />
              <QuickAddSheet />
              <Toaster />
            </>
          }
        />
      </DndProvider>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      {body}
      <UpdatePrompt />
      <InstallHint />
    </MotionConfig>
  );
}

/**
 * Notion-style blank frame while auth/tasks load: the real panel geometry with empty content, so nothing
 * jumps when data arrives. A quiet spinner fades in only if loading takes longer than 300ms.
 */
function LoadingFrame() {
  const mode = useLayoutMode();
  const leftOpen = useStore((s) => s.ui.leftOpen);
  const rightOpen = useStore((s) => s.ui.rightOpen);
  return (
    <AppShellView
      mode={mode}
      left={<div />}
      center={
        <div className={styles.loading} aria-busy="true" aria-label="Loading">
          <span className={styles.spinner} />
        </div>
      }
      right={<div />}
      phoneSheet={null}
      overlays={null}
      leftOpen={leftOpen}
      rightOpen={rightOpen}
      drawerOpen={false}
      onToggleLeft={toggleLeft}
      onToggleRight={toggleRight}
      onDrawerOpenChange={setDrawer}
    />
  );
}

/** "this account isn't allowlisted yet (…)" → "This account isn't allowlisted yet (…)." */
function sentence(reason: string): string {
  const t = reason.trim();
  if (t === '') return '';
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * The tasks never arrived (the listener failed before any data: an account that isn't allowlisted,
 * a quota, a broken offline store). Never show that as an empty calendar ("Nothing planned"): say
 * so, keep the panel geometry, and offer Try again (a fresh start of the app and its sync) and Sign
 * out (a different account). Nothing can be typed here, so nothing can be lost; the repo keeps
 * re-listening and the calendar appears by itself once the data arrives.
 */
export function LoadFailedFrame() {
  const mode = useLayoutMode();
  const leftOpen = useStore((s) => s.ui.leftOpen);
  const rightOpen = useStore((s) => s.ui.rightOpen);
  const reason = useStore((s) => s.sync.error);
  const firebase = useStore((s) => s.mode === 'firebase');
  const email = useStore((s) => s.user?.email ?? null);
  const [busy, setBusy] = useState(false);

  const signOut = () => {
    setBusy(true);
    signOutUser().catch((e: unknown) => {
      setBusy(false);
      showToast(authErrorMessage(e));
    });
  };

  return (
    <AppShellView
      mode={mode}
      left={<div />}
      center={
        <div className={styles.loading}>
          <div className={styles.failed} role="alert" data-testid="load-failed">
            <span className={styles.failedIcon} aria-hidden="true">
              <Icon icon={CloudOff} size={20} />
            </span>
            <h1 className={styles.failedTitle}>Couldn’t load your tasks</h1>
            <p className={styles.failedText}>
              {reason ? `${sentence(reason)} ` : ''}Tasks keeps trying in the background.
            </p>
            <div className={styles.failedActions}>
              <Button variant="primary" size="md" onClick={() => window.location.reload()} data-testid="load-retry">
                Try again
              </Button>
              {firebase && (
                <Button variant="ghost" size="md" onClick={signOut} disabled={busy} data-testid="load-sign-out">
                  Sign out
                </Button>
              )}
            </div>
            {firebase && email && <p className={styles.failedMeta}>Signed in as {email}</p>}
          </div>
        </div>
      }
      right={<div />}
      phoneSheet={null}
      overlays={<Toaster />}
      leftOpen={leftOpen}
      rightOpen={rightOpen}
      drawerOpen={false}
      onToggleLeft={toggleLeft}
      onToggleRight={toggleRight}
      onDrawerOpenChange={setDrawer}
    />
  );
}

/** iOS: block pinch-zoom of the whole app (it should feel like a native app, not a web page). */
function useIOSGestureGuard() {
  useEffect(() => {
    if (!platform.isIOS) return;
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', prevent, { passive: false });
    document.addEventListener('gesturechange', prevent, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
    };
  }, []);
}

/**
 * `?task=ID&occ=DATE` (notification tapped while the app was closed) → once tasks are loaded, clean
 * the URL and hand the link to the same opener the service worker's "open" message uses
 * (push/openLink): it resolves original or moved-to occurrence dates, waits briefly for the task to
 * sync, and says "That task no longer exists" when the task — or that occurrence — is gone, so a
 * reminder tap never lands on an unexplained calendar.
 */
function useDeepLink() {
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const started = useRef(false);

  useEffect(() => {
    if (!tasksLoaded || started.current) return;
    const href = window.location.href;
    const params = new URLSearchParams(window.location.search);
    if (!params.get('task')) return;
    started.current = true;

    params.delete('task');
    params.delete('occ');
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    openTaskLink(href);
  }, [tasksLoaded]);
}

/** Focus the Inbox input, revealing the Inbox first if it's collapsed (desktop/tablet) or a sheet (phone). */
function focusInboxInput() {
  const layout = computeLayoutMode();
  const ui = useStore.getState().ui;
  let delay = 0;
  if (layout === 'phone') {
    if (ui.sheet === 'collapsed') {
      setSheet('half');
      delay = 260;
    }
  } else if (!ui.rightOpen) {
    toggleRight();
    delay = 200;
  }
  const focus = () => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-testid="inbox-input"]');
    input?.focus({ preventScroll: true });
  };
  if (delay) window.setTimeout(focus, delay);
  else focus();
}

function useGlobalHotkeys() {
  const blocked = () => {
    const s = useStore.getState();
    const ui = s.ui;
    if (!s.tasksLoaded || (s.mode === 'firebase' && !s.user)) return true; // loading / signed out
    return hasOpenLayers() || ui.peek !== null || ui.settingsOpen || ui.dragging !== null;
  };
  useHotkeys({
    t: () => (blocked() ? false : goToday()),
    ArrowLeft: () => (blocked() ? false : goPrev()),
    ArrowRight: () => (blocked() ? false : goNext()),
    m: () => (blocked() ? false : setView('month')),
    w: () => (blocked() ? false : setView('week')),
    n: () => (blocked() ? false : focusInboxInput()),
    '[': () => {
      const desktop = computeLayoutMode() === 'desktop';
      if (!desktop && useStore.getState().ui.drawerOpen) return setDrawer(false);
      if (blocked()) return false;
      if (desktop) toggleLeft();
      else setDrawer(true);
    },
    ']': () => {
      if (blocked() || computeLayoutMode() === 'phone') return false;
      toggleRight();
    },
    'mod+z': () => {
      const s = useStore.getState();
      if (s.ui.dragging !== null || !s.tasksLoaded || (s.mode === 'firebase' && !s.user)) return false;
      undo();
    },
    'mod+shift+z': () => {
      const s = useStore.getState();
      if (s.ui.dragging !== null || !s.tasksLoaded || (s.mode === 'firebase' && !s.user)) return false;
      redo();
    },
    // Overlays built on Modal/Sheet/Popover/Drawer consume Escape themselves (lib/layers); this is the
    // fallback for store-level UI that isn't a layer.
    Escape: () => {
      const ui = useStore.getState().ui;
      if (hasOpenLayers()) return false;
      if (ui.peek) closePeek();
      else if (ui.settingsOpen) setSettingsOpen(false);
      else if (ui.composer) closeComposer();
      else if (ui.drawerOpen) setDrawer(false);
      else if (ui.sheet !== 'collapsed' && computeLayoutMode() === 'phone') setSheet('collapsed');
      else return false;
    },
  });
}
