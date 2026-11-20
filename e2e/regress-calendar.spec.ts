/**
 * Regression tests for review findings in the calendar / dnd / sidebars area (review round 1).
 * Each test names the finding it pins down.
 */
import type { Page } from '@playwright/test';
import { test, expect, TODAY, type App } from './fixtures';

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

/** The first week row whose bottom is below the sticky weekday header, and its screen y. */
async function topRow(page: Page): Promise<{ week: string; y: number }> {
  return page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[data-testid="month-scroller"]')!;
    const hdr = (s.firstElementChild as HTMLElement).getBoundingClientRect().bottom;
    for (const row of s.querySelectorAll<HTMLElement>('[data-week]')) {
      const r = row.getBoundingClientRect();
      if (r.bottom > hdr + 2) return { week: row.dataset.week!, y: r.top };
    }
    throw new Error('no rows');
  });
}

/**
 * A decelerating fling driven per frame (like iOS momentum or a fast trackpad), `dist` px (negative =
 * up). Resolves with the distance actually applied by these writes (compensation writes excluded).
 */
async function fling(page: Page, dist: number, ms = 1000): Promise<number> {
  return page.evaluate(
    ([d, dur]) =>
      new Promise<number>((resolve) => {
        const s = document.querySelector<HTMLElement>('[data-testid="month-scroller"]')!;
        const t0 = performance.now();
        let last = 0;
        let applied = 0;
        const f = (now: number) => {
          const t = Math.min(1, (now - t0) / dur!);
          const target = d! * (1 - (1 - t) ** 3);
          const before = s.scrollTop;
          s.scrollTop = before + (target - last);
          applied += s.scrollTop - before;
          last = target;
          if (t < 1) requestAnimationFrame(f);
          else resolve(applied);
        };
        requestAnimationFrame(f);
      }),
    [dist, ms],
  );
}

async function rowY(page: Page, week: string): Promise<number | null> {
  return page.evaluate((w) => {
    const el = document.querySelector(`[data-testid="month-scroller"] [data-week="${w}"]`);
    return el ? el.getBoundingClientRect().top : null;
  }, week);
}

async function inView(app: App, date: string): Promise<boolean> {
  return app.page.evaluate((d) => {
    const c = document.querySelector(`[data-testid="day-cell"][data-date="${d}"]`);
    const sc = document.querySelector('[data-testid="month-scroller"]');
    if (!c || !sc) return false;
    const r = c.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    return r.top >= s.top + 20 && r.bottom <= s.bottom + 1;
  }, date);
}

const DAILY = [
  'Morning workout and stretching',
  'Plan the day',
  'Walk the dog',
].map((title) => ({ title, date: '2024-01-01', recurrence: { freq: 'daily' as const, interval: 1 } }));

// ------------------------------------------------------------------------------------------------
// C1 — the idle trim must never move the view (browser scrollTop clamp before compensation)
// ------------------------------------------------------------------------------------------------

test.describe('C1: month scroller never jumps after a long scroll', () => {
  test.beforeEach(async ({ app }) => {
    await app.goto();
    await app.settle(500);
  });

  test('pressing › 9 times at a normal pace lands on August 2027 with its first week on top', async ({ app, page }) => {
    for (let i = 0; i < 9; i++) {
      await app.press(page.getByTestId('cal-next'));
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(1500);
    await expect(app.title).toHaveText('August 2027');
    expect((await topRow(page)).week).toBe('2027-07-26');
  });

  test('a long fast scroll down stays put when scrolling settles', async ({ app, page }) => {
    if (app.phone) {
      await fling(page, 4000, 1600);
    } else {
      const box = (await page.getByTestId('month-scroller').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 15; i++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(50);
      }
    }
    // Snapshot before the 160ms scroll-idle trim runs, then again well after it.
    await page.waitForTimeout(80);
    const a = await topRow(page);
    await page.waitForTimeout(1200); // idle → trim
    const b = await topRow(page);
    expect(b.week).toBe(a.week);
    expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(1);
    // Far rows were trimmed back (the window doesn't grow forever).
    expect(await page.locator('[data-testid="month-scroller"] [data-week]').count()).toBeLessThanOrEqual(68);
  });

  test('Today right after scrolling back years shows today', async ({ app, page }) => {
    if (app.phone) {
      for (let i = 0; i < 3; i++) await fling(page, -5000, 700);
    } else {
      await page.mouse.move(700, 500);
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, -400);
        await page.waitForTimeout(60);
      }
    }
    await app.press(page.getByTestId('cal-today'));
    await page.waitForTimeout(2000);
    await expect(app.title).toHaveText('November 2026');
    expect(await inView(app, TODAY)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// C-V1 — prepends during fast upward scrolling are always compensated (no 8-week skips)
// ------------------------------------------------------------------------------------------------

async function flingUpDrift(app: App, page: Page, dist: number, n: number): Promise<number[]> {
  const drifts: number[] = [];
  for (let i = 0; i < n; i++) {
    const { week, y } = await topRow(page);
    const applied = await fling(page, -dist, 1000);
    await page.waitForTimeout(900);
    const after = await rowY(page, week);
    expect(after, `row ${week} still mounted`).not.toBeNull();
    drifts.push(Math.round((after as number) - (y - applied)));
  }
  return drifts;
}

test.describe('C-V1: upward flings through prepends keep content still', () => {
  test('busy rows, 4 decelerating flings', async ({ app, page }) => {
    await app.goto();
    await app.seed(DAILY);
    await app.settle(600);
    const drifts = await flingUpDrift(app, page, app.phone ? 1800 : 2800, 4);
    for (const d of drifts) expect(Math.abs(d)).toBeLessThanOrEqual(2);
  });

  test('busy rows on a 6× throttled CPU (React yields mid-render)', async ({ app, page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'CPU throttling needs CDP');
    await app.goto();
    await app.seed(DAILY);
    await app.settle(600);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    try {
      const drifts = await flingUpDrift(app, page, 2400, 4);
      for (const d of drifts) expect(Math.abs(d)).toBeLessThanOrEqual(2);
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
  });
});

// ------------------------------------------------------------------------------------------------
// D2 — on launch, today's row is on screen even when earlier weeks are busy
// ------------------------------------------------------------------------------------------------

test.describe('D2: launch position', () => {
  test('busy earlier weeks never push today (Nov 30) below the fold', async ({ app, page, context }) => {
    await app.goto();
    const busy: Array<{ title: string; date: string }> = [];
    for (const d of ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']) {
      for (let i = 1; i <= 6; i++) busy.push({ title: `Errand number ${i} for the ${d.slice(8)}th`, date: d });
    }
    busy.push({ title: 'TODAY TASK', date: '2026-11-30' });
    await app.seed(busy);
    await page.waitForTimeout(600); // IndexedDB write-through

    const p2 = await context.newPage();
    await p2.clock.install({ time: new Date('2026-11-30T10:00:00') });
    await p2.goto('/');
    await app.ready(p2);
    await p2.waitForTimeout(800);
    const card = p2.getByTestId('task-card').filter({ hasText: 'TODAY TASK' });
    await expect(card).toHaveCount(1);
    const c = (await card.boundingBox())!;
    const s = (await p2.getByTestId('month-scroller').boundingBox())!;
    let bottom = s.y + s.height;
    if (app.phone) {
      const sheet = (await p2.getByTestId('inbox-sheet').boundingBox())!;
      bottom = Math.min(bottom, sheet.y);
    }
    expect(c.y).toBeGreaterThanOrEqual(s.y + 20);
    expect(c.y + c.height).toBeLessThanOrEqual(bottom + 1);
    await expect(p2.getByTestId('cal-title')).toHaveText('November 2026');
    await p2.close();
  });

  test('when everything fits, the month still opens with its first week on top', async ({ app, page }) => {
    await app.goto();
    await app.settle(300);
    expect((await topRow(page)).week).toBe('2026-10-26');
    await expect(app.title).toHaveText('November 2026');
    expect(await inView(app, TODAY)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// D1 / E1 — multi-day names are never cut on the phone grid, in week view, or on touch
// ------------------------------------------------------------------------------------------------

const MULTI = [
  { title: 'Two-day offsite planning workshop with team', date: '2026-11-20', endDate: '2026-11-21' },
  { title: 'Week long vacation in Portugal with family', date: '2026-11-22', endDate: '2026-11-28' },
  { title: 'Multi-day with a pretty long descriptive name here', date: '2026-11-26', endDate: '2026-11-27' },
  { title: 'Call mom', date: '2026-11-26' },
];

/** Every bar title fully shown, and no bar overlapping the first card of `date` (same row). */
async function barsReadable(page: Page, date: string): Promise<{ clipped: string[]; overlap: number }> {
  return page.evaluate((d) => {
    const clipped: string[] = [];
    for (const bar of document.querySelectorAll<HTMLElement>('[data-testid="calendar"] [data-testid="bar"]')) {
      if (bar.closest('[inert]')) continue;
      const t = bar.querySelector<HTMLElement>('span span');
      if (!t) continue;
      if (t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1) clipped.push(t.textContent ?? '');
    }
    const cell = [...document.querySelectorAll<HTMLElement>(`[data-testid="day-cell"][data-date="${d}"]`)].find((c) => !c.closest('[inert]'))!;
    const row = cell.parentElement!;
    const card = cell.querySelector<HTMLElement>('[data-testid="task-card"]')!;
    let maxBottom = -Infinity;
    for (const bar of row.querySelectorAll<HTMLElement>('[data-testid="bar"]')) maxBottom = Math.max(maxBottom, bar.getBoundingClientRect().bottom);
    return { clipped, overlap: maxBottom - card.getBoundingClientRect().top };
  }, date);
}

async function toWeekView(app: App): Promise<void> {
  await app.press(app.page.getByTestId('cal-view'));
  await app.press(app.page.getByRole('menuitemradio', { name: 'Week' }));
  await app.settle();
}

test.describe('D1/E1: multi-day task names stay readable', () => {
  test('phone month grid: bars wrap to show the full name, cards start below them', async ({ app, page }) => {
    test.skip(!app.phone, 'phone grid');
    await app.goto();
    await app.seed(MULTI);
    await app.settle(400);
    const r = await barsReadable(page, '2026-11-26');
    expect(r.clipped).toEqual([]);
    expect(r.overlap).toBeLessThanOrEqual(0.5);
  });

  test('week view (both layouts): bars wrap, cards start below them', async ({ app, page }) => {
    await app.goto();
    await app.seed(MULTI);
    await toWeekView(app);
    await app.press(page.getByTestId('cal-next'));
    await app.settle(400);
    await expect(app.title).toHaveText('Nov 23 – 29, 2026');
    const r = await barsReadable(page, '2026-11-26');
    expect(r.clipped).toEqual([]);
    expect(r.overlap).toBeLessThanOrEqual(0.5);
  });

  test('desktop month keeps Notion one-line bars (full name in the tooltip)', async ({ app, page }) => {
    test.skip(app.phone, 'desktop month');
    await app.goto();
    await app.seed(MULTI);
    const bar = app.bar('Multi-day with a pretty long').first();
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('title', 'Multi-day with a pretty long descriptive name here');
    expect(await bar.getAttribute('data-wrap')).toBeNull();
    expect(Math.round((await bar.boundingBox())!.height)).toBe(28);
    const r = await barsReadable(page, '2026-11-26');
    expect(r.overlap).toBeLessThanOrEqual(0.5);
  });
});

// ------------------------------------------------------------------------------------------------
// D3 — Backspace only deletes a card the user reached with the keyboard
// ------------------------------------------------------------------------------------------------

test.describe('D3: no accidental delete after closing the peek', () => {
  test.beforeEach(async ({ app }) => {
    test.skip(app.phone, 'desktop keyboard');
    await app.goto();
    await app.seed([{ title: 'Call mom', date: TODAY }]);
  });

  test('click → edit title → Esc → Backspace keeps the task', async ({ app, page }) => {
    await app.openPeek(app.card(TODAY, 'Call mom'));
    await page.getByTestId('peek-title').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' tonite');
    for (let i = 0; i < 3 && (await app.peek.isVisible()); i++) {
      await page.keyboard.press('Escape');
      await app.settle(200);
    }
    await expect(app.peek).toBeHidden();
    await page.keyboard.press('Backspace');
    await app.settle(300);
    expect(await app.task('Call mom tonite')).toBeDefined();
    await expect(app.toast.filter({ hasText: 'Task deleted' })).toHaveCount(0);
    await expect(app.card(TODAY, 'Call mom tonite')).toBeVisible();
  });

  test('click → close with ✕ → Backspace keeps the task', async ({ app, page }) => {
    await app.openPeek(app.card(TODAY, 'Call mom'));
    await app.closePeek();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await app.settle(300);
    expect(await app.task('Call mom')).toBeDefined();
    await expect(app.toast.filter({ hasText: 'Task deleted' })).toHaveCount(0);
  });

  test('after Esc, Shift+Tab / Tab back onto the card arms Backspace again', async ({ app, page }) => {
    const card = app.card(TODAY, 'Call mom');
    await app.openPeek(card);
    await page.keyboard.press('Escape');
    await expect(app.peek).toBeHidden();
    await expect(card).toBeFocused(); // handed back by the peek: not armed
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(card).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(app.toast.filter({ hasText: 'Task deleted' })).toBeVisible();
    expect(await app.task('Call mom')).toBeUndefined();
  });

  test('Tab to the card → Backspace deletes it, with Undo', async ({ app, page }) => {
    await page.getByTestId('cal-next').focus();
    await page.keyboard.press('Tab'); // today's cell (the calendar's tab stop)
    await page.keyboard.press('Tab'); // its first card
    await expect(app.card(TODAY, 'Call mom')).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(app.toast.filter({ hasText: 'Task deleted' })).toBeVisible();
    expect(await app.task('Call mom')).toBeUndefined();
    await app.undoFromToast();
    await expect(app.card(TODAY, 'Call mom')).toBeVisible();
  });
});

// ------------------------------------------------------------------------------------------------
// D4 — the calendar is one Tab stop (today), arrows move between days
// ------------------------------------------------------------------------------------------------

test.describe('D4: keyboard entry into the calendar', () => {
  test('Tab from the header lands on today without scrolling; arrows move by day; Tab leaves for the Inbox', async ({ app, page }) => {
    test.skip(app.phone, 'desktop keyboard');
    await app.goto();
    await app.seed([{ title: 'Daily standup', date: '2026-01-05', recurrence: { freq: 'daily', interval: 1 } }]);
    await app.settle(300);
    const before = await topRow(page);
    await page.getByTestId('cal-next').focus();
    await page.keyboard.press('Tab');
    await expect(app.cell(TODAY)).toBeFocused();
    await expect(app.title).toHaveText('November 2026');
    expect((await topRow(page)).week).toBe(before.week);

    // Arrows move the focused day (and never page the month).
    await page.keyboard.press('ArrowRight');
    await expect(app.cell('2026-11-20')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(app.cell('2026-11-27')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await expect(app.cell('2026-11-19')).toBeFocused();
    await expect(app.title).toHaveText('November 2026');

    // Enter adds a task on the focused day.
    await page.keyboard.press('Enter');
    await expect(app.cell(TODAY).getByTestId('composer-input')).toBeFocused();
    await page.keyboard.press('Escape');

    // Back on the day: its card is the next stop, then the calendar is left behind quickly.
    await page.getByTestId('cal-next').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(app.card(TODAY, 'Daily standup')).toBeFocused();
    let reached = false;
    for (let i = 0; i < 8 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await app.inboxInput.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await expect(app.title).toHaveText('November 2026');
  });

  test('the hover "+" buttons are out of the tab order', async ({ app }) => {
    test.skip(app.phone, 'desktop hover +');
    await app.goto();
    const tabbable = await app.calendar.locator('[data-testid="day-add"]').evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex >= 0).length);
    expect(tabbable).toBe(0);
    const stops = await app.calendar.locator('[data-testid="day-cell"]').evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length);
    expect(stops).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// C3 — collapsed Inbox sheet on Face ID iPhones (home-indicator inset): no dead input field
// ------------------------------------------------------------------------------------------------

test.describe('C3: collapsed Inbox sheet with a bottom safe-area inset', () => {
  test('shows only the bar; a tap anywhere on it opens the sheet', async ({ app, page }) => {
    test.skip(!app.phone, 'phone sheet');
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = ':root{--safe-bottom:34px !important}';
        document.head.appendChild(s);
      });
    });
    await app.goto();
    const sheet = page.getByTestId('inbox-sheet');
    await expect(sheet).toHaveAttribute('data-snap', 'collapsed');
    await app.settle(500);
    await expect(app.inboxInput).toBeHidden();
    const vh = page.viewportSize()!.height;
    // The strip under the 56px header (where the input used to peek out).
    await page.touchscreen.tap(200, vh - 20);
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await expect(app.inboxInput).toBeVisible();
  });
});

// ------------------------------------------------------------------------------------------------
// C4 — phone: overshooting the bottom edge-scroll zone never drops the task into the Inbox
// ------------------------------------------------------------------------------------------------

test.describe('C4: dead band between the calendar edge and the Inbox pill', () => {
  test('a release just below the calendar keeps the date and time', async ({ app, page }) => {
    test.skip(!app.phone, 'phone pill');
    await app.goto();
    await app.seed([{ title: 'Call the plumber', date: TODAY, time: '15:00' }]);
    const scroller = (await page.getByTestId('month-scroller').boundingBox())!;
    await app.drag(app.card(TODAY, 'Call the plumber'), async () => ({ x: scroller.x + scroller.width / 2, y: scroller.y + scroller.height + 6 }));
    const t = await app.task('Call the plumber');
    expect([t?.date, t?.time]).toEqual([TODAY, '15:00']);
  });

  test('a release over the pill still moves it to the Inbox', async ({ app, page }) => {
    test.skip(!app.phone, 'phone pill');
    await app.goto();
    await app.seed([{ title: 'Call the plumber', date: TODAY, time: '15:00' }]);
    const pill = page.getByTestId('inbox-dropzone');
    await app.drag(app.card(TODAY, 'Call the plumber'), async () => {
      await expect(pill).toContainText('Move to Inbox');
      const b = (await pill.locator('div', { hasText: 'Move to Inbox' }).last().boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    expect((await app.task('Call the plumber'))?.date).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// C6 — keyboard drag: focus follows the moved card, the announcement says where it went
// ------------------------------------------------------------------------------------------------

test.describe('C6: keyboard drag and drop', () => {
  test('Space → → → Space moves the card two days; focus stays on it; announced with the date', async ({ app, page }) => {
    test.skip(app.phone, 'desktop keyboard');
    await app.goto();
    const [id] = await app.seed([{ title: 'KB', date: TODAY }]);
    await page.getByTestId('cal-next').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const card = app.card(TODAY, 'KB');
    await expect(card).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => app.ui((u) => u.dragging !== null)).toBe(true);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await app.task('KB'))?.date).toBe('2026-11-21');
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.occKey ?? null)).toBe(id);
    await expect
      .poll(() => page.evaluate(() => [...document.querySelectorAll('[id^="DndLiveRegion"]')].map((e) => e.textContent).join(' ')))
      .toContain('dropped on November 21, 2026');
    // Still the keyboard's card: Backspace deletes it (with Undo).
    await page.keyboard.press('Backspace');
    await expect(app.toast.filter({ hasText: 'Task deleted' })).toBeVisible();
  });
});

// ------------------------------------------------------------------------------------------------
// D5 — phone header controls have finger-sized hit areas
// ------------------------------------------------------------------------------------------------

test.describe('D5: phone header touch targets', () => {
  test('☰ ‹ Today › and the title each answer taps over ≥ 40×44', async ({ app, page }) => {
    test.skip(!app.phone, 'touch');
    await app.goto();
    for (const id of ['drawer-toggle', 'cal-prev', 'cal-today', 'cal-next', 'cal-view']) {
      const hit = await page.evaluate((tid) => {
        const el = document.querySelector<HTMLElement>(`[data-testid="calendar"] [data-testid="${tid}"]`)!;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mine = (x: number, y: number) => {
          const at = document.elementFromPoint(x, y);
          return !!at && (at === el || el.contains(at));
        };
        const reach = (dx: number, dy: number) => {
          let n = 0;
          while (n < 60 && mine(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
          return n;
        };
        return { w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1 };
      }, id);
      expect(hit.w, `${id} hit width`).toBeGreaterThanOrEqual(40);
      expect(hit.h, `${id} hit height`).toBeGreaterThanOrEqual(43);
    }
    // The title still fits next to the enlarged cluster.
    const fits = await app.title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// E3 — collapsed sidebars still signal overdue work and Inbox items (and that persists)
// ------------------------------------------------------------------------------------------------

test.describe('E3: collapsed sidebars keep their signals', () => {
  test('desktop rails show the overdue dot and the Inbox count, also in a new session', async ({ app, page, context }) => {
    test.skip(app.phone, 'desktop rails');
    await app.goto();
    await app.seed([{ title: 'Renew car insurance', date: '2026-10-20' }, { title: 'Waiting in the Inbox' }]);
    await app.key('[');
    await app.key(']');
    await app.settle(400);
    const check = async (p: Page) => {
      const open = p.getByRole('button', { name: /^Open sidebar/ });
      await expect(open).toHaveAttribute('data-dot', 'true');
      await expect(open).toHaveAttribute('aria-label', 'Open sidebar, 1 overdue');
      await expect(p.getByTestId('inbox-rail-count')).toHaveText('1');
      await expect(p.getByTestId('inbox-rail')).toHaveAttribute('aria-label', 'Open inbox, 1 task');
    };
    await check(page);
    await page.waitForTimeout(300);
    const p2 = await context.newPage();
    await p2.clock.install({ time: new Date('2026-11-19T10:00:00') });
    await p2.goto('/');
    await app.ready(p2);
    await check(p2);
    await p2.close();
  });
});

// ------------------------------------------------------------------------------------------------
// D8 — compact card times never spill past the card on narrow phones
// ------------------------------------------------------------------------------------------------

test.describe('D8: compact times', () => {
  test('iPhone SE width: "10:30 AM" stays inside its card', async ({ app, page }) => {
    test.skip(!app.phone, 'phone grid');
    await page.setViewportSize({ width: 320, height: 568 });
    await app.goto();
    await app.seed([{ title: 'Standup', date: '2026-11-24', time: '10:30' }, { title: 'Lunch', date: '2026-11-25', time: '12:45' }]);
    await app.settle(300);
    for (const [date, title, text] of [['2026-11-24', 'Standup', '10:30 AM'], ['2026-11-25', 'Lunch', '12:45 PM']] as const) {
      const r = await app.card(date, title).evaluate((card, t) => {
        const spans = [...card.querySelectorAll('span')].filter((s) => s.textContent === t);
        const time = spans[spans.length - 1]!;
        const range = document.createRange();
        range.selectNodeContents(time);
        const text = [...range.getClientRects()].reduce((m, rc) => Math.max(m, rc.right), 0);
        return { text, card: card.getBoundingClientRect().right };
      }, text);
      expect(r.text).toBeLessThanOrEqual(r.card);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// D9 — long metas in the Tasks list wrap instead of being cut off
// ------------------------------------------------------------------------------------------------

test.describe('D9: Tasks list meta', () => {
  test('a cross-year timed range shows its end date and time; the title keeps its width', async ({ app }) => {
    test.skip(app.phone, 'desktop list width');
    await app.goto();
    await app.seed([{ title: 'Ski trip with the whole family', date: '2025-12-29', endDate: '2026-01-03', time: '09:30' }]);
    await app.openTasks();
    const row = app.row('Ski trip');
    await expect(row).toContainText('Jan 3, 2026');
    const m = await row.evaluate((el) => {
      const title = el.querySelector<HTMLElement>('[data-row-focus]')!;
      const meta = title.nextElementSibling as HTMLElement;
      return {
        metaClipped: meta.scrollWidth > meta.clientWidth + 1,
        metaText: meta.textContent,
        titleH: title.getBoundingClientRect().height,
      };
    });
    expect(m.metaClipped).toBe(false);
    expect(m.metaText).toBe('Dec 29, 2025 → Jan 3, 2026 · 9:30 AM');
    expect(m.titleH).toBeLessThanOrEqual(41); // at most 2 lines of 20px
  });
});

// ------------------------------------------------------------------------------------------------
// D10 — screen-reader structure: no control nested in another; ☰ says what is overdue
// ------------------------------------------------------------------------------------------------

test.describe('D10: accessible structure', () => {
  test('list checkboxes and the sheet "+" are not inside role=button; the ☰ label counts overdue', async ({ app, page }) => {
    await app.goto();
    await app.seed([{ title: 'Late one', date: '2026-11-10' }, { title: 'Today one', date: TODAY }]);
    await app.openTasks();
    const nested = await page.getByTestId('list-checkbox').evaluateAll((els) => els.filter((e) => e.parentElement?.closest('[role="button"]')).length);
    expect(nested).toBe(0);
    // The row title is the keyboard control (Enter opens the peek).
    if (!app.phone) {
      await app.row('Today one').locator('[data-row-focus]').focus();
      await page.keyboard.press('Enter');
      await expect(app.peek).toBeVisible();
      await page.keyboard.press('Escape');
    } else {
      await app.closeTasks();
      await expect(app.calendar.getByTestId('drawer-toggle')).toHaveAttribute('aria-label', 'Open tasks, 1 overdue');
      const addNested = await page.getByTestId('inbox-sheet-add').evaluate((e) => !!e.parentElement?.closest('[role="button"]'));
      expect(addNested).toBe(false);
    }
  });
});
