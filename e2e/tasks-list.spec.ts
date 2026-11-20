import { test, expect, TODAY } from './fixtures';

test.describe('Tasks list', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
  });

  test('groups follow the calendar: Today, Tomorrow, weekdays, Later', async ({ app }) => {
    await app.seed([
      { title: 'Call mom', date: TODAY },
      { title: 'Gym', date: TODAY, time: '18:00' },
      { title: 'Grocery run', date: '2026-11-20' },
      { title: 'Haircut', date: '2026-11-23' },
      { title: 'Book flights', date: '2026-12-15' },
      { title: 'Unscheduled idea' },
    ]);
    await app.openTasks();
    const ids = await app.sidebar.getByTestId('group').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')));
    expect(ids).toEqual(['today', 'tomorrow', 'day:2026-11-23', 'later']);
    await expect(app.group('today')).toContainText('Today');
    await expect(app.group('today')).toContainText('Thu, Nov 19');
    await expect(app.group('tomorrow')).toContainText('Tomorrow');
    await expect(app.group('day:2026-11-23')).toContainText('Monday');
    await expect(app.row('Gym')).toContainText('6:00 PM');
    // Inbox tasks never show in the list; Later starts collapsed.
    await expect(app.row('Unscheduled idea')).toHaveCount(0);
    await expect(app.row('Book flights')).toHaveCount(0);
    await app.press(app.group('later').getByTestId('group-toggle'));
    await expect(app.row('Book flights')).toBeVisible();
    await expect(app.row('Book flights')).toContainText('Dec 15');
  });

  test('checking a row removes the card from the calendar; the toast Undo brings it back', async ({ app }) => {
    await app.seed([
      { title: 'Finish report', date: TODAY },
      { title: 'Call mom', date: TODAY },
    ]);
    await expect(app.card(TODAY, 'Finish report')).toBeVisible();
    await app.openTasks();
    await app.checkOff('Finish report');

    await expect(app.row('Finish report')).toHaveCount(0);
    await expect(app.toast.filter({ hasText: 'Task completed' })).toBeVisible();
    expect((await app.task('Finish report'))?.done).toBe(true);
    await app.closeTasks();
    await expect(app.card(TODAY, 'Finish report')).toHaveCount(0);
    await expect(app.card(TODAY, 'Call mom')).toBeVisible();

    await app.undoFromToast();
    await expect(app.card(TODAY, 'Finish report')).toBeVisible();
    expect((await app.task('Finish report'))?.done).toBe(false);
    await app.openTasks();
    await expect(app.row('Finish report')).toBeVisible();
  });

  test('Completed keeps checked tasks; unchecking restores them', async ({ app }) => {
    await app.seed([{ title: 'Pay invoice', date: '2026-11-20' }]);
    await app.openTasks();
    await app.checkOff('Pay invoice');
    await expect(app.row('Pay invoice')).toHaveCount(0);

    const completed = app.group('completed');
    await expect(completed).toBeVisible();
    await app.press(completed.getByTestId('group-toggle'));
    const done = completed.getByTestId('list-row').filter({ hasText: 'Pay invoice' });
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute('data-checked', 'true');

    await app.press(done.getByTestId('list-checkbox'));
    await expect(app.group('tomorrow').getByTestId('list-row').filter({ hasText: 'Pay invoice' })).toBeVisible();
    await expect(completed).toHaveCount(0);
    expect((await app.task('Pay invoice'))?.done).toBe(false);
    await app.closeTasks();
    await expect(app.card('2026-11-20', 'Pay invoice')).toBeVisible();
  });

  test('overdue: red tint, Overdue group on top, Move all to today with one Undo', async ({ app }) => {
    await app.seed([
      { title: 'Pay rent', date: '2026-11-12' },
      { title: 'Renew passport', date: '2026-11-16', time: '15:00' },
      { title: 'Due today', date: TODAY },
    ]);
    await expect(app.card('2026-11-12', 'Pay rent')).toHaveAttribute('data-overdue', 'true');
    await expect(app.card('2026-11-16', 'Renew passport')).toHaveAttribute('data-overdue', 'true');
    await expect(app.card(TODAY, 'Due today')).toHaveAttribute('data-overdue', 'false');
    // Phone: the ☰ shows a red dot while something is overdue.
    const menu = app.calendar.getByTestId('drawer-toggle');
    if (app.phone) await expect(menu).toHaveAttribute('data-dot', 'true');

    await app.openTasks();
    const groups = await app.sidebar.getByTestId('group').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')));
    expect(groups[0]).toBe('overdue');
    const overdue = app.group('overdue');
    await expect(overdue).toContainText('Overdue');
    await expect(overdue.getByTestId('list-row')).toHaveCount(2);
    await expect(app.row('Pay rent')).toContainText('Nov 12');

    await app.press(overdue.getByTestId('overdue-move-all'));
    await expect(app.toast.filter({ hasText: 'Moved 2 tasks to today' })).toBeVisible();
    await expect(app.group('overdue')).toHaveCount(0);
    await expect(app.group('today').getByTestId('list-row')).toHaveCount(3);
    await app.closeTasks();
    if (app.phone) await expect(menu).not.toHaveAttribute('data-dot', 'true');
    expect((await app.cardTitles(TODAY)).sort()).toEqual(['Due today', 'Pay rent', 'Renew passport']);
    await expect(app.cards(TODAY).first()).toHaveAttribute('data-overdue', 'false');

    // One undo puts both back.
    await app.undoFromToast();
    await expect(app.card('2026-11-12', 'Pay rent')).toHaveAttribute('data-overdue', 'true');
    await expect(app.card('2026-11-16', 'Renew passport')).toBeVisible();
    await app.openTasks();
    await expect(app.group('overdue').getByTestId('list-row')).toHaveCount(2);
  });
});
