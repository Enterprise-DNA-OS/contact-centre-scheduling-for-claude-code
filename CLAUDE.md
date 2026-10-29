# Contact Centre Scheduling for Claude Code: operating instructions

This file is the brain. Claude Code reads it at the start of every session. It says who this is for, how work gets done, and the one right way to do each recurring job.

## Who this is for

- **Business:** [YOUR BUSINESS]
- **Operator:** [YOUR NAME], [your role]
- **What matters most:** [the one or two outcomes you care about]

Fill this in once. A worker with context knows. A worker without it guesses.

## How to work

1. **Take a brief, not a script.** The operator describes the outcome. You run the right command and present the answer.
2. **Read before you write.** Before drafting anything about a record, read its full history first.
3. **Plain language.** Short sentences. No filler. Numbers in tables.
4. **Silent success, loud problems.** No play-by-play. Say what broke and what you did about it.
5. **Stop at the line.** Anything that sends, deletes, or faces a customer waits for a yes in this session.

## Routing table: one right way for each recurring job

| Command | Use it when the planner asks... |
|---|---|
| /attention | Everything that needs a planner today: coverage gaps, intraday drift, leave that opens gaps, rule findings, adherence and history outliers. |
| /intraday | Today so far against forecast, and whether the rest of the day is short if the drift holds. |
| /coverage-gaps | Half hours in the next seven days where agents on the phone fall below the agents needed for the service level target. |
| /staffing | The half-hour plan for one day: forecast contacts, handle time, agents needed (Erlang C), agents on the phone, gap and projected service level. |
| /forecast | Daily contacts, handle time and peak agents needed for the next fourteen days. |
| /adjust-forecast | Add a planner adjustment: a marketing send, a billing run, a known event, as a percentage on a queue for a time window. |
| /forecast-accuracy | How well the forecast method did over the last 28 days, by queue: average miss, bias and the worst day. |
| /history-outliers | Days in the last eight weeks that ran 25 per cent or more away from their weekday pattern, and whether they are excluded from the forecast. |
| /exclude-day | Leave a one-off day (an outage, a public holiday) out of the forecast pattern. |
| /schedule | Who is working when: shifts for a day, or one agent from today on. |
| /publish | Publish draft shifts for a date range so agents have their roster. |
| /move-shift | Move or resize a shift. A published shift records the change, its basis and the notice given. |
| /cancel-shift | Cancel a shift and record why. |
| /leave | All leave requests, pending first. |
| /leave-impact | What each pending leave request does to coverage if approved as the roster stands. |
| /decide-leave | Approve or decline a leave request and record who decided. |
| /adherence | Schedule adherence over the last seven days, lowest first, from the phone system feed. |
| /shrinkage | Planned off-phone time (breaks, training, coaching, leave) against the shrinkage budget, by queue and week. |
| /under-hours | Agents rostered below their contract hours next week: the first people to ask about extra cover. |
| /service-level | Service level, abandon rate and handle time by queue and day for the last two weeks, with missed days flagged. |
| /history | Daily contact history by queue. |
| /queues | Queues with their service level target, maximum occupancy, shrinkage budget and opening hours. |
| /agents | Agents with team, queue, employment, contract hours, country and award. |
| /agent | One agent in full: upcoming shifts, leave, adherence and notes. |
| /queue | One queue in full: settings, forecast by day and notes. |
| /shift | One shift in full: times, breaks, sessions and change history. |
| /adjustments | Planner adjustments on the forecast. |
| /roster-changes | Every change to a published shift, with basis and hours of notice. |
| /compliance | Check the roster against the break, rest, minimum shift and notice rules in docs/compliance.md and report what breaches, with the rule cited. |
| /add | Add a record: queue, agent, shift, break, leave request, interval, adherence day or forecast adjustment. |
| /log | Add a note to an agent, queue, shift or leave request. Notes are append-only. |
| /import | Bring interval history or agents across from a Verint (or Calabrio) export. |
| /export | Write every record to one JSON file for backup or moving. |
| /weekly-review | The Monday workforce review, written from attention, coverage gaps, service level, leave and forecast accuracy. |
| /draft-weekly | Save the weekly review as Markdown in drafts/. Nothing sends. |
| /draft-roster | Draft one agent's roster for the next two weeks as a message in drafts/. Nothing sends. |
| /documents | Render the rosters, staffing plans and roster change notices as branded HTML. |
| /customise | Change a field, rule or document in plain language. Writes, tests and applies a migration. |
| /new-view | Add a read-only HTML page rendered in your brand by npm run view. |

If an ask fits nothing here, run the CLI directly (`npm run wfm -- help`) and then propose a new command for it. docs/cli.md says how every number is worked out.

## Hard rules

- Never send email or messages from here. Draft to `drafts/`, a person sends.
- Never delete records without an explicit yes in this session. Prefer marking closed or archived.
- Never invent a record. If a name is ambiguous, list the candidates and ask.
- The database is the source of truth. If the answer is not in it, say so.
- Never invent interval figures, adherence, leave or an award. Imports are dry-run first.
- A rule finding is a prompt to check, not legal advice. Which award or agreement covers a person is the employer's call, recorded in the agent's award field.
- Changes to a published shift always carry a basis (notice, agreed, emergency) and a reason. Agents are told by the planner, not by this system.
- Staff records are personal information. Keep exports and drafts private.

## Where things live

- `scripts/` the CLI. `scripts/lib/db.mjs` picks `DATABASE_URL` (Postgres, Supabase) or the embedded database in `.data/`.
- `supabase/migrations/` the schema, plain SQL. `npm run migrate` applies it.
- `.claude/commands/` the slash commands. Add one every time the same ask comes twice.
- `docs/` the thesis and the guide for moving off Verint Workforce Management.

Built by Enterprise DNA. Installed and run for you as part of Omni: https://enterprisedna.co/omni/instead-of/verint-workforce-management
