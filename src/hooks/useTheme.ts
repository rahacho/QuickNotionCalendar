import { useLayoutEffect, useRef } from 'react';
import type { ThemePref } from '@shared/types';
import { useStore } from '@/store/store';
import { useMediaQuery } from './useMediaQuery';

export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemDark ? 'dark' : 'light';
}

/**
 * Applies a resolved theme to <html data-theme> and every <meta name="theme-color">.
 * Transitions are suppressed for one frame so the whole UI flips at once (like Notion) instead of
 * individual elements fading at different speeds.
 */
export function applyTheme(theme: ResolvedTheme, opts: { suppressTransitions?: boolean } = {}): void {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === theme) return;
  if (opts.suppressTransitions) {
    root.setAttribute('data-theme-switching', '');
    requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute('data-theme-switching')));
  }
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) {
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.setAttribute('content', bg);
    }
  }
}

/** Resolves store.theme (+ prefers-color-scheme when "system") → <html data-theme>, meta theme-color. */
export function useApplyTheme(): void {
  const pref = useStore((s) => s.theme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolved = resolveTheme(pref, systemDark);
  const first = useRef(true);
  useLayoutEffect(() => {
    applyTheme(resolved, { suppressTransitions: !first.current });
    first.current = false;
  }, [resolved]);
}
