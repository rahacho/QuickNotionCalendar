import { test, expect } from './fixtures';

test.describe('Inbox brain-dump', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
  });

  test('Enter adds a bubble directly under the input, newest first, and keeps focus', async ({ app }) => {
    await app.addToInbox('Email landlord', 'Book dentist', 'Buy stamps');

    await expect(app.bubbles).toHaveCount(3);
    expect(await app.bubbleTitles()).toEqual(['Buy stamps', 'Book dentist', 'Email landlord']);
    await expect(app.inboxInput).toBeFocused();
    await expect(app.inboxInput).toHaveValue('');

    // Whitespace-only input creates nothing.
    await app.inboxInput.fill('   ');
    await app.inboxInput.press('Enter');
    await expect(app.bubbles).toHaveCount(3);

    // Stored as unscheduled tasks.
    const tasks = await app.tasks();
    expect(tasks.map((t) => t.date)).toEqual([null, null, null]);
  });

  test('pasting several lines creates one bubble per line, in line order, on top', async ({ app }) => {
    await app.addToInbox('Already here');
    await app.paste(app.inboxInput, '- Call the bank\n* Renew passport\n\n1. Pick a gift for Ana\n');

    await expect(app.bubbles).toHaveCount(4);
    expect(await app.bubbleTitles()).toEqual(['Call the bank', 'Renew passport', 'Pick a gift for Ana', 'Already here']);
    await expect(app.inboxInput).toHaveValue('');
  });

  test('a single-line paste is just text in the field', async ({ app }) => {
    await app.openInbox();
    await app.paste(app.inboxInput, 'Just one line\n');
    // Not split into tasks: nothing was created.
    await expect(app.bubbles).toHaveCount(0);
  });

  test('clicking a bubble opens the peek', async ({ app }) => {
    await app.addToInbox('Read the lease');
    await app.openPeek(app.bubbles.first());
    await expect(app.peek.getByTestId('peek-title')).toHaveValue('Read the lease');
    await expect(app.peek.getByTestId('peek-date')).toHaveText(/Empty/);
  });
});
