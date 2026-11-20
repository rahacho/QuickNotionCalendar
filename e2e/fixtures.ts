/**
 * Shared Playwright fixtures for the Tasks E2E suite.
 *
 * Every test runs in a fresh browser context (clean IndexedDB + localStorage), with the clock installed
 * at Thu 2026-11-19 10:00 local (time then flows normally) and the app in local mode. Console errors,
 * React warnings and uncaught page errors fail the test.
 *
 * `app` wraps the page with helpers that hide the desktop/phone differences that are not under test:
 * where the Inbox and the Tasks list live (panel vs sheet/drawer), click vs tap, mouse vs long-press drags.
 */
import { test as base, expect, type Locator, type Page } from '@playwright/test';

export { expect };

export const TODAY = '2026-11-19';
export const NOW = new Date('2026-11-19T10:00:00');

export interface SeedTask {
  title: string;
  date?: string | null;
  endDate?: string | null;
  time?: string | null;
  recurrence?: {
    freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval: number;
    byWeekday?: number[] | null;
    until?: string | null;
    count?: number | null;
  } | null;
}

/** The subset of a stored task the tests look at. */
export interface TaskView {
  id: string;
  title: string;
  date: string | null;
  endDate: string | null;
  time: string | null;
  order: string;
  done: boolean;
  recurrence: { freq: string; interval: number; byWeekday?: number[] | null } | null;
  overrides: Record<string, { done?: boolean; skipped?: boolean; date?: string; time?: string | null; order?: string }>;
  reminder: { kind: string; minutes?: number; time?: string; daysBefore?: number };
}

interface Point {
  x: number;
  y: number;
}

/** Console noise that is not an app error. */
const IGNORED_CONSOLE = [/\[vite\]/i, /Download the React DevTools/i];

/** The UI state fields the tests read. */
export interface UiView {
  drawerOpen: boolean;
  sheet: 'collapsed' | 'half' | 'full';
  dragging: { occKey: string; source: string; recurring: boolean } | null;
  peek: { taskId: string; origDate: string | null } | null;
  composer: { date: string } | null;
}

/** The DEV-only window hook the calendar installs (src/components/calendar/devHooks.ts). */
interface CalHook {
  actions: {
    createTask(input: SeedTask): string;
    setSheet(s: UiView['sheet']): void;
    setDrawer(open: boolean): void;
  };
  state(): { tasks: Record<string, TaskView>; ui: UiView };
}

declare global {
  interface Window {
    __cal?: CalHook;
    __e2eTouch?: {
      start(x: number, y: number): void;
      move(x: number, y: number): void;
      end(): void;
    };
  }
}

/**
 * Synthetic single-finger touch driver (Playwright has no touch-drag API). Events go to the element
 * first touched, like real touches; works in WebKit and Chromium.
 */
function installTouchDriver(): void {
  let target: EventTarget | null = null;
  let last = { x: 0, y: 0 };
  const touchAt = (x: number, y: number): Touch => {
    const init = { identifier: 1, target: target as EventTarget, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
    try {
      return new Touch(init);
    } catch {
      const legacy = document as Document & {
        createTouch?: (...a: unknown[]) => Touch;
      };
      return legacy.createTouch!(window, target, 1, x, y, x, y);
    }
  };
  const fire = (type: string, x: number, y: number): void => {
    const t = touchAt(x, y);
    const active = type === 'touchend' ? [] : [t];
    const list = (arr: Touch[]) => Object.assign([...arr], { item: (i: number) => arr[i] ?? null });
    const ev = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(ev, 'touches', { value: list(active) });
    Object.defineProperty(ev, 'targetTouches', { value: list(active) });
    Object.defineProperty(ev, 'changedTouches', { value: list([t]) });
    target?.dispatchEvent(ev);
  };
  window.__e2eTouch = {
    start(x, y) {
      target = document.elementFromPoint(x, y);
      last = { x, y };
      fire('touchstart', x, y);
    },
    move(x, y) {
      last = { x, y };
      fire('touchmove', x, y);
    },
    end() {
      fire('touchend', last.x, last.y);
      target = null;
    },
  };
}

export class App {
  constructor(
    readonly page: Page,
    readonly phone: boolean,
  ) {}

  // ---------------------------------------------------------------- boot / state

  async goto(path = '/'): Promise<void> {
    await this.page.goto(path);
    await this.ready();
  }

  async ready(page: Page = this.page): Promise<void> {
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => !!window.__cal, null, { timeout: 10_000 });
  }

  /** Creates tasks through the store (setup only — never the behaviour under test). Returns ids in order. */
  async seed(tasks: SeedTask[], page: Page = this.page): Promise<string[]> {
    const ids = await page.evaluate((list) => list.map((t) => window.__cal!.actions.createTask(t)), tasks);
    await page.waitForTimeout(50); // let the new cards mount
    return ids;
  }

  async tasks(page: Page = this.page): Promise<TaskView[]> {
    return page.evaluate(() => Object.values(window.__cal!.state().tasks));
  }

  async task(title: string, page: Page = this.page): Promise<TaskView | undefined> {
    return (await this.tasks(page)).find((t) => t.title === title);
  }

  /** Reads the UI state through `fn` (serialized and run in the page). */
  async ui<T>(fn: (ui: UiView) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__cal.state().ui)`) as Promise<T>;
  }

  // ---------------------------------------------------------------- locators

  get calendar(): Locator {
    return this.page.getByTestId('calendar');
  }

  cell(date: string): Locator {
    return this.calendar.locator(`[data-testid="day-cell"][data-date="${date}"]`);
  }

  /** Single-day cards of a day (multi-day bars are separate, see `bar`). */
  cards(date: string): Locator {
    return this.cell(date).locator('[data-testid="task-card"]');
  }

  card(date: string, title: string): Locator {
    return this.cards(date).filter({ hasText: title });
  }

  /** Titles of a day's cards, in rendered order. */
  async cardTitles(date: string): Promise<string[]> {
    return this.cell(date)
      .locator('[data-testid="task-card"]')
      .evaluateAll((els) => els.map((e) => (e.firstElementChild?.textContent ?? '').trim()));
  }

  bar(title: string): Locator {
    return this.calendar.locator('[data-testid="bar"]').filter({ hasText: title });
  }

  get title(): Locator {
    return this.page.getByTestId('cal-title');
  }

  get toast(): Locator {
    return this.page.getByTestId('toast');
  }

  get bubbles(): Locator {
    return this.page.getByTestId('inbox-bubble');
  }

  async bubbleTitles(): Promise<string[]> {
    return this.bubbles.evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
  }

  get inboxInput(): Locator {
    return this.page.getByTestId('inbox-input');
  }

  get sidebar(): Locator {
    return this.page.getByTestId('tasks-sidebar');
  }

  group(id: string): Locator {
    return this.sidebar.locator(`[data-testid="group"][data-group-id="${id}"]`);
  }

  row(title: string): Locator {
    return this.sidebar.getByTestId('list-row').filter({ hasText: title });
  }

  get peek(): Locator {
    return this.page.getByTestId('peek');
  }

  // ---------------------------------------------------------------- interactions

  /** Click on desktop, tap on the phone. */
  async press(target: Locator): Promise<void> {
    if (this.phone) await target.tap();
    else await target.click();
  }

  /** Makes the Inbox input usable: desktop panel is always there; phone sheet opens to half. */
  async openInbox(): Promise<void> {
    if (!this.phone) {
      await expect(this.page.getByTestId('inbox')).toBeVisible();
      return;
    }
    const sheet = this.page.getByTestId('inbox-sheet');
    if ((await sheet.getAttribute('data-snap')) === 'collapsed') {
      await this.page.getByTestId('inbox-sheet-handle').tap();
    }
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await this.settle();
  }

  async closeInbox(): Promise<void> {
    if (!this.phone) return;
    const sheet = this.page.getByTestId('inbox-sheet');
    if ((await sheet.getAttribute('data-snap')) === 'collapsed') return;
    await this.page.keyboard.press('Escape');
    if ((await sheet.getAttribute('data-snap')) !== 'collapsed') {
      await this.page.evaluate(() => window.__cal!.actions.setSheet('collapsed'));
    }
    await expect(sheet).toHaveAttribute('data-snap', 'collapsed');
    await this.settle();
  }

  /** Makes the Tasks list visible: desktop left panel; phone drawer. */
  async openTasks(): Promise<void> {
    if (this.phone) {
      if (!(await this.ui((u) => u.drawerOpen))) await this.calendar.getByTestId('drawer-toggle').tap();
      await expect(this.page.getByTestId('drawer')).toBeVisible();
      await this.settle();
    }
    await expect(this.sidebar).toBeVisible();
  }

  async closeTasks(): Promise<void> {
    if (!this.phone) return;
    if (await this.ui((u) => u.drawerOpen)) {
      await this.page.evaluate(() => window.__cal!.actions.setDrawer(false));
    }
    await this.settle();
  }

  async addToInbox(...titles: string[]): Promise<void> {
    await this.openInbox();
    await this.press(this.inboxInput);
    for (const t of titles) {
      await this.inboxInput.fill(t);
      await this.inboxInput.press('Enter');
      await expect(this.inboxInput).toHaveValue('');
    }
  }

  /** A real paste event (clipboardData) on the focused field. */
  async paste(target: Locator, text: string): Promise<void> {
    await target.focus();
    await target.evaluate((el, t) => {
      const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      const data = { getData: (type: string) => (type === 'text/plain' || type === 'text' ? t : ''), types: ['text/plain'] };
      Object.defineProperty(ev, 'clipboardData', { value: data });
      el.dispatchEvent(ev);
    }, text);
  }

  async openPeek(card: Locator): Promise<void> {
    await this.press(card);
    await expect(this.peek).toBeVisible();
    await this.settle();
  }

  async closePeek(): Promise<void> {
    await this.press(this.peek.getByTestId('peek-close'));
    await expect(this.peek).toBeHidden();
  }

  /** Waits for enter/exit animations (180–260ms in the app). */
  async settle(ms = 320): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async center(target: Locator): Promise<Point> {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    if (!b) throw new Error('element has no box');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  /**
   * Drags `source` onto `to` (a locator, a point, or a function computing the point once the drag has
   * started — the phone sheet slides away and layouts shift during a drag), passing through `via`.
   * Desktop: mouse with dnd-kit's 4px threshold. Phone: 300ms long-press, then the finger moves.
   */
  async drag(
    source: Locator,
    to: Locator | Point | (() => Promise<Point>),
    opts: { grab?: Point; via?: Point[] } = {},
  ): Promise<void> {
    // Wait until the source is visible and done animating (list enter / layout motion).
    const box = await this.stableBox(source);
    const from = opts.grab ? { x: box.x + opts.grab.x, y: box.y + opts.grab.y } : { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 12) };
    const target = async (): Promise<Point> => {
      if (typeof to === 'function') return to();
      if ('x' in to) return to;
      const b = await to.boundingBox();
      if (!b) throw new Error('drop target has no box');
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const page = this.page;
    let at = from;

    if (!this.phone) {
      const glide = async (p: Point, steps: number) => {
        await page.mouse.move(p.x, p.y, { steps });
        at = p;
      };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 3, from.y + 6, { steps: 3 });
      await expect.poll(() => this.ui((u) => u.dragging !== null)).toBe(true);
      for (const v of opts.via ?? []) await glide(v, 10);
      const p = await target();
      await glide(p, 14);
      await page.waitForTimeout(120); // a few frames: the drop target is resolved in the drag frame loop
      await page.mouse.move(p.x + 1, p.y, { steps: 1 });
      await page.waitForTimeout(60);
      await page.mouse.up();
    } else {
      const glide = async (p: Point, steps: number) => {
        const start = at;
        for (let i = 1; i <= steps; i++) {
          const x = start.x + ((p.x - start.x) * i) / steps;
          const y = start.y + ((p.y - start.y) * i) / steps;
          await page.evaluate(([x, y]) => window.__e2eTouch!.move(x!, y!), [x, y]);
          await page.waitForTimeout(16);
        }
        at = p;
      };
      await page.evaluate(installTouchDriver);
      await page.evaluate(([x, y]) => window.__e2eTouch!.start(x!, y!), [from.x, from.y]);
      await page.waitForTimeout(450); // long-press (300ms) activates the touch drag
      await expect.poll(() => this.ui((u) => u.dragging !== null)).toBe(true);
      await page.waitForTimeout(250); // sheet slides away / pill rises
      for (const v of opts.via ?? []) {
        await glide(v, 10);
        await page.waitForTimeout(300);
      }
      const p = await target();
      await glide(p, 14);
      await page.waitForTimeout(150);
      await page.evaluate(() => window.__e2eTouch!.end());
    }
    await expect.poll(() => this.ui((u) => u.dragging === null)).toBe(true);
    await this.settle(400);
  }

  /** The element's box once it has stopped moving (two reads 80ms apart agree). */
  async stableBox(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    await expect(target).toBeVisible();
    let prev = await target.boundingBox();
    for (let i = 0; i < 40; i++) {
      await this.page.waitForTimeout(80);
      const next = await target.boundingBox();
      if (prev && next && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5 && Math.abs(prev.height - next.height) < 0.5) {
        return next;
      }
      prev = next;
    }
    throw new Error('element never stopped moving');
  }

  /** Swipes with a finger (no long-press): drawer edge swipes, scroll flicks. */
  async swipe(from: Point, to: Point, steps = 10): Promise<void> {
    const page = this.page;
    await page.evaluate(installTouchDriver);
    await page.evaluate(([x, y]) => window.__e2eTouch!.start(x!, y!), [from.x, from.y]);
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await page.evaluate(([x, y]) => window.__e2eTouch!.move(x!, y!), [x, y]);
      await page.waitForTimeout(16);
    }
    await page.evaluate(() => window.__e2eTouch!.end());
    await this.settle();
  }

  /** The list checkbox → 350ms optimistic check → setDone → row collapses. */
  async checkOff(title: string): Promise<void> {
    const row = this.row(title).first();
    await this.press(row.getByTestId('list-checkbox'));
    await expect(row).toHaveAttribute('data-checked', 'true');
  }

  /** Undo from the newest toast (toasts stack oldest → newest, top to bottom). */
  async undoFromToast(): Promise<void> {
    const action = this.toast.getByTestId('toast-action').last();
    await expect(action).toBeVisible();
    await this.press(action);
  }

  /** Keyboard shortcut / typing on the page body (nothing focused). */
  async key(combo: string): Promise<void> {
    await this.page.keyboard.press(combo);
  }
}

export const test = base.extend<{ app: App; keepInstallHint: boolean }>({
  keepInstallHint: [false, { option: true }],
  app: async ({ page, isMobile, keepInstallHint }, use) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      const text = m.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      problems.push(`[${m.type()}] ${text}`);
    });
    page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

    await page.clock.install({ time: NOW });
    if (!keepInstallHint) {
      // The iOS "Add to Home Screen" card floats over the header in Safari; it has its own test.
      await page.addInitScript(() => {
        try {
          localStorage.setItem('tasks.installHint.dismissed', '1');
        } catch {
          // storage unavailable — the hint may show; tests that care check for it
        }
      });
    }
    const app = new App(page, isMobile);
    await use(app);
    expect(problems, 'console errors / warnings during the test').toEqual([]);
  },
});
