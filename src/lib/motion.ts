/**
 * JS mirrors of the motion tokens in tokens.css (motion/react needs numbers). Keep in sync with
 * --ease / --ease-out / --ease-in and --dur-* there. Reduced motion is honoured globally by
 * <MotionConfig reducedMotion="user"> at the app root.
 */
export const EASE = [0.2, 0, 0, 1] as const;
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;

/** Seconds. */
export const DUR = {
  instant: 0.08,
  fast: 0.12,
  base: 0.18,
  slow: 0.26,
} as const;

/** Critically-damped spring for drag releases (sheets, drawer) — settles fast, never overshoots visibly. */
export const SPRING_SETTLE = { type: 'spring', stiffness: 520, damping: 48, mass: 1 } as const;

/** Milliseconds (for CSS-transition based helpers such as floating-ui's useTransitionStyles). */
export const DUR_MS = {
  instant: 80,
  fast: 120,
  base: 180,
  slow: 260,
} as const;
