# calendar + dnd — notes for other agents

Owned: `src/components/calendar/**`, `src/dnd/**`. SPEC §4.4 API is implemented with the exact names; extras are additive.

## dnd: how it works (read this if you use the API)
- **No dnd-kit droppables and no dnd-kit collision.** Registering hundreds of droppables is O(n²) in dnd-kit's reducer
  (every registration copies the whole map), which made scrolling the month view janky. Instead:
  - drop containers register their DOM node (`useDayDropTarget(date)`, `useInboxDropTarget()`), and the target is the
    container under the pointer **right now** (`elementFromPoint` + ancestor walk) — correct across scroll containers,
    while auto-scrolling, in the phone sheet / pill. Any number of `useInboxDropTarget()` nodes can coexist.
  - items register their node + occurrence (`useSortableTask`, `useDraggableTask`); positions are read live (transforms
    ignored) in `SortableList` order.
  - Hovering the drag's **own** list shifts siblings to open a gap (`useSortableTask().style.transform`, same maths as
    dnd-kit's vertical strategy); **other** lists get the cell highlight + a 2px blue insertion line (portal).
  - `isOver` from the drop-target hooks is a per-node boolean selector — only the affected node re-renders.
- `SortableList` now always renders a plain fragment (stable tree shape) and publishes `itemIds` as the rendered
  order. **Sidebars agent:** the empty-list placeholder id is no longer needed (harmless if kept).
- `style` from `useSortableTask` carries `touch-action: manipulation`, no-select/no-callout, the sort transform and a
  transition while sorting. Spread it last-ish (after your own style) or merge it.
- While a drag is in flight `<html data-dnd-dragging="mouse|touch|keyboard">` is set: every `[data-dnd-draggable]`
  gets `pointer-events: none` (so the element under the pointer is the container) and the cursor is `grabbing`.
  Don't rely on `:hover` of cards/bubbles/rows during a drag.
- Drop → `moveOccurrence(ref, date|null, pos)`; `pos` comes from the rendered neighbours (untimed cards snap into the
  untimed prefix, timed cards order only among same-time cards). A zone with nothing rendered under it (an empty list,
  the phone pill) passes **no pos** → the action default (Inbox top, day bottom). Dropping where nothing changes is a
  no-op (no write, no undo entry). Recurring → Inbox still calls `moveOccurrence` so its refusal toast shows.
- Multi-day bars keep their grab offset and length; while dragging one, every day of the new span reports `isOver`.
- `ui.dragging` is set on drag start (+ drawer closed) and cleared on end/cancel. Clicks within 250ms (mouse) /
  450ms (touch) after a drop are swallowed, so a drop never opens the peek.
- Edge auto-scroll of the calendar (top/bottom 64px, quadratic speed) runs from the drag frame loop whatever the drag
  started from; dnd-kit's own auto-scroll still handles other scroll containers (Inbox list, Tasks list).
- Hovering ‹ / › (`data-dnd-flip`) for 600ms while dragging flips month/week (repeats every 600ms).
- iOS: a permanent non-passive `touchmove` listener preventDefaults only during a touch drag (also attached to the
  touch target itself, which keeps receiving events even if it unmounts); context menu suppressed on long-press.
- Extra exports: `useBarDraggable`, `useDndSelector`/`getDndState` (live drag state: `active`, `hit`, `range`,
  `refused`…), `isRecentSortDrop`, `registerCalendarScroller`, `autoScrollCalendar`, `dayAt(x, y)`.
- DEV only: `window.__dnd` (`pointer()`, `state()`, `resolve()`), `window.__cal` (`seed()`, `actions`, `state()`).

## Calendar behaviours
- Month view = endless scroll of week rows; ~45 mounted, +8 near either end (rendered in a transition), trimmed back to
  ≤60 when scrolling settles. All scroll-position compensation is manual (`overflow-anchor: none`; Safari has none).
- Title month = month of the middle-column date at the viewport centre, capped at 3 rows below the top row (on tall
  tablet screens the centre of a month aligned to the top is already in the next month).
- `scrollRequest` is handled by nonce; target month's first week goes to the top (requested date's week kept visible).
- Composer: desktop/tablet inline at the bottom of the cell (`composer-input`, Enter = create + stay open, Esc = close,
  blur = create if non-empty, multi-line paste = one task per line). Phone: tapping an empty part of a day only calls
  `openComposer(date)` (QuickAddSheet renders). Touch tablets: tap empty area → inline composer.
- Week view: "+ New" row under each column on hover (also `data-testid="day-add"`), no `+` in a corner.
- Keyboard on a focused card: Enter opens the peek, Backspace/Delete deletes (undo toast), Space starts a keyboard
  drag (arrows move by day / week, Space/Enter drop, Esc cancel).

## Verification
The throwaway scripts were removed; the behaviours are covered by the Playwright suite in `e2e/` (`npm run e2e`).

## Requests / observations for other agents
- **Sidebars (Inbox):** the bubble's hover "⋯" stays visible on the bubble under the pointer while a card is being dragged
  over the Inbox (seen in `shots/inbox-insert-line.png`). Hide hover affordances under `html[data-dnd-dragging]`.
- **Sidebars:** the phone pill now gets "Inbox top" (no `pos`) — the end-of-Inbox issue you reported is fixed.
- **PWA:** on iPhone Safari the InstallHint card sits over the calendar's weekday header / first row
  (`shots/phone-quickadd-webkit.png`); that's expected while not installed, just confirming it doesn't block drops
  (it is not a drop container, so a drag released over it does nothing).

## Integration changes (lead)
- Title month: after a programmatic scroll (Prev/Next/Today/initial) the requested month stays the title while the row
  it landed on is still the top row; otherwise the month with the most visible days among the top 5 rows wins (ties →
  later month). Fixes landscape phones (~2 rows) showing "October" for November.
- Date label pixel-matched again: `.head` padding 5px 10px 0, today circle margin 2px -6px 0 0, weekday labels 11px
  above the grid line (reference: digits end 11px from the right line, circle 4px in from both lines).
- Edge auto-scroll arms per edge: a gesture that starts inside a zone doesn't scroll until the pointer has been outside
  it (phone: dragging a Tasks-list row near the top used to send the calendar flying). `resetAutoScroll()` runs at
  every drag/resize start.
- Touch drags ignore mouse/pointer moves (and mouse drags ignore touches): a resting cursor's synthetic mousemoves
  after an auto-scroll used to retarget the drop.
- InlineComposer closes `ui.composer` when its day unmounts for good (text is still saved).

## Review fixes (round 1)
- **Scroll position (C1, C-V1):** the scroller's anchor keeps the last seen `scrollTop`; when rows are removed and the
  browser has already clamped `scrollTop` (content shrank under the view), compensation starts from the real position.
  Idle trims commit synchronously (`flushSync`), so capture → commit → compensate is one task. `rangeRef`/`weeksRef` are
  published in a layout effect (committed rows only), so a time-sliced prepend can no longer lose its anchor
  (8-week skips). Window extends use functional `setRange`.
- **Launch position (D2):** on the current month the first position targets **today** (month's first week on top only
  while today's week still fits). Until the user's first input (pointer, key, wheel, touch, a scroll request, a drag,
  or any scroll we didn't make), layout growth re-applies that position, so late rows never push today off screen.
- **Multi-day bars wrap (D1/E1):** in compact density, week view and on touch (`addMode === 'tap'`) bars show the full
  name (`TaskCard wrap`, `data-wrap="true"`). Lanes become rows of a 7-column grid (`.barsWrap`) sized by their tallest
  bar; WeekRow measures it into `--lanes-h` (layout effect + ResizeObserver), which `.lanes` reserves in every cell.
  Desktop month keeps one-line bars + tooltip (SPEC §5). The drag overlay keeps the source's wrap (`ActiveDrag.wrap`).
- **Keyboard (D3, D4, C6):** the calendar is ONE tab stop (roving tabindex, `roving.ts`): today (if shown) / the first
  day shown / the last day used. Arrows move between days (only for a keyboard-focused cell, so ←/→ still page months
  after a click), Enter or `n` opens the composer there, the active day's cards/bars are the next Tab stops, hover `+`
  and week "+ New" are `tabIndex=-1`; cells never take focus from a mouse press. Backspace/Delete only delete a card
  reached by keyboard (`focusOrigin.ts`): not after a click, not after a peek/popover handed focus back.
  The active day follows focus through a NATIVE `focusin` listener on the calendar root (`data-roving-day` on bars,
  `data-date` on cells): a closing peek restores focus during React's commit, when React drops synthetic focus
  events, so `onFocus` alone left the card untabbable (Shift+Tab / Tab skipped it on any day but today).
  After a keyboard drop focus goes to the moved card / bubble / list row; the live region says "dropped on <date>";
  a keyboard drag from the Tasks list / Inbox enters the calendar at today on the first arrow.
- **Phone header (D5):** on coarse pointers ☰ ‹ › are 32px, Today 32px tall, cluster gap 4px, plus invisible hit
  extensions → every control answers ≥ 40×44 without overlapping neighbours. (On a 320pt-wide phone a long month
  title now ellipsizes; every iOS version that can install the PWA runs on ≥ 375pt.)
- **Phone "Move to Inbox" (C4):** the drop host only accepts the pill itself and the strip from 20px below the calendar
  edge; the band in between keeps edge-scrolling (no accidental unscheduling by overshoot).
- Compact card times wrap AM/PM instead of spilling past the card (D8).
- `DragHandleResult.setActivatorNodeRef` (additive) — where dnd-kit returns keyboard focus after a drag.
