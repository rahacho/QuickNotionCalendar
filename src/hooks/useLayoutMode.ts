import { useSyncExternalStore } from 'react';
import type { LayoutMode } from '@/store/store';

/** phone: width < 640 || (coarse pointer && height < 500, i.e. landscape phone); tablet: < 1100; else desktop. */
export function computeLayoutMode(): LayoutMode {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  const h = window.innerHeight;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  if (w < 640 || (coarse && h < 500)) return 'phone';
  if (w < 1100) return 'tablet';
  return 'desktop';
}

function subscribe(onChange: () => void): () => void {
  let raf = 0;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(onChange);
  };
  const coarse = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  coarse?.addEventListener('change', schedule);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    coarse?.removeEventListener('change', schedule);
  };
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, computeLayoutMode, () => 'desktop' as LayoutMode);
}
