/**
 * Regressions for the "surfaces" review fixes (peek / pickers / quick add / pwa / app shell).
 * Each test drives the real UI; seeding goes through the DEV store hook only.
 */
import { test, expect, TODAY, type App } from './fixtures';

/** Store actions the DEV hook exposes beyond the typed fixture subset. */
interface MoreActions {
  deleteOccurrence(ref: { taskId: string; origDate: string | null }): void;
  closeComposer(): void;
}

const QUICKADD_DAY = '2026-11-25';

/** Phone: tap the empty date strip of a day → the quick-add sheet, field focused. */
async function openQuickAdd(app: App, date = QUICKADD_DAY) {
  const cell = app.cell(date);
  await cell.scrollIntoViewIfNeeded();
  const box = (await cell.boundingBox())!;
  await app.page.touchscreen.tap(box.x + box.width / 2, box.y + 8);
  const sheet = app.page.getByTestId('quickadd');
  await expect(sheet).toBeVisible();
  await app.settle();
  const input = sheet.getByTestId('quickadd-input');
  await expect(input).toBeFocused();
  return { sheet, input };
}

test.describe('Phone quick add never drops a typed task (C2/E2)', () => {
  test.beforeEach(async ({ app }) => {
    test.skip(!app.phone, 'quick-add sheet is the phone composer');
    await app.goto();
  });

  test('tapping the dimmed calendar saves it, with a toast', async ({ app, page }) => {
    const { sheet, input } = await openQuickAdd(app);
    await input.fill('Call the dentist');
    await page.touchscreen.tap(195, 120); // the backdrop above the sheet
    await expect(sheet).toBeHidden();
    await expect(app.card(QUICKADD_DAY, 'Call the dentist')).toHaveCount(1);
    await expect(app.toast.filter({ hasText: 'Added to Wed, Nov 25' })).toBeVisible();
  });

  test('✕ saves it too, and the toast’s Undo removes it again', async ({ app, page }) => {
    const { sheet, input } = await openQuickAdd(app);
    await input.fill('Pick up dry cleaning');
    await sheet.getByTestId('quickadd-close').tap();
    await expect(sheet).toBeHidden();
    await expect(app.card(QUICKADD_DAY, 'Pick up dry cleaning')).toHaveCount(1);
    await app.press(app.toast.filter({ hasText: 'Added to Wed, Nov 25' }).getByTestId('toast-action'));
    await expect(app.card(QUICKADD_DAY, 'Pick up dry cleaning')).toHaveCount(0);
    expect(await app.task('Pick up dry cleaning')).toBeUndefined();
    await expect(page.getByTestId('toast').filter({ hasText: 'Task deleted' })).toBeVisible();
  });

  test('swiping the sheet down saves it', async ({ app }) => {
    const { sheet, input } = await openQuickAdd(app);
    await input.fill('Book the vet');
    const handle = sheet.locator('[data-sheet-handle]');
    const b = (await handle.boundingBox())!;
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await app.swipe(from, { x: from.x, y: from.y + 360 }, 12);
    await expect(sheet).toBeHidden();
    await expect(app.card(QUICKADD_DAY, 'Book the vet')).toHaveCount(1);
  });

  test('closed from elsewhere (store) still saves it', async ({ app, page }) => {
    const { sheet, input } = await openQuickAdd(app);
    await input.fill('Renew library card');
    await page.evaluate(() => (window.__cal!.actions as unknown as MoreActions).closeComposer());
    await expect(sheet).toBeHidden();
    await expect(app.card(QUICKADD_DAY, 'Renew library card')).toHaveCount(1);
  });

  test('Enter-added tasks are not created twice on close; blank text adds nothing', async ({ app, page }) => {
    const { sheet, input } = await openQuickAdd(app);
    await input.fill('Order printer ink');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await input.fill('   ');
    await page.touchscreen.tap(195, 120);
    await expect(sheet).toBeHidden();
    await app.settle();
    expect((await app.tasks()).map((t) => t.title)).toEqual(['Order printer ink']);
    await expect(app.toast).toHaveCount(0);
  });
});

test.describe('Install hint steps aside for the Tasks drawer (C5)', () => {
  test.use({ keepInstallHint: true });

  test('hidden while the drawer is open, back when it closes', async ({ app, page }) => {
    test.skip(!app.phone, 'iOS Safari only');
    await app.goto();
    await app.seed([{ title: 'First task today', date: TODAY }]);
    const hint = page.getByTestId('install-hint');
    await expect(hint).toBeVisible({ timeout: 5000 });
    await app.openTasks();
    await expect(hint).toBeHidden();
    const header = app.page.getByTestId('drawer').locator('[data-testid="group"][data-group-id="today"]');
    await expect(header).toBeVisible();
    // Nothing paints over the Today group header any more.
    const covered = await header.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + 30, r.top + 10)?.closest('[data-testid="install-hint"]') !== null;
    });
    expect(covered).toBe(false);
    await app.closeTasks();
    await expect(hint).toBeVisible();
  });
});

test.describe('Cold-start notification link (C7)', () => {
  test('a link to a deleted occurrence of an existing series explains itself', async ({ app, page }) => {
    await app.goto();
    const [id] = await app.seed([{ title: 'Weekly review', date: TODAY, recurrence: { freq: 'weekly', interval: 1 } }]);
    await page.evaluate((taskId) => {
      (window.__cal!.actions as unknown as MoreActions).deleteOccurrence({ taskId, origDate: '2026-11-26' });
    }, id!);
    await page.waitForTimeout(300); // persisted
    await app.goto(`/?task=${id}&occ=2026-11-26`);
    await expect(app.toast.filter({ hasText: 'That task no longer exists' })).toBeVisible();
    await expect(app.peek).toBeHidden();
    expect(new URL(page.url()).search).toBe('');
  });
});

test.describe('Repeat changes keep planned occurrences (B2)', () => {
  const WEEKLY_THU = { freq: 'weekly' as const, interval: 1, byWeekday: [4] };

  test.beforeEach(async ({ app }) => {
    await app.goto();
    await app.seed([{ title: 'Team sync', date: '2026-11-05', recurrence: WEEKLY_THU }]);
  });

  test('custom panel: weeks → months → weeks changes nothing', async ({ app, page }) => {
    await app.openPeek(app.card('2026-12-03', 'Team sync'));
    await app.press(app.peek.getByTestId('peek-repeat'));
    await app.settle(200);
    await app.press(page.getByTestId('repeat-custom'));
    const unit = page.getByTestId('repeat-freq');
    await expect(unit).toBeVisible();
    await unit.selectOption('monthly');
    await expect(page.getByTestId('repeat-summary')).toHaveText('Every month on the 3rd');
    await unit.selectOption('weekly');
    await app.press(page.getByTestId('repeat-custom-done'));
    await app.settle();
    const t = await app.task('Team sync');
    expect(t?.date).toBe('2026-11-05');
    expect(t?.recurrence).toMatchObject(WEEKLY_THU);
    await app.closePeek();
    await expect(app.card(TODAY, 'Team sync')).toHaveCount(1);
    await expect(app.card('2026-11-26', 'Team sync')).toHaveCount(1);
  });

  test('presets: "monthly" then back to "weekly" restores today’s occurrence', async ({ app, page }) => {
    await app.openPeek(app.card('2026-12-03', 'Team sync'));
    await app.press(app.peek.getByTestId('peek-repeat'));
    await app.settle(200);
    await app.press(page.getByTestId('repeat-monthly'));
    await expect(app.peek.getByTestId('peek-repeat')).toHaveText('Every month on the 3rd');
    await app.settle();
    await app.press(app.peek.getByTestId('peek-repeat'));
    await app.settle(200);
    await app.press(page.getByTestId('repeat-weekly'));
    await expect(app.peek.getByTestId('peek-repeat')).toHaveText('Every week on Thursday');
    expect((await app.task('Team sync'))?.date).toBe('2026-11-05');
    await app.closePeek();
    await expect(app.card(TODAY, 'Team sync')).toHaveCount(1);
    await expect(app.card('2026-11-26', 'Team sync')).toHaveCount(1);
    await app.openTasks();
    await expect(app.group('today')).toContainText('Team sync');
  });
});
