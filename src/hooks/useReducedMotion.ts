import { useMediaQuery } from './useMediaQuery';

/** True when the OS asks for reduced motion — animations should collapse to instant changes. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

export { usePrefersReducedMotion as useReducedMotion };
