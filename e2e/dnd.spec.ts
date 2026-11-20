import { test, expect } from './fixtures';

test.describe('Drag and drop', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
  });

  test('Inbox bubble → day schedules it there', async ({ app, page }) => {
    await app.seed([{ title: 'Plan the trip' }, { title: 'Stay in inbox' }]);
    await app.openInbox();
    const bubble = app.bubbles.filter({ hasText: 'Plan the trip' });
    await expect(bubble).toBeVisible();

    if (app.phone) {
      // Long-press, then up out of the sheet: the sheet slides fully down (revealing the calendar) and
      // the "Move to Inbox" pill rises.
      const sheet = page.getByTestId('inbox-sheet');
      const vw = page.viewportSize()!;
      await app.drag(
        bubble,
        async () => {
          await expect(sheet).toHaveAttribute('data-hidden', 'true');
          await expect(page.getByTestId('inbox-dropzone')).toContainText('Move to Inbox');
          return app.center(app.cell('2026-11-20'));
        },
        { via: [{ x: vw.width / 2, y: 200 }] },
      );
      // After the drop the sheet comes back where it was.
      await expect(sheet).not.toHaveAttribute('data-hidden', 'true');
      await expect(sheet).toHaveAttribute('data-snap', 'half');
    } else {
      await app.drag(bubble, app.cell('2026-11-20'));
    }

    await expect(app.card('2026-11-20', 'Plan the trip')).toBeVisible();
    await expect(app.bubbles.filter({ hasText: 'Plan the trip' })).toHaveCount(0);
    await expect(app.bubbles).toHaveCount(1);
    expect((await app.task('Plan the trip'))?.date).toBe('2026-11-20');
    await expect(app.peek).toBeHidden(); // a drop never opens the peek
  });

  test('card → another day moves it; a multi-day bar keeps its length', async ({ app }) => {
    await app.seed([
      { title: 'Grocery run', date: '2026-11-20' },
      { title: 'Boston trip', date: '2026-11-23', endDate: '2026-11-25' },
    ]);

    await app.drag(app.card('2026-11-20', 'Grocery run'), app.cell('2026-11-24'));
    await expect(app.card('2026-11-24', 'Grocery run')).toBeVisible();
    await expect(app.card('2026-11-20', 'Grocery run')).toHaveCount(0);
    expect((await app.task('Grocery run'))?.date).toBe('2026-11-24');

    // Grab the bar on its first day and drop it two days later: same 3-day length.
    const bar = app.bar('Boston trip').first();
    await expect(bar).toBeVisible();
    const box = (await bar.boundingBox())!;
    await app.drag(bar, app.cell('2026-11-25'), { grab: { x: Math.min(40, box.width / 6), y: box.height / 2 } });
    const t = await app.task('Boston trip');
    expect([t?.date, t?.endDate]).toEqual(['2026-11-25', '2026-11-27']);
  });

  test('reorder within a day', async ({ app }) => {
    await app.seed([
      { title: 'Alpha', date: '2026-11-25' },
      { title: 'Bravo', date: '2026-11-25' },
      { title: 'Charlie', date: '2026-11-25' },
    ]);
    expect(await app.cardTitles('2026-11-25')).toEqual(['Alpha', 'Bravo', 'Charlie']);

    const alpha = app.card('2026-11-25', 'Alpha');
    await app.drag(app.card('2026-11-25', 'Charlie'), async () => {
      const b = (await alpha.boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + 3 };
    });
    await expect.poll(() => app.cardTitles('2026-11-25')).toEqual(['Charlie', 'Alpha', 'Bravo']);

    // The order is stored, not just shown.
    const byTitle = Object.fromEntries((await app.tasks()).map((t) => [t.title, t.order]));
    expect(byTitle.Charlie! < byTitle.Alpha!).toBe(true);
    expect(byTitle.Alpha! < byTitle.Bravo!).toBe(true);
  });

  test('card → Inbox unschedules it (top of the Inbox)', async ({ app, page }) => {
    await app.seed([{ title: 'Existing bubble' }, { title: 'Call the plumber', date: '2026-11-19', time: '15:00' }]);
    const card = app.card('2026-11-19', 'Call the plumber');
    await expect(card).toBeVisible();

    if (app.phone) {
      const pill = page.getByTestId('inbox-dropzone');
      await app.drag(card, async () => {
        await expect(pill).toContainText('Move to Inbox');
        await expect(pill).not.toHaveAttribute('aria-disabled', 'true');
        return app.center(pill);
      });
    } else {
      // Dropped where the pointer is: just above the first bubble → top of the Inbox.
      const first = app.bubbles.first();
      await app.drag(card, async () => {
        const b = (await first.boundingBox())!;
        return { x: b.x + b.width / 2, y: b.y + 3 };
      });
    }

    await expect(app.card('2026-11-19', 'Call the plumber')).toHaveCount(0);
    const t = await app.task('Call the plumber');
    expect([t?.date, t?.time]).toEqual([null, null]);
    await app.openInbox();
    expect(await app.bubbleTitles()).toEqual(['Call the plumber', 'Existing bubble']);
  });

  test('a repeating occurrence is refused by the Inbox', async ({ app, page }) => {
    await app.seed([{ title: 'Water plants', date: '2026-11-19', recurrence: { freq: 'weekly', interval: 1 } }]);
    const card = app.card('2026-11-19', 'Water plants');
    if (app.phone) {
      const pill = page.getByTestId('inbox-dropzone');
      await app.drag(card, async () => {
        await expect(pill).toHaveAttribute('aria-disabled', 'true');
        await expect(pill).toContainText('Repeating tasks stay on the calendar');
        return app.center(pill);
      });
    } else {
      await app.drag(card, page.getByTestId('inbox'));
    }
    await expect(app.toast.filter({ hasText: "Repeating tasks can't go to the Inbox" })).toBeVisible();
    await expect(app.card('2026-11-19', 'Water plants')).toBeVisible();
    expect((await app.task('Water plants'))?.date).toBe('2026-11-19');
  });

  test('reorder the Inbox by drag', async ({ app }) => {
    await app.addToInbox('Third', 'Second', 'First');
    expect(await app.bubbleTitles()).toEqual(['First', 'Second', 'Third']);
    await app.inboxInput.blur();
    const first = app.bubbles.filter({ hasText: 'First' });
    await app.drag(app.bubbles.filter({ hasText: 'Third' }), async () => {
      const b = (await first.boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + 3 };
    });
    await expect.poll(() => app.bubbleTitles()).toEqual(['Third', 'First', 'Second']);
    expect((await app.tasks()).every((t) => t.date === null)).toBe(true);
  });

  test('list row → day, and list row → Inbox', async ({ app, page }) => {
    await app.seed([
      { title: 'From the list', date: '2026-11-20' },
      { title: 'Unschedule me', date: '2026-11-20' },
    ]);
    await app.openTasks();
    await app.drag(app.row('From the list'), () => app.center(app.cell('2026-11-17')));
    await expect(app.card('2026-11-17', 'From the list')).toBeVisible();
    expect((await app.task('From the list'))?.date).toBe('2026-11-17');
    await expect(app.peek).toBeHidden();

    await app.openTasks();
    if (app.phone) {
      const pill = page.getByTestId('inbox-dropzone');
      await app.drag(app.row('Unschedule me'), async () => {
        await expect(pill).toContainText('Move to Inbox');
        return app.center(pill);
      });
    } else {
      await app.drag(app.row('Unschedule me'), page.getByTestId('inbox'));
    }
    expect((await app.task('Unschedule me'))?.date).toBeNull();
    await app.openInbox();
    await expect(app.bubbles.filter({ hasText: 'Unschedule me' })).toBeVisible();
  });

  test('desktop: holding a card over › flips to the next month, then drops there', async ({ app, page }) => {
    test.skip(app.phone, 'mouse hover dwell');
    await app.seed([{ title: 'Push to December', date: '2026-11-20' }]);
    const card = app.card('2026-11-20', 'Push to December');
    const from = await app.center(card);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 4, from.y + 6, { steps: 3 });
    const next = await app.center(page.getByTestId('cal-next'));
    await page.mouse.move(next.x, next.y, { steps: 10 });
    await expect(app.title).toHaveText('December 2026', { timeout: 3000 });
    await page.mouse.move(next.x - 300, next.y + 10, { steps: 4 }); // leave before it flips again
    await app.settle(700);
    const target = await app.center(app.cell('2026-12-16'));
    await page.mouse.move(target.x, target.y, { steps: 12 });
    // The way down crosses the calendar's top auto-scroll zone; on a busy machine a frame or two can
    // scroll it there, so aim again now that the pointer is past the zone (the drop follows the pointer).
    await page.waitForTimeout(100);
    const aim = await app.center(app.cell('2026-12-16'));
    await page.mouse.move(aim.x, aim.y, { steps: 3 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await app.settle();
    expect((await app.task('Push to December'))?.date).toBe('2026-12-16');
  });

  test('desktop: resize edges turn a card into a multi-day bar and move its start', async ({ app, page }) => {
    test.skip(app.phone, 'resize handles are desktop (fine pointer) only');
    await app.seed([{ title: 'Design sprint', date: '2026-11-24' }]);
    const card = app.card('2026-11-24', 'Design sprint');
    await card.hover();
    const end = card.getByTestId('resize-end');
    const eb = (await end.boundingBox())!;
    const target = await app.center(app.cell('2026-11-26'));
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    // Live preview: the bar already spans the days before release.
    await expect(app.bar('Design sprint').first()).toBeVisible();
    await page.mouse.up();
    await app.settle();
    let t = await app.task('Design sprint');
    expect([t?.date, t?.endDate]).toEqual(['2026-11-24', '2026-11-26']);

    // Now drag the bar's start edge one day earlier.
    const bar = app.bar('Design sprint').first();
    await bar.hover();
    const start = bar.getByTestId('resize-start');
    const sb = (await start.boundingBox())!;
    const to = await app.center(app.cell('2026-11-23'));
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await app.settle();
    t = await app.task('Design sprint');
    expect([t?.date, t?.endDate]).toEqual(['2026-11-23', '2026-11-26']);

    // Esc cancels a resize in progress.
    await bar.hover();
    const eb2 = (await bar.getByTestId('resize-end').boundingBox())!;
    const far = await app.center(app.cell('2026-11-28'));
    await page.mouse.move(eb2.x + eb2.width / 2, eb2.y + eb2.height / 2);
    await page.mouse.down();
    await page.mouse.move(far.x, far.y, { steps: 8 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await app.settle();
    t = await app.task('Design sprint');
    expect([t?.date, t?.endDate]).toEqual(['2026-11-23', '2026-11-26']);
  });
});
