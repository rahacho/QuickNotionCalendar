import { forwardRef, useMemo, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Occurrence, Task } from '@shared/types';
import { getOccurrence } from '@shared/occurrences';
import { useStore } from '@/store/store';
import { internOccurrence } from '@/store/selectors';
import { containerIds, dragIds, SortableList } from '@/dnd';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion';
import { DUR, EASE } from '@/lib/motion';
import { cx } from '@/lib/cx';
import { FRAMELOOP_ONLY } from '@/components/tasks/listMotion';
import { InboxBubble } from './InboxBubble';
import styles from './Inbox.module.css';

export interface InboxListProps {
  tasks: Task[];
  className?: string;
  style?: CSSProperties;
}

/**
 * The Inbox bubbles (newest first) in a dnd-kit sortable container, plus the empty state. The forwarded
 * ref is the scroll container.
 */
export const InboxList = forwardRef<HTMLDivElement, InboxListProps>(function InboxList({ tasks, className, style }, ref) {
  const occs = useMemo(() => {
    const out: Occurrence[] = [];
    for (const t of tasks) {
      const o = getOccurrence(t, null);
      if (o) out.push(internOccurrence(o));
    }
    return out;
  }, [tasks]);
  // SortableList always renders a plain fragment (stable tree), so AnimatePresence below keeps the
  // first bubble's enter and the last bubble's exit animation.
  const itemIds = useMemo(() => occs.map((o) => dragIds.inbox(o.taskId)), [occs]);
  const canHover = useMediaQuery('(hover: hover) and (pointer: fine)');
  const dragActive = useStore((s) => s.ui.dragging !== null);
  const reduced = usePrefersReducedMotion();

  return (
    <div ref={ref} className={cx(styles.list, dragActive && styles.listDragging, className)} style={style}>
      <div role="list" aria-label="Inbox tasks" className={styles.bubbles}>
        <SortableList containerId={containerIds.inbox} itemIds={itemIds}>
          <AnimatePresence initial={false}>
            {occs.map((o) => (
              <InboxBubble key={o.taskId} occ={o} menuEnabled={canHover} />
            ))}
          </AnimatePresence>
        </SortableList>
      </div>
      <AnimatePresence initial={false}>
        {occs.length === 0 && (
          <motion.div
            key="empty"
            className={styles.empty}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: reduced ? { duration: 0 } : { duration: DUR.base, ease: EASE, delay: 0.12 } }}
            exit={{ opacity: 0, transition: { duration: 0 } }}
            onUpdate={FRAMELOOP_ONLY}
          >
            <p className={styles.emptyTitle}>Get it out of your head.</p>
            <p className={styles.emptyText}>Type anything above, then drag it onto a day.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
