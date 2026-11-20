import { platform } from './platform';

/** True when keyboard input is going into a text field / editable element (shortcuts must not fire). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // Non-text inputs (checkbox, button, range…) don't capture typing.
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }
  return target.closest('[contenteditable=""],[contenteditable="true"]') !== null;
}

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

const cache = new Map<string, ParsedCombo>();

export function parseCombo(combo: string): ParsedCombo {
  const hit = cache.get(combo);
  if (hit) return hit;
  // "mod+z", "shift+ArrowLeft", "[", "+" (a lone plus), "mod++"
  const parts = combo === '+' ? ['+'] : combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+');
  const parsed: ParsedCombo = { key: '', mod: false, shift: false, alt: false, ctrl: false, meta: false };
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'mod') parsed.mod = true;
    else if (p === 'shift') parsed.shift = true;
    else if (p === 'alt' || p === 'option') parsed.alt = true;
    else if (p === 'ctrl' || p === 'control') parsed.ctrl = true;
    else if (p === 'meta' || p === 'cmd') parsed.meta = true;
    else parsed.key = raw;
  }
  cache.set(combo, parsed);
  return parsed;
}

function normKey(k: string): string {
  if (k === 'Esc') return 'escape';
  if (k === 'Spacebar') return ' ';
  return k.toLowerCase();
}

/**
 * Does the keyboard event match the combo? "mod" = ⌘ on Mac, Ctrl elsewhere. Modifiers must match exactly
 * (so "t" doesn't fire on ⌘T); Shift is ignored for symbol keys like "[" / "?" whose glyph implies it.
 */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const c = parseCombo(combo);
  const wantMeta = c.meta || (c.mod && platform.isMac);
  const wantCtrl = c.ctrl || (c.mod && !platform.isMac);
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== c.alt) return false;
  const key = normKey(c.key);
  const evKey = normKey(e.key);
  const isLetter = /^[a-z]$/.test(key);
  if (isLetter || key.length > 1) {
    if (e.shiftKey !== c.shift) return false;
  } else if (c.shift && !e.shiftKey) {
    return false;
  }
  if (evKey === key) return true;
  // Layout-independent fallback for letters (e.g. ⌘Z while a non-Latin layout is active).
  if (isLetter && e.code === `Key${key.toUpperCase()}`) return true;
  return false;
}

/** Human label for a combo: "mod+z" → "⌘Z" on Mac, "Ctrl+Z" elsewhere. */
export function hotkeyLabel(combo: string): string {
  const c = parseCombo(combo);
  const names: Record<string, string> = {
    arrowleft: '←',
    arrowright: '→',
    arrowup: '↑',
    arrowdown: '↓',
    escape: 'Esc',
    enter: platform.isMac ? '↵' : 'Enter',
    backspace: platform.isMac ? '⌫' : 'Backspace',
    ' ': 'Space',
  };
  const k = names[c.key.toLowerCase()] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (platform.isMac) {
    return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod || c.meta ? '⌘' : ''}${k}`;
  }
  const mods = [c.ctrl || c.mod ? 'Ctrl' : '', c.alt ? 'Alt' : '', c.shift ? 'Shift' : '', c.meta ? 'Win' : ''].filter(Boolean);
  return [...mods, k].join('+');
}
