<h1 align="center">Contact Centre Scheduling for Claude Code</h1>

<p align="center">
  <strong>The open-source contact centre forecasting and scheduling system that is just a database and Claude Code.</strong>
</p>

<p align="center">
  Created by <a href="https://www.enterprisedna.co"><strong>Enterprise DNA</strong></a>. Free and open source. Works with Claude Code, Codex, OpenCode or Cursor.
</p>

<!-- three-doors -->
<table align="center">
  <tr>
    <td align="center"><strong>Do it yourself</strong><br/>Clone it, run it, own it. Free, MIT.<br/><a href="#quick-start">Quick start</a></td>
    <td align="center"><strong>We customise it</strong><br/>Your fields, your rules, your Verint Workforce Management data brought across.<br/><a href="https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=verint-workforce-management">Book a call</a></td>
    <td align="center"><strong>We run it for you</strong><br/>Installed, connected and operated inside Omni. Setup fee, then a retainer.<br/><a href="https://enterprisedna.co/omni/instead-of/verint-workforce-management?utm_source=github&utm_medium=readme&utm_campaign=verint-workforce-management">How it works</a></td>
  </tr>
</table>

<p align="center">
  <a href="#what-is-this">What is this</a> &bull;
  <a href="#why-no-front-end">Why no front end</a> &bull;
  <a href="#quick-start">Quick start</a> &bull;
  <a href="#the-commands">Commands</a> &bull;
  <a href="#instead-of-verint-workforce-management">Instead of Verint Workforce Management</a> &bull;
  <a href="#want-it-installed-and-run-for-you">Installed for you</a> &bull;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square" alt="Node 20+" />
  <img src="https://img.shields.io/badge/PostgreSQL-any-336791?style=flat-square" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/PGlite-embedded-3ecf8e?style=flat-square" alt="PGlite" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" />
</p>

---

## What is this

Contact Centre Scheduling for Claude Code does the job you pay Verint Workforce Management for, as a Postgres database and a set of agent commands. There is no web front end. You open the folder in [Claude Code](https://claude.com/claude-code) (or Codex, OpenCode, Cursor: see `AGENTS.md`) and ask for what you want in plain language. It runs the right query, and it can answer questions the Verint Workforce Management dashboard cannot.

Verint does not publish prices on its website. Its own G-Cloud 15 pricing document, dated 12 December 2025, lists Verint Workforce Management SaaS at £317.83 per named employee per year and Workforce Management Essentials at £211.89, excluding VAT, with Quality Management a further £125.21 per named employee ([pricing document](https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-15/documents/92827/550763558480369-pricing-document-2025-12-12-1522.pdf), checked 29 October 2026). Every agent, team leader and planner you schedule is a named employee. The free code still has hosting, agent and support costs.

Want the same thing with a web front end, or built on a different stack? That is a customisation, and it is exactly what Enterprise DNA does: [book a call](https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=verint-workforce-management).

It is for contact centres in New Zealand and Australia with roughly 10 to 150 agents and one or two people who plan the roster. It keeps half-hour queue history, builds a two week forecast from it, works out the agents needed with Erlang C against each queue's service level target and maximum occupancy, and compares that with the roster after breaks, training and approved leave. It checks rosters against the New Zealand break minimums and the Contract Call Centres Award 2020 meal, minimum shift, rest and notice clauses, with each rule cited in [docs/compliance.md](docs/compliance.md).

The demo is a fictional contract call centre, Tasman Contact Services: an Auckland team on general enquiries and email, and a Brisbane claims team in the middle of a storm surge. It has gaps, a leave request that would make Monday worse, a part-timer rostered for two and a half hours, a meal break pushed too late, a late close followed by an early start, and an outage day sitting in the forecast history.

## Why no front end

- The front end was only ever there because the database was hard to talk to. That is no longer true.
- Your data sits in plain Postgres tables you own. Any tool can read them. No export, no lock-in.
- No seats, no tiers, no add-ons. Read [docs/why-no-front-end.md](docs/why-no-front-end.md) for the honest trade-offs too.

## Quick start

Sixty seconds, no database install (an embedded Postgres runs inside Node):

```bash
git clone https://github.com/Enterprise-DNA-OS/contact-centre-scheduling-for-claude-code.git
cd contact-centre-scheduling-for-claude-code
npm install
npm run demo
```

Then open the folder in Claude Code and type `/attention`. Follow it with `/intraday`, `/leave-impact` and `/compliance`.

Or from the terminal:

```bash
npm test
npm run wfm -- coverage-gaps
npm run view
npm run docs
```

### Use it with your own Postgres or Supabase

Copy `.env.example` to `.env`, set `DATABASE_URL`, then `npm run migrate`. Same commands, shared data, no per-seat fee.

## The commands

| Command | What it does |
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

`npm run view` renders three read-only pages in your brand: this week (gaps, leave, rule checks, adherence, forecast accuracy), today (actual against forecast) and the fortnight's forecast. `npm run docs` renders each agent's two week roster, a staffing plan per queue and a notice for every roster change.

## Ten questions to ask it

These run against the free version today. Verint has its own reports and analytics; the difference here is that you own the records and the rules, and you ask in your own words.

1. If I approve the leave requests waiting, which half hours go below the agents we need? (`/leave-impact`)
2. Claims is running hot this morning. If it holds, how many half hours are short this afternoon? (`/intraday`)
3. Which shifts break the five hour meal rule, the ten hour rest, or the New Zealand break minimums? (`/compliance`)
4. Which published shifts changed with less than a week's notice, and who changed them? (`/roster-changes`)
5. Which days in our history are pushing the forecast up or down? (`/history-outliers`)
6. How far off was our forecast method last month, and was it over or under? (`/forecast-accuracy`)
7. How much of our shrinkage budget is left for sickness once breaks, coaching and leave are planned? (`/shrinkage`)
8. Who is rostered below their contract hours next week and could cover a gap? (`/under-hours`)
9. What service level does next Monday's roster project at 10:00 on claims? (`/staffing`)
10. Which agents have drifted below 85 per cent adherence, and what do their notes say? (`/adherence`, `/agent`)

## Your first hour: ten things to ask for

1. Put our name and colours on the rosters and staffing plans.
2. Add our queues with our service level targets and opening hours.
3. Load eight weeks of our interval history from the Verint export and check it.
4. Load our agents and set the award for each Australian agent.
5. Set our shrinkage budget per queue.
6. Change our break pattern to what our agreement says.
7. Leave out the days our phone system went down.
8. Build next fortnight's roster from our usual shift patterns.
9. Show me where next Monday is short and who has hours.
10. Draft the weekly review for the operations manager.

## Instead of Verint Workforce Management

Export your queue statistics by 30 minute interval, check the columns, and import with a dry run first:

```bash
npm run wfm -- import verint --file=examples/verint-intervals.csv --dry-run
npm run wfm -- import verint --file=examples/verint-intervals.csv
npm run wfm -- import agents --file=imports/agents.csv --dry-run
```

The example file is illustrative, not a real export. Identical rows are skipped on a repeat; a half hour already recorded with different figures stops the whole file. Rosters, skills routing and agent self-service do not carry over automatically. The full guide, including what does not come across: [docs/replace-verint-workforce-management.md](docs/replace-verint-workforce-management.md).

## Validation

`npm test` runs against a temporary database and clears any inherited `DATABASE_URL`, so it cannot touch live data. It runs every read, every write and its failure cases, the Erlang C answer and the one-fewer check, the rule checks, the imports (dry run, repeat, conflict), export, drafts, views and documents. Set `TEST_DATABASE_URL` to an empty disposable PostgreSQL database for a parity run. The suite uses Node APIs only and runs on Windows and Linux; `.github/workflows/ci.yml` has both.

Times are each queue's local wall-clock time. Agents count toward one primary queue. Staff records stay in your database: never publish an export.

Verint, Calabrio and Teleopti are third-party trademarks. This independent project is not affiliated with Verint.

## Architecture

```
contact-centre-scheduling-for-claude-code/
  CLAUDE.md                 how the operator wants this run (routing table + house rules)
  AGENTS.md                 the same, for Codex / OpenCode / Cursor / Gemini CLI
  .claude/commands/         the slash commands
  scripts/                  the CLI the commands drive
  scripts/lib/db.mjs        one adapter: DATABASE_URL (pg) or embedded PGlite
  supabase/migrations/      plain SQL schema
  supabase/seed.sql         demo data
  docs/                     compliance rules, CLI reference, switch guide, evidence runs
  views.json documents.json the HTML pages and paperwork, from SQL
```

## Built for coding agents

The database, CLI and command recipes work with Claude Code, Codex, OpenCode or Cursor. Ask your coding agent for a new command and have it implement and test the change against the same records.

## Contributing

Issues and pull requests are welcome. Keep the shape: plain SQL, a small CLI, a slash command per recurring job, no front end.

## Want it installed and run for you?

Enterprise DNA installs Contact Centre Scheduling for Claude Code for your business, migrates your Verint Workforce Management data, connects it to the rest of your tools, and runs it for you as part of **Omni**, our managed Command Center. One setup fee, then a monthly retainer.

- Book a call: [enterprisedna.co/omni/book](https://enterprisedna.co/omni/book/?offer=replace-software&utm_source=github&utm_medium=readme&utm_campaign=verint-workforce-management)
- Read more: [enterprisedna.co/omni/instead-of/verint-workforce-management](https://enterprisedna.co/omni/instead-of/verint-workforce-management?utm_source=github&utm_medium=readme&utm_campaign=verint-workforce-management)

## License

MIT. Copyright (c) 2026 Enterprise DNA.
