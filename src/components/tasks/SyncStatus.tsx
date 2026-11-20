import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BellOff } from 'lucide-react';
import type { Task } from '@shared/types';
import { useStore } from '@/store/store';
import { setDrawer, setSettingsOpen } from '@/store/actions';
import { pushConfigured, usePushState } from '@/push';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { COLLAPSED, EXPANDED, FRAMELOOP_ONLY, useListTransition } from './listMotion';
import styles from './TasksSidebar.module.css';

/** Firestore acknowledges most writes within a few hundred ms — only call it "Syncing" when it lingers. */
const PENDING_GRACE_MS = 1500;

type Status = { kind: 'error' | 'offline' | 'pending'; label: string; detail: string };

function useLingering(active: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (!active) {
      setLingering(false);
      return;
    }
    const t = window.setTimeout(() => setLingering(true), ms);
    return () => window.clearTimeout(t);
  }, [active, ms]);
  return active && lingering;
}

/**
 * Sidebar footer line that only appears when something is off: a sync error, offline, or writes that
 * have been waiting to reach the server for a while. Silent when everything is synced (like Notion).
 */
export function SyncStatus() {
  const error = useStore((s) => s.sync.error);
  const online = useStore((s) => s.sync.online);
  const pendingWrites = useStore((s) => s.sync.pendingWrites);
  const transition = useListTransition();
  const showPending = useLingering(online && pendingWrites && !error, PENDING_GRACE_MS);

  let status: Status | null = null;
  if (error) {
    status = { kind: 'error', label: "Couldn't sync", detail: error };
  } else if (!online) {
    status = {
      kind: 'offline',
      label: 'Offline',
      detail: pendingWrites ? 'Your changes will sync when you’re back online' : 'Changes are saved on this device',
    };
  } else if (showPending) {
    status = { kind: 'pending', label: 'Syncing…', detail: 'Saving your latest changes' };
  }

  return (
    <>
      <PushOffHint />
      <AnimatePresence initial={false}>
        {status && (
          <motion.div
            key="sync"
            initial={COLLAPSED}
            animate={EXPANDED}
            exit={COLLAPSED}
            transition={transition}
            onUpdate={FRAMELOOP_ONLY}
            className={styles.syncWrap}
          >
            <div className={styles.sync} role="status" aria-live="polite" title={status.detail} data-sync={status.kind}>
              <span className={styles.syncIcon} aria-hidden="true">
                <span
                  className={cx(
                    styles.syncDot,
                    status.kind === 'error' && styles.syncDotError,
                    status.kind === 'offline' && styles.syncDotOffline,
                    status.kind === 'pending' && styles.syncDotPending,
                  )}
                />
              </span>
              <span className={styles.syncText}>
                <span className={styles.syncLabel}>{status.label}</span>
                <span className={styles.syncDetail}>{status.detail}</span>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

let alertMemo: { tasks: Record<string, Task>; result: boolean } | null = null;

/**
 * Some open task would alert on its own: timed with the default / an offset reminder, a reminder at
 * a clock time, or an armed remindAt (e.g. a per-occurrence time).
 */
function anyIndividualAlert(tasks: Record<string, Task>): boolean {
  if (alertMemo?.tasks === tasks) return alertMemo.result;
  let result = false;
  for (const t of Object.values(tasks)) {
    if (t.done || t.date === null || t.reminder.kind === 'none') continue;
    if (t.remindAt != null || t.reminder.kind === 'at' || t.time != null) {
      result = true;
      break;
    }
  }
  alertMemo = { tasks, result };
  return result;
}

/**
 * "Reminders are off on this device · Turn on": shown while this device would miss alerts the owner
 * planned (the morning summary is on, or a task alerts on its own) but push isn't on here — e.g.
 * never enabled, blocked, or a failed re-enable after signing in again. Opens Settings.
 */
function PushOffHint() {
  const push = usePushState();
  const off = pushConfigured && (push === 'default' || push === 'denied' || push === 'error');
  const wanted = useStore((s) => off && (s.settings.summary.enabled || anyIndividualAlert(s.tasks)));
  const phoneOrTablet = useLayoutMode() !== 'desktop';
  const transition = useListTransition();
  const show = off && wanted;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="push-off"
          initial={COLLAPSED}
          animate={EXPANDED}
          exit={COLLAPSED}
          transition={transition}
          onUpdate={FRAMELOOP_ONLY}
          className={styles.syncWrap}
        >
          <button
            type="button"
            className={styles.pushHint}
            data-testid="push-off-hint"
            onClick={() => {
              if (phoneOrTablet) setDrawer(false);
              setSettingsOpen(true);
            }}
          >
            <span className={styles.navIcon} aria-hidden="true">
              <Icon icon={BellOff} size={14} />
            </span>
            <span className={styles.pushHintText}>
              {push === 'denied' ? 'Notifications are blocked on this device' : 'Reminders are off on this device'}
              <span aria-hidden="true"> · </span>
              <span className={styles.pushHintAction}>{push === 'denied' ? 'Fix' : 'Turn on'}</span>
            </span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
