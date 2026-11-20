import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(',');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('inert') || el.closest('[inert]')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
}

/** Keeps Tab / Shift+Tab cycling inside `root`. Call from a keydown handler on the root. */
export function trapTab(e: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement): void {
  if (e.key !== 'Tab') return;
  const list = focusableWithin(root);
  if (!list.length) {
    e.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }
  const first = list[0]!;
  const last = list[list.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/** Focus `el` without scrolling, ignoring detached elements. */
export function safeFocus(el: Element | null | undefined): void {
  if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
}
