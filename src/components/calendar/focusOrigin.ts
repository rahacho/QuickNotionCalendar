/**
 * Where focus came from. A destructive single-key shortcut (Backspace / Delete on a focused card) only
 * applies to an element the user moved focus to WITH THE KEYBOARD (Tab, arrows, a keyboard drop). An
 * element that got focus from a click, or had it handed back when a peek / popover / menu closed, is
 * not armed: "open a task, fix its title, Esc, Backspace" must never delete the task.
 */

const NAV_KEYS = new Set(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** A focus change this soon after a navigation key is that key's doing. */
const NAV_WINDOW_MS = 150;

let navAt = -Infinity;
let last: Element | null = null;
const keyboardFocused = new WeakSet<Element>();
let installed = false;

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'keydown',
    (e) => {
      if (NAV_KEYS.has(e.key)) navAt = performance.now();
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      // Focus coming back to the same element from outside the page (app / window switch) keeps its origin.
      if (t === last && e.relatedTarget === null && !keyboardJustMoved()) return;
      last = t;
      if (keyboardJustMoved()) keyboardFocused.add(t);
      else keyboardFocused.delete(t);
    },
    true,
  );
}

function keyboardJustMoved(): boolean {
  return performance.now() - navAt <= NAV_WINDOW_MS;
}

install();

/** True when `el` has focus and got it from keyboard navigation. */
export function isKeyboardFocused(el: Element): boolean {
  return typeof document !== 'undefined' && document.activeElement === el && keyboardFocused.has(el);
}

/** For focus moved by our own keyboard flows (e.g. after a keyboard drop). */
export function markKeyboardFocused(el: Element): void {
  keyboardFocused.add(el);
  last = el;
}
