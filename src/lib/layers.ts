/**
 * Overlay layer stack — one place that decides which overlay (Modal, Sheet, Drawer, Popover, Menu)
 * is "on top". Escape closes ONLY the topmost layer (capture-phase listener, propagation stopped),
 * so nested overlays (a date picker inside the peek) close one at a time, and global hotkeys never
 * see an Escape that an overlay consumed.
 *
 * Ordering is by React nesting depth first (a Popover rendered inside a Modal is above it even if its
 * effect registered first), then by open order.
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';

interface Layer {
  id: number;
  depth: number;
  seq: number;
  onEscape: () => void;
}

let nextId = 1;
let nextSeq = 1;
let layers: Layer[] = [];
const subscribers = new Set<() => void>();
let installed = false;

function notify(): void {
  for (const fn of subscribers) fn();
}

function topLayer(): Layer | undefined {
  let top: Layer | undefined;
  for (const l of layers) {
    if (!top || l.depth > top.depth || (l.depth === top.depth && l.seq > top.seq)) top = l;
  }
  return top;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
  const top = topLayer();
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.onEscape();
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeyDown, true);
  installed = true;
}

/** Registers a layer; returns its id. Remove with removeLayer(id). */
export function pushLayer(onEscape: () => void, depth = 0): number {
  install();
  const id = nextId++;
  layers = [...layers, { id, depth, seq: nextSeq++, onEscape }];
  notify();
  return id;
}

export function removeLayer(id: number): void {
  const next = layers.filter((l) => l.id !== id);
  if (next.length !== layers.length) {
    layers = next;
    notify();
  }
}

export function isTopLayer(id: number): boolean {
  return topLayer()?.id === id;
}

export function hasOpenLayers(): boolean {
  return layers.length > 0;
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Re-renders when overlays open/close; true while any overlay layer is open. */
export function useHasOpenLayers(): boolean {
  return useSyncExternalStore(subscribe, hasOpenLayers, () => false);
}

/**
 * z-index for a modal surface (Modal / Sheet) at nesting `depth` (1 = top-level). A nested surface
 * (phone: the date picker sheet over the peek sheet) must put its backdrop ABOVE the panel below it so
 * that panel dims too: depth 1 → backdrop --z-backdrop, panel --z-peek; depth n > 1 → backdrop
 * --z-peek + 2(n-1) - 1, panel --z-peek + 2(n-1). Popovers (--z-popover) stay above every level.
 */
export function overlayZ(depth: number, part: 'backdrop' | 'panel'): string | undefined {
  if (depth <= 1) return undefined;
  const step = 2 * (depth - 1) - (part === 'backdrop' ? 1 : 0);
  return `calc(var(--z-peek) + ${step})`;
}

/** Nesting depth for layers rendered inside another layer's React subtree. */
export const LayerDepthContext = createContext(0);

/**
 * Registers an overlay layer while `open`. Wrap the overlay's children in
 * <LayerDepthContext.Provider value={depth}> so nested overlays stack above it.
 */
export function useLayer(open: boolean, onEscape: () => void): { depth: number; isTop: () => boolean } {
  const parentDepth = useContext(LayerDepthContext);
  const depth = parentDepth + 1;
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const id = pushLayer(() => escRef.current(), depth);
    idRef.current = id;
    return () => {
      removeLayer(id);
      if (idRef.current === id) idRef.current = null;
    };
  }, [open, depth]);

  const isTopRef = useRef(() => idRef.current !== null && isTopLayer(idRef.current));
  return { depth, isTop: isTopRef.current };
}

/**
 * Backdrop presses that respect layering. Records — in a window capture listener, i.e. before
 * floating-ui's outside-press handlers can close a nested popover and re-render — whether a pointerdown
 * landed exactly on the backdrop element while this layer was topmost. `consume()` (call from the
 * backdrop's click handler) returns that verdict once.
 */
export function useBackdropPress(
  ref: { readonly current: HTMLElement | null },
  isTop: () => boolean,
  enabled: boolean,
): () => boolean {
  const armed = useRef(false);
  const isTopRef = useRef(isTop);
  isTopRef.current = isTop;
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: PointerEvent) => {
      armed.current = ref.current !== null && e.target === ref.current && isTopRef.current();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [enabled, ref]);
  const consume = useRef(() => {
    const v = armed.current;
    armed.current = false;
    return v;
  });
  return consume.current;
}

/**
 * While this layer is topmost, a Tab pressed with focus OUTSIDE `ref` (e.g. focus fell back to <body>
 * after a nested popover closed) is redirected into it. Tab cycling inside is handled by trapTab.
 */
export function useTabGuard(ref: { readonly current: HTMLElement | null }, isTop: () => boolean, enabled: boolean): void {
  const isTopRef = useRef(isTop);
  isTopRef.current = isTop;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key !== 'Tab' || !root || !isTopRef.current()) return;
      if (root.contains(document.activeElement)) return;
      e.preventDefault();
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      );
      const target = (e.shiftKey ? focusables[focusables.length - 1] : focusables[0]) ?? root;
      target.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, ref]);
}
