import { useCallback, useEffect, type ReactNode } from 'react';
import { useStore } from '@/store/store';
import { setDrawer, toggleLeft, toggleRight } from '@/store/actions';
import { useInboxTasks, useTaskGroups } from '@/store/selectors';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { AppShellView } from './AppShellView';

/**
 * Responsive frame with slots. Owns sidebar widths & collapse animations, the Tasks drawer
 * (phone/tablet, edge-swipe), safe-area insets, and closing the drawer when a drag starts.
 */
export function AppShell(p: { left: ReactNode; center: ReactNode; right: ReactNode; phoneSheet: ReactNode; overlays: ReactNode }) {
  const mode = useLayoutMode();
  const leftOpen = useStore((s) => s.ui.leftOpen);
  const rightOpen = useStore((s) => s.ui.rightOpen);
  const drawerOpen = useStore((s) => s.ui.drawerOpen);
  const dragging = useStore((s) => s.ui.dragging !== null);
  const groups = useTaskGroups();
  const overdueCount = groups.find((g) => g.id === 'overdue')?.count ?? 0;
  const overdue = overdueCount > 0;
  const inboxCount = useInboxTasks().length;

  // A drag that starts inside the drawer must reveal the calendar underneath.
  useEffect(() => {
    if (dragging && mode !== 'desktop' && useStore.getState().ui.drawerOpen) setDrawer(false);
  }, [dragging, mode]);

  // The drawer doesn't exist on desktop — never leave it "open" (and scroll-locked) after a resize.
  useEffect(() => {
    if (mode === 'desktop' && useStore.getState().ui.drawerOpen) setDrawer(false);
  }, [mode]);

  const canSwipe = useCallback(() => useStore.getState().ui.dragging === null, []);

  return (
    <AppShellView
      mode={mode}
      left={p.left}
      center={p.center}
      right={p.right}
      phoneSheet={p.phoneSheet}
      overlays={p.overlays}
      leftOpen={leftOpen}
      rightOpen={rightOpen}
      drawerOpen={drawerOpen && mode !== 'desktop'}
      onToggleLeft={toggleLeft}
      onToggleRight={toggleRight}
      onDrawerOpenChange={setDrawer}
      overdueDot={overdue}
      overdueCount={overdueCount}
      inboxCount={inboxCount}
      canSwipe={canSwipe}
    />
  );
}
