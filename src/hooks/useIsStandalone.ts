import { useMediaQuery } from './useMediaQuery';

function navigatorStandalone(): boolean {
  return typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** True when running as an installed PWA (home-screen app) rather than in a browser tab. */
export function useIsStandalone(): boolean {
  const displayStandalone = useMediaQuery('(display-mode: standalone)');
  const fullscreen = useMediaQuery('(display-mode: fullscreen)');
  return displayStandalone || fullscreen || navigatorStandalone();
}

/** Non-hook variant for one-off checks. */
export function isStandalone(): boolean {
  if (navigatorStandalone()) return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches
    : false;
}
