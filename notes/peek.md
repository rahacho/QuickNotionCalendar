# peek agent (peek / pickers / settings / auth / quickadd) — notes for other agents

## Components (named exports)
- `peek/TaskPeek` — driven by `store.ui.peek`. Desktop/tablet: `Modal` (center peek); phone: `Sheet`.
  Closes itself if the occurrence disappears (remote delete / skipped elsewhere). Flushes the title on every close.
- `peek/PropertyRow` — `<PropertyRow icon label kind="button|box|static" onClick active empty disabled disabledReason tone>`;
  ref → the value element (popover anchor).
- `peek/TitleEditor`, `peek/EditorSurface` (popover on desktop, titled bottom sheet on phone).
- `pickers/DatePicker` — `<DatePicker occ onRequestClose? startInputRef? variant?>` (content only).
  `DatePickerPopover({ open, onOpenChange, anchor, occ, placement? })` — the 260px Notion popover; **on phones it renders a
  bottom sheet** (data-testid `date-picker` either way).
- `pickers/MiniCalendar` — `<MiniCalendar month onMonthChange selected rangeEnd? onSelect today weekStart onToday? min?>`.
- `pickers/TimeInput` — `<TimeInput value onChange placeholder? step?=30 showList? disabled? aria-label data-testid>`; ref → `<input>`.
- `pickers/RepeatEditor` — `<RepeatEditor occ onDone? initialView?>`; `pickers/ReminderMenu` — `<ReminderMenu occ onDone?>`.
  Both default `onDone` to closing the enclosing Popover; **pass `onDone` when rendering them outside a Popover**.
- `pickers/pickerUtils` — `formatOccurrenceDate`, `reminderValueLabel`, `applyRepeat`, `retargetPeek`, `repeatPresets`,
  `matchPreset`, `defaultTimeFor`, `shake`, `weekdayOrder`, …
- `settings/SettingsModal`, `auth/AuthScreen`, `quickadd/QuickAddSheet` (phone only; desktop composer is the calendar's).

## Behaviors worth knowing
- Repeat choices are anchored on the viewed occurrence's rule date (one-time: its date; Inbox: today, scheduled first).
  Monthly/yearly anchored on a different day than the series start pass the new start to `setRecurrence(id, rule, { start })`
  (start + rule = one write, one undo entry; "Repeat changed · Undo" when planned occurrences disappear). After any series-level
  change the peek is re-pointed (`retargetPeek`) at a valid occurrence (same date if still valid, else the next one), so it
  never closes under the user.
- Remind value for UNTIMED tasks reads "None" when the reminder is default/offset (no individual alert; the morning summary
  covers it) — `formatReminder` would say "Default". The ReminderMenu's "None" for untimed writes `{kind:'default'}`.
- Date picker: End date ON → first click sets start, then clicks set the end; a click before the start moves the start
  and keeps the end. Typed dates outside 1900–2199 are rejected (shake).
- Peek ⋯ "Duplicate" keeps the peek on the original and toasts "Task duplicated".

## Extra test ids (beyond SPEC §8)
`date-start-input`, `date-end-input`, `date-time-input`, `date-end-toggle`, `date-time-toggle`, `date-repeat`, `date-remind`,
`date-clear`, `date-occurrence-caption`, `date-picker-done` (phone), `mini-day` (+`data-day`), `repeat-menu`, `remind-menu`,
`repeat-never|daily|weekdays|weekly|monthly|yearly|custom`, `repeat-custom-panel`, `repeat-interval`, `repeat-freq`,
`repeat-weekday` (+`data-weekday`), `repeat-ends-never|until|count`, `repeat-until`, `repeat-count`, `repeat-custom-done`,
`remind-at-time|5m|10m|15m|30m|1h|2h|1d|none|day-9|prev-9|custom`, `remind-custom-time|days|done`, `peek-menu-duplicate`,
`peek-menu-move-inbox`, `peek-menu-delete`, `peek-menu-delete-occurrence|all`, `peek-delete-occurrence|all` (bottom Delete on a
recurring task opens a menu), `settings-close`, `weekstart-select`, `summary-toggle`, `summary-time`, `push-status`,
`push-enable|disable|test`, `account-local`, `account-email`, `sign-out`, `auth-error`, `auth-forgot`, `auth-toggle`,
`quickadd` (sheet), `quickadd-close`, `quickadd-add`, `quickadd-task`.
`theme-select` / `weekstart-select` are native `<select>`s → use `selectOption('dark')`.

## Requests for other owners
- **shell (ui/Sheet, ui/Modal):** nested overlays all use `--z-backdrop` (60) for the backdrop and `--z-peek` (70) for the
  panel, so a Sheet opened on top of another Sheet (phone: peek → date/repeat/remind sheet) does not dim the lower sheet
  (its backdrop sits under the lower panel). Suggest stepping both z-indexes by layer depth (e.g.
  `calc(var(--z-backdrop) + depth * 20)`). I mitigate it in TaskPeek by dimming the peek panel (`filter: brightness`) while
  an editor sheet is stacked on it; remove that once the primitive handles stacking.

## Verification
The throwaway harness was removed; peek / picker / settings flows are covered by `e2e/peek.spec.ts`, `e2e/recurring.spec.ts`, `e2e/misc.spec.ts`.

## Resolved by integration
- Stacked sheets: `Sheet`/`Modal` now raise nested backdrops/panels by layer depth (`overlayZ` in `lib/layers`), so the
  TaskPeek `stacked` brightness workaround was removed.
- Settings → Sign out first removes this device's push subscription (`disablePush({ resumeOnSignIn: true })`, max 3s)
  so a signed-out device stops receiving that account's reminders; the next sign-in on the device turns push back on.
- Touch: generic IconButtons get a ≥44px invisible hit area (IconButton.module.css, coarse pointers). Where two sit
  side by side (peek ⋯ ✕, mini-calendar ‹ ›) they get larger boxes extended only vertically, so neither covers the other.

## Review fixes (surfaces)
- **Repeat never silently drops planned occurrences (B2).** `applyRepeat` moves a series start for a monthly/yearly
  anchor only as far as needed (`anchoredStart`: the earliest date on the viewed occurrence's cycle that is not before
  max(original start, today)), and remembers the move (`movedStarts`, per app session). A later rule that doesn't need
  it (daily / weekly / monthly-yearly on the original day) puts the start back, so "monthly → weekly" (presets or the
  custom panel) restores today's and every other occurrence. "Never" and any other start change forget the memory.
  "Never" keeps the occurrence being viewed (`setRecurrence(id, null, { keepOrigDate })`) when it is still open.
- **Series time (B6).** The date picker's time edits on a repeating task change only that occurrence; when its time
  differs from the series', a quiet "Use 7:00 AM for every repeat" / "Remove the time from every repeat" link
  (`date-series-time`) calls `setSeriesTime` (toast + Undo), so a daily task can get its timed alerts.
- Custom repeat panel: the unit `<select>` is a draft like the typed numbers — it applies on Done, with the next
  applied control (chips, Ends), or when the panel closes (incl. Back / popover close / sheet dismiss). Browsing
  units writes nothing.
- **QuickAddSheet keeps typed text (C2/E2).** The field's text lives in `QuickAddSheet`; every way of leaving —
  ✕, backdrop tap, swipe down, Esc, tapping a planned task, `closeComposer()` from elsewhere, a new composer day,
  the layout leaving phone, unmount — creates the task on its day and toasts "Added to Wed, Nov 25 · Undo"
  (Undo = `deleteTask`, which offers its own Undo). Enter / ↑ / multi-line paste behave as before.
- **Sign out waits for queued task changes (A7).** Settings → Sign out shows "Syncing…" for up to 5 s until
  `sync.pendingWrites` clears; offline or still pending → an inline "Some changes haven't synced yet" row with
  Cancel / Sign out anyway (`sign-out-pending`, `sign-out-cancel`, `sign-out-confirm`). Helper:
  `settings/waitForTaskSync.ts`.
