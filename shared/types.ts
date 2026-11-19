/**
 * Core domain types — THE contract shared by the web app (src/), the service worker,
 * and Cloud Functions (functions/). Pure data, no imports from firebase/react.
 *
 * Dates are FLOATING calendar dates ("YYYY-MM-DD"): a task on 2026-11-19 is on the 19th
 * wherever you are. Only reminders convert to instants, using Settings.timezone.
 * All timestamps are milliseconds since epoch (number), never Firestore Timestamp.
 */

/** Calendar date, zero-padded ISO "YYYY-MM-DD". */
export type ISODate = string;
/** 24h wall-clock time "HH:mm" (00:00–23:59). */
export type HM = string;
/** Milliseconds since Unix epoch. */
export type Millis = number;

/** 0 = Sunday … 6 = Saturday (same as Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** Repeat every N units; integer >= 1. */
  interval: number;
  /**
   * weekly only: which weekdays (sorted, unique). Defaults to [weekday of series start] when absent/empty.
   * "Every weekday" = { freq:'weekly', interval:1, byWeekday:[1,2,3,4,5] }.
   */
  byWeekday?: Weekday[] | null;
  /** Inclusive last possible occurrence date. Mutually exclusive with count. */
  until?: ISODate | null;
  /** Total number of occurrences counted from the series start. Mutually exclusive with until. */
  count?: number | null;
}

/** Per-occurrence changes for a recurring task, keyed (in Task.overrides) by the ORIGINAL rule date. */
export interface OccurrenceOverride {
  done?: boolean;
  doneAt?: Millis | null;
  /** This single occurrence was deleted. */
  skipped?: boolean;
  /** Occurrence moved to another date (drag & drop / date picker). */
  date?: ISODate;
  /** Time override for this occurrence (null = explicitly untimed). Absent = inherit Task.time. */
  time?: HM | null;
  /** Manual order override within its day (fractional index key). */
  order?: string;
}

/**
 * Reminder setting for a task.
 *  - default: timed task → alert at its time; untimed task → no individual alert (morning summary covers it)
 *  - none:    never alert individually
 *  - offset:  alert `minutes` before the task's date+time (only meaningful for timed tasks;
 *             for untimed tasks it behaves like `default`)
 *  - at:      alert at clock `time`, `daysBefore` days before the task's (occurrence) date (0 = same day)
 */
export type Reminder =
  | { kind: 'default' }
  | { kind: 'none' }
  | { kind: 'offset'; minutes: number }
  | { kind: 'at'; time: HM; daysBefore: number };

export interface Task {
  id: string;
  title: string;
  /** Start date. null => unscheduled (lives in the Inbox). For recurring tasks: the series start. */
  date: ISODate | null;
  /** Inclusive end date for multi-day tasks; null (or === date) => single-day. Always null when recurrence != null or date == null. */
  endDate: ISODate | null;
  /** Optional time of day (applies to the start date / each occurrence). null when date == null. */
  time: HM | null;
  /** Fractional-index key: order within its day (untimed tasks) or within the Inbox. */
  order: string;
  /** Non-recurring completion. Always false for recurring tasks (they use overrides[d].done). */
  done: boolean;
  doneAt: Millis | null;
  /** Repeat rule. Only allowed when date != null and endDate == null. */
  recurrence: Recurrence | null;
  /** Recurring per-occurrence overrides keyed by original rule date. {} for non-recurring. */
  overrides: Record<ISODate, OccurrenceOverride>;
  reminder: Reminder;
  /**
   * Next reminder instant (computed by shared/reminders.ts nextReminder, written by the client on every
   * task write and by Cloud Functions after firing). null => nothing scheduled. Indexed for the
   * scheduled function's collection-group query.
   */
  remindAt: Millis | null;
  createdAt: Millis;
  updatedAt: Millis;
}

/** A concrete appearance of a task on the calendar / in lists. */
export interface Occurrence {
  /** Stable unique key: `${taskId}` for non-recurring, `${taskId}@${origDate}` for recurring. */
  key: string;
  taskId: string;
  /** Recurring: original rule date (override key). Non-recurring: null. */
  origDate: ISODate | null;
  /** Effective start date (after overrides). null => Inbox. */
  date: ISODate | null;
  /** Effective inclusive end date; === date for single-day; null for Inbox. */
  endDate: ISODate | null;
  time: HM | null;
  title: string;
  order: string;
  done: boolean;
  doneAt: Millis | null;
  recurring: boolean;
  /** endDate > date (non-recurring only). */
  multiDay: boolean;
  task: Task;
}

/** Reference to "the thing the user acted on": a task, or one occurrence of a recurring task. */
export interface OccurrenceRef {
  taskId: string;
  /** Original rule date for recurring occurrences; null for non-recurring tasks. */
  origDate: ISODate | null;
}

export type ThemePref = 'system' | 'light' | 'dark';

/** Synced settings (Firestore users/{uid}.settings). Theme is per-device (localStorage), not here. */
export interface Settings {
  /** 1 = Monday (default, as in Notion screenshot), 0 = Sunday. */
  weekStart: 0 | 1;
  summary: {
    enabled: boolean;
    /** Local time for the morning summary push. Default "08:00". */
    time: HM;
  };
  /** IANA timezone of the user's devices (updated from the device on app start). */
  timezone: string;
}

export const DEFAULT_SETTINGS: Settings = {
  weekStart: 1,
  summary: { enabled: true, time: '08:00' },
  timezone: 'UTC',
};

/** Firestore users/{uid} document. */
export interface UserDoc {
  settings: Settings;
  /** Next morning-summary instant (computed client-side + by functions). null when disabled. */
  summaryAt: Millis | null;
  updatedAt: Millis;
}

/** Firestore users/{uid}/devices/{deviceId} — one Web Push subscription per installed device. */
export interface DeviceDoc {
  /** PushSubscription.toJSON() */
  subscription: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
  userAgent: string;
  createdAt: Millis;
  updatedAt: Millis;
}

/** Payload the Cloud Function sends in each Web Push message (JSON-encoded). */
export interface PushPayload {
  title: string;
  body: string;
  /** Home-screen icon badge count (today's open + overdue). */
  badge: number;
  /** Notification tag — same tag replaces previous notification. */
  tag: string;
  /** Deep link opened on click, e.g. "/?task=ID&occ=2026-11-19" or "/". */
  url: string;
}

/** Left "Tasks" sidebar grouping. */
export type ListGroupId = 'overdue' | 'today' | 'tomorrow' | `day:${string}` | 'later' | 'completed';

export interface ListItem {
  occ: Occurrence;
  /** Right-aligned secondary text, e.g. "Nov 12", "3:00 PM", "Nov 19 → 21", "Fri · 3:00 PM". May be ''. */
  meta: string;
  overdue: boolean;
}

export interface ListGroup {
  id: ListGroupId;
  /** "Overdue" | "Today" | "Tomorrow" | weekday name e.g. "Saturday" | "Later" | "Completed" */
  title: string;
  /** e.g. "Thu, Nov 19" for Today/Tomorrow, "Nov 21" for weekday groups; '' otherwise. */
  subtitle: string;
  items: ListItem[];
  /** For 'completed' this is the TOTAL number of completed items (items may be truncated). */
  count: number;
  collapsible: boolean;
  defaultCollapsed: boolean;
}

/** Month/week grid layout for one week row. */
export interface WeekBar {
  occ: Occurrence;
  /** Column index 0..6 within the row where the bar starts / ends (inclusive). */
  startCol: number;
  endCol: number;
  lane: number;
  /** The task continues before this row's first day / after its last day (flat edge, no rounded corner). */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface WeekLayout {
  /** The 7 dates of the row, in display order. */
  days: ISODate[];
  /** Multi-day bars, lane-packed. */
  bars: WeekBar[];
  laneCount: number;
  /** Single-day occurrences per date, already sorted with compareInDay. */
  singles: Record<ISODate, Occurrence[]>;
}
