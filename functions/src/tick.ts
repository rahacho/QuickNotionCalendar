/**
 * The scheduled "tick" (SPEC §7), runs every minute, for every ALLOWLISTED account only
 * (`allow/{uid}` documents, created by the owner in the console; firestore.rules use the same list):
 *
 *  1. Recently written tasks — remindAt is DERIVED from the task but written by every device as its
 *     own field, so a field-level merge of two devices' edits (or a write computed from a stale
 *     offline copy, or on a device whose clock is off) can leave it pointing too late, or at nothing.
 *     Every client write stamps the task with the server's commit time (`syncedAt`, a
 *     serverTimestamp). Each tick re-derives remindAt for the tasks written in the last FEED_MS from
 *     the MERGED document: a missing or too-late value is lowered to the first alert after the write
 *     landed (shared/reminders.ts repairedRemindAt; a due value is left to step 2). So whatever the
 *     merged document plans after a write is armed within a minute — even when no app is open.
 *  2. Task reminders — `users/{uid}/tasks` where remindAt <= now (oldest first, ≤ 200 per user):
 *     find the reminder(s) the stored remindAt stands for, advance remindAt to the next reminder
 *     after now, and push every one of them that is at most 15 minutes late. Per-user queries mean
 *     no other account's documents can ever take the owner's slots.
 *  3. Morning summaries — users/{uid}.summaryAt <= now: advance summaryAt to the next summary time,
 *     and push "Today · N tasks" (+ badge) unless the summary is disabled or > 15 minutes late. A
 *     summaryAt that disagrees with the settings (null while enabled, written from a stale copy) is
 *     repaired; one re-armed to an instant already summarized (`summarySentAt`, e.g. written by a
 *     device whose clock is behind) is advanced without sending it again.
 *  4. Daily sweep — the same remindAt repair over every open task (missed writes: an outage longer
 *     than FEED_MS, documents from before `syncedAt`), and right away when the time zone changed.
 *
 * Exactly-once-ish: every send is preceded by a CONDITIONAL write (Firestore precondition on the
 * document's updateTime as it was read). Overlapping ticks — or a client editing the task at the same
 * moment — make the write fail, and only the tick whose write succeeded sends. A lost claim is simply
 * re-evaluated on the next tick with fresh data. (At-most-once: a crash between claim and send drops
 * that one notification rather than risking a duplicate.) Which alerts were sent — (occurrence,
 * instant) pairs of the last 15 minutes — is also recorded in `users/{uid}/fired/{taskId}` (admin-only,
 * expires after a day), so a client write queued offline that lands after an alert fired and re-arms
 * the same alert never sends it twice, while a different alert that was never sent still goes out.
 *
 * Device docs whose push endpoint is gone (HTTP 404/410) are deleted.
 *
 * All I/O is injected (a minimal subset of the Admin SDK's Firestore + web-push's sendNotification)
 * so the logic is unit-tested with in-memory fakes (tick.test.ts).
 */
import type { DeviceDoc, ISODate, PushPayload, Settings, Task } from '../../shared/types.js';
import { addDays } from '../../shared/dates.js';
import { formatDateShort, formatRange, formatTime, formatWeekdayShort } from '../../shared/format.js';
import { getOccurrence } from '../../shared/occurrences.js';
import {
  badgeCount,
  computeRemindAt,
  nextReminder,
  nextSummaryAt,
  repairedRemindAt,
  summaryText,
  zonedToday,
} from '../../shared/reminders.js';
import { toMillis, toSettings, toSubscription, toTask } from './docs.js';

// ---------------------------------------------------------------------------------------------
// Injected I/O (structurally compatible with firebase-admin/firestore and web-push)
// ---------------------------------------------------------------------------------------------

export type DocData = Record<string, unknown>;

export interface FsDocRef {
  readonly id: string;
  readonly path: string;
  readonly parent: { readonly parent: FsDocRef | null };
  update(data: DocData, precondition?: { lastUpdateTime?: unknown }): Promise<unknown>;
  set(data: DocData): Promise<unknown>;
  delete(): Promise<unknown>;
  get(): Promise<FsDocSnap>;
  collection(id: string): FsQuery;
}

export interface FsDocSnap {
  readonly id: string;
  readonly ref: FsDocRef;
  readonly exists: boolean;
  /** Opaque token passed back as the update precondition (Admin SDK: Timestamp). */
  readonly updateTime?: unknown;
  data(): DocData | undefined;
}

export interface FsQuery {
  /** Range filters compare values of one type: numbers with numbers, Dates with timestamps. */
  where(field: string, op: '<=' | '==' | '>', value: unknown): FsQuery;
  orderBy(field: string): FsQuery;
  limit(n: number): FsQuery;
  get(): Promise<{ readonly docs: FsDocSnap[] }>;
}

export interface FsDb {
  collection(path: string): FsQuery;
  collectionGroup(id: string): FsQuery;
  doc(path: string): FsDocRef;
}

export interface SendOptions {
  TTL: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  timeout: number;
}

/** web-push's sendNotification (VAPID details bound by the caller). Rejects with {statusCode} on HTTP errors. */
export type SendNotification = (subscription: DeviceDoc['subscription'], payload: string, options: SendOptions) => Promise<unknown>;

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface TickDeps {
  db: FsDb;
  sendNotification: SendNotification;
  now?: () => number;
  log?: Logger;
}

export interface TickResult {
  remindersSent: number;
  summariesSent: number;
  /** Due items whose time passed more than STALE_MS ago: advanced without sending. */
  skippedStale: number;
  /** Conditional writes that lost the race (another tick or a concurrent edit); retried next tick. */
  claimsLost: number;
  /** Due reminders / summaries not sent because that exact alert already went out (a stale write re-armed it). */
  duplicatesSkipped: number;
  /** remindAt / summaryAt values corrected to what the merged document says (recent writes, sweep, summary). */
  repaired: number;
  /** Pushes accepted by push services (one per device). */
  pushesDelivered: number;
  devicesPruned: number;
  errors: number;
}

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

export const STALE_MS = 15 * 60 * 1000;
export const TASK_BATCH = 200;
/**
 * Tasks written (syncedAt) within this window get remindAt re-derived every tick. Longer than
 * STALE_MS, so after a few missed ticks every alert that is still sendable is armed.
 */
export const FEED_MS = STALE_MS + 5 * 60 * 1000;
/** How often every open task's remindAt is re-derived server-side (per user), as a backstop. */
export const SWEEP_MS = 24 * 60 * 60 * 1000;
/** Most alerts of ONE task sent by one tick (a late tick catching up on near-simultaneous ones). */
const MAX_CATCH_UP = 5;
/** Fired pairs only matter while their alert could still be sent (STALE_MS); TTL deletes the doc after this. */
const FIRED_TTL_MS = 24 * 60 * 60 * 1000;
const FIRED_KEEP_MS = STALE_MS + 60 * 1000;
const CONCURRENCY = 8;
const USER_CONCURRENCY = 4;
const SEND_TIMEOUT_MS = 10_000;
const REMINDER_TTL_S = 6 * 60 * 60;
const SUMMARY_TTL_S = 12 * 60 * 60;
const MAX_TITLE_CHARS = 120;

const silentLog: Logger = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** gRPC FAILED_PRECONDITION (9) / ABORTED (10) → the document changed since we read it. */
function isPreconditionFailure(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return code === 9 || code === 10 || code === 'failed-precondition' || code === 'aborted' || code === 'FAILED_PRECONDITION';
}

function statusOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const s = (e as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' ? s : null;
}

function errorInfo(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { error: e.message, status: statusOf(e) };
  return { error: String(e) };
}

function shortTitle(t: string): string {
  const s = t.trim().replace(/\s+/g, ' ');
  if (s === '') return 'Untitled';
  const chars = Array.from(s);
  return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join('').trimEnd()}…` : s;
}

function dayLabel(date: ISODate, today: ISODate): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  return formatWeekdayShort(date);
}

/** Notification body for a task reminder: "Today at 3:00 PM", "Tomorrow", "Fri, Nov 21", "Nov 19 → 21". */
export function reminderBody(task: Task, origDate: ISODate | null, occDate: ISODate, today: ISODate): string {
  const occ = getOccurrence(task, origDate);
  const date = occ?.date ?? occDate;
  const time = occ ? occ.time : task.time;
  if (occ?.multiDay && occ.endDate) {
    const range = date === today ? `Today → ${formatDateShort(occ.endDate)}` : formatRange(date, occ.endDate);
    return time ? `${range} · ${formatTime(time)}` : range;
  }
  const day = dayLabel(date, today);
  return time ? `${day} at ${formatTime(time)}` : day;
}

/** Deep link the app understands (`?task=ID&occ=DATE`, occ = original rule date for repeats). */
export function taskUrl(taskId: string, occ: ISODate): string {
  return `/?task=${encodeURIComponent(taskId)}&occ=${encodeURIComponent(occ)}`;
}

// ---------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------

interface UserCtx {
  uid: string;
  settings: Settings;
  /** Loaded lazily (only when something is about to be sent). */
  devices?: Promise<FsDocSnap[]>;
  openTasks?: Promise<Task[]>;
}

interface Fire {
  at: number;
  origDate: ISODate | null;
  occDate: ISODate;
}

/** The occurrence a reminder is about (original rule date for repeats). */
function occOf(r: Fire): ISODate {
  return r.origDate ?? r.occDate;
}

/** One alert that went out: which occurrence, at which instant. */
interface FiredPair {
  at: number;
  occ: string;
}

/** The pairs recorded in users/{uid}/fired/{taskId} (also reads the earlier `{at, occs}` shape). */
function firedPairs(data: DocData | undefined): FiredPair[] {
  const out: FiredPair[] = [];
  const sent: unknown = data?.sent;
  if (Array.isArray(sent)) {
    for (const p of sent) {
      if (p === null || typeof p !== 'object') continue;
      const at = toMillis((p as DocData).at);
      const occ = (p as DocData).occ;
      if (at !== null && typeof occ === 'string') out.push({ at, occ });
    }
  }
  const at = toMillis(data?.at);
  const occs: unknown = data?.occs;
  if (at !== null && Array.isArray(occs)) for (const occ of occs) if (typeof occ === 'string') out.push({ at, occ });
  return out;
}

export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { db, sendNotification } = deps;
  const log = deps.log ?? silentLog;
  const now = (deps.now ?? Date.now)();
  const result: TickResult = {
    remindersSent: 0,
    summariesSent: 0,
    skippedStale: 0,
    claimsLost: 0,
    duplicatesSkipped: 0,
    repaired: 0,
    pushesDelivered: 0,
    devicesPruned: 0,
    errors: 0,
  };

  const devicesOf = (ctx: UserCtx): Promise<FsDocSnap[]> =>
    (ctx.devices ??= db
      .collection(`users/${ctx.uid}/devices`)
      .get()
      .then((s) => s.docs));
  const openTasksOf = (ctx: UserCtx): Promise<Task[]> =>
    (ctx.openTasks ??= db
      .collection(`users/${ctx.uid}/tasks`)
      .where('done', '==', false)
      .get()
      .then((s) => s.docs.map((d) => toTask(d.data(), d.id)).filter((t): t is Task => t !== null)));

  /**
   * A task write by this tick also moves `syncedAt` on: the recent-writes repair (step 1) then
   * derives from after it, and never re-arms an alert this tick just handled.
   */
  const handled = (remindAt: number | null): DocData => ({ remindAt, syncedAt: new Date(now) });

  /** Conditional write: true when this tick owns the change, false when the document moved on. */
  const claim = async (snap: FsDocSnap, data: DocData): Promise<boolean> => {
    try {
      await snap.ref.update(data, snap.updateTime !== undefined ? { lastUpdateTime: snap.updateTime } : undefined);
      return true;
    } catch (e) {
      if (isPreconditionFailure(e)) {
        result.claimsLost++;
        return false;
      }
      throw e;
    }
  };

  const pruned = new Set<string>();

  /** Sends one payload to every device of the user; prunes dead endpoints. Returns deliveries. */
  const sendToUser = async (ctx: UserCtx, payload: PushPayload, opts: Omit<SendOptions, 'timeout'>): Promise<number> => {
    const devices = await devicesOf(ctx);
    const body = JSON.stringify(payload);
    const seen = new Set<string>();
    let delivered = 0;
    await Promise.all(
      devices.map(async (d) => {
        if (pruned.has(d.ref.path)) return;
        const sub = toSubscription(d.data());
        if (!sub) {
          log.warn('device doc without a usable subscription', { path: d.ref.path });
          return;
        }
        if (seen.has(sub.endpoint)) return; // same browser registered twice → one notification
        seen.add(sub.endpoint);
        try {
          await sendNotification(sub, body, { ...opts, timeout: SEND_TIMEOUT_MS });
          delivered++;
        } catch (e) {
          const status = statusOf(e);
          if (status === 404 || status === 410) {
            pruned.add(d.ref.path);
            await d.ref.delete().catch(() => undefined);
            result.devicesPruned++;
            log.info('pruned expired push subscription', { path: d.ref.path, status });
          } else {
            result.errors++;
            log.warn('push send failed', { path: d.ref.path, ...errorInfo(e) });
          }
        }
      }),
    );
    result.pushesDelivered += delivered;
    return delivered;
  };

  /**
   * Lowers / fills one task's remindAt to the first alert the merged document plans after `from`
   * (never touches a due value: step 2 owns it).
   */
  const repairTask = async (ctx: UserCtx, snap: FsDocSnap, from: (raw: DocData | undefined) => number | null): Promise<void> => {
    try {
      const raw = snap.data();
      const task = toTask(raw, snap.id);
      const after = from(raw);
      if (!task || after === null) return;
      const fix = repairedRemindAt(toMillis(raw?.remindAt), computeRemindAt(task, ctx.settings.timezone, after), now);
      if (fix !== undefined && (await claim(snap, { remindAt: fix }))) result.repaired++;
    } catch (e) {
      result.errors++;
      log.error('remindAt repair failed', { path: snap.ref.path, ...errorInfo(e) });
    }
  };

  // -------------------------------------------------------------------------------------------
  // 1. Recently written tasks (one user): re-derive remindAt from the merged documents
  // -------------------------------------------------------------------------------------------
  const repairRecent = async (ctx: UserCtx): Promise<void> => {
    const recent = await db.collection(`users/${ctx.uid}/tasks`).where('syncedAt', '>', new Date(now - FEED_MS)).get();
    // From the moment the write landed: an alert the merged document plans after it is armed even
    // when it is already due (a stale write landing just before the alert) — unless it is too late
    // to send anyway.
    await mapLimit(recent.docs, CONCURRENCY, (snap) =>
      repairTask(ctx, snap, (raw) => {
        const synced = toMillis(raw?.syncedAt);
        return synced === null ? null : Math.max(Math.min(synced, now), now - STALE_MS);
      }),
    );
  };

  // -------------------------------------------------------------------------------------------
  // 2. Task reminders (one user)
  // -------------------------------------------------------------------------------------------
  const remindTask = async (ctx: UserCtx, snap: FsDocSnap): Promise<void> => {
    const raw = snap.data();
    const stored = toMillis(raw?.remindAt);
    if (stored === null) return;
    const task = toTask(raw, snap.id);
    if (!task) return;
    const tz = ctx.settings.timezone;

    // The reminder the stored instant stands for (null: nothing valid any more — done, deleted, edited).
    const first = nextReminder(task, tz, stored - 1);
    const next = computeRemindAt(task, tz, now);

    if (!first || first.at > now) {
      // Stale/early value written by an older client: correct it, nothing to send.
      await claim(snap, handled(next));
      return;
    }
    // Every reminder of this task in (stored − 1, now] that is not stale (a late tick catching up).
    const due: Fire[] = [];
    let r: Fire | null = now - first.at <= STALE_MS ? first : nextReminder(task, tz, now - STALE_MS - 1);
    for (let n = 0; r !== null && r.at <= now && n < MAX_CATCH_UP; n++) {
      due.push(r);
      r = nextReminder(task, tz, r.at);
    }
    if (due.length === 0) {
      if (await claim(snap, handled(next))) result.skippedStale++;
      return;
    }
    if (!(await claim(snap, handled(next)))) return;

    // Nobody to tell (push not enabled on any device): the claim above already advanced it.
    if ((await devicesOf(ctx)).length === 0) return;

    // Never the same alert twice: a client write computed before the alert (queued offline, an
    // undo restore) can land after it fired and set remindAt back to the same instant. Only that
    // exact (occurrence, instant) is skipped — an earlier alert that never went out (an occurrence
    // moved before it while offline) still does.
    const firedRef = db.doc(`users/${ctx.uid}/fired/${task.id}`);
    const firedSnap = await firedRef.get();
    const fired = firedPairs(firedSnap.exists ? firedSnap.data() : undefined);
    const toSend = due.filter((f) => !fired.some((p) => p.at === f.at && p.occ === occOf(f)));
    result.duplicatesSkipped += due.length - toSend.length;
    if (toSend.length === 0) return;
    const sent = [...fired, ...toSend.map((f) => ({ at: f.at, occ: occOf(f) }))].filter((p) => p.at > now - FIRED_KEEP_MS);
    await firedRef.set({ sent, expireAt: new Date(now + FIRED_TTL_MS) });

    const today = zonedToday(now, tz);
    const openTasks = await openTasksOf(ctx);
    const badge = badgeCount(openTasks, today);
    for (const f of toSend) {
      const occ = occOf(f);
      const payload: PushPayload = {
        title: shortTitle(task.title),
        body: reminderBody(task, f.origDate, f.occDate, today),
        badge,
        tag: `task-${task.id}-${occ}`,
        url: taskUrl(task.id, occ),
      };
      if ((await sendToUser(ctx, payload, { TTL: REMINDER_TTL_S, urgency: 'high' })) > 0) result.remindersSent++;
    }
  };

  // -------------------------------------------------------------------------------------------
  // 3. Morning summary (one user)
  // -------------------------------------------------------------------------------------------
  const summarize = async (ctx: UserCtx, snap: FsDocSnap): Promise<void> => {
    const settings = ctx.settings;
    const data = snap.data();
    const stored = toMillis(data?.summaryAt);
    const next = nextSummaryAt(settings, now);
    if (stored === null || stored > now) {
      // Not due. Repair a value that disagrees with the settings (e.g. null written from a stale
      // "disabled" copy while the summary is on): otherwise it would never fire again.
      if (stored !== next && (await claim(snap, { summaryAt: next }))) result.repaired++;
      return;
    }
    const stale = now - stored > STALE_MS;
    // Summaries go out in time order (each next one is after now), so a due instant at or before the
    // last one sent was re-armed by a device whose clock is behind (or a stale copy): already done.
    const lastSent = toMillis(data?.summarySentAt);
    const already = lastSent !== null && stored <= lastSent;
    const sending = settings.summary.enabled && !stale && !already;
    if (!(await claim(snap, sending ? { summaryAt: next, summarySentAt: stored } : { summaryAt: next }))) return;
    if (!settings.summary.enabled) return;
    if (stale) {
      result.skippedStale++;
      return;
    }
    if (already) {
      result.duplicatesSkipped++;
      return;
    }
    if ((await devicesOf(ctx)).length === 0) return;
    const today = zonedToday(now, settings.timezone);
    const openTasks = await openTasksOf(ctx);
    const { title, body } = summaryText(openTasks, today);
    const payload: PushPayload = {
      title,
      body,
      badge: badgeCount(openTasks, today),
      tag: `summary-${today}`,
      url: '/',
    };
    if ((await sendToUser(ctx, payload, { TTL: SUMMARY_TTL_S, urgency: 'normal', topic: 'summary' })) > 0) {
      result.summariesSent++;
    }
  };

  // -------------------------------------------------------------------------------------------
  // 4. Daily sweep (one user): every open task, and right away after a time-zone change
  // -------------------------------------------------------------------------------------------
  const sweep = async (ctx: UserCtx, userSnap: FsDocSnap): Promise<void> => {
    const data = userSnap.data();
    const swept = toMillis(data?.sweptAt);
    const sweptTz = typeof data?.sweptTz === 'string' ? data.sweptTz : null;
    const zoneChanged = sweptTz !== null && sweptTz !== ctx.settings.timezone;
    if (swept !== null && swept <= now && now - swept < SWEEP_MS && !zoneChanged) return;
    const open = await db.collection(`users/${ctx.uid}/tasks`).where('done', '==', false).get();
    await mapLimit(open.docs, CONCURRENCY, (snap) => repairTask(ctx, snap, () => now));
    await userSnap.ref.update({ sweptAt: now, sweptTz: ctx.settings.timezone });
  };

  // -------------------------------------------------------------------------------------------
  // Every allowlisted account
  // -------------------------------------------------------------------------------------------
  const allowed = await db.collection('allow').get();

  await mapLimit(allowed.docs, USER_CONCURRENCY, async (allow) => {
    const uid = allow.id;
    try {
      const userSnap = await db.doc(`users/${uid}`).get();
      if (!userSnap.exists) return;
      const ctx: UserCtx = { uid, settings: toSettings(userSnap.data()?.settings) };

      // First, so an alert a just-landed write plans for this very minute is sent by this tick. A
      // failure here never holds up the reminders themselves.
      try {
        await repairRecent(ctx);
      } catch (e) {
        result.errors++;
        log.error('recent-writes repair failed', { uid, ...errorInfo(e) });
      }

      const due = await db.collection(`users/${uid}/tasks`).where('remindAt', '<=', now).orderBy('remindAt').limit(TASK_BATCH).get();
      await mapLimit(due.docs, CONCURRENCY, async (snap) => {
        try {
          await remindTask(ctx, snap);
        } catch (e) {
          result.errors++;
          log.error('reminder failed', { path: snap.ref.path, ...errorInfo(e) });
        }
      });

      try {
        await summarize(ctx, userSnap);
      } catch (e) {
        result.errors++;
        log.error('summary failed', { path: userSnap.ref.path, ...errorInfo(e) });
      }

      await sweep(ctx, userSnap);
    } catch (e) {
      result.errors++;
      log.error('user tick failed', { uid, ...errorInfo(e) });
    }
  });

  return result;
}
