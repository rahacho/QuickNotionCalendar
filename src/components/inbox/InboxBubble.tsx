import { memo, useRef, useState, type KeyboardEvent } from 'react';
import { motion, useIsPresent, type TargetAndTransition } from 'motion/react';
import { Ellipsis, Maximize2, Sun, Sunrise, Trash } from 'lucide-react';
import type { Occurrence } from '@shared/types';
import { addDays } from '@shared/dates';
import { refOf } from '@shared/occurrences';
import { useStore } from '@/store/store';
import { deleteOccurrence, moveOccurrence, openPeek } from '@/store/actions';
import { containerIds, useSortableTask } from '@/dnd';
import { TaskCard } from '@/components/card/TaskCard';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { cx } from '@/lib/cx';
import { splitDragProps } from '@/components/tasks/dragProps';
import { COLLAPSED, FRAMELOOP_ONLY, justDragged, useListTransition } from '@/components/tasks/listMotion';
import styles from './Inbox.module.css';

/** A new bubble drops in just under the input while the others glide down. */
const ENTER_FROM: TargetAndTransition = { height: 0, opacity: 0, y: -6, overflow: 'hidden' };
const ENTER_TO: TargetAndTransition = { height: 'auto', opacity: 1, y: 0, transitionEnd: { overflow: 'visible' } };

/**
 * One Inbox task: the Notion "page" rectangle (TaskCard variant="inbox"). Click/Enter opens the peek,
 * drag (mouse 4px / long-press) moves it onto a day or reorders it, Space starts a keyboard drag.
 * Desktop: hovering reveals a small ⋯ with quick actions.
 */
export const InboxBubble = memo(function InboxBubble({ occ, menuEnabled }: { occ: Occurrence; menuEnabled: boolean }) {
  const isPresent = useIsPresent();
  const transition = useListTransition();
  const sortable = useSortableTask({ occ, source: 'inbox', containerId: containerIds.inbox });
  const dragProps = splitDragProps(sortable);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const open = () => {
    if (!isPresent || justDragged()) return;
    openPeek(refOf(occ));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      open();
      return;
    }
    dragProps.onKeyDown?.(e);
  };

  const scheduleIn = (days: number) => moveOccurrence(refOf(occ), addDays(useStore.getState().today, days));

  return (
    <motion.div
      className={styles.bubbleWrap}
      initial={ENTER_FROM}
      animate={ENTER_TO}
      exit={COLLAPSED}
      transition={transition}
      onUpdate={FRAMELOOP_ONLY}
      style={isPresent ? undefined : { pointerEvents: 'none' }}
      role="listitem"
    >
      <div className={cx(styles.slot, menuOpen && styles.slotMenuOpen)}>
        <TaskCard
          ref={sortable.setNodeRef}
          occ={occ}
          variant="inbox"
          dragging={sortable.isDragging}
          role="button"
          tabIndex={0}
          {...dragProps.attributes}
          {...dragProps.listeners}
          onKeyDown={onKeyDown}
          onClick={open}
          style={sortable.style}
          className={styles.bubble}
          data-testid="inbox-bubble"
          data-task-id={occ.taskId}
        />
        {menuEnabled && (
          <>
            <IconButton
              ref={moreRef}
              label="More actions"
              icon={Ellipsis}
              size={24}
              tooltip={false}
              active={menuOpen}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={styles.more}
              data-testid="inbox-bubble-menu"
              onClick={() => setMenuOpen((o) => !o)}
            />
            <Popover open={menuOpen} onOpenChange={setMenuOpen} anchor={moreRef} placement="bottom-end" width={224} role="none">
              <Menu aria-label="Inbox task actions">
                <MenuItem icon={Maximize2} label="Open" onSelect={() => openPeek(refOf(occ))} />
                <MenuItem icon={Sun} label="Schedule for today" onSelect={() => scheduleIn(0)} />
                <MenuItem icon={Sunrise} label="Schedule for tomorrow" onSelect={() => scheduleIn(1)} />
                <MenuSeparator />
                <MenuItem icon={Trash} label="Delete" danger onSelect={() => deleteOccurrence(refOf(occ))} />
              </Menu>
            </Popover>
          </>
        )}
      </div>
    </motion.div>
  );
});
