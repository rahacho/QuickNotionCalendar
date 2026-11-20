import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { flushSync } from 'react-dom';
import { animate, motion, useMotionValue, type Transition } from 'motion/react';
import { Ban, Inbox as InboxIcon, Plus } from 'lucide-react';
import { useStore, type UIState } from '@/store/store';
import { setSheet } from '@/store/actions';
import { useInboxTasks } from '@/store/selectors';
import { useInboxDropTarget } from '@/dnd';
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion';
import { useVisualViewport } from '@/hooks/useVisualViewport';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { cx } from '@/lib/cx';
import { platform } from '@/lib/platform';
import { DUR, EASE, EASE_OUT, SPRING_SETTLE } from '@/lib/motion';
import { FRAMELOOP_ONLY } from '@/components/tasks/listMotion';
import { InboxInput } from './InboxInput';
import { InboxList } from './InboxList';
import { scrollToTop } from './scroll';
import styles from './InboxSheet.module.css';

type Snap = UIState['sheet'];

/** Finger travel (px) before a press on the header becomes a drag instead of a tap. */
const SLOP = 6;
/** Release speed (px/s) that moves one detent in the flick direction regardless of position. */
const FLICK = 500;
/** Extra distance below the screen while hidden for a drag (clears the upward shadow). */
const HIDE_EXTRA = 40;
/** iOS-style rubber band beyond the first/last detent. */
const RUBBER_LIMIT = 120;
const RUBBER_K = 0.55;

interface Insets {
  /** env(safe-area-inset-top / bottom) in px. */
  top: number;
  bottom: number;
  /** Calendar header height (--header-h). */
  header: number;
  /** --sheet-collapsed-h (56px + safe-bottom). */
  collapsed: number;
}

function readInsets(): Insets {
  const fallback: Insets = { top: 0, bottom: 0, header: 44, collapsed: 56 };
  if (typeof document === 'undefined' || !document.body) return fallback;
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;box-sizing:content-box;' +
    'padding-top:var(--safe-top);padding-bottom:var(--safe-bottom);height:var(--header-h);width:var(--sheet-collapsed-h)';
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const px = (v: string, d: number) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  const r: Insets = {
    top: px(cs.paddingTop, 0),
    bottom: px(cs.paddingBottom, 0),
    header: px(cs.height, 44),
    collapsed: px(cs.width, 56),
  };
  el.remove();
  return r;
}

function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.header === b.header && a.collapsed === b.collapsed;
}

/** Safe-area insets + layout viewport height, refreshed on resize/rotation. */
function useScreenMetrics(): { insets: Insets; layoutH: number } {
  const [insets, setInsets] = useState(readInsets);
  const [layoutH, setLayoutH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = readInsets();
        setInsets((prev) => (sameInsets(prev, next) ? prev : next));
        setLayoutH(window.innerHeight);
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return { insets, layoutH };
}

function rubber(overshoot: number): number {
  return (1 - 1 / ((overshoot * RUBBER_K) / RUBBER_LIMIT + 1)) * RUBBER_LIMIT;
}

function velocityOf(samples: Array<{ t: number; y: number }>): number {
  const last = samples[samples.length - 1];
  if (!last || samples.length < 2) return 0;
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

const ORDER: Snap[] = ['collapsed', 'half', 'full'];

/** Detent after a release at `visible` px with vertical velocity `v` (px/s, + = downward). */
function pickSnap(visible: number, v: number, heights: Record<Snap, number>): Snap {
  if (Math.abs(v) > FLICK) {
    if (v < 0) return ORDER.find((s) => heights[s] > visible + 8) ?? 'full';
    return [...ORDER].reverse().find((s) => heights[s] < visible - 8) ?? 'collapsed';
  }
  let best: Snap = 'collapsed';
  for (const s of ORDER) if (Math.abs(heights[s] - visible) < Math.abs(heights[best] - visible)) best = s;
  return best;
}

interface Gesture {
  id: number;
  startY: number;
  base: number;
  dragging: boolean;
  samples: Array<{ t: number; y: number }>;
}

/**
 * Phone Inbox: a bottom sheet with three detents — collapsed (handle + "Inbox · N" + "+"), half (50dvh)
 * and full (top just under the calendar header). store.ui.sheet is the source of truth. The header drags
 * with the finger (rubber band past the ends, velocity-aware snapping); tapping it cycles the detents like
 * an iOS sheet grabber. The input stays above the iOS keyboard (visualViewport). While a task is being
 * dragged the sheet slides away and a "Move to Inbox" pill drop zone rises from the bottom.
 */
export function InboxSheet() {
  const sheet = useStore((s) => s.ui.sheet);
  const dragging = useStore((s) => s.ui.dragging);
  const tasks = useInboxTasks();
  const reduced = usePrefersReducedMotion();
  const vv = useVisualViewport(true);
  const { insets, layoutH } = useScreenMetrics();
  const drop = useInboxDropTarget();
  // The sheet's own list is an Inbox drop zone too: bubbles can be reordered inside the sheet.
  const listDrop = useInboxDropTarget();

  const inputRef = useRef<HTMLInputElement>(null);
  const proxyRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const setListNode = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      listDrop.setNodeRef(el);
    },
    [listDrop.setNodeRef],
  );

  // A drag that starts on a bubble keeps the sheet up (to reorder the Inbox) until the finger leaves
  // it upward; then the sheet slides away like for any other drag, revealing the whole calendar.
  const fromInbox = dragging?.source === 'inbox';
  const [escaped, setEscaped] = useState(false);
  useEffect(() => {
    if (!fromInbox) {
      setEscaped(false);
      return;
    }
    const onMove = (e: Event) => {
      let y: number | null = null;
      if (typeof TouchEvent !== 'undefined' && e instanceof TouchEvent) {
        const t = e.touches[0] ?? e.changedTouches[0];
        if (t) y = t.clientY;
      } else if (e instanceof MouseEvent) {
        y = e.clientY;
      }
      const el = sheetRef.current;
      if (y === null || !el) return;
      if (y < el.getBoundingClientRect().top - 4) setEscaped(true);
    };
    window.addEventListener('touchmove', onMove, { capture: true, passive: true });
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener('touchmove', onMove, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
    };
  }, [fromInbox]);

  // ---- geometry -------------------------------------------------------------------------------
  const kb = vv.keyboard;
  const visTop = kb > 0 ? vv.offsetTop : 0;
  const visBottom = kb > 0 ? vv.offsetTop + vv.height : layoutH;
  const collapsedH = Math.round(kb > 0 ? insets.collapsed - insets.bottom : insets.collapsed);
  const fullH = Math.max(collapsedH + 80, Math.round(visBottom - visTop - insets.top - insets.header));
  // With the keyboard up there is no room for a "half" — it shows everything between header and keyboard.
  const halfH = kb > 0 ? fullH : Math.min(fullH, Math.max(collapsedH, Math.round(layoutH * 0.5)));
  const heights: Record<Snap, number> = { collapsed: collapsedH, half: halfH, full: fullH };
  const hidden = dragging !== null && (!fromInbox || escaped);
  const restY = fullH - heights[sheet];
  const targetY = hidden ? fullH + HIDE_EXTRA : restY;
  const bottom = Math.max(0, layoutH - visBottom);

  const y = useMotionValue(targetY);
  const gesture = useRef<Gesture | null>(null);
  const releaseVelocity = useRef<number | null>(null);
  const suppressClick = useRef(false);
  // Latest geometry for the pointer handlers (they run between renders).
  const live = useRef({ sheet, heights, fullH, restY });
  useLayoutEffect(() => {
    live.current = { sheet, heights, fullH, restY };
  });

  // Keep the sheet's top edge where it is when its box changes (keyboard / rotation), then glide.
  const prevBox = useRef({ fullH, bottom, layoutH });
  useLayoutEffect(() => {
    const p = prevBox.current;
    if (p.fullH !== fullH || p.bottom !== bottom || p.layoutH !== layoutH) {
      const prevTop = p.layoutH - p.bottom - p.fullH + y.get();
      y.set(prevTop - (layoutH - bottom - fullH));
      prevBox.current = { fullH, bottom, layoutH };
    }
  }, [fullH, bottom, layoutH, y]);

  // Animate to the detent (or off-screen while a drag is in flight).
  const mountedOnce = useRef(false);
  useLayoutEffect(() => {
    if (!mountedOnce.current) {
      mountedOnce.current = true;
      y.set(targetY);
      return;
    }
    if (gesture.current?.dragging) return;
    const v = releaseVelocity.current;
    releaseVelocity.current = null;
    let t: Transition;
    if (reduced) t = { duration: 0 };
    else if (hidden) t = { duration: 0.22, ease: EASE };
    else if (v !== null) t = { ...SPRING_SETTLE, velocity: v };
    else t = { duration: DUR.slow, ease: EASE_OUT };
    const controls = animate(y, targetY, t);
    return () => controls.stop();
    // fullH/bottom/layoutH: the box changed under the sheet (keyboard, rotation) — re-settle from the
    // position the continuity effect above just restored, even when the detent offset is unchanged.
  }, [targetY, hidden, reduced, y, fullH, bottom, layoutH]);

  // Collapsing hides the keyboard (the input is about to be off-screen).
  useEffect(() => {
    if (sheet !== 'collapsed') return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && contentRef.current?.contains(active)) active.blur();
  }, [sheet]);

  // ---- header gestures ------------------------------------------------------------------------
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    gesture.current = { id: e.pointerId, startY: e.clientY, base: y.get(), dragging: false, samples: [{ t: e.timeStamp, y: e.clientY }] };
    // Touch pointers are implicitly captured; a mouse/pen is not, and its first move may already be
    // outside the 56px header — capture now so the gesture keeps following it.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone.
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.dragging) {
      if (Math.abs(e.clientY - g.startY) < SLOP) return;
      g.dragging = true;
      y.stop();
      g.base = y.get();
      g.startY = e.clientY;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer already released — the move still applies.
      }
    }
    const maxY = live.current.fullH - live.current.heights.collapsed;
    const raw = g.base + (e.clientY - g.startY);
    y.set(raw < 0 ? -rubber(-raw) : raw > maxY ? maxY + rubber(raw - maxY) : raw);
    g.samples.push({ t: e.timeStamp, y: e.clientY });
    if (g.samples.length > 12) g.samples.shift();
  };

  const finishGesture = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!g.dragging) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 400);
    const { heights: h, fullH: full, sheet: current, restY: rest } = live.current;
    const v = cancelled ? 0 : velocityOf(g.samples);
    const next = pickSnap(full - y.get(), v, h);
    if (next === current) {
      animate(y, rest, reduced ? { duration: 0 } : { ...SPRING_SETTLE, velocity: v });
    } else {
      releaseVelocity.current = v;
      setSheet(next);
    }
  };

  const cycle = () => setSheet(sheet === 'collapsed' ? 'half' : sheet === 'half' ? 'full' : 'collapsed');

  const onHeaderClick = (e: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (e.target instanceof Element && e.target.closest('button')) return;
    cycle();
  };

  const onHeaderKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      cycle();
    } else if (e.key === 'ArrowUp' && sheet !== 'full') {
      e.preventDefault();
      setSheet(sheet === 'collapsed' ? 'half' : 'full');
    } else if (e.key === 'ArrowDown' && sheet !== 'collapsed') {
      e.preventDefault();
      setSheet(sheet === 'full' ? 'half' : 'collapsed');
    }
  };

  // "+": open to half and focus the input. iOS only raises the keyboard for a focus() made inside the
  // tap, and would pan the whole page to reveal an input that is still off-screen — so focus a hidden
  // proxy input at the top of the screen now, and hand focus to the real input once the sheet is up.
  const onAdd = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const input = inputRef.current;
    if (!input) return;
    if (sheet !== 'collapsed') {
      input.focus({ preventScroll: true });
      return;
    }
    if (platform.isIOS && proxyRef.current) {
      proxyRef.current.focus({ preventScroll: true });
      setSheet('half');
      window.setTimeout(() => {
        if (document.activeElement === proxyRef.current) inputRef.current?.focus({ preventScroll: true });
      }, reduced ? 0 : 300);
      return;
    }
    flushSync(() => setSheet('half'));
    input.focus({ preventScroll: true });
  };

  const onCreated = useCallback(() => scrollToTop(listRef.current), []);

  // Collapsed, the part of the sheet below its header (the home-indicator inset on Face ID iPhones) is
  // part of the bar: a tap there opens the sheet like a tap on the header.
  const onSheetClick = (e: MouseEvent<HTMLDivElement>) => {
    if (sheet !== 'collapsed') return;
    if (e.target instanceof Element && e.target.closest('[data-sheet-header]')) return;
    setSheet('half');
  };

  // ---- render ---------------------------------------------------------------------------------
  const count = tasks.length;
  const collapsed = sheet === 'collapsed';
  const recurring = dragging?.recurring === true;
  const over = drop.isOver && hidden && !recurring;
  const listPad = Math.max(0, restY) + (kb > 0 ? 0 : insets.bottom) + 16;

  return (
    <>
      <motion.div
        ref={sheetRef}
        className={styles.sheet}
        data-testid="inbox-sheet"
        data-snap={sheet}
        data-hidden={hidden ? 'true' : undefined}
        role="region"
        aria-label="Inbox"
        style={{ y, height: fullH, bottom }}
        onClick={onSheetClick}
      >
        {/* The whole header is the drag / tap surface; the keyboard / screen-reader control is the
            "Inbox · N" button inside it, a sibling of "+" (no interactive control nested in another). */}
        <div
          className={styles.header}
          data-sheet-header=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finishGesture(e, false)}
          onPointerCancel={(e) => finishGesture(e, true)}
          // The grabber never takes focus from a press (no focus ring flash, and a drag that ends over
          // the input must not focus it and raise the keyboard). Keyboard users still Tab to it.
          onMouseDown={(e) => {
            if (!(e.target instanceof Element && e.target.closest('button'))) e.preventDefault();
          }}
          onClick={onHeaderClick}
        >
          <div className={styles.handleBar} aria-hidden="true">
            <span className={styles.handle} />
          </div>
          <div className={styles.titleRow}>
            <div
              className={styles.handleButton}
              data-testid="inbox-sheet-handle"
              role="button"
              tabIndex={0}
              aria-expanded={!collapsed}
              aria-label={`Inbox, ${count} ${count === 1 ? 'task' : 'tasks'}. ${collapsed ? 'Expand' : sheet === 'half' ? 'Expand fully' : 'Collapse'}`}
              onKeyDown={onHeaderKeyDown}
            >
              <span className={styles.title}>Inbox</span>
              {count > 0 && (
                <span className={styles.count} aria-hidden="true">
                  <span className={styles.sep}>·</span>
                  {count}
                </span>
              )}
            </div>
            <IconButton
              label="Add to Inbox"
              icon={Plus}
              tooltip={false}
              className={styles.add}
              data-testid="inbox-sheet-add"
              onClick={onAdd}
            />
          </div>
        </div>

        <div ref={contentRef} className={styles.content} inert={collapsed} aria-hidden={collapsed ? true : undefined}>
          <div className={styles.inputRow}>
            <InboxInput ref={inputRef} onCreated={onCreated} />
          </div>
          <InboxList
            ref={setListNode}
            tasks={tasks}
            className={styles.list}
            style={{ '--inbox-pad-bottom': `${listPad}px` } as CSSProperties}
          />
        </div>
      </motion.div>

      {/* Focus proxy for iOS (see onAdd). Off to the top so iOS never pans the page for it. */}
      <input ref={proxyRef} className={styles.proxy} aria-hidden="true" tabIndex={-1} autoComplete="off" />

      {/* Drag-time drop zone. The droppable box always sits at its final position so the dnd measurement
          taken at drag start is right; only the pill inside animates. */}
      <div
        ref={drop.setNodeRef}
        className={cx(styles.dropHost, hidden && styles.dropHostActive)}
        data-testid="inbox-dropzone"
        data-over={over ? 'true' : undefined}
        aria-disabled={recurring ? true : undefined}
        aria-hidden={hidden ? undefined : true}
      >
        {/* What accepts the drop: the pill itself, and the strip from 20px below the calendar's bottom
            edge. The band in between keeps edge-scrolling the calendar — overshooting that zone by a
            few pixels must never unschedule the task. */}
        <div className={styles.dropHit} />
        <motion.div
          className={cx(styles.pill, over && styles.pillOver, recurring && styles.pillDisabled)}
          initial={false}
          animate={hidden ? { y: 0, opacity: 1, scale: over ? 1.04 : 1 } : { y: 96, opacity: 0, scale: 1 }}
          transition={reduced ? { duration: 0 } : { duration: 0.22, ease: hidden ? EASE_OUT : EASE }}
          onUpdate={FRAMELOOP_ONLY}
        >
          <Icon icon={recurring ? Ban : InboxIcon} size={16} className={styles.pillIcon} />
          <span>{recurring ? 'Repeating tasks stay on the calendar' : 'Move to Inbox'}</span>
        </motion.div>
      </div>
    </>
  );
}
