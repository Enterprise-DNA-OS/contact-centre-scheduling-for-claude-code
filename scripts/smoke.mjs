// npm test: a temporary database, every command, the rules and the edge cases. Never touches a live database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDb, REPO_ROOT } from './lib/db.mjs';
import { migrate } from './migrate.mjs';
import { seed } from './seed.mjs';
import { run, READS, TABLES, date, stamp, seconds, mapIntervalRow } from './wfm.mjs';
import { parseCsv } from './lib/csv.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfm-test-'));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
process.env.DATA_DIR = path.join(temp, 'db');
process.env.OUTPUT_DIR = temp;
let db; let checks = 0;
const ok = (v, msg) => { assert.ok(v, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); checks++; };
const rejects = async (fn, re) => { await assert.rejects(fn, re); checks++; };
const file = (name, v) => { const f = path.join(temp, `${name}.json`); fs.writeFileSync(f, JSON.stringify(v)); return `--data=${f}`; };
function cli(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout); checks++;
  return r.stdout;
}
const one = async (sql, p = []) => (await db.query(sql, p))[0];

try {
  db = await getDb();
  await migrate(db);
  eq((await migrate(db)).ran.length, 0, 'repeat migration is a no-op');
  await seed(db); await seed(db);
  eq((await run(db, ['agents'])).length, 21, 'seed is idempotent');
  const weekday = Number((await one('select extract(isodow from current_date)::int d')).d) < 6;

  // Every read runs and returns rows in the expected shape.
  for (const c of Object.keys(READS)) ok(Array.isArray(await run(db, [c])), c);
  for (const c of ['staffing', 'schedule', 'history']) ok(Array.isArray(await run(db, [c])), c);
  const help = await run(db, ['help']);
  eq(help.reads.length, Object.keys(READS).length + 3, 'help lists every read');

  // Erlang C: the answer meets the target and one fewer agent does not.
  const e = await one(`select wfm.agents_needed(100, 180, 80, 20, 100, 'voice') n,
    wfm.service_level(100, 180, wfm.agents_needed(100, 180, 80, 20, 100, 'voice'), 20, 'voice') sl_at_n,
    wfm.service_level(100, 180, wfm.agents_needed(100, 180, 80, 20, 100, 'voice') - 1, 20, 'voice') sl_below,
    wfm.agents_needed(0, 300, 80, 20, 85, 'voice') zero, wfm.agents_needed(10, 420, 80, 20, 85, 'email') email,
    wfm.agents_needed(100, 180, 80, 20, 60, 'voice') capped`);
  ok(Number(e.n) > 10 && Number(e.sl_at_n) >= 80 && Number(e.sl_below) < 80, `Erlang C minimum (${e.n} agents, ${e.sl_at_n}% vs ${e.sl_below}%)`);
  eq(Number(e.zero), 0, 'no contacts needs no agents');
  eq(Number(e.email), Math.ceil((10 * 420 / 1800) / 0.85), 'email is workload over occupancy');
  ok(Number(e.capped) >= Math.ceil(10 / 0.6), 'maximum occupancy raises the requirement');

  // Forecast: six weeks of pattern, today and the next thirteen days, weekdays only.
  const fc = await run(db, ['forecast']);
  ok(fc.length >= 27 && fc.every((r) => Number(r.weeks_of_history) === 6), 'forecast covers the fortnight from six weeks of history');
  ok(fc.some((r) => Number(r.adjustment_pct) === 15), 'planner adjustment applied');

  // Coverage nets off breaks and approved leave.
  const g07 = await one(`select count(*)::int n from wfm.on_phone o join wfm.leave_requests l on l.agent_id = o.agent_id and l.status = 'approved'
    and o.starts_at::date between l.starts_on and l.ends_on`);
  eq(g07.n, 0, 'approved leave removes the shift from coverage');
  const brk = await one(`select o.fte from wfm.on_phone o join wfm.activities x on x.shift_id = o.shift_id and x.kind = 'meal'
    where o.starts_at = x.starts_at limit 1`);
  eq(Number(brk.fte), 0, 'a 30 minute meal takes the agent off the phone for that half hour');
  ok((await run(db, ['coverage-gaps'])).length > 0, 'coverage gaps found');

  // The deliberate problems are all found, with their rules.
  const rules = new Set((await run(db, ['compliance'])).map((r) => r.rule));
  for (const r of ['au-meal-5h', 'au-part-time-3h', 'au-10h-rest', 'au-roster-notice', 'nz-breaks', 'roster-unpublished']) ok(rules.has(r), `rule ${r} found`);
  ok((await run(db, ['leave-impact'])).some((r) => r.code === 'LV-001' && r.newly_short > 0), 'leave that opens gaps is flagged');
  ok((await run(db, ['leave-impact'])).some((r) => r.code === 'LV-003' && r.verdict.includes('beyond')), 'leave past the forecast says so');
  ok((await run(db, ['adherence'])).filter((r) => r.flag).length === 2, 'two agents below 85 per cent adherence');
  eq((await run(db, ['history-outliers'])).filter((r) => r.queue === 'GEN').length, 1, 'outage day found');
  eq((await run(db, ['under-hours']))[0].agent, 'C05', 'part-timer with hours to give');
  if (weekday) {
    const intr = (await run(db, ['intraday'])).find((r) => r.queue === 'CLM');
    ok(Number(intr.variance_pct) > 30 && intr.short_after_reforecast >= intr.short_rest_of_day_on_plan, 'intraday drift and reforecast');
  }
  const att = await run(db, ['attention']);
  for (const a of ['coverage', 'leave', 'rules', 'adherence', 'forecast']) ok(att.some((i) => i.area === a), `attention covers ${a}`);

  // Lookups: case-insensitive names, partial ids, ambiguity lists candidates.
  eq((await run(db, ['agent', 'liam o\'connor'])).agent.code, 'C03', 'case-insensitive name');
  const id = (await run(db, ['agent', 'C03'])).agent.id;
  eq((await run(db, ['agent', id.slice(0, 8)])).agent.code, 'C03', 'partial id');
  await rejects(() => run(db, ['agent', 'an']), /Ambiguous agents/);
  await rejects(() => run(db, ['agent', 'nobody']), /No agents/);
  await rejects(() => run(db, ['agents', '--typo']), /Unknown option/);
  await rejects(() => run(db, ['agents', 'extra']), /Unexpected/);
  await rejects(() => run(db, ['nonsense']), /Unknown command/);
  assert.throws(() => date('2026-02-30')); assert.throws(() => stamp('2026-01-01 25:00')); checks += 2;
  eq(seconds('5:30'), 330, 'mm:ss handle time'); eq(seconds('01:02:03'), 3723, 'hh:mm:ss'); eq(seconds('412'), 412, 'seconds');
  ok(parseCsv('﻿A,B\r\n"a,b","line\nwith ""quotes"""')[0].B === 'line\nwith "quotes"', 'CSV quoting');
  assert.throws(() => parseCsv('A,A\n1,2')); checks++;

  // Writes.
  await run(db, ['add', 'queues', file('q', { code: 'TST', name: 'Test queue', channel: 'chat', opens: '09:00', closes: '12:00' })]);
  await run(db, ['add', 'agents', file('a', { code: 'T01', name: 'Test Agent', team: 'Test', queue_id: 'TST', employment: 'full_time', contract_minutes_week: 600, jurisdiction: 'NZ' })]);
  const sh = await run(db, ['add', 'shifts', file('s', { code: 'T01-A', agent_id: 'T01', starts_at: '2030-01-07 09:00', ends_at: '2030-01-07 17:30' })]);
  eq(sh.status, 'draft', 'new shifts start as draft');
  await run(db, ['add', 'activities', file('b', { shift_id: 'T01-A', kind: 'meal', starts_at: '2030-01-07 13:00', ends_at: '2030-01-07 13:30' })]);
  await rejects(() => run(db, ['add', 'activities', file('b2', { shift_id: 'T01-A', kind: 'rest', starts_at: '2030-01-07 08:00', ends_at: '2030-01-07 08:15' })]), /outside its shift/);
  await rejects(() => run(db, ['add', 'activities', file('b3', { shift_id: 'T01-A', kind: 'rest', starts_at: '2030-01-07 13:15', ends_at: '2030-01-07 13:30' })]), /overlaps/);
  await rejects(() => run(db, ['add', 'shifts', file('s2', { code: 'T01-B', agent_id: 'T01', starts_at: '2030-01-07 12:00', ends_at: '2030-01-07 15:00' })]), /overlapping/);
  await rejects(() => run(db, ['add', 'shifts', file('s3', { code: 'T01-C', agent_id: 'T01', starts_at: '2030-01-07 12:00', bogus: 1 })]), /Unknown field/);
  ok((await run(db, ['compliance'])).some((r) => r.shift === 'T01-A' && r.rule === 'nz-breaks'), 'missing NZ rest breaks found on a new shift');

  const pub = await run(db, ['publish', '--from=2030-01-07', '--to=2030-01-07', '--queue=TST']);
  eq(pub.published, 1, 'publish a draft');
  const mv = await run(db, ['move-shift', 'T01-A', '--start=2030-01-07 10:00', '--end=2030-01-07 18:30', '--basis=agreed', '--reason=Swap requested', '--by=Planner']);
  eq(mv.breaks_moved, 1, 'breaks move with the shift');
  eq((await one("select to_char(x.starts_at, 'HH24:MI') t from wfm.activities x join wfm.shifts s on s.id = x.shift_id where s.code = 'T01-A'")).t, '14:00', 'meal kept its place');
  eq(mv.recorded_change.basis, 'agreed', 'published shift change recorded');
  await rejects(() => run(db, ['move-shift', 'T01-A', '--start=2030-01-07 10:00', '--end=2030-01-07 11:00', '--basis=agreed', '--reason=x', '--by=y']), /outside its shift/);
  eq((await one("select to_char(starts_at, 'HH24:MI') t from wfm.shifts where code = 'T01-A'")).t, '10:00', 'failed move rolled back');
  await rejects(() => run(db, ['move-shift', 'T01-A', '--start=2030-01-07 10:00', '--end=2030-01-07 18:30', '--basis=whim', '--reason=x', '--by=y']), /basis/);

  const before = (await run(db, ['leave-impact'])).find((r) => r.code === 'LV-001');
  const dec = await run(db, ['decide-leave', 'LV-001', '--status=approved', '--by=Planner']);
  eq(dec.status, 'approved', 'leave approved');
  const afterGaps = await one(`select count(*)::int n from wfm.coverage where queue = 'GEN' and gap < 0 and starts_at::date = $1`, [before.starts_on]);
  ok(afterGaps.n >= before.newly_short + before.already_short, 'approval shows in coverage as predicted');
  await rejects(() => run(db, ['decide-leave', 'LV-001', '--status=declined', '--by=Planner']), /already been decided/);

  const ex = await run(db, ['exclude-day', 'GEN', `--date=${(await run(db, ['history-outliers']))[0].day}`, '--reason=Client outage', '--by=Planner']);
  ok(ex.excluded && !(await run(db, ['attention'])).some((i) => i.area === 'forecast'), 'excluded outlier leaves attention');

  const note = await run(db, ['log', 'agent', 'G05', '--author=Planner', '--text=Coaching booked on adherence.']);
  eq(note.logged, 'G05', 'note logged');
  await rejects(() => db.query("update wfm.notes set body = 'changed'"), /append-only/);
  const cx = await run(db, ['cancel-shift', 'T01-A', '--reason=Training cancelled', '--by=Planner']);
  eq(cx.cancelled, 'T01-A', 'shift cancelled');

  // Imports: dry run rolls back, a repeat skips, a conflict stops the whole file.
  const csv = path.join(REPO_ROOT, 'examples', 'verint-intervals.csv');
  const dry = await run(db, ['import', 'verint', `--file=${csv}`, '--dry-run']);
  eq(dry.inserted, 5, 'dry run counts rows');
  eq((await one("select count(*)::int n from wfm.intervals where source = 'verint-import'")).n, 0, 'dry run rolled back');
  eq((await run(db, ['import', 'verint', `--file=${csv}`])).inserted, 5, 'import');
  eq((await run(db, ['import', 'verint', `--file=${csv}`])).skipped_identical, 5, 'repeat import skips');
  const bad = path.join(temp, 'conflict.csv');
  fs.writeFileSync(bad, 'Queue,Interval Start,Offered,Handled,AHT\nGEN,2026-08-03 08:00,12,12,330\nGEN,2026-08-03 10:00,5,5,300\n');
  await rejects(() => run(db, ['import', 'verint', `--file=${bad}`]), /different figures/);
  eq((await one("select count(*)::int n from wfm.intervals where starts_at = '2026-08-03 10:00'")).n, 0, 'conflict stopped the whole import');
  assert.throws(() => mapIntervalRow({ Queue: 'GEN', 'Interval Start': '2026-08-03 08:15', Offered: '1', Handled: '1' }, 2), /half hour/); checks++;
  assert.throws(() => mapIntervalRow({ Queue: 'GEN', 'Interval Start': '2026-08-03 08:00', Offered: '1', Handled: '2' }, 2), /add up/); checks++;
  const agentsCsv = path.join(temp, 'agents.csv');
  fs.writeFileSync(agentsCsv, 'Agent ID,Agent Name,Team,Primary Queue,Employment Type,Weekly Hours,Country\nN01,New Starter,Auckland voice,GEN,Part time,20,New Zealand\n');
  eq((await run(db, ['import', 'agents', `--file=${agentsCsv}`])).inserted, 1, 'agent import');
  eq((await run(db, ['agent', 'N01'])).agent.contract_minutes_week, 1200, 'contract hours mapped');
  eq((await run(db, ['import', 'agents', `--file=${agentsCsv}`])).skipped_identical, 1, 'repeat agent import skips');

  // Export, drafts, views and documents.
  const exp = await run(db, ['export', `--out=${path.join(temp, 'exports', 'backup.json')}`]);
  ok(TABLES.every((t) => t in exp.counts) && exp.counts.shifts > 100, 'export has every table');
  const wk = await run(db, ['draft-weekly']);
  ok(fs.readFileSync(wk.draft, 'utf8').includes('## Coverage gaps'), 'weekly draft written');
  const ro = await run(db, ['draft-roster', 'C03']);
  ok(ro.shifts > 0 && fs.readFileSync(ro.draft, 'utf8').startsWith('Hi Liam'), 'roster draft written');
  await db.close(); db = null;
  ok(cli('view.mjs').includes('views/week.html'), 'views render');
  ok(/\d+ document\(s\) rendered/.test(cli('docs.mjs')), 'documents render');
  ok(cli('wfm.mjs', ['coverage-gaps', '--json']).trim().startsWith('['), 'json output');
  console.log(`PASS ${checks} checks (${process.env.DATABASE_URL ? 'postgres' : 'pglite'})`);
} finally {
  if (db) await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
