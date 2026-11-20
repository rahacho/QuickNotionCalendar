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
import { animate, AnimatePresence, motion, useMotionValue, usePresence, useTransform } from 'motion/react';
import { cx } from '@/lib/cx';
import { safeFocus, trapTab } from '@/lib/focus';
import { LayerDepthContext, overlayZ, useBackdropPress, useLayer, useTabGuard } from '@/lib/layers';
import { DUR, EASE_IN, EASE_OUT, SPRING_SETTLE } from '@/lib/motion';
import { lockScroll } from '@/lib/scrollLock';
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion';
import { useVisualViewport } from '@/hooks/useVisualViewport';
import styles from './Sheet.module.css';

export interface SheetProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  open: boolean;
  onClose: () => void;
  /** 'auto' (default) sizes to content up to near full height; 'full' always takes the full height. */
  snap?: 'auto' | 'full';
  labelledBy?: string;
  /** Element to focus on open. Default: keep focus where the consumer put it (e.g. an autoFocus input). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/** Distance (px) the finger must travel before we decide between "drag the sheet" and "scroll content". */
const SLOP = 6;
/** Release velocity (px/s) that dismisses regardless of distance. */
const FLICK_VELOCITY = 650;

/**
 * Phone bottom sheet (modal). Drag the handle — or pull down from the top of the content — to dismiss;
 * a flick dismisses early, otherwise it springs back. Sits above the iOS keyboard (visualViewport),
 * pads for the home indicator, locks background scrolling and traps focus. Escape closes it on desktop.
 */
export function Sheet(props: SheetProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>{props.open && <SheetFrame key="sheet" {...props} />}</AnimatePresence>,
    document.body,
  );
}

function scrollableAncestor(target: EventTarget | null, stop: HTMLElement): HTMLElement | null {
  let el = target instanceof Element ? target : null;
  while (el && el !== stop) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
    el = el.parentElement;
  }
  return null;
}

function releaseVelocity(samples: Array<{ t: number; y: number }>): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  // Use the oldest sample within the last 80ms for a stable estimate.
  let first = samples[0]!;
  for (const s of samples) {
    if (last.t - s.t <= 80) {
      first = s;
      break;
    }
  }
  const dt = last.t - first.t;
  return dt > 0 ? ((last.y - first.y) / dt) * 1000 : 0;
}

function SheetFrame({
  open: _open,
  onClose,
  snap = 'auto',
  labelledBy,
  initialFocusRef,
  className,
  style,
  children,
  ...rest
}: SheetProps) {
  const [isPresent, safeToRemove] = usePresence();
  const reduced = usePrefersReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(0);
  const backdropRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const presentRef = useRef(isPresent);
  presentRef.current = isPresent;

  const y = useMotionValue(0);
  const backdropOpacity = useTransform(y, (v) => {
    const h = heightRef.current || 1;
    return Math.max(0, Math.min(1, 1 - v / h));
  });

  const { depth, isTop } = useLayer(isPresent, () => onCloseRef.current());
  const consumeBackdropPress = useBackdropPress(backdropRef, isTop, isPresent);
  useTabGuard(panelRef, isTop, isPresent);
  const vv = useVisualViewport(true);

  // Track the panel height (content / keyboard changes) for drag thresholds and the exit distance.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    heightRef.current = el.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      heightRef.current = el.getBoundingClientRect().height;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Enter: slide up from below.
  useLayoutEffect(() => {
    const h = heightRef.current || window.innerHeight;
    y.set(h);
    const controls = animate(y, 0, { duration: reduced ? 0 : DUR.slow, ease: EASE_OUT });
    return () => controls.stop();
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Exit: slide down from wherever it is (also after a drag), then unmount. If it is reopened while
  // still sliding out, AnimatePresence revives this instance — slide back up.
  const removeRef = useRef(safeToRemove);
  removeRef.current = safeToRemove;
  const wasPresent = useRef(isPresent);
  useEffect(() => {
    if (isPresent) {
      if (wasPresent.current) return;
      wasPresent.current = true;
      const controls = animate(y, 0, { duration: reduced ? 0 : DUR.slow, ease: EASE_OUT });
      return () => controls.stop();
    }
    wasPresent.current = false;
    const h = (heightRef.current || window.innerHeight) + 24;
    const controls = animate(y, h, {
      duration: reduced ? 0 : DUR.base,
      ease: EASE_IN,
      onComplete: () => removeRef.current?.(),
    });
    return () => controls.stop();
    // Runs when presence flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  // Background scroll lock.
  useEffect(() => {
    if (!isPresent) return;
    return lockScroll(panelRef.current);
  }, [isPresent]);

  // Focus in / restore.
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
      if (!active || active === document.body || (panel && panel.contains(active))) safeFocus(previously);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag-to-dismiss (touch: handle anywhere, content only when scrolled to top and pulling down).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let tracking = false;
    let decided: 'drag' | 'other' | null = null;
    let fromHandle = false;
    let startX = 0;
    let startY = 0;
    let base = 0;
    let scroller: HTMLElement | null = null;
    const samples: Array<{ t: number; y: number }> = [];

    const begin = (clientX: number, clientY: number, target: EventTarget | null, t: number) => {
      tracking = true;
      decided = null;
      startX = clientX;
      startY = clientY;
      fromHandle = target instanceof Element && target.closest('[data-sheet-handle]') !== null;
      scroller = scrollableAncestor(target, panel);
      samples.length = 0;
      samples.push({ t, y: clientY });
    };

    const move = (clientX: number, clientY: number, t: number): boolean => {
      if (!tracking || !presentRef.current) return false;
      const dx = clientX - startX;
      const dy = clientY - startY;
      if (decided === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return false;
        const vertical = Math.abs(dy) > Math.abs(dx);
        const atTop = !scroller || scroller.scrollTop <= 0;
        decided = vertical && (fromHandle || (dy > 0 && atTop)) ? 'drag' : 'other';
        if (decided === 'drag') {
          y.stop();
          base = y.get();
          startY = clientY;
        }
      }
      if (decided !== 'drag') return false;
      const raw = base + (clientY - startY);
      // Rubber-band when pulled above its resting position.
      y.set(raw < 0 ? -Math.sqrt(-raw) * 2.2 : raw);
      samples.push({ t, y: clientY });
      if (samples.length > 12) samples.shift();
      return true;
    };

    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (decided !== 'drag') return;
      const v = releaseVelocity(samples);
      const offset = y.get();
      const h = heightRef.current || window.innerHeight;
      if (offset > Math.min(h * 0.33, 200) || (v > FLICK_VELOCITY && offset > 12)) {
        onCloseRef.current();
      } else {
        animate(y, 0, { ...SPRING_SETTLE, velocity: v });
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t) {
        tracking = false;
        return;
      }
      begin(t.clientX, t.clientY, e.target, e.timeStamp);
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (move(t.clientX, t.clientY, e.timeStamp) && e.cancelable) e.preventDefault();
    };

    // Mouse: only from the handle (desktop / devtools).
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (!(e.target instanceof Element) || !e.target.closest('[data-sheet-handle]')) return;
      begin(e.clientX, e.clientY, e.target, e.timeStamp);
      const onMove = (ev: PointerEvent) => {
        if (move(ev.clientX, ev.clientY, ev.timeStamp)) ev.preventDefault();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        end();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    panel.addEventListener('touchmove', onTouchMove, { passive: false });
    panel.addEventListener('touchend', end);
    panel.addEventListener('touchcancel', end);
    panel.addEventListener('pointerdown', onPointerDown);
    return () => {
      panel.removeEventListener('touchstart', onTouchStart);
      panel.removeEventListener('touchmove', onTouchMove);
      panel.removeEventListener('touchend', end);
      panel.removeEventListener('touchcancel', end);
      panel.removeEventListener('pointerdown', onPointerDown);
    };
  }, [y]);

  const keyboardOpen = vv.keyboard > 0;
  const maxH = keyboardOpen ? `calc(${vv.height}px - var(--safe-top) - 10px)` : 'calc(100dvh - var(--safe-top) - 10px)';
  const panelStyle = {
    ...style,
    zIndex: overlayZ(depth, 'panel'),
    y,
    bottom: vv.keyboard,
    maxHeight: maxH,
    height: snap === 'full' ? maxH : undefined,
    paddingBottom: keyboardOpen ? 0 : 'var(--safe-bottom)',
  } as const;

  return (
    <LayerDepthContext.Provider value={depth}>
      <motion.div
        ref={backdropRef}
        className={styles.backdrop}
        style={{ opacity: backdropOpacity, pointerEvents: isPresent ? undefined : 'none', zIndex: overlayZ(depth, 'backdrop') }}
        aria-hidden="true"
        onClick={(e) => {
          if (consumeBackdropPress() && e.target === e.currentTarget) onClose();
        }}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx(styles.panel, snap === 'full' && styles.full, className)}
        style={panelStyle as unknown as CSSProperties}
        onKeyDown={(e) => {
          if (panelRef.current) trapTab(e, panelRef.current);
        }}
        {...stripMotionConflicts(rest)}
      >
        <div className={styles.handleArea} data-sheet-handle="">
          <span className={styles.handle} />
        </div>
        <div className={styles.body}>{children}</div>
      </motion.div>
    </LayerDepthContext.Provider>
  );
}

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
