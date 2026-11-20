import type { ReactNode } from 'react';
import { ChevronsLeft, ChevronsRight, Menu as MenuIcon } from 'lucide-react';
import type { LayoutMode } from '@/store/store';
import { cx } from '@/lib/cx';
import { IconButton } from '@/components/ui/IconButton';
import { Drawer } from './Drawer';
import styles from './AppShell.module.css';

export interface AppShellViewProps {
  mode: LayoutMode;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  phoneSheet: ReactNode;
  overlays: ReactNode;
  leftOpen: boolean;
  rightOpen: boolean;
  drawerOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onDrawerOpenChange: (open: boolean) => void;
  /** Red dot on the tablet drawer toggle and the desktop "Open sidebar" rail button (overdue tasks exist). */
  overdueDot?: boolean;
  /** Overdue count, spoken in those buttons' labels. */
  overdueCount?: number;
  /** Unscheduled tasks waiting in the Inbox: shown on the collapsed Inbox rail. */
  inboxCount?: number;
  /** Touch-gesture guard for the drawer (false while a task drag is in flight). */
  canSwipe?: () => boolean;
  /** Fill the positioned parent instead of the viewport (gallery previews). */
  contained?: boolean;
}

/**
 * Presentational app frame (no store access — the gallery renders it directly).
 *  desktop: Tasks (left) · Calendar · Inbox (right); sidebars collapse with a 180ms slide while the
 *           calendar reflows; a slim rail with a reopen button takes their place.
 *  tablet:  rail(☰) · Calendar · Inbox; Tasks live in the Drawer.
 *  phone:   full-bleed Calendar + Drawer (Tasks) + phoneSheet (Inbox sheet) slot.
 */
export function AppShellView({
  mode,
  left,
  center,
  right,
  phoneSheet,
  overlays,
  leftOpen,
  rightOpen,
  drawerOpen,
  onToggleLeft,
  onToggleRight,
  onDrawerOpenChange,
  overdueDot,
  overdueCount = 0,
  inboxCount = 0,
  canSwipe,
  contained,
}: AppShellViewProps) {
  const desktop = mode === 'desktop';
  const phone = mode === 'phone';
  const leftShown = desktop && leftOpen;
  const leftRail = !phone && !leftShown;
  const rightShown = !phone && rightOpen;
  const rightRail = !phone && !rightOpen;
  // A collapsed sidebar must never hide that something needs attention (it stays collapsed across
  // sessions): the rails carry the overdue dot and the Inbox count.
  const overdueSuffix = overdueDot && overdueCount > 0 ? `, ${overdueCount} overdue` : '';
  const inboxLabel = inboxCount > 0 ? `Open inbox, ${inboxCount} ${inboxCount === 1 ? 'task' : 'tasks'}` : 'Open inbox';

  return (
    <div className={cx(styles.shell, contained && styles.contained)} data-layout={mode}>
      {desktop && (
        <aside
          className={cx(styles.panel, styles.leftPanel, leftShown && styles.panelOpen)}
          aria-label="Tasks"
          aria-hidden={leftShown ? undefined : true}
          inert={!leftShown}
        >
          <div className={cx(styles.panelInner, styles.leftInner)}>
            {left}
            <div className={styles.collapseBtn}>
              <IconButton
                label="Close sidebar"
                icon={ChevronsLeft}
                hint="["
                onClick={onToggleLeft}
                tooltipPlacement="right"
              />
            </div>
          </div>
        </aside>
      )}

      <div className={cx(styles.rail, styles.leftRailEl, leftRail && styles.railOpen)} inert={!leftRail}>
        {!phone &&
          (desktop ? (
            <IconButton
              label="Open sidebar"
              aria-label={`Open sidebar${overdueSuffix}`}
              icon={ChevronsRight}
              hint="["
              onClick={onToggleLeft}
              dot={overdueDot}
              tooltipPlacement="right"
            />
          ) : (
            <IconButton
              label="Open tasks"
              aria-label={`Open tasks${overdueSuffix}`}
              icon={MenuIcon}
              onClick={() => onDrawerOpenChange(true)}
              data-testid="drawer-toggle"
              dot={overdueDot}
              tooltipPlacement="right"
            />
          ))}
      </div>

      <main className={styles.center}>{center}</main>

      <div className={cx(styles.rail, styles.rightRailEl, rightRail && styles.railOpen)} inert={!rightRail}>
        {!phone && (
          <div className={styles.railStack}>
            <IconButton
              label="Open inbox"
              aria-label={inboxLabel}
              tooltip={inboxCount > 0 ? `Open inbox (${inboxCount})` : true}
              icon={ChevronsLeft}
              hint="]"
              onClick={onToggleRight}
              tooltipPlacement="left"
              data-testid="inbox-rail"
            />
            {inboxCount > 0 && (
              <span className={styles.railCount} data-testid="inbox-rail-count" aria-hidden="true">
                {inboxCount}
              </span>
            )}
          </div>
        )}
      </div>

      {!phone && (
        <aside
          className={cx(styles.panel, styles.rightPanel, rightShown && styles.panelOpen)}
          aria-label="Inbox"
          aria-hidden={rightShown ? undefined : true}
          inert={!rightShown}
        >
          <div className={cx(styles.panelInner, styles.rightInner)}>
            {right}
            <div className={styles.collapseBtn}>
              <IconButton
                label="Close inbox"
                icon={ChevronsRight}
                hint="]"
                onClick={onToggleRight}
                tooltipPlacement="left"
              />
            </div>
          </div>
        </aside>
      )}

      {!desktop && (
        <Drawer open={drawerOpen} onOpenChange={onDrawerOpenChange} canSwipe={canSwipe} contained={contained}>
          {left}
        </Drawer>
      )}

      {phone && phoneSheet}
      {overlays}
    </div>
  );
}
