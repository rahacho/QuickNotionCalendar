/**
 * Keeps store.today current: now, at the next local midnight (re-armed every time), and whenever
 * the app comes back (visibilitychange → visible, focus, pageshow from the back/forward cache).
 * Timers are capped at one hour so a device clock / time zone change self-corrects even if no
 * resume event fires; an iOS home-screen app suspended overnight updates as soon as it is shown.
 */
import { todayISO } from '@shared/dates';
import { useStore } from './store';

const MAX_DELAY = 60 * 60 * 1000;
/** Fire slightly after midnight so the new date is unambiguous. */
const AFTER_MIDNIGHT = 250;

function msUntilNextMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, AFTER_MIDNIGHT);
  return next.getTime() - now.getTime();
}

export function startClock(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    const delay = Math.min(MAX_DELAY, Math.max(1000, msUntilNextMidnight(new Date())));
    timer = setTimeout(tick, delay);
  };

  const tick = (): void => {
    if (stopped) return;
    const today = todayISO();
    if (useStore.getState().today !== today) useStore.setState({ today });
    schedule();
  };

  const onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') tick();
  };

  tick();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', tick);
    window.addEventListener('pageshow', tick);
  }

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', tick);
      window.removeEventListener('pageshow', tick);
    }
  };
}
