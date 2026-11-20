import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import type { ToastItem } from '@/store/store';
import { cx } from '@/lib/cx';
import { DUR, EASE } from '@/lib/motion';
import styles from './Toast.module.css';

const MAX_VISIBLE = 3;

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden', () => true);
}

export interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  /** 'phone' lifts the stack above the collapsed Inbox sheet. */
  position?: 'default' | 'phone';
  /** Render inline (gallery) instead of portaling to <body>. */
  inline?: boolean;
}

/**
 * The text a screen reader should hear for the newest toast. One persistent live region announces it:
 * a freshly mounted role=status node is often skipped (VoiceOver). A repeat of the same message
 * ("Task completed" twice) alternates a trailing no-break space so it is announced again.
 */
function useAnnouncement(toasts: ToastItem[]): string {
  const newest = toasts.at(-1);
  const [state, setState] = useState<{ id: string | null; text: string; flip: boolean }>({ id: null, text: '', flip: false });
  if (newest && newest.id !== state.id) {
    const flip = !state.flip;
    const text = `${newest.message}${newest.action ? ` · ${newest.action.label}` : ''}${flip ? '\u00a0' : ''}`;
    setState({ id: newest.id, text, flip });
  }
  return state.text;
}

/**
 * Presentational toast stack (bottom-center). Each toast auto-dismisses after `duration` ms — paused
 * while hovered, while focus is inside it (keyboard users can reach Undo) or while the page is
 * hidden; duration ≤ 0 / Infinity = sticky. Swipe sideways to dismiss.
 */
export function ToastStack({ toasts, onDismiss, position = 'default', inline }: ToastStackProps) {
  const visible = toasts.slice(-MAX_VISIBLE);
  const announcement = useAnnouncement(toasts);
  const stack = (
    <div
      className={cx(styles.stack, position === 'phone' && styles.phone, inline && styles.inline)}
      role="region"
      aria-label="Notifications"
    >
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="toast-live">
        {announcement}
      </div>
      <AnimatePresence initial={false}>
        {visible.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
  if (inline || typeof document === 'undefined') return stack;
  return createPortal(stack, document.body);
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const pageVisible = useDocumentVisible();
  const remaining = useRef(toast.duration);
  const sticky = !Number.isFinite(toast.duration) || toast.duration <= 0;

  useEffect(() => {
    if (sticky || hovered || focused || !pageVisible) return;
    const started = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [sticky, hovered, focused, pageVisible, toast.id, onDismiss]);

  return (
    <motion.div
      layout="position"
      className={styles.toast}
      data-testid="toast"
      data-paused={hovered || focused ? (focused ? 'focus' : 'hover') : undefined}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: DUR.fast, ease: EASE } }}
      transition={{ duration: DUR.base, ease: EASE }}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') setHovered(false);
      }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.7}
      dragSnapToOrigin
      onDragEnd={(_e, info) => {
        if (Math.abs(info.offset.x) > 72 || Math.abs(info.velocity.x) > 600) onDismiss(toast.id);
      }}
    >
      <span className={styles.message}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className={styles.action}
          data-testid="toast-action"
          onPointerDownCapture={(e) => e.stopPropagation()}
          onClick={() => {
            const action = toast.action;
            onDismiss(toast.id);
            action?.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </motion.div>
  );
}
