import { useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Ban } from 'lucide-react';
import { useStore } from '@/store/store';
import { useInboxTasks } from '@/store/selectors';
import { useInboxDropTarget } from '@/dnd';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { FRAMELOOP_ONLY, useListTransition } from '@/components/tasks/listMotion';
import { InboxInput } from './InboxInput';
import { InboxList } from './InboxList';
import { scrollToTop } from './scroll';
import styles from './InboxPanel.module.css';

/**
 * Right "Inbox" column (desktop/tablet): a brain-dump input and the unscheduled tasks as Notion cards.
 * The whole column is a drop target, so calendar cards and list rows can be dragged back into it.
 * AppShell paints the background, the edge hairline, safe-area padding and the hover « collapse button.
 */
export function InboxPanel() {
  const tasks = useInboxTasks();
  const drop = useInboxDropTarget();
  const dragging = useStore((s) => s.ui.dragging);
  const listRef = useRef<HTMLDivElement>(null);
  const transition = useListTransition();

  // Highlight only for things coming in from outside (reordering inside the Inbox is the list's business).
  const incoming = dragging !== null && dragging.source !== 'inbox';
  const recurring = dragging?.recurring === true;
  const accept = drop.isOver && incoming && !recurring;
  const refuse = drop.isOver && incoming && recurring;

  const onCreated = useCallback(() => scrollToTop(listRef.current), []);
  const count = tasks.length;

  return (
    <div
      ref={drop.setNodeRef}
      className={cx(styles.panel, accept && styles.accept)}
      data-testid="inbox"
      data-drop-over={accept ? 'true' : undefined}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>Inbox</h2>
        {count > 0 && (
          <span className={styles.count} aria-label={`${count} ${count === 1 ? 'task' : 'tasks'}`}>
            {count}
          </span>
        )}
      </div>
      <div className={styles.inputRow}>
        <InboxInput onCreated={onCreated} />
      </div>
      <InboxList ref={listRef} tasks={tasks} className={styles.list} />
      <AnimatePresence>
        {refuse && (
          <motion.div
            key="refuse"
            className={styles.refuse}
            role="status"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={transition}
            onUpdate={FRAMELOOP_ONLY}
          >
            <Icon icon={Ban} size={14} />
            <span>Repeating tasks stay on the calendar</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
