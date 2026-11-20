import { test, expect, TODAY } from './fixtures';

const WEEKLY = { freq: 'weekly' as const, interval: 1 };

test.describe('Repeating tasks', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
  });

  test('dragging one occurrence moves only that occurrence', async ({ app }) => {
    const [id] = await app.seed([{ title: 'Water plants', date: TODAY, recurrence: WEEKLY }]);
    await app.drag(app.card('2026-11-26', 'Water plants'), app.cell('2026-11-27'));

    await expect(app.card('2026-11-27', 'Water plants')).toBeVisible();
    await expect(app.card('2026-11-26', 'Water plants')).toHaveCount(0);
    await expect(app.card(TODAY, 'Water plants')).toBeVisible();
    await expect(app.card('2026-12-03', 'Water plants')).toBeVisible();
    const t = await app.task('Water plants');
    expect(t?.date).toBe(TODAY); // series start untouched
    expect(t?.overrides['2026-11-26']?.date).toBe('2026-11-27');
    await expect(app.card('2026-11-27', 'Water plants')).toHaveAttribute('data-occ-key', `${id}@2026-11-26`);
  });

  test('checking one occurrence completes only it', async ({ app }) => {
    await app.seed([{ title: 'Stretch', date: TODAY, recurrence: { freq: 'daily', interval: 1 } }]);
    await app.openTasks();
    const todayRow = app.group('today').getByTestId('list-row').filter({ hasText: 'Stretch' });
    await app.press(todayRow.getByTestId('list-checkbox'));
    await expect(app.group('today')).toHaveCount(0);
    await expect(app.group('tomorrow').getByTestId('list-row').filter({ hasText: 'Stretch' })).toBeVisible();
    await app.closeTasks();

    await expect(app.card(TODAY, 'Stretch')).toHaveCount(0);
    await expect(app.card('2026-11-20', 'Stretch')).toBeVisible();
    const t = await app.task('Stretch');
    expect(t?.overrides[TODAY]?.done).toBe(true);
    expect(t?.done).toBe(false);
  });

  test('past occurrences never go overdue', async ({ app }) => {
    await app.seed([
      { title: 'Daily standup', date: '2026-11-10', recurrence: { freq: 'daily', interval: 1 } },
      { title: 'One-off late', date: '2026-11-17' },
    ]);
    await expect(app.card('2026-11-17', 'One-off late')).toHaveAttribute('data-overdue', 'true');
    for (const d of ['2026-11-10', '2026-11-14', '2026-11-18']) {
      await expect(app.card(d, 'Daily standup')).toHaveAttribute('data-overdue', 'false');
    }
    await app.openTasks();
    const overdue = app.group('overdue');
    await expect(overdue.getByTestId('list-row')).toHaveCount(1);
    await expect(overdue).toContainText('One-off late');
    await expect(overdue).not.toContainText('Daily standup');
  });

  test('delete this occurrence vs delete all repeats', async ({ app, page }) => {
    await app.seed([{ title: 'Piano lesson', date: TODAY, recurrence: WEEKLY }]);

    await app.openPeek(app.card('2026-11-26', 'Piano lesson'));
    await app.press(app.peek.getByTestId('peek-delete'));
    await app.press(page.getByTestId('peek-delete-occurrence'));
    await expect(app.peek).toBeHidden();
    await expect(app.card('2026-11-26', 'Piano lesson')).toHaveCount(0);
    await expect(app.card(TODAY, 'Piano lesson')).toBeVisible();
    await expect(app.card('2026-12-03', 'Piano lesson')).toBeVisible();
    expect((await app.task('Piano lesson'))?.overrides['2026-11-26']?.skipped).toBe(true);

    await app.openPeek(app.card('2026-12-03', 'Piano lesson'));
    await app.press(app.peek.getByTestId('peek-delete'));
    await app.press(page.getByTestId('peek-delete-all'));
    await expect(app.peek).toBeHidden();
    await expect(app.calendar.getByTestId('task-card').filter({ hasText: 'Piano lesson' })).toHaveCount(0);
    expect(await app.task('Piano lesson')).toBeUndefined();

    // Undo restores the whole series (with its skipped occurrence still skipped).
    await app.undoFromToast();
    await expect(app.card(TODAY, 'Piano lesson')).toBeVisible();
    await expect(app.card('2026-12-03', 'Piano lesson')).toBeVisible();
    await expect(app.card('2026-11-26', 'Piano lesson')).toHaveCount(0);
  });

  test('a title edit renames every occurrence', async ({ app }) => {
    await app.seed([{ title: 'Gym', date: TODAY, recurrence: WEEKLY }]);
    await app.openPeek(app.card('2026-11-26', 'Gym'));
    const title = app.peek.getByTestId('peek-title');
    await app.press(title);
    await title.fill('Gym — legs');
    await title.press('Enter');
    await app.closePeek();
    for (const d of [TODAY, '2026-11-26', '2026-12-03']) await expect(app.card(d, 'Gym — legs')).toBeVisible();
  });
});
