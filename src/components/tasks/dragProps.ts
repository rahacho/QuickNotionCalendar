import type { KeyboardEvent } from 'react';

type Listener = (e: unknown) => void;

export interface SplitDragProps {
  /** dnd-kit attributes minus `aria-disabled` (a non-draggable row still has a working checkbox). */
  attributes: Record<string, unknown>;
  /** Pointer/touch activators to spread on the drag node. */
  listeners: Record<string, Listener>;
  /** Keyboard activator (Space starts a keyboard drag) — call it only for keys you don't handle. */
  onKeyDown: ((e: KeyboardEvent<HTMLElement>) => void) | undefined;
}

/**
 * Splits a dnd hook result so the owner can keep Enter for "open" and keys pressed on inner controls
 * (checkbox, ⋯) away from the drag sensor.
 */
export function splitDragProps(handle: {
  attributes: Record<string, unknown>;
  listeners: Record<string, Function> | undefined;
}): SplitDragProps {
  const { 'aria-disabled': _ariaDisabled, ...attributes } = handle.attributes;
  const { onKeyDown, ...listeners } = (handle.listeners ?? {}) as Record<string, Listener>;
  return { attributes, listeners, onKeyDown };
}
