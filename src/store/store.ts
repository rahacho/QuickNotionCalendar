/**
 * App state (zustand v5). State only — every mutation lives in actions.ts.
 * Per-device UI preferences (view, sidebars, collapsed groups, theme) are restored from
 * localStorage at startup and persisted whenever they change.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { ISODate, OccurrenceRef, Settings, Task, ThemePref } from '@shared/types';
import { startOfMonth, todayISO } from '@shared/dates';
import { firebaseConfigured } from '@/data/env';
import { deviceTimeZone } from '@/data/taskDoc';
import { loadTheme, loadUIPrefs, saveTheme, saveUIPrefs } from './prefs';

export type LayoutMode = 'desktop' | 'tablet' | 'phone';
export type DragSource = 'calendar' | 'inbox' | 'list';

export interface ToastItem {
  id: string;
  message: string;
  action?: { label: string; run: () => void };
  duration: number;
}

export interface UIState {
  view: 'month' | 'week';
  /** "YYYY-MM-01" of the month dominating the month scroller (header title + dimming). */
  visibleMonth: ISODate;
  /** Any date inside the week shown in week view. */
  weekAnchor: ISODate;
  scrollRequest: { date: ISODate; behavior: 'smooth' | 'instant'; nonce: number } | null;
  peek: OccurrenceRef | null;
  /** Desktop sidebars (persisted per device). */
  leftOpen: boolean;
  rightOpen: boolean;
  /** Phone/tablet Tasks drawer. */
  drawerOpen: boolean;
  /** Phone Inbox sheet. */
  sheet: 'collapsed' | 'half' | 'full';
  dragging: { occKey: string; source: DragSource; recurring: boolean } | null;
  /** Desktop inline composer cell / phone QuickAddSheet. */
  composer: { date: ISODate } | null;
  settingsOpen: boolean;
  /** Persisted; missing → group.defaultCollapsed. */
  collapsedGroups: Record<string, boolean>;
  /** How many items the Completed group lists (grows with showMoreCompleted(); not persisted). */
  completedLimit: number;
}

/** Completed items listed before "Show more" (SPEC §4.1 default). */
export const COMPLETED_PAGE = 50;

export interface AppState {
  mode: 'firebase' | 'local';
  authReady: boolean;
  user: { uid: string; email: string | null } | null;
  tasks: Record<string, Task>;
  tasksLoaded: boolean;
  settings: Settings;
  /**
   * error: the sticky "Couldn't sync" reason (a failed listener keeps it until it delivers again).
   * loadFailed: the tasks listener failed before ANY task data arrived — what's shown may be
   * incomplete (show "Couldn't load your tasks" rather than an empty calendar).
   */
  sync: { online: boolean; pendingWrites: boolean; fromCache: boolean; error: string | null; loadFailed: boolean };
  /** Per device (localStorage 'tasks.theme'). */
  theme: ThemePref;
  /** Kept current by startClock(). */
  today: ISODate;
  ui: UIState;
  toasts: ToastItem[];
}

/** Settings used until the user document arrives: defaults in the device's time zone. */
export function initialSettings(): Settings {
  return { ...DEFAULT_SETTINGS, summary: { ...DEFAULT_SETTINGS.summary }, timezone: deviceTimeZone() };
}

function initialOnline(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
}

/** A complete fresh state (also used by tests to reset the store between cases). */
export function createInitialState(): AppState {
  const today = todayISO();
  const prefs = loadUIPrefs();
  const mode = firebaseConfigured ? 'firebase' : 'local';
  return {
    mode,
    authReady: mode === 'local',
    user: null,
    tasks: {},
    tasksLoaded: false,
    settings: initialSettings(),
    sync: { online: initialOnline(), pendingWrites: false, fromCache: false, error: null, loadFailed: false },
    theme: loadTheme(),
    today,
    ui: {
      view: prefs.view,
      visibleMonth: startOfMonth(today),
      weekAnchor: today,
      scrollRequest: null,
      peek: null,
      leftOpen: prefs.leftOpen,
      rightOpen: prefs.rightOpen,
      drawerOpen: false,
      sheet: 'collapsed',
      dragging: null,
      composer: null,
      settingsOpen: false,
      collapsedGroups: prefs.collapsedGroups,
      completedLimit: COMPLETED_PAGE,
    },
    toasts: [],
  };
}

export const useStore: UseBoundStore<StoreApi<AppState>> = create<AppState>()(() => createInitialState());

// Persist per-device preferences whenever they change.
useStore.subscribe((s, prev) => {
  if (s.theme !== prev.theme) saveTheme(s.theme);
  const a = s.ui;
  const b = prev.ui;
  if (a.view !== b.view || a.leftOpen !== b.leftOpen || a.rightOpen !== b.rightOpen || a.collapsedGroups !== b.collapsedGroups) {
    saveUIPrefs({ view: a.view, leftOpen: a.leftOpen, rightOpen: a.rightOpen, collapsedGroups: a.collapsedGroups });
  }
});
