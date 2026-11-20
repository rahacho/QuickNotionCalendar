import { useEffect, useLayoutEffect, useRef } from 'react';
import { isTypingTarget, matchesCombo } from '@/lib/hotkeys';

/**
 * Global keyboard shortcuts: { "t": fn, "ArrowLeft": fn, "mod+z": fn, "[": fn }.
 * "mod" = ⌘ on Mac / Ctrl elsewhere. Ignored while typing (inputs, textareas, contenteditable), during IME
 * composition, and for events already handled (defaultPrevented). A matched handler prevents the browser
 * default unless it returns `false` (meaning "not handled — let the key through").
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps?: unknown[]): void {
  const mapRef = useRef(map);
  useLayoutEffect(() => {
    mapRef.current = map;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (isTypingTarget(e.target)) return;
      const current = mapRef.current;
      for (const combo of Object.keys(current)) {
        if (!matchesCombo(e, combo)) continue;
        const handler = current[combo];
        if (!handler) continue;
        const result = handler(e) as unknown;
        if (result !== false) {
          e.preventDefault();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // The map is read through a ref (always fresh); `deps` only forces a re-bind when callers ask for it.
  }, deps ?? []); // eslint-disable-line react-hooks/exhaustive-deps
}
