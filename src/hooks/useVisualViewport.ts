import { useEffect, useState } from 'react';

export interface ViewportInsets {
  /** Pixels of the layout viewport hidden at the bottom (the on-screen keyboard on iOS). */
  keyboard: number;
  /** Visible height (visualViewport.height). */
  height: number;
  /** How far iOS has panned the visual viewport down (focus scrolling). */
  offsetTop: number;
}

function read(): ViewportInsets {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) {
    const h = typeof window !== 'undefined' ? window.innerHeight : 0;
    return { keyboard: 0, height: h, offsetTop: 0 };
  }
  // Below ~80px is browser chrome jitter, not a keyboard.
  const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  return { keyboard: hidden < 80 ? 0 : Math.round(hidden), height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop) };
}

/**
 * Tracks window.visualViewport so bottom-anchored UI (sheets, inputs) can sit above the iOS keyboard.
 * Only subscribes while `enabled`.
 */
export function useVisualViewport(enabled = true): ViewportInsets {
  const [state, setState] = useState<ViewportInsets>(read);
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = read();
        setState((prev) =>
          prev.keyboard === next.keyboard && prev.height === next.height && prev.offsetTop === next.offsetTop ? prev : next,
        );
      });
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled]);
  return state;
}
