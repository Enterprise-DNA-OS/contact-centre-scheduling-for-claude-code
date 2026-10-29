# Moving from Verint Workforce Management

Verint and Calabrio (Teleopti) are now one company. Both keep the records this base needs: queue history by interval, the agent list, and the roster. Export what your account allows, test the import, then run both side by side for at least two forecast cycles.

## 1. Queue history (the forecast needs six weeks, eight is better)

Export a queue or skill statistics report by 30 minute interval to CSV. Your account's report names differ by version and by who set it up, so check the columns against this list. Each field accepts any of the names shown (case does not matter):

| Field | Accepted column names |
|---|---|
| queue | Queue, Queue Name, Skill, Skill Name, Activity |
| interval start | Interval Start, Interval, Start Time, Period, Date Time. A time on its own also needs a Date column. |
| offered | Offered, Calls Offered, Contacts Offered, Offered Calls |
| handled | Handled, Calls Handled, Contacts Handled, Answered |
| answered within service level | Answered Within SL, Answered in SL, Within Service Level, Answered Within Service Level |
| abandoned | Abandoned, Calls Abandoned, Contacts Abandoned |
| handle time | AHT, AHT (s), Average Handle Time, Handle Time. Seconds, mm:ss or hh:mm:ss. |

Rename a column in the CSV if yours differs, or ask Claude Code to add the alias. Add each queue first (`/add` with type `queues`) using the same code or name the export uses.

```bash
npm run wfm -- import verint --file=imports/intervals.csv --dry-run
npm run wfm -- import verint --file=imports/intervals.csv
npm run wfm -- history --days=56
```

The dry run reads every row and rolls back. Rows that match recorded figures are skipped. A row for a half hour already recorded with different figures stops the whole file: reconcile it before trying again. Intervals must start on the hour or half hour.

## 2. Agents

Export the agent or employee list to CSV with ID, name, team, primary queue, employment type (full time, part time, casual), weekly contract hours and country (NZ or AU).

```bash
npm run wfm -- import agents --file=imports/agents.csv --dry-run
npm run wfm -- import agents --file=imports/agents.csv
```

Set each Australian agent's `award` from their employment agreement (`MA000023` turns on the Contract Call Centres Award checks). The import does not guess it.

## 3. The roster

Roster exports vary the most. Export the next two weeks of shifts with agent, start, end and each break or activity. Ask Claude Code to map it to `/add` calls for `shifts` and `activities`, or build new rosters here from the forecast. Shifts load as drafts. Publish with `/publish` once checked.

## What does not carry over

- Skill-based routing weights and multi-skill scheduling. Each agent here counts toward one primary queue.
- Automatic schedule generation and optimisation. Rosters are built from patterns and adjusted with commands.
- Live adherence. Load daily adherence from the phone system as a file (`/add` with type `adherence`).
- Agent self-service (shift bids, swaps, leave requests in an app). Leave requests are recorded by the planner.
- Quality management, recording and speech analytics.

## Side by side

For two weeks, compare this base's `/forecast` and `/staffing` with Verint's for the same days, and compare `/service-level` with the phone system's own report. Differences in agents needed usually come from the service level target, maximum occupancy or handle time settings: line those up in `/queues` first.
