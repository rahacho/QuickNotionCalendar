# shell (ui / card / layout / hooks / lib / App) — notes for other agents

Gallery (dev only): `npx vite --port <yours> --strictPort` → `/?gallery&section=primitives|cards|menu|modal|sheet|toasts|shell&theme=light|dark`
(shell also takes `&mode=desktop|tablet|phone&left=0&right=0&drawer=1`). It renders mock panels that mimic
the Notion screenshot — use it as the visual reference for spacing/colors.

## Imports
One file per primitive, named exports: `@/components/ui/Button`, `IconButton`, `Checkbox`, `Toggle`, `Popover`,
`Menu` (Menu, MenuItem, MenuSeparator, MenuLabel), `Modal`, `Sheet`, `Toaster`, `Toast` (presentational ToastStack),
`Tooltip`, `TextInput`, `Kbd`, `Icon`. Barrel: `@/components/ui` (re-exports all). Hooks: `@/hooks/<file>` or `@/hooks`.
Card: `@/components/card/TaskCard`. Layout: `@/components/layout/AppShell`, `AppShellView` (store-free), `Drawer`.
Lib: `@/lib/cx`, `ids`, `platform`, `layers`, `scrollLock`, `hotkeys`, `focus`, `motion` (JS mirrors of motion tokens:
`EASE`, `EASE_OUT`, `DUR` (s), `DUR_MS`, `SPRING_SETTLE`).

## Escape / overlay layering (important)
Modal, Sheet, Popover (and Menu inside it) and Drawer register in a layer stack (`@/lib/layers`). A capture-phase
listener closes ONLY the topmost layer on Escape and stops propagation. **Do not add your own Escape handlers for
overlays built on these primitives** (you'd close two things at once). If you build a custom overlay, call
`useLayer(open, onEscape)` and wrap its children in `<LayerDepthContext.Provider value={depth}>`.
`hasOpenLayers()` / `useHasOpenLayers()` tell you whether any overlay is open (App uses it to gate global hotkeys).
Backdrop clicks also respect layering (clicking the peek backdrop while a date picker is open closes only the picker).
App's global Escape is the fallback for non-layer UI: peek → settings → composer → drawer → phone sheet (half/full → collapsed).

## Primitives — API notes beyond SPEC §4.5
- `Button`: `iconRight` (e.g. Month ⌄), `active` (pressed look while its menu is open), `size="sm"` = 28px.
- `IconButton`: `label` → aria-label + tooltip (desktop hover, 400ms); `tooltip={false}` to disable, `hint="["` shows a
  shortcut line, `dot` = red dot (overdue indicator on ☰), `size` 24|28.
- `Checkbox`: `<button role="checkbox" aria-checked>`; **stops click propagation** so a checkbox in a clickable row
  doesn't open the row. Pass `aria-label` when there's no `label`. Spread props (e.g. `data-testid="list-checkbox"`).
- `Popover`: `anchor` = ref | element | virtual `{getBoundingClientRect}`; `placement` default `bottom-start`; `width`,
  `matchAnchorWidth`, `initialFocus` (index | ref | -1), `returnFocus`, `closeOnFocusOut`, `role` ('none' when the
  content brings its own role), `data-testid` (on the panel). Inside content, `usePopoverClose()` → `{close, closeAll}`.
  Nested popovers (e.g. RepeatEditor inside DatePicker) form a floating tree automatically.
- `Menu`/`MenuItem`: put `<Menu>` inside a `<Popover>`. MenuItem `{icon, label, hint, danger, onSelect, submenu,
  selected, keepOpen, disabled}` — selecting closes the whole popover chain unless `keepOpen`. `selected` renders ✓
  (role menuitemradio). `submenu` = MenuItems (opened on hover / → / Enter). Rows are 28px (40px on touch).
- `Modal`: extra props `initialFocusRef`, `closeOnBackdrop`, `className`, `style`, any `data-*`/aria on the panel
  (e.g. `data-testid="peek"`). Panel is the scroll container (max-height 85vh), focus trapped + restored.
- `Sheet`: `snap="auto|full"`, `initialFocusRef` (default: leaves focus where you put it, so `autoFocus` on an input
  keeps the iOS keyboard), any `data-*` on the panel. Content goes in a scrollable body under a built-in drag handle.
  Pull down on handle (or content scrolled to top) to dismiss; keyboard-aware via visualViewport.
- `TextInput`: ref → the `<input>`; `className` styles the outer field, `inputClassName` the input; `icon`, `trailing`,
  `variant="plain"`. 32px, 16px font on coarse pointers (no iOS zoom). **Any input you style yourself must also be
  ≥16px on `(pointer: coarse)`.**
- `Toaster` renders `store.toasts` and **owns the auto-dismiss timers** (pause on hover / hidden tab; swipe to dismiss).
  Store agent: `showToast` should NOT schedule its own dismissal; `duration <= 0` or `Infinity` = sticky.
  Action click → `dismissToast(id)` then `action.run()`.

## TaskCard
- `data-testid="task-card"` is set first, so passing `data-testid="bar"` overrides it for multi-day bars.
- Renders `children` last inside the card (position: relative) → put resize handles there.
- Calendar-sized variants (`calendar`, `bar`, `overlay`) read `--cal-card-font/-line/-pad-y/-pad-x`, `--cal-cell-pad-x`,
  `--cal-card-gap`, `--cal-lane-h` (tokens.css). **Override those on your compact grid container** and every card/bar
  inside follows. `variant="compact"` has fixed 11px/13px metrics.
- Extra optional prop `compact` (non-contract) applies compact metrics to `bar`/`overlay` (phone bars, phone drag overlay).
- `bar`: margins `0 var(--cal-cell-pad-x)` except on flat (continuing) edges. Position it with `left`/`right`
  (percentages), not `width`, so the margins inset it. Height = `--cal-lane-h − --cal-card-gap`.
- `overlay` fills its box (width/height 100%, no margin) — DragOverlay sizes it to the source rect.
- Memoised on displayed fields (key/title/time/recurring/done/date/endDate) + shallow props; inline closures still re-render.

## AppShell (layout contract for panel content)
- Every slot's root is stretched (`flex: 1; min-height: 0`) — make your own inner list the scroll container.
- AppShell paints the sidebar background (`--bg-sidebar`) and the inner-edge hairline, and adds `--safe-top`
  padding to every column → **don't add safe-top / sidebar bg / edge line again** in TasksSidebar/InboxPanel/CalendarView.
- Desktop: a hover-revealed « / » collapse button sits over the **top-right 36px of each sidebar's 44px header row** —
  keep that corner free. Collapsed sidebars become a 36px rail with a reopen button.
- Tablet: the left rail renders the ☰ `data-testid="drawer-toggle"` (with overdue dot). **Calendar: render your ☰ only
  in phone mode** to avoid a duplicate.
- Phone: center gets `padding-bottom: var(--sheet-collapsed-h)` (= 56px + safe-bottom, defined in global.css) so the
  calendar ends above the collapsed Inbox sheet. InboxSheet should use `--sheet-collapsed-h` for its collapsed height.
- The Drawer (phone/tablet Tasks) stays mounted when closed (inert, off-screen). Its z-index is above `--z-sheet`
  (an open drawer covers the Inbox sheet) and below the peek/popovers. AppShell closes it when `ui.dragging` turns on.
- Edge swipe (left 20px) opens the drawer on touch; guarded off while `ui.dragging` is set.

## Hooks
- `useHotkeys(map)`: handlers may `return false` to mean "not handled" (key passes through, no preventDefault).
- `useVisualViewport()` → `{keyboard, height, offsetTop}` for bottom-anchored inputs (InboxSheet input above keyboard).
- `useApplyTheme()` sets `<html data-theme>` and rewrites every `meta[name=theme-color]` content to the resolved `--bg`.

## App
- Global hotkeys are ignored while loading/signed out, while any overlay layer / peek / settings is open, or during a drag.
  `n` reveals the Inbox (opens desktop panel / phone sheet half) then focuses `[data-testid="inbox-input"]`.
- Deep link `?task=ID&occ=DATE`: `occ` may be the original rule date or the moved-to date (both resolve). If the task
  isn't in the local cache yet it waits up to 6s for the server snapshot, else toasts "That task no longer exists".
- main.tsx loads App via dynamic import (one extra chunk) so `?gallery` in DEV never evaluates the store graph.

## For the PWA agent
- index.html is minimal on purpose: keep the inline theme script (reads `tasks.theme`, raw or JSON-quoted) and the
  viewport meta (`viewport-fit=cover`). Add manifest/iOS metas around them.
- iOS `black-translucent` status bar text is always white — in the light theme it sits on a white header. Known iOS
  limitation; consider it when choosing the status-bar style.

## For the store agent
- Persist theme in localStorage `tasks.theme` as the raw string ("system"|"light"|"dark").
- `LayoutMode`, `ToastItem`, `DragSource` are imported as types from `@/store/store` (per SPEC).

## Token corrections (resolved by integration)
The pixel-measured dark values (`--text` rgb(240,239,237), `--text-secondary` rgb(125,122,117), `--grid-line`
rgb(56,56,53), `--today` rgb(229,100,89) / `--today-text` #000) now live in `tokens.css`; the override block in
`global.css` is gone.

## Integration changes (lead)
- Nested modal surfaces stack by depth: `overlayZ(depth, part)` in `lib/layers.ts`, used by `Modal` and `Sheet`
  (a sheet opened from the peek sheet now dims it with its own backdrop). `--z-toast` is 78: above every modal
  surface, below popovers/menus (a toast never covers an open menu).
- `IconButton` exposes `data-dot="true"` when the red dot shows.

## Review fixes (surfaces)
- Deep link (C7): App's cold-start `?task=&occ=` now cleans the URL and calls `openTaskLink()` from
  `push/openLink` — one resolver for cold and warm taps; a deleted/skipped occurrence of an existing series
  toasts "That task no longer exists" instead of opening nothing.
- InstallHint (C5) also fades out while the Tasks drawer or any overlay layer (peek, settings, quick add,
  popovers) is open: it is portaled to `<body>`, so no z-index inside `#root` (drawer) can cover it.
- iOS launch screens (D7): `scripts/generate-icons.mjs` writes a light set (`splash/iphone-WxH-light.png`, #FFFFFF,
  hairline tile) next to the dark one; index.html picks by `prefers-color-scheme`
  (`node scripts/generate-icons.mjs --links` prints the block). `scripts/generate-icons.test.mjs` (run by vitest)
  checks links ↔ SPLASH_SCREENS, sizes and background colors. A forced in-app theme opposite to the OS can still
  flash (media queries can't see it); iOS caches launch images at install — re-add to the Home Screen to see them.

## Gap fixes (after review)
- App: `sync.loadFailed && !tasksLoaded` → `LoadFailedFrame` (exported from App.tsx; testids `load-failed`,
  `load-retry`, `load-sign-out`): same panel geometry as the loading frame, CloudOff glyph, "Couldn’t load your
  tasks", the sync reason as a sentence + "Tasks keeps trying in the background.", Try again (reload) and Sign out
  (Firebase mode), "Signed in as …". Test: src/App.test.tsx.
