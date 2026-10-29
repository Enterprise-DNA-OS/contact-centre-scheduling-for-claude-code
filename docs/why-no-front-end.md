# Why there is no front end

A workforce management suite is a forecast, a set of rosters and a few rules, wrapped in screens. The arithmetic underneath is public and old: Erlang C dates from 1917. What a planner pays for is the layer that lets them see the half hours and drag shifts around.

Here the half hours are a question you ask. "Where are we short next Monday?" runs the same Erlang C calculation against your own history and roster, in your database, and answers in a table you can print.

## What you gain

- **Questions in your words.** "If I approve Ben's leave, which half hours go short?" is one ask, not a report to configure.
- **No per-agent licence.** Every planner and team leader can ask. The bill does not grow with headcount.
- **Your history in your database.** Interval data, rosters and changes are plain records you keep when you leave.
- **Rules you can read.** The break and notice checks are written out with their sources in docs/compliance.md.

## What a screen gives that this does not

- **A drag and drop roster board.** Shifts move by asking, one at a time or by pattern.
- **An agent app.** Agents do not see their roster, bid for shifts or swap here. Rosters go out as drafts you send.
- **Live adherence.** This base reads adherence a day at a time from a file, not second by second.
- **Automatic schedule optimisation.** It finds the gaps and who has hours. A planner decides the fix.

## Who this fits

Centres from about 10 to 150 agents, with one or two planners who already live in spreadsheets around their WFM tool. If your centre runs complex multi-skill routing across hundreds of agents and needs optimised schedules every week, keep the suite, or have Enterprise DNA build those parts in.

Installed and run for you: https://enterprisedna.co/omni/instead-of/verint-workforce-management
