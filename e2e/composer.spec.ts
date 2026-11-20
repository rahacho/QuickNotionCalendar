import { test, expect } from './fixtures';

test.describe('Adding on the calendar', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
  });

  test('desktop: hover "+" opens an inline card composer; Enter adds and keeps it open', async ({ app, page }) => {
    test.skip(app.phone, 'hover "+" is desktop only');
    const cell = app.cell('2026-11-24');
    await cell.hover();
    const add = cell.getByTestId('day-add');
    await expect(add).toBeVisible();
    await add.click();

    const input = cell.getByTestId('composer-input');
    await expect(input).toBeFocused();
    await input.fill('Buy groceries');
    await input.press('Enter');
    await expect(app.card('2026-11-24', 'Buy groceries')).toBeVisible();
    // Stays open for the next one.
    await expect(cell.getByTestId('composer-input')).toBeFocused();
    await expect(cell.getByTestId('composer-input')).toHaveValue('');
    await page.keyboard.type('Pick up dry cleaning');
    await page.keyboard.press('Enter');
    expect(await app.cardTitles('2026-11-24')).toEqual(['Buy groceries', 'Pick up dry cleaning']);

    // Esc discards an unsaved draft and closes.
    await page.keyboard.type('never mind');
    await page.keyboard.press('Escape');
    await expect(cell.getByTestId('composer-input')).toHaveCount(0);
    expect(await app.cardTitles('2026-11-24')).toEqual(['Buy groceries', 'Pick up dry cleaning']);
    expect((await app.tasks()).every((t) => t.date === '2026-11-24')).toBe(true);
  });

  test('desktop: double-click an empty part of a day; clicking away saves the draft', async ({ app, page }) => {
    test.skip(app.phone, 'double-click is desktop only');
    const cell = app.cell('2026-11-26');
    const box = (await cell.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height - 20);
    const input = cell.getByTestId('composer-input');
    await expect(input).toBeFocused();
    await input.fill('Thanksgiving prep');
    // Click somewhere neutral (the header title) → blur with text creates the task.
    await app.title.click();
    await expect(app.card('2026-11-26', 'Thanksgiving prep')).toBeVisible();
    await expect(cell.getByTestId('composer-input')).toHaveCount(0);

    // Blur while empty just closes.
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height - 10);
    await expect(cell.getByTestId('composer-input')).toBeFocused();
    await app.title.click();
    await expect(cell.getByTestId('composer-input')).toHaveCount(0);
    expect(await app.tasks()).toHaveLength(1);
  });

  test('desktop: a multi-line paste in the composer creates one card per line', async ({ app }) => {
    test.skip(app.phone, 'inline composer is desktop only');
    const cell = app.cell('2026-11-27');
    await cell.hover();
    await cell.getByTestId('day-add').click();
    await app.paste(cell.getByTestId('composer-input'), 'Wrap gifts\nCall grandma\n');
    await expect.poll(() => app.cardTitles('2026-11-27')).toEqual(['Wrap gifts', 'Call grandma']);
  });

  test('phone: tapping an empty part of a day opens the quick-add sheet', async ({ app, page }) => {
    test.skip(!app.phone, 'quick-add sheet is the phone composer');
    await app.seed([{ title: 'Already planned', date: '2026-11-24' }]);
    const cell = app.cell('2026-11-24');
    const box = (await cell.boundingBox())!;
    // The date-label strip: well away from the card (iOS snaps taps near a card onto the card).
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 8);

    const sheet = page.getByTestId('quickadd');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('New task');
    await expect(sheet).toContainText('Tue, Nov 24');
    await expect(sheet.getByTestId('quickadd-task')).toHaveText(['Already planned']);
    const input = sheet.getByTestId('quickadd-input');
    await expect(input).toBeFocused();
    await input.fill('Pay water bill');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await input.fill('Order printer ink');
    await input.press('Enter');
    await expect(sheet.getByTestId('quickadd-task')).toHaveText(['Already planned', 'Pay water bill', 'Order printer ink']);

    await sheet.getByTestId('quickadd-close').tap();
    await expect(sheet).toBeHidden();
    expect(await app.cardTitles('2026-11-24')).toEqual(['Already planned', 'Pay water bill', 'Order printer ink']);
  });
});
