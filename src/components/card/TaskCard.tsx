import { forwardRef, memo, type ForwardRefExoticComponent, type HTMLAttributes, type RefAttributes } from 'react';
import { Repeat } from 'lucide-react';
import type { Occurrence } from '@shared/types';
import { formatTime } from '@shared/format';
import { cx } from '@/lib/cx';
import styles from './TaskCard.module.css';

export interface TaskCardProps extends HTMLAttributes<HTMLDivElement> {
  occ: Occurrence;
  /**
   * calendar — card in a day cell (sizes from the --cal-card-* tokens, so a .compact grid restyles it)
   * compact  — phone grid (cell < 96px): 11px/13px
   * inbox    — full-width bubble in the Inbox
   * bar      — multi-day bar, one line (or wrapped with `wrap`), flat edge where it continues
   * overlay  — the drag preview (lifted shadow, grabbing cursor, fills the overlay box)
   */
  variant: 'calendar' | 'compact' | 'inbox' | 'bar' | 'overlay';
  overdue?: boolean;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  /** Source card while its drag overlay is in flight → faded ghost (opacity .35). */
  dragging?: boolean;
  /** Extra (non-contract): compact metrics for `bar` / `overlay` (phone grid drags & bars). */
  compact?: boolean;
  /** Extra (non-contract): `bar` shows its full name wrapped (height grows) instead of one line + ellipsis. */
  wrap?: boolean;
}

/**
 * The Notion calendar "page" rectangle. Spreads any extra props (dnd-kit listeners/attributes, onClick,
 * style, data-*) onto the root and renders `children` last (e.g. resize handles), so consumers can wire
 * drag & resize without wrappers. Memoised on what it displays.
 */
const TaskCardImpl = forwardRef<HTMLDivElement, TaskCardProps>(function TaskCard(
  { occ, variant, overdue = false, continuesBefore, continuesAfter, dragging, compact, wrap, className, children, ...rest },
  ref,
) {
  const isBar = variant === 'bar';
  const time = occ.time ? formatTime(occ.time) : '';
  const hasTitle = occ.title.trim().length > 0;
  const showMeta = !isBar && (time !== '' || occ.recurring);
  const iconSize = variant === 'compact' || compact ? 10 : 12;

  return (
    <div
      ref={ref}
      data-testid="task-card"
      data-occ-key={occ.key}
      data-overdue={overdue ? 'true' : 'false'}
      data-variant={variant}
      data-wrap={isBar && wrap ? 'true' : undefined}
      title={isBar ? occ.title : undefined}
      className={cx(
        styles.card,
        styles[variant],
        (compact || variant === 'compact') && styles.compactMetrics,
        isBar && wrap && styles.barWrap,
        overdue && styles.overdue,
        occ.done && styles.done,
        isBar && continuesBefore && styles.flatStart,
        isBar && continuesAfter && styles.flatEnd,
        dragging && styles.dragging,
        className,
      )}
      {...rest}
    >
      {isBar ? (
        <span className={styles.barLine}>
          <span className={cx(styles.title, !hasTitle && styles.untitled)}>{hasTitle ? occ.title : 'Untitled'}</span>
          {time && !continuesBefore && <span className={styles.barTime}>{time}</span>}
        </span>
      ) : (
        <>
          <span className={cx(styles.title, !hasTitle && styles.untitled)}>{hasTitle ? occ.title : 'Untitled'}</span>
          {showMeta && (
            <span className={styles.meta}>
              {time && <span className={styles.time}>{time}</span>}
              {occ.recurring && (
                <Repeat
                  size={iconSize}
                  strokeWidth={2}
                  className={styles.repeat}
                  aria-label="Repeats"
                  role="img"
                />
              )}
            </span>
          )}
        </>
      )}
      {children}
    </div>
  );
});

function sameOcc(a: Occurrence, b: Occurrence): boolean {
  return (
    a === b ||
    (a.key === b.key &&
      a.title === b.title &&
      a.time === b.time &&
      a.recurring === b.recurring &&
      a.done === b.done &&
      a.date === b.date &&
      a.endDate === b.endDate)
  );
}

function propsEqual(prev: TaskCardProps, next: TaskCardProps): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const a = (prev as unknown as Record<string, unknown>)[k];
    const b = (next as unknown as Record<string, unknown>)[k];
    if (k === 'occ') {
      if (!sameOcc(a as Occurrence, b as Occurrence)) return false;
    } else if (k === 'style') {
      if (!shallowEqual(a as Record<string, unknown> | undefined, b as Record<string, unknown> | undefined)) return false;
    } else if (!Object.is(a, b)) {
      return false;
    }
  }
  return true;
}

function shallowEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

export const TaskCard: ForwardRefExoticComponent<TaskCardProps & RefAttributes<HTMLDivElement>> = memo(
  TaskCardImpl,
  propsEqual,
) as unknown as ForwardRefExoticComponent<TaskCardProps & RefAttributes<HTMLDivElement>>;
TaskCard.displayName = 'TaskCard';
