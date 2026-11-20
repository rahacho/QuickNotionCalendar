import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { cx } from '@/lib/cx';
import { safeFocus } from '@/lib/focus';
import { LayerDepthContext, useBackdropPress, useLayer } from '@/lib/layers';
import { DUR, EASE, EASE_OUT, SPRING_SETTLE } from '@/lib/motion';
import { lockScroll } from '@/lib/scrollLock';
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** Swipe in from the left screen edge (touch) to open. */
  edgeSwipe?: boolean;
  /** Gesture guard — return false to ignore swipes (e.g. while a task is being dragged). */
  canSwipe?: () => boolean;
  /** Contain the drawer in its positioned parent instead of the viewport (gallery frames). */
  contained?: boolean;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

const EDGE = 20;
const SLOP = 8;
const FLICK = 450;

function velocityOf(samples: Array<{ t: number; x: number }>): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  let first = samples[0]!;
  for (const s of samples) {
    if (last.t - s.t <= 80) {
      first = s;
      break;
    }
  }
  const dt = last.t - first.t;
  return dt > 0 ? ((last.x - first.x) / dt) * 1000 : 0;
}

/**
 * Left drawer (phone/tablet Tasks list): min(320px, 85vw), dimmed backdrop, follows the finger —
 * edge-swipe from the left 20px to open, swipe left (on panel or backdrop) to close, flick-aware.
 * Stays mounted while closed (translated off-screen, inert) so list state and in-flight drags survive.
 */
export function Drawer({
  open,
  onOpenChange,
  children,
  edgeSwipe = true,
  canSwipe,
  contained,
  className,
  'aria-label': ariaLabel = 'Tasks',
  'data-testid': testId = 'drawer',
}: DrawerProps) {
  const reduced = usePrefersReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(320);
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const canSwipeRef = useRef(canSwipe);
  canSwipeRef.current = canSwipe;

  const x = useMotionValue(open ? 0 : -400);
  const progress = useTransform(x, (v) => Math.max(0, Math.min(1, 1 + v / (widthRef.current || 1))));
  const visibility = useTransform(progress, (p) => (p <= 0 ? 'hidden' : 'visible'));

  const { depth, isTop } = useLayer(open, () => onOpenChangeRef.current(false));
  const backdropRef = useRef<HTMLDivElement>(null);
  const consumeBackdropPress = useBackdropPress(backdropRef, isTop, open);

  // Measure width (min(320px, 85vw) changes with rotation).
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width || 320;
      widthRef.current = w;
      if (!openRef.current && !x.isAnimating()) x.set(-w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x]);

  // Animate to the controlled state. After a swipe release, carry the finger's velocity into a spring.
  const releaseVelocity = useRef<number | null>(null);
  useEffect(() => {
    const w = widthRef.current;
    const v = releaseVelocity.current;
    releaseVelocity.current = null;
    const controls = animate(
      x,
      open ? 0 : -w,
      reduced
        ? { duration: 0 }
        : v !== null
          ? { ...SPRING_SETTLE, velocity: v }
          : { duration: open ? DUR.slow : DUR.base, ease: open ? EASE_OUT : EASE },
    );
    return () => controls.stop();
  }, [open, reduced, x]);

  // Scroll lock + focus handling while open.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previously = document.activeElement;
    const unlock = lockScroll(panel);
    const raf = requestAnimationFrame(() => {
      if (panel && !panel.contains(document.activeElement)) safeFocus(panel);
    });
    return () => {
      cancelAnimationFrame(raf);
      unlock();
      const active = document.activeElement;
      if (!active || active === document.body || (panel && panel.contains(active))) safeFocus(previously);
    };
  }, [open]);

  // Touch gestures.
  useEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;

    let tracking: 'open' | 'close' | null = null;
    let decided: 'drag' | 'other' | null = null;
    let startX = 0;
    let startY = 0;
    let base = 0;
    const samples: Array<{ t: number; x: number }> = [];

    const allowed = () => (canSwipeRef.current ? canSwipeRef.current() : true);

    const start = (e: TouchEvent, kind: 'open' | 'close') => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return;
      tracking = kind;
      decided = null;
      startX = t.clientX;
      startY = t.clientY;
      samples.length = 0;
      samples.push({ t: e.timeStamp, x: t.clientX });
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (decided === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        const rightWay = tracking === 'open' ? dx > 0 : dx < 0;
        decided = horizontal && rightWay && allowed() ? 'drag' : 'other';
        if (decided === 'other') {
          tracking = null;
          return;
        }
        x.stop();
        base = x.get();
        startX = t.clientX;
      }
      if (decided !== 'drag') return;
      if (e.cancelable) e.preventDefault();
      const w = widthRef.current;
      x.set(Math.max(-w, Math.min(0, base + (t.clientX - startX))));
      samples.push({ t: e.timeStamp, x: t.clientX });
      if (samples.length > 12) samples.shift();
    };

    const onEnd = () => {
      if (!tracking) return;
      const kind = tracking;
      tracking = null;
      if (decided !== 'drag') return;
      const v = velocityOf(samples);
      const w = widthRef.current;
      const pos = x.get();
      const shouldOpen = kind === 'open' ? v > FLICK || (v > -FLICK && pos > -w * 0.5) : !(v < -FLICK || pos < -w * 0.35);
      if (shouldOpen !== openRef.current) {
        // The open-state effect picks this velocity up for its settle spring.
        releaseVelocity.current = v;
        onOpenChangeRef.current(shouldOpen);
        // If the owner rejected the change, settle back to the actual state.
        requestAnimationFrame(() => {
          if (openRef.current !== shouldOpen) {
            releaseVelocity.current = null;
            animate(x, openRef.current ? 0 : -w, { duration: DUR.base, ease: EASE });
          }
        });
      } else {
        animate(x, shouldOpen ? 0 : -w, { ...SPRING_SETTLE, velocity: v });
      }
    };

    // Opening: a touch that begins at the very left edge of the screen.
    const onDocStart = (e: TouchEvent) => {
      if (openRef.current || !edgeSwipe) return;
      const t = e.touches[0];
      const box = root.getBoundingClientRect();
      if (!t || t.clientX - box.left > EDGE) return;
      start(e, 'open');
    };
    // Closing: a touch on the open panel or its backdrop.
    const onRootStart = (e: TouchEvent) => {
      if (!openRef.current) return;
      start(e, 'close');
    };

    const doc = root.ownerDocument;
    doc.addEventListener('touchstart', onDocStart, { passive: true, capture: true });
    root.addEventListener('touchstart', onRootStart, { passive: true });
    doc.addEventListener('touchmove', onMove, { passive: false, capture: true });
    doc.addEventListener('touchend', onEnd, true);
    doc.addEventListener('touchcancel', onEnd, true);
    return () => {
      doc.removeEventListener('touchstart', onDocStart, { capture: true } as EventListenerOptions);
      root.removeEventListener('touchstart', onRootStart);
      doc.removeEventListener('touchmove', onMove, { capture: true } as EventListenerOptions);
      doc.removeEventListener('touchend', onEnd, true);
      doc.removeEventListener('touchcancel', onEnd, true);
    };
  }, [edgeSwipe, x]);

  return (
    <div ref={rootRef} className={cx(styles.root, contained && styles.contained)} data-open={open || undefined}>
      <motion.div
        ref={backdropRef}
        className={styles.backdrop}
        style={{ opacity: progress, visibility }}
        onClick={(e) => {
          if (consumeBackdropPress() && e.target === e.currentTarget) onOpenChange(false);
        }}
        aria-hidden="true"
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal={open || undefined}
        aria-label={ariaLabel}
        aria-hidden={open ? undefined : true}
        inert={!open}
        tabIndex={-1}
        data-testid={testId}
        className={cx(styles.panel, className)}
        style={{ x, visibility }}
      >
        <LayerDepthContext.Provider value={depth}>{children}</LayerDepthContext.Provider>
      </motion.div>
    </div>
  );
}
