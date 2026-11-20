/**
 * Motion helpers shared by the Tasks list and the Inbox (both owned by the sidebars feature).
 *
 * Lists animate inserts/removals by height + opacity (siblings glide because the layout flows with the
 * animated height — no transform fights with dnd-kit's sortable transforms). `overflow` is only hidden
 * while a row is collapsing/expanding so focus rings and card shadows are never clipped at rest.
 */
import type { TargetAndTransition, Transition } from 'motion/react';
import { useStore } from '@/store/store';
import { DUR, EASE } from '@/lib/motion';
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion';

export const COLLAPSED: TargetAndTransition = { height: 0, opacity: 0, overflow: 'hidden' };
export const EXPANDED: TargetAndTransition = { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } };

/**
 * Pass as `onUpdate` to keep a motion component's opacity on motion's JS frameloop instead of WAAPI.
 * These wrappers animate `height` on the main thread anyway, so nothing is lost — and their exits can't
 * stall when `performance.now()` and `document.timeline` disagree (Playwright's fake clock across a
 * reload: WAAPI then starts seconds late and AnimatePresence never removes the row).
 */
export const FRAMELOOP_ONLY = (): void => {};

/** 180ms decelerating (SPEC §5 motion rules); instant when the OS asks for reduced motion. */
export function useListTransition(duration: number = DUR.base): Transition {
  const reduced = usePrefersReducedMotion();
  return reduced ? { duration: 0 } : { duration, ease: EASE };
}

// ---------------------------------------------------------------------------------------------
// Click-after-drag guard: a drag released over its own source would otherwise also "click" it
// (opening the peek). Tracks the end of every drag via the store.
// ---------------------------------------------------------------------------------------------

let wasDragging = useStore.getState().ui.dragging !== null;
let lastDragEnd = 0;

useStore.subscribe((s) => {
  const dragging = s.ui.dragging !== null;
  if (wasDragging && !dragging) lastDragEnd = performance.now();
  wasDragging = dragging;
});

/** True while a drag is in flight or for a short moment after it ended. */
export function justDragged(windowMs = 250): boolean {
  return useStore.getState().ui.dragging !== null || performance.now() - lastDragEnd < windowMs;
}
