# CLI reference

One CLI: `npm run wfm -- <command>`. Reads print aligned tables; add `--json` for rows. Writes run in one transaction and roll back on any error. References accept a code, a full name (any case) or the start of the record's id; an ambiguous reference lists the candidates and exits 1.

## Reads

| Command | Returns |
|---|---|
| `attention` | Coverage gaps, intraday drift, leave that opens gaps, rule findings, low adherence, history outliers. |
| `intraday` | Today: offered and forecast so far, variance, service level so far, short half hours on plan and after reforecast. |
| `coverage-gaps` | Next 7 days: short half hours by queue and day, worst gap, lowest projected service level. |
| `staffing [--date=YYYY-MM-DD] [--queue=CODE]` | One day by half hour: contacts, handle time, agents needed, agents on the phone, gap, projected service level. Default: next working day. |
| `forecast` | Next 14 days by queue: contacts, handle time, peak agents, adjustment, weeks of history. |
| `forecast-accuracy` | Last 28 days: average daily miss, bias, worst day. |
| `history-outliers` | Days 25 per cent or more from their weekday pattern in the last 8 weeks. |
| `adjustments` | Planner adjustments. |
| `history [--days=N]` | Daily offered, handled, abandoned, service level, handle time. |
| `service-level` | Last 14 days by queue and day against target. |
| `schedule [--date=] [--agent=]` | Shifts for a day (default today) or an agent from today. |
| `leave`, `leave-impact` | Leave requests; what each pending one does to coverage. |
| `adherence` | Last 7 days by agent, lowest first. |
| `shrinkage` | Planned rest, training, coaching and leave against the shrinkage budget by week. |
| `under-hours` | Agents rostered below contract hours next week. |
| `roster-changes` | Changes to published shifts with basis and hours of notice. |
| `compliance` | Rule findings (see docs/compliance.md). |
| `queues`, `agents` | Settings and people. |
| `agent <ref>`, `queue <ref>`, `shift <ref>` | One record in full with notes. |

## Writes

| Command | Does |
|---|---|
| `add <type> --data=<file.json>` | Inserts one record. Types: queues, agents, intervals, history_exclusions, forecast_adjustments, shifts, activities, leave_requests, adherence. `queue_id`, `agent_id` and `shift_id` accept codes. Unknown fields are refused. |
| `log <agent\|queue\|shift\|leave> <ref> --author= --text=` | Append-only note. |
| `publish --from= --to= [--queue=]` | Draft shifts in the range become published, with the time. |
| `move-shift <shift> --start="YYYY-MM-DD HH:MM" --end=... --basis=notice\|agreed\|emergency --reason= --by=` | Moves a shift; breaks keep their place from the start. A published shift records the change and notice. |
| `cancel-shift <shift> --reason= --by=` | Cancels and notes why. |
| `decide-leave <leave> --status=approved\|declined --by=` | Records the decision. Approved leave removes the agent from coverage those days. |
| `exclude-day <queue> --date= --reason= --by=` | Leaves a one-off day out of the forecast pattern. |
| `import verint --file= [--dry-run]` | Interval statistics CSV. See docs/replace-verint-workforce-management.md. |
| `import agents --file= [--dry-run]` | Agent list CSV. |
| `export --out=<file.json>` | Every record, every table. |
| `draft-weekly`, `draft-roster <agent>` | Markdown drafts in drafts/. Nothing sends. |

## How the numbers are worked out

- **Forecast:** for each queue, weekday and half hour, the average contacts over the last six weeks (excluded days left out), times one plus any planner adjustment covering that half hour. Handle time is the handled-weighted average.
- **Agents needed:** Erlang C. The fewest agents on the phone whose projected service level meets the queue's target within its threshold and whose occupancy stays at or under the maximum. Email has no wait in the model: workload divided by maximum occupancy.
- **Agents on the phone:** each shift's share of each half hour minus breaks, meals, training, coaching and meetings. A shift on a day of approved leave counts as zero. Draft and published shifts both count.
- **Service level:** contacts answered within the threshold divided by contacts offered.
- **Planned shrinkage:** rest, training, coaching and meeting minutes plus leave days, over paid minutes (shift minus meal).
