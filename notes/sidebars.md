# sidebars (Tasks list + Inbox) — notes for other agents

Owned: `src/components/tasks/**` (TasksSidebar, TaskRow, SyncStatus, listMotion, dragProps, useScrollEdges,
devHooks) and `src/components/inbox/**` (InboxPanel, InboxSheet, InboxInput, InboxList, InboxBubble, scroll).

## Test ids / attributes (beyond SPEC §8)
- `tasks-sidebar` root has `data-scrolled` / `data-more-below` (hairlines under header / above footer).
- `group` (+`data-group-id`), `group-toggle` (only collapsible groups: Later, Completed; `aria-expanded`),
  `overdue-move-all`, `list-row` (+`data-occ-key`, **`data-checked="true|false"`** = what the box shows,
  including the 350ms optimistic phase), `list-checkbox`, `settings-open`.
- `inbox` (desktop/tablet panel root = the drop target; `data-drop-over="true"` while an outside card hovers),
  `inbox-input`, `inbox-bubble` (+`data-task-id`), `inbox-bubble-menu` (hover ⋯, fine pointers only).
- Phone: `inbox-sheet` (+`data-snap="collapsed|half|full"`, `data-hidden="true"` during a drag),
  `inbox-sheet-handle` (tap cycles collapsed → half → full → collapsed; drag snaps with velocity),
  `inbox-sheet-add` (the "+"), `inbox-dropzone` (visible only while `ui.dragging`; `data-over`,
  `aria-disabled="true"` for recurring drags).
- Completing from the list: click → `data-checked="true"` immediately → `setDone` after 350ms → row collapses
  (180ms). Wait ≥ ~600ms before asserting the row is gone. Uncheck in Completed commits after 150ms.

## Dev hook (DEV builds only; stripped from production — verified)
`window.__tasksDev = { actions, state(), setState }` — e.g. seed overdue tasks with
`__tasksDev.actions.createTask({ title: 'Pay rent', date: '2026-11-12' })`.

## For the E2E agent / lead — Playwright fake clock + reload stalls motion's WAAPI animations
With `page.clock.setFixedTime/install`, after `page.reload()` `performance.now()` and rAF timestamps keep
counting from the first load while `document.timeline` restarts at 0. motion starts its WAAPI-accelerated
animations (opacity / transform) with a startTime seconds in the future, so **exit animations don't finish
and AnimatePresence never removes the element** until that many seconds pass. Measured: after ~6s of test,
an opacity exit had `currentTime ≈ -6000ms`. My list/sheet wrappers are immune (they pass `onUpdate`, which
keeps motion on its JS frameloop — see `FRAMELOOP_ONLY` in `src/components/tasks/listMotion.ts`), but other
motion exits (peek, toasts, popovers using motion) can stall after a reload under the fake clock. Prefer a
fresh `page`/context over `reload()` in E2E, or apply the same `onUpdate` trick to presence-critical exits.

## For the calendar/dnd agent
- `SortableList` returns a bare fragment for `itemIds.length === 0` and a `SortableContext` otherwise. That
  element-type switch remounts everything below it, so a consumer's `AnimatePresence` loses the first item's
  enter and the last item's exit animation. I work around it in InboxList by passing a placeholder id
  (`inbox:__inbox-placeholder__`) when empty (no node → never hit-tested; your drop math uses the registry).
  If you change SortableList, keep the tree shape stable (e.g. always render the context) — then I can drop
  the placeholder.
- Phone pill drop ("Move to Inbox"): works (verified chromium + webkit, mouse sensor), but the task lands at
  the **end** of the Inbox — the drop index is computed against the (now off-screen) sheet bubbles. SPEC says
  Inbox default is top (`moveOccurrence(ref, null)` without `pos`). Consider passing no `pos` when the hit
  container is the pill (it has `data-testid="inbox-dropzone"`), or index 0.
- The pill host is `pointer-events: auto` only while `ui.dragging` is set (your hit-test uses the element under
  the pointer); it covers exactly the bottom `--sheet-collapsed-h` strip, which the calendar never occupies.
- Exiting (collapsing) Inbox bubbles stay mounted ~180ms and remain registered in your `inbox` container.
- List rows: `useDraggableTask(..., disabled: true)` for completed rows and during the 350ms check delay. I drop
  `aria-disabled` from your attributes on purpose (it made the row's checkbox read as disabled to AT and
  Playwright).

## For the PWA agent
- `InstallHint` is mounted exactly once, in the Tasks sidebar footer (as assigned). Your card floats at
  `top: safe-top + header + 8px`, `z-index: var(--z-sheet)`, rendered after the sheet → **it covers the Inbox
  sheet's grabber/title/"+" when the sheet is at `full`** (top just below the header) on iPhone Safari
  (not installed). Suggest hiding it while `ui.sheet !== 'collapsed'`, or lowering it below `--z-sheet`.

## For the shell agent (FYI)
- In DEV with reduced motion, motion logs a console *warning* ("You have Reduced Motion enabled…") because
  of `<MotionConfig reducedMotion="user">`. Harmless; E2E "no console warnings" checks should ignore it.

## Resolved
- peek `TitleEditor.tsx` had literal U+2028/U+2029 characters in a regex (unparseable); fixed by its owner.
  Beware: the file-writing tool can turn ` ` escapes into raw characters.

## Integration changes (lead)
- InboxList no longer passes a placeholder id (SortableList is a plain fragment now).
- The hover "⋯" stays hidden during drags (`.listDragging .slot:hover .more` now loses to the drag rule).
- Phone sheet: a drag that starts on a bubble keeps the sheet up (its list is an Inbox drop zone, so bubbles can be
  reordered in the sheet) until the finger leaves the sheet upward; then it slides away and the pill rises as before.
  Drags from the calendar / Tasks list still hide it at once.
- Sheet header: pointer capture is taken on pointerdown (a mouse/pen whose first move already leaves the 56px header
  used to lose the gesture).

## Review fixes (round 1)
- **Tasks list rows (D9, D10a):** the row is the pointer/drag surface only; its title is the keyboard + screen-reader
  control (`role=button`, `data-row-focus`, Enter opens, Space drags; dnd activator), the checkbox a sibling — no
  control nested in another. The meta sits right of the title while the title keeps ≥ 4em, else wraps onto its own
  line (right-aligned) and breaks only before " → " / " · " — never truncated (end date + time of long ranges stay
  visible). The focus ring is drawn on the row (`:has(.rowTitle:focus-visible)`).
- **Inbox sheet (C3, D10a):** collapsed = bar only: the content is `visibility:hidden` once the slide-down ends (Face ID
  iPhones showed a dead input in the home-indicator strip); a tap anywhere on the collapsed bar opens it to half. The
  header is the drag/tap surface; `inbox-sheet-handle` is now the "Inbox · N" button inside it, a sibling of "+".
- **Phone pill (C4):** pill 40px, 12px from the calendar edge; the accepting area is the pill + the strip from +20px
  (dead band above keeps the calendar edge-scrolling).
- **Rails (E3):** a collapsed desktop Tasks sidebar's "Open sidebar" shows the red overdue dot (label "…, N overdue");
  the collapsed Inbox rail shows a neutral count (`inbox-rail`, `inbox-rail-count`, label "Open inbox, N tasks").
  ☰ labels (phone header, tablet rail) say "Open tasks, N overdue".
