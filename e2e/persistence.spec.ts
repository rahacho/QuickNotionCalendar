import { test, expect, TODAY, type App } from './fixtures';

async function openSettings(app: App): Promise<void> {
  await app.openTasks();
  await app.press(app.page.getByTestId('settings-open'));
  await expect(app.page.getByTestId('settings-modal')).toBeVisible();
}

test.describe('Persistence, sync and theme', () => {
  test('theme: System / Light / Dark is remembered on this device', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto();
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light'); // System → follows the OS

    await openSettings(app);
    await page.getByTestId('theme-select').selectOption('dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#191919');

    // A fresh load (same device) comes back dark before any interaction, even with a light OS.
    await page.reload();
    await app.ready();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    // System follows the OS live.
    await openSettings(app);
    await page.getByTestId('theme-select').selectOption('system');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('tasks survive a reload', async ({ app, page }) => {
    await app.goto();
    await app.addToInbox('Inbox survivor');
    await app.closeInbox();
    await app.seed([{ title: 'Calendar survivor', date: TODAY, time: '09:00' }]);
    await app.openTasks();
    await app.checkOff('Calendar survivor');
    await expect(app.row('Calendar survivor')).toHaveCount(0);
    await app.closeTasks();

    await page.reload();
    await app.ready();
    await app.openInbox();
    await expect(app.bubbles).toHaveText(['Inbox survivor']);
    await app.closeInbox();
    // Still completed after the reload (not back on the calendar).
    await expect(app.card(TODAY, 'Calendar survivor')).toHaveCount(0);
    expect((await app.task('Calendar survivor'))?.done).toBe(true);
  });

  test('two tabs stay in sync', async ({ app, context }) => {
    await app.goto();
    const other = await context.newPage();
    await other.goto('/');
    await app.ready(other);
    await other.waitForTimeout(300);
    const otherApp = new (app.constructor as typeof App)(other, app.phone);

    // Tab 1 adds to the Inbox → tab 2 shows it.
    await app.addToInbox('From tab one');
    await otherApp.openInbox();
    await expect(otherApp.bubbles).toHaveText(['From tab one']);

    // Tab 2 schedules a task → tab 1's calendar shows it.
    await otherApp.seed([{ title: 'From tab two', date: '2026-11-21' }]);
    await expect(app.card('2026-11-21', 'From tab two')).toBeVisible();

    // Tab 1 completes it → it disappears in tab 2.
    await app.closeInbox();
    await app.openTasks();
    await app.checkOff('From tab two');
    await expect(otherApp.card('2026-11-21', 'From tab two')).toHaveCount(0);
    await other.close();
  });
});
