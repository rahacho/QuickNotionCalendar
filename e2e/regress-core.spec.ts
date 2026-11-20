/**
 * Regressions for the "core" review fixes (store / data), driven through the real UI. Seeding goes
 * through the DEV store hook only.
 */
import { test, expect, TODAY } from './fixtures';

test.beforeEach(async ({ app }) => {
  await app.goto();
});

test.describe('Repeat → Never keeps the planned task visible (B1)', () => {
  test("with today's occurrence checked off, tomorrow's card becomes the one-time task", async ({ app, page }) => {
    await app.seed([{ title: 'Gym', date: TODAY, recurrence: { freq: 'daily', interval: 1 } }]);
    await app.openTasks();
    await app.checkOff('Gym');
    await expect(app.toast.filter({ hasText: 'Task completed' })).toBeVisible();
    await app.closeTasks();
    await expect(app.card(TODAY, 'Gym')).toHaveCount(0);

    await app.openPeek(app.card('2026-11-20', 'Gym'));
    await app.press(app.peek.getByTestId('peek-repeat'));
    await app.settle(200);
    await app.press(page.getByTestId('repeat-never'));
    await expect(app.toast.filter({ hasText: 'Repeat removed' })).toBeVisible();
    await app.closePeek();

    await expect(app.card('2026-11-20', 'Gym')).toBeVisible();
    await expect(app.card('2026-11-21', 'Gym')).toHaveCount(0);
    const t = await app.task('Gym');
    expect([t?.date, t?.done, t?.recurrence]).toEqual(['2026-11-20', false, null]);
    await app.openTasks();
    await expect(app.group('tomorrow').getByTestId('list-row').filter({ hasText: 'Gym' })).toBeVisible();
  });
});

test.describe('An overdue task made to repeat stays in Overdue (B5)', () => {
  test('the missed Nov 1 instance keeps its red tint and its Overdue row', async ({ app, page }) => {
    await app.seed([{ title: 'Pay rent', date: '2026-11-01' }]);
    await app.openTasks();
    const overdue = app.group('overdue');
    await expect(overdue.getByTestId('list-row').filter({ hasText: 'Pay rent' })).toBeVisible();
    await app.closeTasks();

    await app.openPeek(app.card('2026-11-01', 'Pay rent'));
    await app.press(app.peek.getByTestId('peek-repeat'));
    await app.settle(200);
    await app.press(page.getByTestId('repeat-monthly'));
    await expect(app.toast.filter({ hasText: 'the Nov 1 one stays in Overdue' })).toBeVisible();
    await app.closePeek();

    await expect(app.card('2026-11-01', 'Pay rent')).toHaveAttribute('data-overdue', 'true');
    await app.openTasks();
    await expect(overdue.getByTestId('list-row').filter({ hasText: 'Pay rent' })).toBeVisible();
    await app.closeTasks();
    await expect(app.card('2026-12-01', 'Pay rent')).toBeVisible();
  });
});

test.describe('⌘Z says what it undid (E5)', () => {
  test.beforeEach(({ app }) => {
    test.skip(app.phone, 'keyboard shortcut');
  });

  test('⌘Z after a rename reverts the rename, never the task added before it', async ({ app, page }) => {
    await app.seed([{ title: 'Call dentist', date: '2026-11-20' }]);
    await app.addToInbox('Buy milk');
    await app.openPeek(app.card('2026-11-20', 'Call dentist'));
    const title = app.peek.getByTestId('peek-title');
    await title.fill('Call dentist about crown');
    await title.press('Enter');
    await app.closePeek();
    await expect(app.card('2026-11-20', 'Call dentist about crown')).toBeVisible();

    await page.locator('body').click({ position: { x: 700, y: 20 } });
    await app.key('ControlOrMeta+z');
    await expect(app.toast.filter({ hasText: 'Undid: renamed “Call dentist”' })).toBeVisible();
    await expect(app.card('2026-11-20', 'Call dentist')).toHaveText(/^Call dentist$/);
    await expect(app.bubbles.filter({ hasText: 'Buy milk' })).toHaveCount(1);

    // A second ⌘Z removes the Inbox task — visibly, with Redo.
    await app.key('ControlOrMeta+z');
    await expect(app.toast.filter({ hasText: 'Undid: added “Buy milk”' })).toBeVisible();
    await expect(app.bubbles.filter({ hasText: 'Buy milk' })).toHaveCount(0);
    await app.undoFromToast(); // the newest toast's action: Redo
    await expect(app.bubbles.filter({ hasText: 'Buy milk' })).toHaveCount(1);
  });
});

test.describe('Completed: every completion stays reachable (E7)', () => {
  test('"Show more" lists an old completion so it can be unchecked', async ({ app, page }) => {
    // Setup through the DEV hook (it exposes every store action; the fixture types only a few).
    const complete = (list: string[]) =>
      page.evaluate((ids) => {
        const a = window.__cal!.actions as unknown as { setDone(ref: { taskId: string; origDate: null }, d: boolean): void };
        for (const id of ids) a.setDone({ taskId: id, origDate: null }, true);
      }, list);
    await complete(await app.seed([{ title: 'Accidentally checked', date: '2026-11-20' }]));
    await page.clock.fastForward(60_000);
    await complete(await app.seed(Array.from({ length: 50 }, (_, i) => ({ title: `Done ${i + 1}`, date: '2026-11-21' }))));
    await app.openTasks();
    const completed = app.group('completed');
    await app.press(completed.getByTestId('group-toggle'));
    await expect(completed).toContainText('Showing the latest 50 of 51');
    const row = completed.getByTestId('list-row').filter({ hasText: 'Accidentally checked' });
    await expect(row).toHaveCount(0);
    await app.press(completed.getByTestId('completed-show-more'));
    await expect(row).toBeVisible();
    await expect(completed.getByTestId('completed-show-more')).toHaveCount(0);
    await app.press(row.getByTestId('list-checkbox'));
    await expect.poll(async () => (await app.task('Accidentally checked'))?.done).toBe(false);
  });
});

test.describe('A repeating task can get one time for every repeat (B6)', () => {
  test('“Use 9:00 AM for every repeat” times the whole series, with Undo', async ({ app, page }) => {
    await app.seed([{ title: 'Gym', date: TODAY, recurrence: { freq: 'daily', interval: 1 } }]);
    await app.openPeek(app.card('2026-11-20', 'Gym'));
    await app.press(app.peek.getByTestId('peek-date'));
    const picker = page.getByTestId('date-picker');
    await expect(picker).toBeVisible();
    await app.press(picker.getByTestId('date-time-toggle'));
    await expect.poll(async () => (await app.task('Gym'))?.overrides['2026-11-20']?.time).toBe('09:00');
    const all = picker.getByTestId('date-series-time');
    await expect(all).toHaveText('Use 9:00 AM for every repeat');
    await app.press(all);
    await expect(app.toast.filter({ hasText: 'Every repeat is at 9:00 AM now' })).toBeVisible();
    await expect.poll(async () => (await app.task('Gym'))?.time).toBe('09:00');
    await expect(all).toHaveCount(0);
    if (app.phone) await app.press(picker.getByTestId('date-picker-done'));
    else await page.keyboard.press('Escape');
    await app.closePeek();
    await expect(app.card('2026-11-23', 'Gym')).toContainText('9:00 AM');
    await app.undoFromToast();
    await expect.poll(async () => (await app.task('Gym'))?.time).toBeNull();
  });
});

test.describe('Unscheduling to the Inbox offers Undo (C4)', () => {
  test('peek → Move to Inbox: "Moved to Inbox · Undo" puts date and time back', async ({ app }) => {
    await app.seed([{ title: 'Dentist', date: '2026-11-20', time: '15:00' }]);
    await app.openPeek(app.card('2026-11-20', 'Dentist'));
    await app.press(app.peek.getByTestId('peek-move-inbox'));
    await expect(app.toast.filter({ hasText: 'Moved to Inbox' })).toBeVisible();
    await expect.poll(async () => (await app.task('Dentist'))?.date).toBeNull();
    await app.closePeek();
    await app.undoFromToast();
    await expect.poll(async () => {
      const t = await app.task('Dentist');
      return [t?.date, t?.time];
    }).toEqual(['2026-11-20', '15:00']);
    await expect(app.card('2026-11-20', 'Dentist')).toBeVisible();
  });
});

test.describe('Toasts wait for keyboard users (D10)', () => {
  test.beforeEach(({ app }) => {
    test.skip(app.phone, 'keyboard focus');
  });

  test('a focused Undo keeps its toast; the live region announces it', async ({ app, page }) => {
    await app.seed([{ title: 'Keep me', date: '2026-11-20' }]);
    await app.openPeek(app.card('2026-11-20', 'Keep me'));
    await app.press(app.peek.getByTestId('peek-delete'));
    const toast = app.toast.filter({ hasText: 'Task deleted' });
    await expect(toast).toBeVisible();
    await expect(page.getByTestId('toast-live')).toContainText('Task deleted');
    // The store's toast list (fast-forwarding the fake clock stalls motion's exit animation, so the
    // DOM node can linger after a dismissal; the store says what the timer did).
    const queued = () =>
      page.evaluate(() =>
        (window.__cal!.state() as unknown as { toasts: Array<{ message: string }> }).toasts.map((t) => t.message),
      );
    await toast.getByTestId('toast-action').focus();
    await expect(toast).toHaveAttribute('data-paused', 'focus');
    await page.clock.fastForward(8_000);
    expect(await queued()).toContain('Task deleted');
    await toast.getByTestId('toast-action').evaluate((el) => (el as HTMLElement).blur());
    await expect(toast).not.toHaveAttribute('data-paused', /.+/);
    await page.clock.fastForward(6_000);
    await expect.poll(queued).not.toContain('Task deleted');
  });
});

test.describe('Touch targets in the phone peek (D5)', () => {
  test.beforeEach(({ app }) => {
    test.skip(!app.phone, 'coarse pointer');
  });

  test('⋯ and ✕ are at least 40×44 and never take each other’s taps', async ({ app, page }) => {
    await app.seed([{ title: 'Tap targets', date: '2026-11-20' }]);
    await app.openPeek(app.card('2026-11-20', 'Tap targets'));
    const menu = app.peek.getByTestId('peek-menu');
    const close = app.peek.getByTestId('peek-close');
    const m = (await menu.boundingBox())!;
    const c = (await close.boundingBox())!;
    expect(Math.min(m.width, m.height, c.width, c.height)).toBeGreaterThanOrEqual(40);
    const hit = (x: number, y: number) =>
      page.evaluate(([px, py]) => document.elementFromPoint(px as number, py as number)?.closest('button')?.getAttribute('data-testid') ?? null, [x, y]);
    // Extended above and below (44px tall)…
    expect(await hit(m.x + m.width / 2, m.y - 1)).toBe('peek-menu');
    expect(await hit(c.x + c.width / 2, c.y + c.height + 1)).toBe('peek-close');
    // …but each keeps its own edge next to the other.
    expect(await hit(m.x + m.width - 1, m.y + m.height / 2)).toBe('peek-menu');
    expect(await hit(c.x + 1, c.y + c.height / 2)).toBe('peek-close');
  });
});
