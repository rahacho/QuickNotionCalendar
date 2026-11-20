import { test, expect, TODAY } from './fixtures';

test.describe('Task peek', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
  });

  test('rename applies to the card and the list', async ({ app, page }) => {
    await app.seed([{ title: 'Write report', date: TODAY }]);
    await app.openPeek(app.card(TODAY, 'Write report'));
    const title = app.peek.getByTestId('peek-title');
    await expect(title).toHaveValue('Write report');
    await app.press(title);
    await title.fill('Write the Q4 report');
    await title.press('Enter'); // Enter ends editing (single-line title)
    await expect(title).not.toBeFocused();
    await expect.poll(async () => (await app.tasks())[0]?.title).toBe('Write the Q4 report');
    await app.closePeek();
    await expect(app.card(TODAY, 'Write the Q4 report')).toBeVisible();
    await app.openTasks();
    await expect(app.row('Write the Q4 report')).toBeVisible();

    // Clearing the title reverts to the last saved one (a task always has a name).
    await app.closeTasks();
    await app.openPeek(app.card(TODAY, 'Write the Q4 report'));
    await app.press(title);
    await title.fill('');
    await page.keyboard.press('Enter');
    await expect(title).toHaveValue('Write the Q4 report');
  });

  test('date picker: pick a day, a range, a time', async ({ app, page }) => {
    await app.seed([{ title: 'Dentist', date: TODAY }]);
    await app.openPeek(app.card(TODAY, 'Dentist'));
    const date = app.peek.getByTestId('peek-date');
    await expect(date).toHaveText('November 19, 2026');

    await app.press(date);
    const picker = page.getByTestId('date-picker');
    await expect(picker).toBeVisible();
    await app.settle();

    // Click a day in the mini month.
    await app.press(picker.locator('[data-testid="mini-day"][data-day="2026-11-23"]'));
    await expect(date).toHaveText('November 23, 2026');
    expect((await app.task('Dentist'))?.date).toBe('2026-11-23');

    // Typed start date.
    const start = picker.getByTestId('date-start-input');
    await start.fill('Nov 24');
    await start.press('Enter');
    await expect(date).toHaveText('November 24, 2026');

    // Range: End date on → next click sets the end.
    await app.press(picker.getByTestId('date-end-toggle'));
    await expect(picker.getByTestId('date-end-input')).toBeVisible();
    await app.press(picker.locator('[data-testid="mini-day"][data-day="2026-11-26"]'));
    await expect(date).toHaveText('Nov 24, 2026 → Nov 26, 2026');
    let t = await app.task('Dentist');
    expect([t?.date, t?.endDate]).toEqual(['2026-11-24', '2026-11-26']);
    // Multi-day tasks can't repeat.
    await expect(app.peek.getByTestId('peek-repeat')).toHaveAttribute('aria-disabled', 'true');

    // Back to a single day, then include a time.
    await app.press(picker.getByTestId('date-end-toggle'));
    await expect.poll(async () => (await app.task('Dentist'))?.endDate).toBeNull();
    await app.press(picker.getByTestId('date-time-toggle'));
    const time = picker.getByTestId('date-time-input');
    await expect(time).toBeVisible();
    await time.fill('3:30pm');
    await time.press('Enter');
    await expect.poll(async () => (await app.task('Dentist'))?.time).toBe('15:30');
    await expect(date).toHaveText('November 24, 2026 3:30 PM');

    // Close the picker (Esc on desktop, Done on the phone sheet); the peek stays.
    if (app.phone) await app.press(picker.getByTestId('date-picker-done'));
    else await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(app.peek).toBeVisible();
    await app.closePeek();

    // The card moved and shows its time.
    const card = app.card('2026-11-24', 'Dentist');
    await expect(card).toBeVisible();
    await expect(card).toContainText('3:30 PM');
    t = await app.task('Dentist');
    expect([t?.date, t?.endDate, t?.time]).toEqual(['2026-11-24', null, '15:30']);
  });

  test('repeat weekly shows every week; reminder can be set', async ({ app, page }) => {
    await app.seed([{ title: 'Team sync', date: TODAY, time: '09:30' }]);
    await app.openPeek(app.card(TODAY, 'Team sync'));

    await app.press(app.peek.getByTestId('peek-repeat'));
    await app.settle(200);
    await app.press(page.getByTestId('repeat-weekly'));
    await expect(app.peek.getByTestId('peek-repeat')).toHaveText('Every week on Thursday');
    const t = await app.task('Team sync');
    expect(t?.recurrence).toMatchObject({ freq: 'weekly', interval: 1, byWeekday: [4] });

    // Remind: a timed task defaults to "At time of task"; choose 10 minutes before.
    const remind = app.peek.getByTestId('peek-remind');
    await expect(remind).toHaveText('At time of task');
    await app.press(remind);
    await app.settle(200);
    await app.press(page.getByTestId('remind-10m'));
    await expect(remind).toHaveText('10 minutes before');
    expect((await app.task('Team sync'))?.reminder).toEqual({ kind: 'offset', minutes: 10 });

    await app.closePeek();
    // Every Thursday on screen carries the card (with its repeat icon).
    for (const d of [TODAY, '2026-11-26', '2026-12-03']) {
      await expect(app.card(d, 'Team sync')).toBeVisible();
    }
    await expect(app.card('2026-11-12', 'Team sync')).toHaveCount(0); // not before the series start
    await expect(app.card('2026-11-26', 'Team sync').getByRole('img', { name: 'Repeats' })).toBeVisible();
  });

  test('Done in the peek completes it, keeps the peek open, and Undo restores', async ({ app }) => {
    await app.seed([{ title: 'Return library book', date: TODAY }]);
    await app.openPeek(app.card(TODAY, 'Return library book'));
    const done = app.peek.getByTestId('peek-done');
    await app.press(done);
    await expect(done).toHaveAttribute('aria-checked', 'true');
    await expect(app.peek).toBeVisible();
    await expect(app.toast.filter({ hasText: 'Task completed' })).toBeVisible();
    await app.closePeek();
    await expect(app.card(TODAY, 'Return library book')).toHaveCount(0);
    await app.undoFromToast();
    await expect(app.card(TODAY, 'Return library book')).toBeVisible();
    expect((await app.task('Return library book'))?.done).toBe(false);
  });

  test('Move to Inbox and Delete (with Undo)', async ({ app }) => {
    await app.seed([{ title: 'Someday task', date: '2026-11-20' }, { title: 'Delete me', date: '2026-11-20' }]);
    await app.openPeek(app.card('2026-11-20', 'Someday task'));
    await app.press(app.peek.getByTestId('peek-move-inbox'));
    await expect.poll(async () => (await app.task('Someday task'))?.date).toBeNull();
    await expect(app.peek.getByTestId('peek-date')).toHaveText(/Empty/);
    await app.closePeek();
    await expect(app.card('2026-11-20', 'Someday task')).toHaveCount(0);
    await app.openInbox();
    await expect(app.bubbles.filter({ hasText: 'Someday task' })).toBeVisible();
    await app.closeInbox();

    await app.openPeek(app.card('2026-11-20', 'Delete me'));
    await app.press(app.peek.getByTestId('peek-delete'));
    await expect(app.peek).toBeHidden();
    await expect(app.toast.filter({ hasText: 'Task deleted' })).toBeVisible();
    await expect(app.card('2026-11-20', 'Delete me')).toHaveCount(0);
    expect(await app.task('Delete me')).toBeUndefined();
    await app.undoFromToast();
    await expect(app.card('2026-11-20', 'Delete me')).toBeVisible();
  });
});
