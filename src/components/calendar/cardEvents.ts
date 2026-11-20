import type { KeyboardEvent } from 'react';
import type { Occurrence } from '@shared/types';
import { getOccurrence, refOf } from '@shared/occurrences';
import { useStore } from '@/store/store';
import { deleteOccurrence, openPeek } from '@/store/actions';
import { getDndState } from '@/dnd';
import { resizeJustEnded } from './resize';
import { isKeyboardFocused } from './focusOrigin';

/** Click on a card / bar → open its peek (unless the click is the tail of a resize). */
export function openCard(occ: Occurrence): void {
  if (resizeJustEnded() || getDndState().active) return;
  openPeek(refOf(occ));
}

/**
 * Enter opens, Backspace/Delete deletes (with the Undo toast). Space is the keyboard drag.
 * Deleting needs a card the user reached with the keyboard: a card focused by a click, or one that got
 * focus back when its peek closed (Esc), ignores a stray Backspace.
 */
export function cardKeyDown(e: KeyboardEvent<HTMLElement>, occ: Occurrence): void {
  if (e.defaultPrevented || e.target !== e.currentTarget || getDndState().active) return;
  if (e.key === 'Enter' && !e.repeat) {
    e.preventDefault();
    openPeek(refOf(occ));
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (!isKeyboardFocused(e.currentTarget)) return;
    e.preventDefault();
    deleteOccurrence(refOf(occ));
  }
}

/**
 * Exit animation choice for a card that left a cell: completed / deleted cards fade + shrink (Notion),
 * cards that merely moved (drag, date edit, resize into a bar, sent to the Inbox) vanish instantly —
 * their new home shows them.
 */
export function exitKindOf(occ: Occurrence): 'removed' | 'moved' {
  const task = useStore.getState().tasks[occ.taskId];
  if (!task) return 'removed';
  const now = getOccurrence(task, occ.origDate);
  if (!now || now.done) return 'removed';
  return 'moved';
}
