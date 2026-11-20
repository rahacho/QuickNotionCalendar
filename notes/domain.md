# domain (shared/) — notes for other agents

Import from `@shared/<module>` or `@shared/index`. Internal relative imports use `.js` specifiers
(works with Vite/vitest, rolldown/esbuild and NodeNext). No DOM/React/Firebase; checked under a
WebWorker-only lib and NodeNext config (throwaway tsconfigs, since removed; `functions/` builds it under NodeNext).

## Behavior worth knowing (SPEC is silent or I chose the "nothing hidden" option)
- **getOccurrence is lenient where unambiguous**: non-recurring task + any origDate → its single
  occurrence; recurring task + `origDate: null` → occurrence at the series start (if it is a rule
  date). So a peek ref survives toggling Repeat on/off. It still returns null for skipped/non-rule dates.
- **Bad stored data never hides a task**: invalid `date` → treated as Inbox (`inboxTasks` includes it);
  invalid `endDate`/`time` ignored; `endDate` on a recurring task ignored; unknown `freq` → daily.
- **Orphan overrides** (keys that are no longer rule dates after a rule/start change) are ignored
  everywhere, including Completed. Store agent: `setRecurrence` / `setSeriesStart` may want to prune them.
- `normalizeRecurrence` raises `until < start` to `start`, and if both until and count are set keeps
  the less restrictive one. It always returns every key (`byWeekday/until/count` = null, never undefined).
- **keyBetween never throws**: malformed bound → treated as null; `a === b` → key just above a;
  `a > b` → `keyBetween(a, null)` (an untimed card dropped next to a timed one keeps "after prev").
  DnD: pass the neighbors you rendered; inconsistent ones are fine.
- Keys/orders are compared by code unit (`<`), never `localeCompare` (`"Zz" < "a0"`).
- `occurrencesInRange` returns occurrences sorted by start date then `compareInDay`.
- `layoutWeek.singles` has an entry (possibly `[]`) for every row day.
- Grouping: a recurring series counts as "in the window" only if it has an OPEN occurrence there;
  otherwise its next open occurrence goes to Later. Done Inbox tasks appear in Completed (meta '').
  Metas add the year when it differs from today's ("Jan 5, 2027"); multi-day items always show
  a range. Completed uses a bounded top-N (cheap with years of history).
- `formatReminder`: default → "At time of task" (timed) / "Default" (untimed); offset on an untimed
  task → "Default" (it behaves like default). Labels: "10 minutes before", "1 hour before",
  "1 day before", "1 week before", "On day (9:00 AM)", "2 days before (9:00 AM)", "None".
- `parseDateInput` without a year is forward-biased: earliest match on/after today − 31 days
  ("Jan 5" in November → next January; "Nov 10" → this year). Weekday names → on or after today.
- `parseTimeInput`: bare numbers are 24h ("9" → 09:00, "21" → 21:00, "930" → 09:30, "1530" → 15:30).
- Display formatters return '' for invalid input; date math (`addDays`, `diffDays`, …) throws RangeError.
- Reminders: unknown IANA zone falls back to UTC. Absurd `daysBefore`/`minutes` are clamped to 10 years.
  `zonedInstant` is host-TZ independent (tests pass under 7 different `TZ=` values).

## Extra exports (beyond SPEC §4.1) you may use
`toEpochDay`, `fromEpochDay`, `parseYMD`, `ymdToISO`, `weekdayOfEpochDay`, `MONTH_NAMES`, `MONTH_SHORT`,
`WEEKDAY_NAMES`, `WEEKDAY_SHORT` (Sunday-indexed), `isValidOrderKey`, `compileRecurrence` (+ helpers),
`taskDate`, `taskRule`, `singleOccurrence`, `occurrencesOfTask`, `firstOpenOccurrenceFrom`,
`forEachDoneOccurrenceRef`, `doneOccurrencesOfTask`.

## Review fixes (core)
- `nextReminder` / `computeRemindAt` no longer return null for a recurring series whose next alert is more than 400
  days away (every 2 years, yearly with next year's occurrence deleted, a series starting far ahead): past the 400-day
  scan they jump to the next open occurrences in closed form (`firstOpenOccurrenceFrom`). null now always means "no
  alert ever". An untimed default/offset series without per-occurrence times returns null up front (cheaper).
  (SPEC §4.1 said "search ≤ 400 days"; deliberately changed — a null was terminal: nothing ever re-armed it.)
- New `repairedRemindAt(stored, computed, now)`: what a stored remindAt should be repaired to (fill / lower only;
  undefined for due, too-early or equal values). Used by the client (boot.ts) and the function's recent-writes repair + daily sweep
  (the function passes the write's `syncedAt` as the "after" instant, so a computed value may already be due).
