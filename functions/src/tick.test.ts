import { describe, expect, it, vi } from 'vitest';
import type { PushPayload, Task } from '../../shared/types.js';
import { computeRemindAt, zonedInstant } from '../../shared/reminders.js';
import { STALE_MS, reminderBody, runTick, taskUrl, type SendNotification, type SendOptions } from './tick.js';
import { toSubscription, toTask } from './docs.js';
import { FakeFirestore } from './testing/fakeFirestore.js';

const TZ = 'America/New_York';
const TODAY = '2026-11-19';
const UID = 'u1';

function task(id: string, over: Partial<Task> = {}): Task {
  const t: Task = {
    id,
    title: `Task ${id}`,
    date: TODAY,
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
  return t;
}

function device(endpoint: string): Record<string, unknown> {
  return {
    subscription: { endpoint, expirationTime: null, keys: { p256dh: `p256-${endpoint.length}`, auth: 'auth-secret' } },
    userAgent: 'test',
    createdAt: 1,
    updatedAt: 1,
  };
}

interface Sent {
  endpoint: string;
  payload: PushPayload;
  options: SendOptions;
}

/** A web-push sendNotification mock that records deliveries; `fail` maps endpoint → HTTP status. */
function mockPush(fail: Record<string, number> = {}): { send: SendNotification & ReturnType<typeof vi.fn>; sent: Sent[] } {
  const sent: Sent[] = [];
  const send = vi.fn(async (sub: { endpoint: string }, payload: string, options: SendOptions) => {
    await new Promise((r) => setTimeout(r, 0));
    const status = fail[sub.endpoint];
    if (status) throw Object.assign(new Error(`Received unexpected response code ${status}`), { statusCode: status, body: '' });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as PushPayload, options });
    return { statusCode: 201 };
  });
  return { send: send as SendNotification & ReturnType<typeof vi.fn>, sent };
}

/** A signed-in user (New York) with two push devices and the given tasks (remindAt computed like the client). */
function seed(
  tasks: Task[],
  opts: { devices?: string[]; summaryAt?: number | null; summary?: { enabled: boolean; time: string }; at?: number; sweptAt?: number } = {},
): FakeFirestore {
  const db = new FakeFirestore();
  const at = opts.at ?? zonedInstant(TODAY, '00:00', TZ);
  db.set(`allow/${UID}`, {});
  db.set(`users/${UID}`, {
    settings: { weekStart: 1, summary: opts.summary ?? { enabled: true, time: '08:00' }, timezone: TZ },
    summaryAt: opts.summaryAt ?? null,
    updatedAt: 1,
    ...(opts.sweptAt !== undefined ? { sweptAt: opts.sweptAt } : {}),
  });
  for (const t of tasks) {
    const remindAt = t.remindAt ?? computeRemindAt(t, TZ, at);
    db.set(`users/${UID}/tasks/${t.id}`, { ...t, remindAt });
  }
  for (const [i, endpoint] of (opts.devices ?? ['https://push.example/a', 'https://push.example/b']).entries()) {
    db.set(`users/${UID}/devices/d${i + 1}`, device(endpoint));
  }
  return db;
}

const tenAm = zonedInstant(TODAY, '10:00', TZ);

describe('runTick — task reminders', () => {
  it('pushes a due timed reminder to every device and clears remindAt of a one-time task', async () => {
    const db = seed([task('t1', { title: 'Call mom', time: '10:00' })]);
    expect(db.get(`users/${UID}/tasks/t1`)?.remindAt).toBe(tenAm);
    const push = mockPush();

    const result = await runTick({ db, sendNotification: push.send, now: () => tenAm + 30_000 });

    expect(result).toMatchObject({ remindersSent: 1, pushesDelivered: 2, errors: 0 });
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual(['https://push.example/a', 'https://push.example/b']);
    const first = push.sent[0];
    expect(first?.payload).toEqual({
      title: 'Call mom',
      body: 'Today at 10:00 AM',
      badge: 1,
      tag: 'task-t1-2026-11-19',
      url: '/?task=t1&occ=2026-11-19',
    });
    expect(first?.options).toMatchObject({ TTL: 6 * 3600, urgency: 'high' });
    expect(db.get(`users/${UID}/tasks/t1`)?.remindAt).toBeNull();
  });

  it('advances a repeating task to its next occurrence and links the occurrence', async () => {
    const db = seed([task('r1', { title: 'Standup', time: '10:00', recurrence: { freq: 'daily', interval: 1 } })]);
    const push = mockPush();

    await runTick({ db, sendNotification: push.send, now: () => tenAm + 5_000 });

    expect(push.sent).toHaveLength(2);
    expect(push.sent[0]?.payload.url).toBe('/?task=r1&occ=2026-11-19');
    expect(db.get(`users/${UID}/tasks/r1`)?.remindAt).toBe(zonedInstant('2026-11-20', '10:00', TZ));
  });

  it('does not send reminders that are more than 15 minutes late, but still advances them', async () => {
    const db = seed([task('t1', { time: '10:00', recurrence: { freq: 'daily', interval: 1 } })]);
    const push = mockPush();

    const result = await runTick({ db, sendNotification: push.send, now: () => tenAm + STALE_MS + 60_000 });

    expect(push.send).not.toHaveBeenCalled();
    expect(result.skippedStale).toBe(1);
    expect(db.get(`users/${UID}/tasks/t1`)?.remindAt).toBe(zonedInstant('2026-11-20', '10:00', TZ));
  });

  it('corrects a remindAt that no longer stands for a reminder (task completed elsewhere) without sending', async () => {
    const db = seed([task('t1', { time: '10:00', done: true, doneAt: 5, remindAt: tenAm })]);
    const push = mockPush();

    await runTick({ db, sendNotification: push.send, now: () => tenAm + 1_000 });

    expect(push.send).not.toHaveBeenCalled();
    expect(db.get(`users/${UID}/tasks/t1`)?.remindAt).toBeNull();
  });

  it('honors per-task reminder overrides (offset before the task time)', async () => {
    const db = seed([task('t1', { title: 'Dentist', time: '10:00', reminder: { kind: 'offset', minutes: 30 } })]);
    const push = mockPush();
    const at = tenAm - 30 * 60_000;
    expect(db.get(`users/${UID}/tasks/t1`)?.remindAt).toBe(at);

    await runTick({ db, sendNotification: push.send, now: () => at + 10_000 });

    expect(push.sent[0]?.payload).toMatchObject({ title: 'Dentist', body: 'Today at 10:00 AM' });
  });

  it('never double-sends when two ticks overlap (conditional claim on remindAt)', async () => {
    const db = seed([task('t1', { time: '10:00' }), task('t2', { time: '10:00', order: 'a1' })], {
      summary: { enabled: false, time: '08:00' },
    });
    const push = mockPush();
    const now = (): number => tenAm + 2_000;

    const [a, b] = await Promise.all([
      runTick({ db, sendNotification: push.send, now }),
      runTick({ db, sendNotification: push.send, now }),
    ]);

    // 2 tasks × 2 devices, each exactly once.
    expect(push.sent).toHaveLength(4);
    const keys = push.sent.map((s) => `${s.payload.tag}|${s.endpoint}`);
    expect(new Set(keys).size).toBe(4);
    expect(a.remindersSent + b.remindersSent).toBe(2);
    expect(a.claimsLost + b.claimsLost).toBe(2);
  });

  it('lets a concurrent client edit win; the reminder goes out on the next tick', async () => {
    const db = seed([task('t1', { time: '10:00' })]);
    const push = mockPush();
    let edited = false;
    db.beforeUpdate = (path) => {
      if (!edited && path.endsWith('/t1')) {
        edited = true;
        db.patch(path, { title: 'Renamed', updatedAt: 2 }); // client rename lands between read and claim
      }
    };

    const first = await runTick({ db, sendNotification: push.send, now: () => tenAm + 1_000 });
    expect(first.claimsLost).toBe(1);
    expect(push.send).not.toHaveBeenCalled();

    const second = await runTick({ db, sendNotification: push.send, now: () => tenAm + 61_000 });
    expect(second.remindersSent).toBe(1);
    expect(push.sent[0]?.payload.title).toBe('Renamed');
    expect(db.get(`users/${UID}/tasks/t1`)?.remindAt).toBeNull();
  });

  it('prunes devices whose subscription is gone (404/410) and keeps them on transient errors', async () => {
    const db = seed([task('t1', { time: '10:00' })], {
      devices: ['https://push.example/gone', 'https://push.example/missing', 'https://push.example/flaky', 'https://push.example/ok'],
    });
    const push = mockPush({ 'https://push.example/gone': 410, 'https://push.example/missing': 404, 'https://push.example/flaky': 503 });

    const result = await runTick({ db, sendNotification: push.send, now: () => tenAm });

    expect(result).toMatchObject({ devicesPruned: 2, pushesDelivered: 1, errors: 1, remindersSent: 1 });
    expect(db.has(`users/${UID}/devices/d1`)).toBe(false);
    expect(db.has(`users/${UID}/devices/d2`)).toBe(false);
    expect(db.has(`users/${UID}/devices/d3`)).toBe(true);
    expect(db.has(`users/${UID}/devices/d4`)).toBe(true);
  });

  it('sends once per endpoint even when the same browser registered twice, and skips malformed devices', async () => {
    const db = seed([task('t1', { time: '10:00' })], { devices: ['https://push.example/same', 'https://push.example/same'] });
    db.set(`users/${UID}/devices/bad`, { subscription: { endpoint: 'http://insecure', keys: {} } });
    const push = mockPush();

    await runTick({ db, sendNotification: push.send, now: () => tenAm });

    expect(push.sent).toHaveLength(1);
  });

  it('advances reminders for users without devices without reading their open tasks', async () => {
    const db = seed([task('t1', { time: '10:00' })], { devices: [], sweptAt: tenAm - 60_000 });
    const push = mockPush();

    await runTick({ db, sendNotification: push.send, now: () => tenAm });

    expect(push.send).not.toHaveBeenCalled();
    expect(db.get(`users/${UID}/tasks/t1`)?.remindAt).toBeNull();
    expect(db.reads).not.toContain(`collection(users/${UID}/tasks) where done == false`);
  });

  it('badge counts today’s open tasks plus overdue one-time tasks', async () => {
    const db = seed([
      task('t1', { time: '10:00' }),
      task('t2', { order: 'a1' }),
      task('old', { date: '2026-11-17' }),
      task('done', { done: true, doneAt: 3 }),
      task('inbox', { date: null }),
    ]);
    const push = mockPush();

    await runTick({ db, sendNotification: push.send, now: () => tenAm });

    expect(push.sent[0]?.payload.badge).toBe(3);
  });
});

describe('runTick — morning summary', () => {
  const eightAm = zonedInstant(TODAY, '08:00', TZ);

  it('sends today’s summary with the badge and schedules tomorrow’s', async () => {
    const db = seed(
      [
        task('a', { title: 'Finish report' }),
        task('b', { title: 'Gym', order: 'a1' }),
        task('late', { title: 'Old thing', date: '2026-11-16' }),
        task('tmrw', { date: '2026-11-20' }),
      ],
      { summaryAt: eightAm },
    );
    const push = mockPush();

    const result = await runTick({ db, sendNotification: push.send, now: () => eightAm + 20_000 });

    expect(result.summariesSent).toBe(1);
    expect(push.sent).toHaveLength(2);
    expect(push.sent[0]?.payload).toEqual({
      title: 'Today · 2 tasks',
      body: 'Finish report, Gym · 1 overdue',
      badge: 3,
      tag: 'summary-2026-11-19',
      url: '/',
    });
    expect(push.sent[0]?.options).toMatchObject({ urgency: 'normal', topic: 'summary', TTL: 12 * 3600 });
    expect(db.get(`users/${UID}`)?.summaryAt).toBe(zonedInstant('2026-11-20', '08:00', TZ));
  });

  it('clears summaryAt without sending when the summary is disabled', async () => {
    const db = seed([task('a')], { summaryAt: eightAm, summary: { enabled: false, time: '08:00' } });
    const push = mockPush();

    await runTick({ db, sendNotification: push.send, now: () => eightAm + 1_000 });

    expect(push.send).not.toHaveBeenCalled();
    expect(db.get(`users/${UID}`)?.summaryAt).toBeNull();
  });

  it('skips a summary that is more than 15 minutes late but reschedules it', async () => {
    const db = seed([task('a')], { summaryAt: eightAm });
    const push = mockPush();

    const result = await runTick({ db, sendNotification: push.send, now: () => eightAm + STALE_MS + 1 });

    expect(push.send).not.toHaveBeenCalled();
    expect(result.skippedStale).toBe(1);
    expect(db.get(`users/${UID}`)?.summaryAt).toBe(zonedInstant('2026-11-20', '08:00', TZ));
  });

  it('sends exactly one summary when ticks overlap', async () => {
    const db = seed([task('a')], { summaryAt: eightAm, devices: ['https://push.example/only'] });
    const push = mockPush();
    const now = (): number => eightAm + 1_000;

    await Promise.all([runTick({ db, sendNotification: push.send, now }), runTick({ db, sendNotification: push.send, now })]);

    expect(push.sent).toHaveLength(1);
  });

  it('leaves users whose summary is not due alone', async () => {
    const db = seed([task('a')], { summaryAt: eightAm });
    const push = mockPush();

    await runTick({ db, sendNotification: push.send, now: () => eightAm - 1 });

    expect(push.send).not.toHaveBeenCalled();
    expect(db.get(`users/${UID}`)?.summaryAt).toBe(eightAm);
  });
});

describe('reminder text + docs', () => {
  it('describes when the task is', () => {
    expect(reminderBody(task('x', { time: '15:00' }), null, TODAY, TODAY)).toBe('Today at 3:00 PM');
    expect(reminderBody(task('x', { date: '2026-11-20' }), null, '2026-11-20', TODAY)).toBe('Tomorrow');
    expect(reminderBody(task('x', { date: '2026-11-24', time: '09:05' }), null, '2026-11-24', TODAY)).toBe('Tue, Nov 24 at 9:05 AM');
    expect(reminderBody(task('x', { endDate: '2026-11-21' }), null, TODAY, TODAY)).toBe('Today → Nov 21');
    expect(reminderBody(task('x', { date: '2026-11-20', endDate: '2026-11-22' }), null, '2026-11-20', TODAY)).toBe('Nov 20 → 22');
  });

  it('builds deep links the app understands', () => {
    expect(taskUrl('abc', '2026-11-19')).toBe('/?task=abc&occ=2026-11-19');
  });

  it('reads odd documents defensively', () => {
    const t = toTask({ title: 7, date: 'nope', reminder: { kind: 'offset' }, remindAt: '1' }, 'id');
    expect(t).toMatchObject({ id: 'id', title: '', date: null, reminder: { kind: 'default' }, remindAt: null, overrides: {} });
    expect(toTask(undefined, 'id')).toBeNull();
    expect(toSubscription({ subscription: { endpoint: 'https://x/y', keys: { p256dh: 'p', auth: 'a' } } })).toEqual({
      endpoint: 'https://x/y',
      expirationTime: null,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(toSubscription({ subscription: { endpoint: 'https://x/y', keys: { p256dh: 'p' } } })).toBeNull();
  });
});
