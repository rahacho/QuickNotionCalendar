/**
 * "Install Tasks" hint for iPhone/iPad Safari (not yet on the Home Screen): a compact Notion-style
 * card — tap Share, then Add to Home Screen. Installing is what makes Tasks a full-screen app with
 * notifications and a badge on iOS.
 *
 * Self-contained floating card (portal to <body>, under the header, above the calendar). It steps
 * aside (fades out) whenever something is opened over the app — the Tasks drawer, the raised Inbox
 * sheet, the peek, settings, quick add, any popover — and during drags: being portaled to <body>, it
 * would otherwise paint over the drawer, which lives inside #root's own stacking context. Renders
 * nothing elsewhere, once installed, or once dismissed (remembered per device). Mount it once at the
 * app's top level.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Share, X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { useIsStandalone } from '@/hooks/useIsStandalone';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { useHasOpenLayers } from '@/lib/layers';
import { DUR, EASE } from '@/lib/motion';
import { useStore } from '@/store/store';
import { isIOSSafari } from '@/push/support';
import styles from './InstallHint.module.css';

const DISMISSED_KEY = 'tasks.installHint.dismissed';
/** Let the app settle (loading frame → calendar) before the card slides in. */
const SHOW_DELAY_MS = 1200;

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: the hint simply returns next launch.
  }
}

export function InstallHint() {
  const standalone = useIsStandalone();
  const [eligible] = useState(() => isIOSSafari() && !wasDismissed());
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const dragging = useStore((s) => s.ui.dragging !== null);
  // The phone Inbox sheet, when raised, reaches up under the header: step aside while it is open.
  const phone = useLayoutMode() === 'phone';
  const sheetRaised = useStore((s) => s.ui.sheet !== 'collapsed');
  // The drawer (Tasks list) is in #root's stacking context, so no z-index can lift it over this card:
  // hide while it — or any other overlay layer — is open.
  const drawerOpen = useStore((s) => s.ui.drawerOpen);
  const layerOpen = useHasOpenLayers();

  useEffect(() => {
    if (!eligible || standalone) return;
    const timer = window.setTimeout(() => setReady(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [eligible, standalone]);

  if (!eligible || typeof document === 'undefined') return null;

  const visible = ready && !dismissed && !standalone && !dragging && !drawerOpen && !layerOpen && !(phone && sheetRaised);
  const dismiss = (): void => {
    rememberDismissed();
    setDismissed(true);
  };

  return createPortal(
    <AnimatePresence>
      {visible && (
        <div key="install-hint" className={styles.wrap}>
          <motion.div
            className={styles.card}
            role="region"
            aria-label="Install Tasks"
            data-testid="install-hint"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: DUR.fast, ease: EASE } }}
            transition={{ duration: DUR.base, ease: EASE }}
          >
            <img className={styles.appIcon} src="/apple-touch-icon.png" alt="" width={32} height={32} draggable={false} />
            <div className={styles.text}>
              <span className={styles.title}>Install Tasks</span>
              <span className={styles.body}>
                Tap <Share className={styles.share} size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
                <strong>Share</strong>, then <strong>Add to Home Screen</strong>
              </span>
            </div>
            <IconButton
              className={styles.close}
              label="Dismiss"
              icon={X}
              size={24}
              tooltip={false}
              onClick={dismiss}
              data-testid="install-hint-dismiss"
            />
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
