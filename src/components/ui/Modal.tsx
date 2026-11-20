import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { cx } from '@/lib/cx';
import { safeFocus, trapTab } from '@/lib/focus';
import { LayerDepthContext, overlayZ, useBackdropPress, useLayer, useTabGuard } from '@/lib/layers';
import { DUR, EASE } from '@/lib/motion';
import { lockScroll } from '@/lib/scrollLock';
import styles from './Modal.module.css';

export interface ModalProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  open: boolean;
  onClose: () => void;
  /** id of the element that names the dialog (aria-labelledby). */
  labelledBy?: string;
  /** Max panel width in px (default 640); always ≤ 100vw − 48px. */
  width?: number;
  /** Element to focus on open (default: the panel itself). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Close when the backdrop is clicked (default true). */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}

/**
 * Notion center peek frame: dimmed backdrop (fade 180ms), panel top-aligned at 10vh, enters with
 * opacity + scale .98→1 + y 8→0 (180ms), exits in 120ms. Focus is trapped and restored; Escape and
 * backdrop clicks close only when this is the topmost overlay.
 */
export function Modal(props: ModalProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>{props.open && <ModalFrame key="modal" {...props} />}</AnimatePresence>,
    document.body,
  );
}

function ModalFrame({
  open: _open,
  onClose,
  labelledBy,
  width = 640,
  initialFocusRef,
  closeOnBackdrop = true,
  className,
  style,
  children,
  ...rest
}: ModalProps) {
  const isPresent = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { depth, isTop } = useLayer(isPresent, () => onCloseRef.current());
  const consumeBackdropPress = useBackdropPress(frameRef, isTop, isPresent);
  useTabGuard(panelRef, isTop, isPresent);

  // Scroll lock while present.
  useEffect(() => {
    if (!isPresent) return;
    return lockScroll(panelRef.current);
  }, [isPresent]);

  // Initial focus (next frame, so menus/popovers that triggered the open have finished restoring focus)
  // and focus restoration on close.
  useLayoutEffect(() => {
    const previously = document.activeElement;
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      safeFocus(initialFocusRef?.current ?? panel);
    });
    return () => {
      cancelAnimationFrame(raf);
      const panel = panelRef.current;
      const active = document.activeElement;
      // Only restore if focus is still inside the modal (or lost to <body>), never yank it from elsewhere.
      if (!active || active === document.body || (panel && panel.contains(active))) safeFocus(previously);
    };
    // Mount/unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <LayerDepthContext.Provider value={depth}>
      <motion.div
        className={styles.backdrop}
        style={{ zIndex: overlayZ(depth, 'backdrop') }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: DUR.fast, ease: EASE } }}
        transition={{ duration: DUR.base, ease: EASE }}
        aria-hidden="true"
      />
      <div
        ref={frameRef}
        className={styles.frame}
        style={{ pointerEvents: isPresent ? undefined : 'none', zIndex: overlayZ(depth, 'panel') }}
        onClick={(e) => {
          const armed = consumeBackdropPress();
          if (armed && e.target === e.currentTarget && closeOnBackdrop) onClose();
        }}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          className={cx(styles.panel, className)}
          style={{ ...style, '--modal-w': `${width}px` } as CSSProperties}
          initial={{ opacity: 0, scale: 0.98, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 8, transition: { duration: DUR.fast, ease: EASE } }}
          transition={{ duration: DUR.base, ease: EASE }}
          onKeyDown={(e) => {
            if (panelRef.current) trapTab(e, panelRef.current);
          }}
          {...stripMotionConflicts(rest)}
        >
          {children}
        </motion.div>
      </div>
    </LayerDepthContext.Provider>
  );
}

/** motion.div redefines a few DOM handler names (drag/animation events) — drop them from passthrough props. */
function stripMotionConflicts(rest: HTMLAttributes<HTMLDivElement>) {
  const {
    onDrag: _a,
    onDragStart: _b,
    onDragEnd: _c,
    onAnimationStart: _d,
    onAnimationEnd: _e,
    onAnimationIteration: _f,
    ...clean
  } = rest;
  return clean;
}
