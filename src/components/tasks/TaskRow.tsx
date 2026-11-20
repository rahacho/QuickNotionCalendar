import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Repeat } from 'lucide-react';
import type { ListItem } from '@shared/types';
import { refOf } from '@shared/occurrences';
import { openPeek, setDone } from '@/store/actions';
import { useDraggableTask } from '@/dnd';
import { Checkbox } from '@/components/ui/Checkbox';
import { cx } from '@/lib/cx';
import { splitDragProps } from './dragProps';
import { COLLAPSED, EXPANDED, FRAMELOOP_ONLY, justDragged, useListTransition } from './listMotion';
import styles from './TasksSidebar.module.css';

/** Check → the box fills and the title strikes through, then the change is committed (SPEC §6). */
const CHECK_COMMIT_MS = 350;
/** Uncheck (Completed group) → a short beat so the box visibly clears before the row moves. */
const UNCHECK_COMMIT_MS = 150;
/** If a committed row is still on screen after this, the store is the source of truth again. */
const SETTLE_MS = 800;

interface Pending {
  value: boolean;
  /** The list item the row showed when the change was committed (identity = "same frozen row"). */
  item: ListItem;
  committed: boolean;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * "Dec 29, 2025 → Jan 3, 2026 · 9:30 AM": dates and times never break inside; a long meta wraps at its
 * " → " / " · " joints instead of being cut off (the end date and time of a plan must stay readable).
 */
function MetaText({ text }: { text: string }) {
  // Break before a joint, so a wrapped line starts with "→ Jan 3, 2026" / "· 9:30 AM".
  const parts = text.split(/ (?=→ |· )/);
  return (
    <span className={styles.rowMetaText}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={styles.rowMetaSeg}>{p}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * One task in the left list: Notion to-do checkbox, wrapping title, right-aligned meta. Clicking the row
 * opens the peek; long-press / drag moves it onto the calendar or into the Inbox.
 *
 * Completion choreography: the checkbox flips locally right away (fill + check draw + strikethrough fade),
 * the store write happens 350ms later, and the row then collapses out of its group (AnimatePresence). The
 * timer is deliberately not cancelled on unmount — the click expressed the user's intent.
 */
export const TaskRow = memo(function TaskRow({ item }: { item: ListItem }) {
  const { occ } = item;
  const isPresent = useIsPresent();
  const transition = useListTransition();
  const [pending, setPending] = useState<Pending | null>(null);

  const itemRef = useRef(item);
  useLayoutEffect(() => {
    itemRef.current = item;
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // While exiting, AnimatePresence keeps rendering this row with the item it had at commit time, so the
  // optimistic value stays on screen. A different item object means fresh data (e.g. Undo revived it).
  const live = pending !== null && (!pending.committed || pending.item === item);
  const checked = live ? pending.value : occ.done;

  // Safety net: a commit that didn't remove the row (refused / no-op) hands control back to the store.
  useEffect(() => {
    if (!pending?.committed || !isPresent) return;
    const t = window.setTimeout(() => setPending(null), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [pending, isPresent]);

  const drag = useDraggableTask({ occ, source: 'list', disabled: live || occ.done });
  const dragProps = splitDragProps(drag);

  const onCheck = (next: boolean) => {
    if (live || !isPresent) return;
    const ref = refOf(occ);
    setPending({ value: next, item, committed: false });
    window.setTimeout(
      () => {
        setDone(ref, next);
        if (mounted.current) setPending({ value: next, item: itemRef.current, committed: true });
      },
      next ? CHECK_COMMIT_MS : UNCHECK_COMMIT_MS,
    );
  };

  const open = () => {
    if (!isPresent || justDragged()) return;
    openPeek(refOf(occ));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      open();
      return;
    }
    dragProps.onKeyDown?.(e);
  };

  const hasTitle = occ.title.trim().length > 0;
  const title = hasTitle ? occ.title : 'Untitled';
  const showMeta = item.meta !== '' || occ.recurring;
  // The row is the drag surface (pointer); the title is the keyboard / screen-reader control (open with
  // Enter, Space starts a keyboard drag) and the checkbox its sibling — no control nested in another.
  const { 'data-dnd-draggable': draggableMark, ...a11y } = dragProps.attributes;

  return (
    <motion.div
      layout="position"
      className={styles.rowWrap}
      initial={COLLAPSED}
      animate={EXPANDED}
      exit={COLLAPSED}
      transition={transition}
      onUpdate={FRAMELOOP_ONLY}
      style={isPresent ? undefined : { pointerEvents: 'none' }}
    >
      <div
        ref={drag.setNodeRef}
        data-dnd-draggable={draggableMark as string | undefined}
        {...dragProps.listeners}
        onClick={open}
        style={drag.style}
        data-testid="list-row"
        data-occ-key={occ.key}
        data-checked={checked ? 'true' : 'false'}
        className={cx(
          styles.row,
          checked && styles.rowChecked,
          item.overdue && !checked && styles.rowOverdue,
          drag.isDragging && styles.rowDragging,
        )}
      >
        {/* The checkbox never starts a drag (mouse wobble while clicking, long-press on touch). */}
        <span className={styles.rowCheck} onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}>
          <Checkbox checked={checked} onChange={onCheck} data-testid="list-checkbox" aria-label={title} />
        </span>
        <span className={styles.rowBody}>
          <span
            ref={drag.setActivatorNodeRef}
            className={cx(styles.rowTitle, !hasTitle && styles.untitled)}
            {...a11y}
            role="button"
            tabIndex={0}
            data-row-focus=""
            onKeyDown={onKeyDown}
          >
            {title}
          </span>
          {showMeta && (
            <span className={styles.rowMeta}>
              {item.meta !== '' && <MetaText text={item.meta} />}
              {occ.recurring && (
                <Repeat size={12} strokeWidth={2} className={styles.rowRepeat} aria-label="Repeats" role="img" />
              )}
            </span>
          )}
        </span>
      </div>
    </motion.div>
  );
});
