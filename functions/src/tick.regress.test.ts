/**
 * Regression tests for review findings on the scheduled tick (A1, A3, B3, B7, B8) and the gaps left
 * after their first fixes (recently written tasks repaired every minute; exact fired pairs; one
 * summary per instant).
 */
import { describe, expect, it } from 'vitest';
import type { PushPayload, Task } from '../../shared/types.js';
import { computeRemindAt, zonedInstant } from '../../shared/reminders.js';
import { FEED_MS, SWEEP_MS, runTick, type SendNotification } from './tick.js';
import { FakeFirestore } from './testing/fakeFirestore.js';

const TZ = 'America/New_York';
const UID = 'owner';

function mk(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    date: '2026-11-19',
    endDate: null,
    time: null,
    order: 'a0',
    done: false,
    doneAt: null,
    recurrence: null,
    overrides: {},
    reminder: { kind: 'default' },
    remindAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const device = (endpoint: string) => ({
  subscription: { endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } },
  userAgent: 't',
  createdAt: 1,
  updatedAt: 1,
});

/** The owner (allowlisted, New York, summary off) with one device and tasks whose remindAt is computed at `at`. */
function seed(tasks: Task[], at: number, user: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.set(`allow/${UID}`, {});
  db.set(`users/${UID}`, {
    settings: { weekStart: 1, summary: { enabled: false, time: '08:00' }, timezone: TZ },
    summaryAt: null,
    updatedAt: 1,
    ...user,
  });
  for (const t of tasks) db.set(`users/${UID}/tasks/${t.id}`, { ...t, remindAt: computeRemindAt(t, TZ, at) });
  db.set(`users/${UID}/devices/d1`, device('https://push.example/owner'));
  return db;
}

function pushes(): { send: SendNotification; sent: Array<{ endpoint: string; payload: PushPayload }> } {
  const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
  const send: SendNotification = async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as PushPayload });
    return {};
  };
  return { send, sent };
}

const at = (date: string, time: string): number => zonedInstant(date, time, TZ);

/** A client write as Firestore stores it: the fields, stamped with the server's commit time. */
function clientWrite(db: FakeFirestore, id: string, fields: Record<string, unknown>, landedAt: number): void {
  db.patch(`users/${UID}/tasks/${id}`, { ...fields, syncedAt: new Date(landedAt) });
}

/** Runs one tick a minute (at hh:mm:05) from `from` for `minutes` minutes. */
async function everyMinute(db: FakeFirestore, send: SendNotification, from: number, minutes: number): Promise<void> {
  for (let m = 0; m <= minutes; m++) await runTick({ db, sendNotification: send, now: () => from + m * 60_000 + 5_000 });
}

describe('A3: only allowlisted accounts are served', () => {
  it("another account flooding due tasks can't starve the owner, and never gets pushes", async () => {
    const tenAm = at('2026-11-19', '10:00');
    const db = seed([mk('dentist', { title: 'Dentist', time: '10:00' })], tenAm - 3_600_000);
    db.set('users/mallory', { settings: { timezone: 'UTC' }, summaryAt: 1, updatedAt: 1 });
    db.set('users/mallory/devices/m', device('https://attacker.example/hook'));
    const p = pushes();
    for (let minute = 0; minute <= 3; minute++) {
      for (let i = 0; i < 250; i++) db.set(`users/mallory/tasks/j${i}`, { title: 'x', date: '2026-11-19', time: '00:00', remindAt: 1 });
      await runTick({ db, sendNotification: p.send, now: () => tenAm + minute * 60_000 + 5_000 });
    }
    expect(p.sent.map((s) => s.endpoint)).toEqual(['https://push.example/owner']);
    expect(p.sent[0]?.payload.title).toBe('Dentist');
    // Nothing of the other account was touched.
    expect(db.get('users/mallory/tasks/j0')?.remindAt).toBe(1);
    expect(db.get('users/mallory')?.summaryAt).toBe(1);
  });

  it('does nothing at all without an allowlist entry', async () => {
    const tenAm = at('2026-11-19', '10:00');
    const db = seed([mk('t', { time: '10:00' })], tenAm - 60_000);
    db.store.delete(`allow/${UID}`);
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => tenAm + 1_000 });
    expect(p.sent).toEqual([]);
  });
});

describe('A1: remindAt left wrong by a field-level merge is repaired server-side', () => {
  it('two devices editing different fields (date on A, time on B offline): the merged reminder still fires', async () => {
    const created = at('2026-11-19', '10:00');
    const original = mk('dentist', { title: 'Dentist', date: '2026-11-25', time: '09:00' });
    const db = seed([original], created);
    // A (online) moved it to Nov 20; B (offline, still on Nov 25) changed the time to 10:00.
    db.patch(`users/${UID}/tasks/dentist`, { date: '2026-11-20', remindAt: at('2026-11-20', '09:00'), updatedAt: 2 });
    db.patch(`users/${UID}/tasks/dentist`, { time: '10:00', remindAt: at('2026-11-25', '10:00'), updatedAt: 3 });
    const p = pushes();
    const start = at('2026-11-20', '09:55');
    for (let m = 0; m <= 10; m++) await runTick({ db, sendNotification: p.send, now: () => start + m * 60_000 + 5_000 });
    expect(p.sent.map((s) => s.payload.body)).toEqual(['Today at 10:00 AM']);
  });

  it('a stale remindAt written from an old cached copy (task since moved earlier) is lowered by the sweep', async () => {
    const db = seed([mk('t', { date: '2026-11-20', time: '09:00' })], at('2026-11-19', '12:00'));
    db.patch(`users/${UID}/tasks/t`, { remindAt: at('2026-11-25', '09:00') });
    const p = pushes();
    const start = at('2026-11-20', '08:59');
    for (let m = 0; m <= 5; m++) await runTick({ db, sendNotification: p.send, now: () => start + m * 60_000 + 5_000 });
    expect(p.sent).toHaveLength(1);
  });

  it('the sweep fills a missing remindAt, leaves too-early / correct values alone, and runs daily', async () => {
    const now = at('2026-11-19', '12:00');
    const db = seed(
      [
        mk('missing', { date: '2026-11-21', time: '09:00' }),
        mk('early', { date: '2026-11-22', time: '09:00' }),
        mk('ok', { date: '2026-11-23', time: '09:00' }),
      ],
      now - 3_600_000,
    );
    db.patch(`users/${UID}/tasks/missing`, { remindAt: null });
    db.patch(`users/${UID}/tasks/early`, { remindAt: at('2026-11-20', '09:00') });
    const p = pushes();
    const r = await runTick({ db, sendNotification: p.send, now: () => now });
    expect(db.get(`users/${UID}/tasks/missing`)?.remindAt).toBe(at('2026-11-21', '09:00'));
    expect(db.get(`users/${UID}/tasks/early`)?.remindAt).toBe(at('2026-11-20', '09:00'));
    expect(db.get(`users/${UID}/tasks/ok`)?.remindAt).toBe(at('2026-11-23', '09:00'));
    expect(r.repaired).toBe(1);
    expect(db.get(`users/${UID}`)?.sweptAt).toBe(now);

    // Within the day: no sweep (no read of the open tasks).
    db.patch(`users/${UID}/tasks/missing`, { remindAt: null });
    db.reads.length = 0;
    await runTick({ db, sendNotification: p.send, now: () => now + SWEEP_MS - 60_000 });
    expect(db.get(`users/${UID}/tasks/missing`)?.remindAt).toBeNull();
    expect(db.reads).not.toContain(`collection(users/${UID}/tasks) where done == false`);
    await runTick({ db, sendNotification: p.send, now: () => now + SWEEP_MS });
    expect(db.get(`users/${UID}/tasks/missing`)?.remindAt).toBe(at('2026-11-21', '09:00'));
    expect(p.sent).toEqual([]);
  });

  it('a summaryAt cleared from a stale "disabled" copy while the summary is on is re-armed', async () => {
    const now = at('2026-11-19', '12:00');
    const db = seed([], now, { settings: { weekStart: 1, summary: { enabled: true, time: '08:00' }, timezone: TZ }, summaryAt: null });
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => now });
    expect(db.get(`users/${UID}`)?.summaryAt).toBe(at('2026-11-20', '08:00'));
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-20', '08:00') + 5_000 });
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['summary-2026-11-20']);
  });
});

describe('A1 (gap): a merge that lands between sweeps is repaired within a minute, server-side', () => {
  /** Device A (online) moved Dentist to Nov 20; device B (offline, still on Nov 25) changed the time. */
  function merged(landedAt: number): FakeFirestore {
    const original = mk('dentist', { title: 'Dentist', date: '2026-11-25', time: '09:00' });
    // The daily sweep just ran: only the recent-writes repair can catch the merge.
    const db = seed([original], at('2026-11-19', '12:00'), { sweptAt: at('2026-11-20', '09:30'), sweptTz: TZ });
    clientWrite(db, 'dentist', { date: '2026-11-20', remindAt: at('2026-11-20', '09:00') }, at('2026-11-19', '12:01'));
    clientWrite(db, 'dentist', { time: '10:00', remindAt: at('2026-11-25', '10:00') }, landedAt);
    return db;
  }

  it('no app open, sweep ran 10 minutes before the merge: the 10:00 alert still goes out, once', async () => {
    const db = merged(at('2026-11-20', '09:40'));
    expect(db.get(`users/${UID}/tasks/dentist`)?.remindAt).toBe(at('2026-11-25', '10:00'));
    const p = pushes();
    await everyMinute(db, p.send, at('2026-11-20', '09:41'), 35);
    expect(p.sent.map((s) => s.payload.body)).toEqual(['Today at 10:00 AM']);
    expect(db.get(`users/${UID}/tasks/dentist`)?.remindAt).toBeNull();
  });

  it('a merge landing seconds before the alert is sent by the very next tick', async () => {
    const db = merged(at('2026-11-20', '09:59') + 50_000);
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-20', '10:00') + 5_000 });
    expect(p.sent.map((s) => s.payload.body)).toEqual(['Today at 10:00 AM']);
  });

  it('a write from a device whose clock runs ahead (it thought the alert had passed) is re-armed', async () => {
    const t = mk('call', { title: 'Call', date: '2026-11-20', time: '09:00', recurrence: { freq: 'daily', interval: 1 } });
    const db = seed([t], at('2026-11-19', '12:00'), { sweptAt: at('2026-11-20', '08:00'), sweptTz: TZ });
    // Real time 08:59:40; the phone's clock reads 09:00:10, so it computed tomorrow's alert.
    clientWrite(db, 'call', { title: 'Call mom', remindAt: computeRemindAt(t, TZ, at('2026-11-20', '09:00') + 10_000) }, at('2026-11-20', '08:59') + 40_000);
    const p = pushes();
    await everyMinute(db, p.send, at('2026-11-20', '09:00'), 3);
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['task-call-2026-11-20']);
  });

  it('never re-arms an alert the tick already handled, and leaves correct values alone (no writes)', async () => {
    const t = mk('gym', { date: '2026-11-20', time: '09:00', recurrence: { freq: 'daily', interval: 1 } });
    const db = seed([t], at('2026-11-19', '12:00'), { sweptAt: at('2026-11-20', '08:00'), sweptTz: TZ });
    clientWrite(db, 'gym', { title: 'Gym', remindAt: at('2026-11-20', '09:00') }, at('2026-11-20', '08:50'));
    const p = pushes();
    let repaired = 0;
    for (let m = 0; m <= FEED_MS / 60_000 + 2; m++) {
      const r = await runTick({ db, sendNotification: p.send, now: () => at('2026-11-20', '08:51') + m * 60_000 + 5_000 });
      repaired += r.repaired;
    }
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['task-gym-2026-11-20']);
    expect(repaired).toBe(0);
    expect(db.get(`users/${UID}/tasks/gym`)?.remindAt).toBe(at('2026-11-21', '09:00'));
  });

  it('reads only recently written tasks each minute (the full sweep runs once a day)', async () => {
    const now = at('2026-11-20', '12:00');
    const db = seed([mk('a', { date: '2026-11-21', time: '09:00' }), mk('b', { date: '2026-11-22', time: '09:00' })], now - 3_600_000, {
      sweptAt: now - 60_000,
      sweptTz: TZ,
    });
    clientWrite(db, 'a', { title: 'A' }, now - FEED_MS - 1);
    clientWrite(db, 'b', { title: 'B' }, now - 30_000);
    db.reads.length = 0;
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => now });
    expect(db.reads).toContain(`collection(users/${UID}/tasks) where syncedAt > ${now - FEED_MS}`);
    expect(db.reads).not.toContain(`collection(users/${UID}/tasks) where done == false`);
  });

  it('a failing recent-writes query never holds up the reminders', async () => {
    const tenAm = at('2026-11-20', '10:00');
    const db = seed([mk('t', { date: '2026-11-20', time: '10:00' })], tenAm - 3_600_000, { sweptAt: tenAm - 60_000, sweptTz: TZ });
    const collection = db.collection.bind(db);
    db.collection = (path: string) => {
      const q = collection(path);
      const where = q.where.bind(q);
      q.where = (field, op, value) => {
        if (field === 'syncedAt') throw new Error('FAILED_PRECONDITION: index building');
        return where(field, op, value);
      };
      return q;
    };
    const p = pushes();
    const r = await runTick({ db, sendNotification: p.send, now: () => tenAm + 5_000 });
    expect(p.sent).toHaveLength(1);
    expect(r.errors).toBe(1);
  });

  it('a time-zone change is swept right away (remindAt values left in the old zone)', async () => {
    const t = mk('flight', { date: '2026-11-20', time: '09:00' });
    const now = at('2026-11-19', '12:00');
    // Written in Los Angeles (09:00 PT = 12:00 ET): three hours too late for New York.
    const db = seed([t], now, { sweptAt: now - 60_000, sweptTz: 'America/Los_Angeles' });
    db.patch(`users/${UID}/tasks/flight`, { remindAt: computeRemindAt(t, 'America/Los_Angeles', now) });
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => now });
    expect(db.get(`users/${UID}/tasks/flight`)?.remindAt).toBe(at('2026-11-20', '09:00'));
    expect(db.get(`users/${UID}`)?.sweptTz).toBe(TZ);
  });
});

describe('summary (gap): a device whose clock is behind never causes a second summary', () => {
  it('summaryAt re-armed to the instant just summarized is advanced without sending; the next day still goes out', async () => {
    const eight = at('2026-11-20', '08:00');
    const db = seed([], eight - 3_600_000, {
      settings: { weekStart: 1, summary: { enabled: true, time: '08:00' }, timezone: TZ },
      summaryAt: eight,
    });
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => eight + 5_000 });
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['summary-2026-11-20']);
    // A phone whose clock reads 07:59:51 writes "today 08:00" back (e.g. saving a setting).
    db.patch(`users/${UID}`, { summaryAt: eight });
    const r = await runTick({ db, sendNotification: p.send, now: () => eight + 65_000 });
    expect(p.sent).toHaveLength(1);
    expect(r.duplicatesSkipped).toBe(1);
    expect(db.get(`users/${UID}`)?.summaryAt).toBe(at('2026-11-21', '08:00'));
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-21', '08:00') + 5_000 });
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['summary-2026-11-20', 'summary-2026-11-21']);
  });
});

describe('B3: recurring reminders beyond 400 days are never dropped', () => {
  it('every-2-years timed task alerts again two years later', async () => {
    const t = mk('bi', { time: '09:00', recurrence: { freq: 'yearly', interval: 2 } });
    const db = seed([t], at('2026-11-19', '00:00'));
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:00') + 5_000 });
    expect(db.get(`users/${UID}/tasks/bi`)?.remindAt).toBe(at('2028-11-19', '09:00'));
    await runTick({ db, sendNotification: p.send, now: () => at('2028-11-19', '09:00') + 5_000 });
    expect(p.sent.map((s) => s.payload.body)).toEqual(['Today at 9:00 AM', 'Today at 9:00 AM']);
  });
});

describe('B7: an alert that already fired is never sent again', () => {
  it('a queued offline write that re-arms the fired instant does not re-send it', async () => {
    const t = mk('dup', { time: '09:00', recurrence: { freq: 'daily', interval: 1 } });
    const db = seed([t], at('2026-11-19', '00:00'));
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:00') + 2_000 });
    expect(p.sent).toHaveLength(1);
    db.patch(`users/${UID}/tasks/dup`, { title: 'Standup', remindAt: computeRemindAt(t, TZ, at('2026-11-19', '08:30')) });
    const r = await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:06') });
    expect(p.sent).toHaveLength(1);
    expect(r.duplicatesSkipped).toBe(1);
    // ...and the next day's alert still goes out.
    expect(db.get(`users/${UID}/tasks/dup`)?.remindAt).toBe(at('2026-11-20', '09:00'));
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-20', '09:00') + 2_000 });
    expect(p.sent).toHaveLength(2);
  });

  it('an undo restore (full-document set) landing late does not re-send either', async () => {
    const t = mk('one', { time: '09:00' });
    const db = seed([t], at('2026-11-19', '00:00'));
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:00') + 2_000 });
    db.set(`users/${UID}/tasks/one`, { ...t, remindAt: computeRemindAt(t, TZ, at('2026-11-19', '08:45')) });
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:03') });
    expect(p.sent).toHaveLength(1);
    expect(db.get(`users/${UID}/fired/one`)?.sent).toEqual([{ at: at('2026-11-19', '09:00'), occ: '2026-11-19' }]);
  });

  it('an EARLIER alert that never went out is not mistaken for a duplicate', async () => {
    // Daily 09:00. Offline at 08:50 the phone moves tomorrow's occurrence to today 08:55; the write lands at 09:05.
    const t = mk('pair', { time: '09:00', recurrence: { freq: 'daily', interval: 1 } });
    const db = seed([t], at('2026-11-19', '00:00'));
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:00') + 3_000 });
    const edited: Task = { ...t, overrides: { '2026-11-20': { date: '2026-11-19', time: '08:55' } } };
    clientWrite(db, 'pair', { overrides: edited.overrides, remindAt: computeRemindAt(edited, TZ, at('2026-11-19', '08:50')) }, at('2026-11-19', '09:05'));
    const r = await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:05') + 30_000 });
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['task-pair-2026-11-19', 'task-pair-2026-11-20']);
    expect(r.duplicatesSkipped).toBe(1); // only the 09:00 one, which really went out
  });

  it('reads the earlier marker shape ({at, occs}) too', async () => {
    const t = mk('old', { time: '09:00' });
    const db = seed([t], at('2026-11-19', '00:00'));
    db.set(`users/${UID}/fired/old`, { at: at('2026-11-19', '09:00'), occs: ['2026-11-19'] });
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:01') });
    expect(p.sent).toEqual([]);
  });
});

describe('B8: a late tick sends every non-stale alert of a task', () => {
  it('two occurrences a minute apart, tick 90 s late → both alerts, once each', async () => {
    const t = mk('two', {
      time: '09:00',
      recurrence: { freq: 'daily', interval: 1 },
      overrides: { '2026-11-20': { date: '2026-11-19', time: '09:01' } },
    });
    const db = seed([t], at('2026-11-19', '00:00'));
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:01') + 30_000 });
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:02') + 30_000 });
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['task-two-2026-11-19', 'task-two-2026-11-20']);
  });

  it('after a long outage, the alerts of the last 15 minutes still go out (older ones are skipped)', async () => {
    const t = mk('daily', { time: '09:00', recurrence: { freq: 'daily', interval: 1 } });
    const db = seed([t], at('2026-10-01', '00:00')); // remindAt = Oct 1 09:00, never advanced since
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:05') });
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['task-daily-2026-11-19']);
    expect(db.get(`users/${UID}/tasks/daily`)?.remindAt).toBe(at('2026-11-20', '09:00'));
  });

  it('still skips the alerts that are more than 15 minutes late', async () => {
    const t = mk('late', {
      time: '09:00',
      recurrence: { freq: 'daily', interval: 1 },
      overrides: { '2026-11-20': { date: '2026-11-19', time: '09:20' } },
    });
    const db = seed([t], at('2026-11-19', '00:00'));
    const p = pushes();
    await runTick({ db, sendNotification: p.send, now: () => at('2026-11-19', '09:21') });
    expect(p.sent.map((s) => s.payload.tag)).toEqual(['task-late-2026-11-20']);
  });
});
