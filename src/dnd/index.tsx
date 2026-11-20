/**
 * Drag & drop (SPEC §4.4). Public API used by the calendar, the Inbox and the Tasks list:
 *
 *   <DndProvider>               — one per app (App.tsx)
 *   <SortableList containerId itemIds>  + useSortableTask()   — day cards, Inbox bubbles
 *   useDraggableTask()          — Tasks list rows (drag onto a day / the Inbox)
 *   useDayDropTarget(date)      — day cells;  useInboxDropTarget() — any Inbox drop zone
 *
 * How it works: the drop target is found by live DOM hit-testing under the pointer (works across
 * scroll containers and the phone sheet), positions come from the target container's rendered order,
 * and onDragEnd calls actions.moveOccurrence. See notes/calendar.md.
 */
export { dragIds, containerIds, type TaskDragData } from './ids';
export { DndProvider } from './DndProvider';
export {
  SortableList,
  useSortableTask,
  useDraggableTask,
  useDayDropTarget,
  useInboxDropTarget,
  useBarDraggable,
  type DragHandleResult,
  type DropTargetResult,
} from './hooks';
export { registerCalendarScroller, autoScrollCalendar, resetAutoScroll } from './autoscroll';
export { dayAt } from './geometry';
export { useDndSelector, getDndState, isRecentSortDrop, type ActiveDrag, type DropHit } from './state';
