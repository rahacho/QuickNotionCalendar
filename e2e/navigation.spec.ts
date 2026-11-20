import { test, expect, TODAY, type App } from './fixtures';

async function chooseView(app: App, view: 'Month' | 'Week'): Promise<void> {
  await app.press(app.page.getByTestId('cal-view'));
  await app.press(app.page.getByRole('menuitemradio', { name: view }));
  await app.settle();
}

test.describe('Calendar navigation', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
  });

  test('opens on the current month with today marked (Monday-first)', async ({ app }) => {
    await expect(app.title).toHaveText('November 2026');
    await expect(app.cell(TODAY)).toHaveAttribute('data-today', 'true');
    await expect(app.cell(TODAY)).toBeInViewport();
    // Monday-first grid: Nov 16 (Mon) .. Nov 22 (Sun) share a row.
    const mon = (await app.cell('2026-11-16').boundingBox())!;
    const sun = (await app.cell('2026-11-22').boundingBox())!;
    expect(Math.abs(mon.y - sun.y)).toBeLessThan(1);
    expect(sun.x).toBeGreaterThan(mon.x);
    // The 1st of a month reads "Dec 1".
    await expect(app.cell('2026-12-01')).toContainText('Dec 1');
  });

  test('prev / next / Today in month view', async ({ app }) => {
    await app.press(app.page.getByTestId('cal-next'));
    await expect(app.title).toHaveText('December 2026');
    await expect(app.cell('2026-12-15')).toBeInViewport();
    await app.press(app.page.getByTestId('cal-next'));
    await expect(app.title).toHaveText('January 2027');
    await app.press(app.page.getByTestId('cal-prev'));
    await app.press(app.page.getByTestId('cal-prev'));
    await app.press(app.page.getByTestId('cal-prev'));
    await expect(app.title).toHaveText('October 2026');
    await app.settle(700);
    await expect(app.cell('2026-10-14')).toBeInViewport();
    await app.press(app.page.getByTestId('cal-today'));
    await expect(app.title).toHaveText('November 2026');
    await app.settle(700);
    await expect(app.cell(TODAY)).toBeInViewport();
  });

  test('week view: switch, step weeks, Today, back to month', async ({ app }) => {
    await app.seed([{ title: 'Standup', date: '2026-11-24' }]);
    await chooseView(app, 'Week');
    await expect(app.title).toHaveText('Nov 16 – 22, 2026');
    await expect(app.calendar.getByTestId('day-cell')).toHaveCount(7);
    await expect(app.cell(TODAY)).toHaveAttribute('data-today', 'true');

    await app.press(app.page.getByTestId('cal-next'));
    await expect(app.title).toHaveText('Nov 23 – 29, 2026');
    await expect(app.card('2026-11-24', 'Standup')).toBeVisible();
    await app.press(app.page.getByTestId('cal-next'));
    await expect(app.title).toHaveText('Nov 30 – Dec 6, 2026');
    await app.press(app.page.getByTestId('cal-today'));
    await expect(app.title).toHaveText('Nov 16 – 22, 2026');
    await app.press(app.page.getByTestId('cal-prev'));
    await expect(app.title).toHaveText('Nov 9 – 15, 2026');

    await chooseView(app, 'Month');
    await expect(app.title).toHaveText('November 2026');
    expect(await app.calendar.getByTestId('day-cell').count()).toBeGreaterThan(100);
  });

  test('month view scrolls continuously; prepending weeks above never moves what you look at', async ({ app, page }) => {
    const scroller = app.calendar.locator('[data-cal-scroller]');
    const firstDate = () => app.calendar.getByTestId('day-cell').first().getAttribute('data-date');
    const before = await firstDate();

    // Scroll up in steps; each step is a frame apart, like a user scrolling.
    let prepended = false;
    for (let i = 0; i < 40 && !prepended; i++) {
      // Track a cell that is on screen right now.
      const probe = await page.evaluate(() => {
        const sc = document.querySelector<HTMLElement>('[data-cal-scroller]')!;
        const r = sc.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest<HTMLElement>('[data-testid="day-cell"]');
        return el ? { date: el.dataset.date!, top: el.getBoundingClientRect().top } : null;
      });
      expect(probe).not.toBeNull();
      await scroller.evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollTop - 300);
      });
      await page.waitForTimeout(120);
      const now = await firstDate();
      if (now !== before) {
        prepended = true;
        // Rows were added above: the probe cell moved exactly by the scroll delta (300px or less at the
        // very top), never by the height of the inserted rows.
        const after = await app.cell(probe!.date).evaluate((el) => el.getBoundingClientRect().top);
        const moved = after - probe!.top;
        expect(moved).toBeGreaterThanOrEqual(-1);
        expect(moved).toBeLessThanOrEqual(301);
      }
    }
    expect(prepended).toBe(true);
    // Stable at rest: nothing drifts once scrolling settles.
    const probeDate = await page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>('[data-cal-scroller]')!;
      const r = sc.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest<HTMLElement>('[data-testid="day-cell"]')?.dataset.date ?? null;
    });
    const top1 = await app.cell(probeDate!).evaluate((el) => el.getBoundingClientRect().top);
    await app.settle(600);
    const top2 = await app.cell(probeDate!).evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(top2 - top1)).toBeLessThan(1);
    // The title follows the month in view, and Today comes back.
    await expect(app.title).not.toHaveText('November 2026');
    await app.press(app.page.getByTestId('cal-today'));
    await expect(app.title).toHaveText('November 2026');
    await app.settle(800);
    await expect(app.cell(TODAY)).toBeInViewport();
  });

  test('phone: the title opens the Month / Week menu', async ({ app }) => {
    test.skip(!app.phone, 'phone header');
    await chooseView(app, 'Week');
    await expect(app.title).toHaveText('Nov 16 – 22, 2026');
    await chooseView(app, 'Month');
    await expect(app.title).toHaveText('November 2026');
  });
});

test.describe('Keyboard shortcuts (desktop)', () => {
  test.beforeEach(async ({ app }) => {
    test.skip(app.phone, 'keyboard shortcuts are desktop only');
    await app.goto();
  });

  test('t ← → m w', async ({ app }) => {
    await app.key('ArrowRight');
    await expect(app.title).toHaveText('December 2026');
    await app.key('ArrowLeft');
    await app.key('ArrowLeft');
    await expect(app.title).toHaveText('October 2026');
    await app.key('t');
    await expect(app.title).toHaveText('November 2026');
    await app.key('w');
    await expect(app.title).toHaveText('Nov 16 – 22, 2026');
    await app.key('ArrowRight');
    await expect(app.title).toHaveText('Nov 23 – 29, 2026');
    await app.key('t');
    await expect(app.title).toHaveText('Nov 16 – 22, 2026');
    await app.key('m');
    await expect(app.title).toHaveText('November 2026');
  });

  test('n focuses the Inbox; typing never triggers shortcuts; Esc leaves the field', async ({ app }) => {
    await app.key('n');
    await expect(app.inboxInput).toBeFocused();
    await app.page.keyboard.type('two weeks plan');
    await expect(app.inboxInput).toHaveValue('two weeks plan');
    await expect(app.title).toHaveText('November 2026'); // "w", "t", "m" typed, not executed
    await app.page.keyboard.press('Enter');
    await expect(app.bubbles).toHaveText(['two weeks plan']);
    await app.page.keyboard.press('Escape');
    await expect(app.inboxInput).not.toBeFocused();
    // n with the Inbox closed opens it first.
    await app.key(']');
    await expect(app.page.getByTestId('inbox')).toBeHidden();
    await app.key('n');
    await expect(app.page.getByTestId('inbox')).toBeVisible();
    await expect(app.inboxInput).toBeFocused();
  });

  test('[ and ] toggle the sidebars', async ({ app }) => {
    await expect(app.sidebar).toBeVisible();
    await app.key('[');
    await expect(app.sidebar).toBeHidden();
    await app.key('[');
    await expect(app.sidebar).toBeVisible();
    await app.key(']');
    await expect(app.page.getByTestId('inbox')).toBeHidden();
    await app.key(']');
    await expect(app.page.getByTestId('inbox')).toBeVisible();
  });

  test('⌘Z / Ctrl+Z undoes the last change; Esc closes the peek', async ({ app, page }) => {
    await app.seed([{ title: 'Move me', date: '2026-11-20' }]);
    await app.drag(app.card('2026-11-20', 'Move me'), app.cell('2026-11-24'));
    await expect(app.card('2026-11-24', 'Move me')).toBeVisible();
    await app.key('ControlOrMeta+z');
    await expect(app.card('2026-11-20', 'Move me')).toBeVisible();
    await expect(app.card('2026-11-24', 'Move me')).toHaveCount(0);

    await app.openPeek(app.card('2026-11-20', 'Move me'));
    await page.keyboard.press('Escape');
    await expect(app.peek).toBeHidden();
  });

  test('focused card: Enter opens it, Backspace deletes it (with Undo)', async ({ app, page }) => {
    await app.seed([{ title: 'Focus me', date: '2026-11-20' }]);
    const card = app.card('2026-11-20', 'Focus me');
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(app.peek).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(app.peek).toBeHidden();
    // Focus handed back by the closing peek never arms Backspace (review D3); reaching the card by
    // keyboard does.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(card).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(app.toast.filter({ hasText: 'Task deleted' })).toBeVisible();
    await expect(card).toHaveCount(0);
    await app.key('ControlOrMeta+z');
    await expect(app.card('2026-11-20', 'Focus me')).toBeVisible();
  });
});
