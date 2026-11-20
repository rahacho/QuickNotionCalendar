import { memo, useId, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, ChevronsLeft, Settings } from 'lucide-react';
import type { ListGroup } from '@shared/types';
import { useStore } from '@/store/store';
import { moveAllOverdueToToday, setDrawer, setSettingsOpen, showMoreCompleted, toggleGroup } from '@/store/actions';
import { useTaskGroups } from '@/store/selectors';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { cx } from '@/lib/cx';
import { COLLAPSED, EXPANDED, FRAMELOOP_ONLY, useListTransition } from './listMotion';
import { SyncStatus } from './SyncStatus';
import { TaskRow } from './TaskRow';
import { useScrollEdges } from './useScrollEdges';
import './devHooks';
import styles from './TasksSidebar.module.css';

/**
 * Left "Tasks" list (desktop column; phone/tablet Drawer): everything on the calendar grouped as
 * Overdue · Today · Tomorrow · next days · Later · Completed, so nothing planned is out of sight.
 * AppShell paints the sidebar background, the edge hairline and the safe-area padding.
 */
export function TasksSidebar() {
  const groups = useTaskGroups();
  const collapsedGroups = useStore((s) => s.ui.collapsedGroups);
  const inDrawer = useLayoutMode() !== 'desktop';
  const hasOpenWork = groups.some((g) => g.id !== 'completed');
  const scrollRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(scrollRef);

  return (
    <div
      className={cx(styles.root, inDrawer && styles.inDrawer)}
      data-testid="tasks-sidebar"
      data-scrolled={edges.scrolled ? '' : undefined}
      data-more-below={edges.moreBelow ? '' : undefined}
    >
      <div className={cx(styles.header, inDrawer && styles.headerDrawer)}>
        <span className={styles.glyph} aria-hidden="true">
          <Icon icon={Check} size={13} strokeWidth={2.5} className={styles.glyphIcon} />
        </span>
        <h2 className={styles.headerTitle}>Tasks</h2>
        {inDrawer && (
          <IconButton label="Close tasks" icon={ChevronsLeft} onClick={() => setDrawer(false)} tooltip={false} />
        )}
      </div>

      <motion.div ref={scrollRef} layoutScroll className={styles.scroll}>
        <AnimatePresence initial={false}>
          {!hasOpenWork && <EmptyState key="empty" />}
          {groups.map((g) => (
            <TaskGroupSection
              key={g.id}
              group={g}
              collapsed={isCollapsed(g, collapsedGroups)}
            />
          ))}
        </AnimatePresence>
      </motion.div>

      <div className={styles.footer}>
        <SyncStatus />
        <button type="button" className={styles.navItem} data-testid="settings-open" onClick={() => setSettingsOpen(true)}>
          <span className={styles.navIcon} aria-hidden="true">
            <Icon icon={Settings} size={16} />
          </span>
          <span className={styles.navLabel}>Settings</span>
        </button>
      </div>
    </div>
  );
}

/** Persisted per device; a group the device has no preference for uses its default (Later/Completed: collapsed). */
function isCollapsed(group: ListGroup, prefs: Record<string, boolean>): boolean {
  if (!group.collapsible) return false;
  return Object.prototype.hasOwnProperty.call(prefs, group.id) ? prefs[group.id] === true : group.defaultCollapsed;
}

function EmptyState() {
  const transition = useListTransition();
  return (
    <motion.div
      className={styles.emptyWrap}
      initial={COLLAPSED}
      animate={EXPANDED}
      exit={COLLAPSED}
      transition={transition}
      onUpdate={FRAMELOOP_ONLY}
    >
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>Nothing planned</p>
        <p className={styles.emptyText}>Tasks you put on the calendar show up here, grouped by day.</p>
      </div>
    </motion.div>
  );
}

const TaskGroupSection = memo(function TaskGroupSection({ group, collapsed }: { group: ListGroup; collapsed: boolean }) {
  const transition = useListTransition();
  const titleId = useId();
  const rowsId = useId();
  const isOverdue = group.id === 'overdue';
  const hidden = group.count - group.items.length;

  return (
    <motion.section
      className={styles.group}
      data-testid="group"
      data-group-id={group.id}
      aria-labelledby={titleId}
      initial={COLLAPSED}
      animate={EXPANDED}
      exit={COLLAPSED}
      transition={transition}
      onUpdate={FRAMELOOP_ONLY}
    >
      <GroupHeader group={group} collapsed={collapsed} titleId={titleId} rowsId={rowsId} />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="rows"
            id={rowsId}
            role="list"
            aria-label={isOverdue ? 'Overdue tasks' : `${group.title} tasks`}
            initial={COLLAPSED}
            animate={EXPANDED}
            exit={COLLAPSED}
            transition={transition}
            onUpdate={FRAMELOOP_ONLY}
          >
            <AnimatePresence initial={false}>
              {group.items.map((item) => (
                <TaskRow key={item.occ.key} item={item} />
              ))}
            </AnimatePresence>
            {hidden > 0 && (
              <p className={styles.more}>
                <span>
                  Showing the latest {group.items.length} of {group.count}
                </span>
                <button type="button" className={styles.showMore} data-testid="completed-show-more" onClick={() => showMoreCompleted()}>
                  Show more
                </button>
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
});

function GroupHeader({
  group,
  collapsed,
  titleId,
  rowsId,
}: {
  group: ListGroup;
  collapsed: boolean;
  titleId: string;
  rowsId: string;
}) {
  if (group.id === 'overdue') {
    return (
      <div className={styles.groupHeader}>
        <span id={titleId} className={cx(styles.groupTitle, styles.red)}>
          {group.title}
        </span>
        <span className={styles.groupCountInline}>{group.count}</span>
        <button
          type="button"
          className={styles.moveAll}
          data-testid="overdue-move-all"
          onClick={() => moveAllOverdueToToday()}
        >
          Move all to today
        </button>
      </div>
    );
  }

  const content = (
    <>
      <span id={titleId} className={styles.groupTitle}>
        {group.title}
      </span>
      {group.subtitle !== '' && <span className={styles.groupSub}>{group.subtitle}</span>}
      {group.collapsible && (
        <Icon icon={ChevronRight} size={12} strokeWidth={2.25} className={cx(styles.caret, !collapsed && styles.caretOpen)} />
      )}
      <span className={styles.groupCount} aria-label={`${group.count} ${group.count === 1 ? 'task' : 'tasks'}`}>
        {group.count}
      </span>
    </>
  );

  if (!group.collapsible) return <div className={styles.groupHeader}>{content}</div>;

  return (
    <button
      type="button"
      className={cx(styles.groupHeader, styles.groupToggle)}
      data-testid="group-toggle"
      aria-expanded={!collapsed}
      aria-controls={collapsed ? undefined : rowsId}
      onClick={() => toggleGroup(group.id, group.defaultCollapsed)}
    >
      {content}
    </button>
  );
}
