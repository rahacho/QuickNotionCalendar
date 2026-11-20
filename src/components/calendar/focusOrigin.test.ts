// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isKeyboardFocused, markKeyboardFocused } from './focusOrigin';

/**
 * Review D3: Backspace deleted the card that a closing peek handed focus back to. Only focus the user
 * moved with the keyboard arms the destructive shortcut.
 */
describe('focusOrigin', () => {
  let now = 10_000;
  let a: HTMLButtonElement;
  let b: HTMLButtonElement;

  beforeEach(() => {
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    a = document.getElementById('a') as HTMLButtonElement;
    b = document.getElementById('b') as HTMLButtonElement;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (document.activeElement as HTMLElement | null)?.blur();
  });

  const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('focus that follows Tab / arrows is keyboard focus', () => {
    key('Tab');
    now += 5;
    a.focus();
    expect(isKeyboardFocused(a)).toBe(true);
    now += 1000;
    key('ArrowRight');
    b.focus();
    expect(isKeyboardFocused(b)).toBe(true);
  });

  it('focus from a click or code (no navigation key) is not', () => {
    now += 1000;
    a.focus();
    expect(isKeyboardFocused(a)).toBe(false);
  });

  it('focus handed back after an overlay closed (Esc) is not, even if Tab reached it first', () => {
    key('Tab');
    a.focus();
    expect(isKeyboardFocused(a)).toBe(true);
    now += 1000;
    b.focus(); // the peek takes focus
    now += 1000;
    key('Escape');
    a.focus(); // …and restores it on close
    expect(isKeyboardFocused(a)).toBe(false);
  });

  it('coming back to the page keeps the origin', () => {
    key('Tab');
    a.focus();
    now += 5000;
    a.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: null }));
    expect(isKeyboardFocused(a)).toBe(true);
  });

  it('markKeyboardFocused arms an element our keyboard flow focused late (after a keyboard drop)', () => {
    now += 1000;
    a.focus();
    markKeyboardFocused(a);
    expect(isKeyboardFocused(a)).toBe(true);
    expect(isKeyboardFocused(b)).toBe(false); // not focused at all
  });
});
