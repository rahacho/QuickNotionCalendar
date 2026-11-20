import { test, expect, TODAY } from './fixtures';

test.describe('Deep links, day rollover, settings', () => {
  test('?task=ID&occ=DATE opens that occurrence, then the URL is cleaned', async ({ app, page }) => {
    await app.goto();
    const [id] = await app.seed([{ title: 'Weekly review', date: TODAY, recurrence: { freq: 'weekly', interval: 1 } }]);
    await page.waitForTimeout(300); // persisted
    await app.goto(`/?task=${id}&occ=2026-11-26`);
    await expect(app.peek).toBeVisible();
    await expect(app.peek.getByTestId('peek-title')).toHaveValue('Weekly review');
    await expect(app.peek.getByTestId('peek-date')).toHaveText('November 26, 2026');
    expect(new URL(page.url()).search).toBe('');
  });

  test('a link to a task that no longer exists explains itself', async ({ app, page }) => {
    await app.goto('/?task=doesnotexist&occ=2026-11-26');
    await expect(app.toast.filter({ hasText: 'That task no longer exists' })).toBeVisible({ timeout: 10_000 });
    await expect(app.peek).toBeHidden();
    expect(new URL(page.url()).search).toBe('');
  });

  test('at midnight "today" rolls over: marker moves, yesterday\'s open task turns overdue', async ({ app, page }) => {
    await app.goto();
    await app.seed([{ title: 'Unfinished', date: TODAY }]);
    await expect(app.card(TODAY, 'Unfinished')).toHaveAttribute('data-overdue', 'false');
    await page.clock.fastForward('14:00:30'); // 10:00 → 00:00:30 next day
    await expect(app.cell('2026-11-20')).toHaveAttribute('data-today', 'true');
    await expect(app.cell(TODAY)).not.toHaveAttribute('data-today', 'true');
    await expect(app.card(TODAY, 'Unfinished')).toHaveAttribute('data-overdue', 'true');
    await app.openTasks();
    await expect(app.group('overdue')).toContainText('Unfinished');
  });

  test('week start can be Sunday', async ({ app, page }) => {
    await app.goto();
    await app.openTasks();
    await app.press(page.getByTestId('settings-open'));
    const settings = page.getByTestId('settings-modal');
    await expect(settings).toBeVisible();
    await page.getByTestId('weekstart-select').selectOption('0');
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await app.closeTasks();
    // Sun Nov 15 now starts the row that holds Thu Nov 19.
    const sun = (await app.cell('2026-11-15').boundingBox())!;
    const thu = (await app.cell(TODAY).boundingBox())!;
    expect(Math.abs(sun.y - thu.y)).toBeLessThan(1);
    expect(sun.x).toBeLessThan(thu.x);
    await expect(app.title).toHaveText('November 2026');
  });
});
