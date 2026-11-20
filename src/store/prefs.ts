/**
 * Per-device UI preferences in localStorage. Every access is wrapped: storage can be missing
 * (SSR/tests), blocked (Safari private mode, disabled site data) or full.
 */
import type { ThemePref } from '@shared/types';

export const THEME_KEY = 'tasks.theme';
export const UI_KEY = 'tasks.ui';
/** Collapsed-group ids kept at most (ids like "day:…" would otherwise accumulate forever). */
const MAX_GROUP_PREFS = 40;

export interface UIPrefs {
  view: 'month' | 'week';
  leftOpen: boolean;
  rightOpen: boolean;
  collapsedGroups: Record<string, boolean>;
}

export const DEFAULT_UI_PREFS: UIPrefs = { view: 'month', leftOpen: true, rightOpen: true, collapsedGroups: {} };

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Full or blocked storage: the preference just won't survive a reload.
  }
}

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** Theme preference; stored raw ("dark"), JSON-quoted values are accepted too (see index.html). */
export function loadTheme(): ThemePref {
  const raw = read(THEME_KEY);
  const v = raw === null ? null : raw.replace(/"/g, '').trim();
  return isThemePref(v) ? v : 'system';
}

export function saveTheme(theme: ThemePref): void {
  write(THEME_KEY, theme);
}

function sanitizeGroups(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return out;
  const entries = Object.entries(v as Record<string, unknown>).filter(
    (e): e is [string, boolean] => typeof e[0] === 'string' && e[0] !== '' && typeof e[1] === 'boolean',
  );
  for (const [k, b] of entries.slice(-MAX_GROUP_PREFS)) out[k] = b;
  return out;
}

export function loadUIPrefs(): UIPrefs {
  const raw = read(UI_KEY);
  if (!raw) return { ...DEFAULT_UI_PREFS, collapsedGroups: {} };
  try {
    const p: unknown = JSON.parse(raw);
    if (p == null || typeof p !== 'object') throw new Error('bad prefs');
    const o = p as Record<string, unknown>;
    return {
      view: o.view === 'week' ? 'week' : 'month',
      leftOpen: typeof o.leftOpen === 'boolean' ? o.leftOpen : DEFAULT_UI_PREFS.leftOpen,
      rightOpen: typeof o.rightOpen === 'boolean' ? o.rightOpen : DEFAULT_UI_PREFS.rightOpen,
      collapsedGroups: sanitizeGroups(o.collapsedGroups),
    };
  } catch {
    return { ...DEFAULT_UI_PREFS, collapsedGroups: {} };
  }
}

export function saveUIPrefs(p: UIPrefs): void {
  write(
    UI_KEY,
    JSON.stringify({
      view: p.view,
      leftOpen: p.leftOpen,
      rightOpen: p.rightOpen,
      collapsedGroups: sanitizeGroups(p.collapsedGroups),
    }),
  );
}
