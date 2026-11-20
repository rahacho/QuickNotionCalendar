import { test, expect, TODAY } from './fixtures';

test.describe('Phone layout', () => {
  test.beforeEach(async ({ app }) => {
    test.skip(!app.phone, 'phone only');
    await app.goto();
  });

  test('full-name compact grid: every task shows its whole name, rows grow', async ({ app }) => {
    const long = 'Finish quarterly report draft and send it to Sarah for review';
    await app.seed([
      { title: long, date: TODAY },
      { title: 'Call mom', date: TODAY },
      { title: 'Gym', date: TODAY, time: '18:00' },
    ]);
    const card = app.card(TODAY, long);
    await expect(card).toHaveAttribute('data-variant', 'compact');
    await expect(card).toHaveText(long);
    // Nothing is clipped: the card is as tall as its wrapped text, and the cell contains every card.
    const fits = await card.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
    expect(fits).toBe(true);
    const cell = (await app.cell(TODAY).boundingBox())!;
    for (const t of [long, 'Call mom', 'Gym']) {
      const b = (await app.card(TODAY, t).boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(cell.y + cell.height + 0.5);
    }
    await expect(app.calendar).not.toContainText('more');
  });

  test('Tasks drawer: ☰ opens it, the backdrop and a left swipe close it, an edge swipe opens it', async ({ app, page }) => {
    const drawer = page.getByTestId('drawer');
    await expect(drawer).toBeHidden();
    await app.calendar.getByTestId('drawer-toggle').tap();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('tasks-sidebar')).toBeVisible();
    await app.settle();

    // Tap the dimmed calendar to the right of the drawer.
    const vw = page.viewportSize()!;
    await page.touchscreen.tap(vw.width - 20, vw.height / 2);
    await expect(drawer).toBeHidden();

    // Edge swipe from the left edge opens it…
    await app.swipe({ x: 4, y: 300 }, { x: 300, y: 305 }, 12);
    await expect(drawer).toBeVisible();
    // …and a swipe to the left closes it.
    await app.swipe({ x: 250, y: 300 }, { x: 20, y: 300 }, 10);
    await expect(drawer).toBeHidden();
  });

  test('Inbox sheet snaps: collapsed → half → full → collapsed; drag the handle; + focuses the input', async ({ app, page }) => {
    await app.seed([{ title: 'One' }, { title: 'Two' }]);
    const sheet = page.getByTestId('inbox-sheet');
    const handle = page.getByTestId('inbox-sheet-handle');
    await expect(sheet).toHaveAttribute('data-snap', 'collapsed');
    await expect(handle).toContainText('Inbox');
    await expect(handle).toContainText('2');
    // Collapsed: only the handle row peeks out above the home indicator.
    const vh = page.viewportSize()!.height;
    const top = async () => (await handle.boundingBox())!.y;
    expect(vh - (await top())).toBeLessThan(80);

    await handle.tap();
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await app.settle(450);
    const halfTop = await top();
    expect(Math.abs(halfTop - vh / 2)).toBeLessThan(40);
    await handle.tap();
    await expect(sheet).toHaveAttribute('data-snap', 'full');
    await app.settle(450);
    expect(await top()).toBeLessThan(halfTop - 100);
    await handle.tap();
    await expect(sheet).toHaveAttribute('data-snap', 'collapsed');
    await app.settle(450);

    // Drag the handle up slowly to around the middle → half; flick it down → collapsed.
    const h = (await handle.boundingBox())!;
    const x = h.x + h.width / 2;
    await page.mouse.move(x, h.y + 10);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(x, h.y + 10 - (i * (h.y - vh / 2)) / 12);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await app.settle(500);
    const h2 = (await handle.boundingBox())!;
    await page.mouse.move(x, h2.y + 10);
    await page.mouse.down();
    await page.mouse.move(x, h2.y + 40, { steps: 2 });
    await page.mouse.move(x, h2.y + 140, { steps: 2 });
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-snap', 'collapsed');
    await app.settle(500);

    // "+" opens to half and focuses the input.
    await page.getByTestId('inbox-sheet-add').tap();
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await expect(app.inboxInput).toBeFocused();
  });

  test('a long-press drag from the drawer closes it, hides the sheet, and drops on a day', async ({ app, page }) => {
    await app.seed([{ title: 'Drag me', date: TODAY }]);
    await app.openInbox();
    const sheet = page.getByTestId('inbox-sheet');
    await app.openTasks();
    await app.drag(app.row('Drag me'), async () => {
      await expect(page.getByTestId('drawer')).toBeHidden();
      await expect(sheet).toHaveAttribute('data-hidden', 'true');
      return app.center(app.cell('2026-11-12'));
    });
    await expect(app.card('2026-11-12', 'Drag me')).toBeVisible();
    expect((await app.task('Drag me'))?.date).toBe('2026-11-12');
    // The sheet comes back to where it was.
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await expect(sheet).not.toHaveAttribute('data-hidden', 'true');
  });

  test('a quick swipe on a card scrolls instead of dragging', async ({ app, page }) => {
    await app.seed([{ title: 'Swipe over me', date: '2026-11-25' }]);
    const c = await app.center(app.card('2026-11-25', 'Swipe over me'));
    await app.swipe(c, { x: c.x, y: c.y - 150 }, 6);
    expect(await app.ui((u) => u.dragging)).toBeNull();
    expect((await app.task('Swipe over me'))?.date).toBe('2026-11-25');
    await expect(page.getByTestId('peek')).toBeHidden();
  });
});

test.describe('Phone landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('landscape phone keeps the phone layout with regular-size cards', async ({ app, page }) => {
    test.skip(!app.phone, 'phone only');
    await app.goto();
    await app.seed([{ title: 'Landscape card', date: TODAY }]);
    await expect(page.getByTestId('inbox-sheet')).toBeVisible(); // phone shell (sheet, no side panels)
    await expect(page.getByTestId('tasks-sidebar')).toBeHidden();
    await expect(app.card(TODAY, 'Landscape card')).toHaveAttribute('data-variant', 'calendar');
    // Only ~2 rows fit: the title still names the month navigated to, not the previous month whose
    // days fill the first row.
    await expect(app.title).toHaveText('November 2026');
    await app.press(page.getByTestId('cal-next'));
    await app.settle(800);
    await expect(app.title).toHaveText('December 2026');
    await app.press(page.getByTestId('cal-prev'));
    await app.settle(800);
    await expect(app.title).toHaveText('November 2026');
  });
});

test.describe('Install hint (iPhone Safari, not installed)', () => {
  test.use({ keepInstallHint: true });

  test('shows "Add to Home Screen" help once and remembers the dismissal', async ({ app, page }) => {
    test.skip(!app.phone, 'iOS Safari only');
    await app.goto();
    const hint = page.getByTestId('install-hint');
    await expect(hint).toBeVisible({ timeout: 5000 });
    await expect(hint).toContainText('Add to Home Screen');
    await hint.getByTestId('install-hint-dismiss').tap();
    await expect(hint).toBeHidden();
    await page.reload();
    await app.ready();
    await page.waitForTimeout(1800);
    await expect(hint).toBeHidden();
  });
});
