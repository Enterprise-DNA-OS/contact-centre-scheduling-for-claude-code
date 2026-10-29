#!/usr/bin/env node
// The one CLI. Every slash command drives this file.
//   npm run wfm -- help
//   npm run wfm -- coverage-gaps [--json]
// Reads print aligned tables; --json prints rows for machines. Writes run in one transaction.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getDb, REPO_ROOT } from './lib/db.mjs';
import { parseCsv, pick } from './lib/csv.mjs';
import { table } from './lib/format.mjs';

export const TABLES = ['queues', 'agents', 'intervals', 'history_exclusions', 'forecast_adjustments', 'shifts', 'activities',
  'shift_changes', 'leave_requests', 'adherence', 'notes', 'import_rows'];

const DAY = "to_char(starts_at, 'Dy DD Mon')";
export const READS = {
  queues: `select code, name, channel, sl_target_pct || '/' || sl_seconds || 's' service_level, max_occupancy_pct max_occ,
    shrinkage_pct shrinkage_budget, to_char(opens, 'HH24:MI') || '-' || to_char(closes, 'HH24:MI') hours from wfm.queues order by code`,
  agents: `select a.code, a.name, a.team, q.code queue, a.employment, round(a.contract_minutes_week / 60.0, 1) contract_hours,
    a.jurisdiction, coalesce(a.award, '') award, a.active from wfm.agents a join wfm.queues q on q.id = a.queue_id order by a.code`,
  'service-level': `select queue, to_char(day, 'Dy DD Mon') as day, offered, handled, sl_pct, sl_target_pct target, abandon_pct, aht_seconds aht,
    case when sl_pct < sl_target_pct then 'MISSED' else '' end flag
    from wfm.daily_service where day >= current_date - 14 and day < current_date order by queue, daily_service.day`,
  forecast: `select queue, to_char(starts_at::date, 'Dy DD Mon') as day, round(sum(calls))::int contacts,
    round(sum(calls * aht_seconds) / nullif(sum(calls), 0))::int aht, max(required) peak_agents,
    (array_agg(to_char(starts_at, 'HH24:MI') order by required desc, starts_at))[1] peak_at,
    max(adjustment_pct) adjustment_pct, min(weeks_of_history) weeks_of_history
    from wfm.requirements group by queue, starts_at::date order by queue, starts_at::date`,
  'coverage-gaps': `select queue, to_char(starts_at::date, 'Dy DD Mon') as day, count(*)::int short_intervals,
    min(gap) worst_gap, (array_agg(to_char(starts_at, 'HH24:MI') order by gap, starts_at))[1] worst_at,
    min(projected_sl_pct) lowest_projected_sl, string_agg(to_char(starts_at, 'HH24:MI'), ' ' order by starts_at) intervals
    from wfm.coverage where gap < 0 and starts_at::date between current_date and current_date + 6
    group by queue, starts_at::date order by starts_at::date, queue`,
  intraday: `with actual as (
      select q.code queue, i.starts_at, i.offered, i.handled, i.answered_in_sl, i.aht_seconds
      from wfm.intervals i join wfm.queues q on q.id = i.queue_id where i.starts_at::date = current_date),
    sofar as (select a.queue, sum(a.offered) actual, sum(c.calls) forecast from actual a
      join wfm.coverage c on c.queue = a.queue and c.starts_at = a.starts_at group by a.queue),
    rest as (select c.queue, count(*) filter (where wfm.agents_needed(c.calls * coalesce(s.actual / nullif(s.forecast, 0), 1), c.aht_seconds,
        q.sl_target_pct, q.sl_seconds, q.max_occupancy_pct, c.channel) > c.scheduled)::int short_after_reforecast,
        count(*) filter (where c.gap < 0)::int short_on_plan
      from wfm.coverage c join wfm.queues q on q.id = c.queue_id left join sofar s on s.queue = c.queue
      where c.starts_at::date = current_date and not exists (select 1 from actual a where a.queue = c.queue and a.starts_at = c.starts_at)
      group by c.queue)
    select s.queue, s.actual::int offered_so_far, round(s.forecast)::int forecast_so_far,
      round((s.actual / nullif(s.forecast, 0) - 1) * 100, 1) variance_pct,
      (select round(100.0 * sum(answered_in_sl) / nullif(sum(offered), 0), 1) from actual a where a.queue = s.queue) sl_so_far,
      coalesce(r.short_on_plan, 0) short_rest_of_day_on_plan, coalesce(r.short_after_reforecast, 0) short_after_reforecast
    from sofar s left join rest r on r.queue = s.queue order by s.queue`,
  adherence: `select agent, name, team, days, adherence_pct, worst_day_pct,
    case when adherence_pct < 85 then 'BELOW 85' else '' end flag from wfm.adherence_week order by adherence_pct, agent`,
  leave: `select l.code, a.code agent, a.name, l.kind, l.starts_on, l.ends_on, l.status, l.requested_on, coalesce(l.decided_by, '') decided_by
    from wfm.leave_requests l join wfm.agents a on a.id = l.agent_id
    order by (l.status = 'pending') desc, l.starts_on, l.code`,
  'leave-impact': `select code, agent, name, queue, kind, starts_on, ends_on, current_date - requested_on days_waiting,
    newly_short, already_short, case when beyond_forecast then 'beyond the 14 day forecast' when newly_short > 0 then 'approving opens new gaps'
    when already_short > 0 then 'queue already short those days' else 'no coverage effect' end verdict
    from wfm.leave_impact order by newly_short desc, starts_on`,
  shrinkage: `select queue, week_of, round(paid_minutes / 60.0, 1) paid_hours, round(rest_minutes / 60.0, 1) rest_hours,
    round(development_minutes / 60.0, 1) training_coaching_hours, round(leave_minutes / 60.0, 1) leave_hours,
    planned_pct, assumed_pct budget_pct, round(assumed_pct - planned_pct, 1) left_for_unplanned
    from wfm.planned_shrinkage order by queue, week_of`,
  'forecast-accuracy': `select queue, days, mape_pct, bias_pct, worst_day from wfm.forecast_accuracy order by queue`,
  'history-outliers': `select queue, day, offered, typical, variance_pct, excluded from wfm.history_outliers order by day, queue`,
  adjustments: `select f.code, q.code queue, f.starts_at, f.ends_at, f.volume_pct, f.reason, f.created_by
    from wfm.forecast_adjustments f join wfm.queues q on q.id = f.queue_id order by f.starts_at`,
  'roster-changes': `select s.code shift, a.code agent, c.changed_at, c.old_starts_at, c.new_starts_at, c.new_ends_at, c.basis,
    round(extract(epoch from least(c.old_starts_at, c.new_starts_at) - c.changed_at) / 3600)::int hours_notice, c.reason, c.changed_by
    from wfm.shift_changes c join wfm.shifts s on s.id = c.shift_id join wfm.agents a on a.id = s.agent_id order by c.changed_at desc`,
  'under-hours': `with nextweek as (select (current_date + (8 - extract(isodow from current_date)::int)) wk),
    hrs as (select a.id, coalesce(sum(d.paid_minutes) filter (where d.status <> 'cancelled' and not d.on_leave), 0) working,
        coalesce(sum(d.paid_minutes) filter (where d.status <> 'cancelled' and d.on_leave), 0) on_leave
      from wfm.agents a cross join nextweek w left join wfm.shift_detail d on d.agent = a.code and d.work_date between w.wk and w.wk + 6
      group by a.id)
    select a.code agent, a.name, q.code queue, a.employment, round(a.contract_minutes_week / 60.0, 1) contract_hours,
      round(h.working / 60.0, 1) rostered_hours, round(h.on_leave / 60.0, 1) leave_hours,
      round((a.contract_minutes_week - h.working - h.on_leave) / 60.0, 1) hours_available
    from wfm.agents a join wfm.queues q on q.id = a.queue_id join hrs h on h.id = a.id
    where a.active and a.employment <> 'casual' and a.contract_minutes_week - h.working - h.on_leave > 0
    order by hours_available desc, a.code`,
  compliance: `select rule, shift, agent, work_date, detail from wfm.compliance_findings order by work_date, rule, agent`,
};
// Reads that take options: date and agent filters.
const OPTION_READS = {
  staffing: { opts: ['date', 'queue'], run: async (db, o) => {
    const date = o.date ? dateArg(o.date) : (await db.query("select min(starts_at::date)::text d from wfm.coverage where starts_at::date > current_date"))[0].d;
    return db.query(`select queue, to_char(starts_at, 'HH24:MI') as time, calls, aht_seconds aht, required, scheduled, gap,
      projected_sl_pct projected_sl, sl_target_pct target from wfm.coverage
      where starts_at::date = $1 and ($2 = '' or lower(queue) = lower($2)) order by queue, starts_at`, [date, o.queue || '']);
  } },
  schedule: { opts: ['date', 'agent'], run: async (db, o) => {
    const date = o.date ? dateArg(o.date) : null;
    return db.query(`select d.code shift, d.agent, d.name, d.queue, to_char(d.starts_at, 'Dy DD Mon') as day, to_char(d.starts_at, 'HH24:MI') starts,
      to_char(d.ends_at, 'HH24:MI') ends, d.status, d.rest_breaks rests, d.meal_breaks meals, d.development_minutes training_mins,
      case when d.on_leave then 'ON LEAVE' else '' end leave
      from wfm.shift_detail d where d.status <> 'cancelled'
      and case when $1::date is not null then d.work_date = $1::date when $2 <> '' then d.work_date >= current_date else d.work_date = current_date end
      and ($2 = '' or lower(d.agent) = lower($2)) order by d.starts_at, d.agent`, [date, o.agent || '']);
  } },
  history: { opts: ['days'], run: async (db, o) => {
    const days = o.days ? Number(o.days) : 14;
    if (!Number.isInteger(days) || days < 1 || days > 400) throw Error('--days must be a whole number from 1 to 400');
    return db.query(`select queue, to_char(day, 'Dy DD Mon') as day, offered, handled, abandoned, sl_pct, aht_seconds aht
      from wfm.daily_service where day >= current_date - $1::int and day < current_date order by queue, daily_service.day`, [days]);
  } },
};

const ADD_FIELDS = {
  queues: ['code', 'name', 'channel', 'sl_target_pct', 'sl_seconds', 'max_occupancy_pct', 'shrinkage_pct', 'opens', 'closes', 'open_days'],
  agents: ['code', 'name', 'team', 'queue_id', 'employment', 'contract_minutes_week', 'jurisdiction', 'award', 'active'],
  intervals: ['queue_id', 'starts_at', 'offered', 'handled', 'answered_in_sl', 'abandoned', 'aht_seconds', 'source'],
  history_exclusions: ['queue_id', 'day', 'reason', 'created_by'],
  forecast_adjustments: ['code', 'queue_id', 'starts_at', 'ends_at', 'volume_pct', 'reason', 'created_by'],
  shifts: ['code', 'agent_id', 'starts_at', 'ends_at'],
  activities: ['shift_id', 'kind', 'starts_at', 'ends_at'],
  leave_requests: ['code', 'agent_id', 'kind', 'starts_on', 'ends_on', 'requested_on'],
  adherence: ['agent_id', 'work_date', 'scheduled_minutes', 'adherent_minutes', 'source'],
};
const REFS = { queue_id: 'queues', agent_id: 'agents', shift_id: 'shifts' };
const LOOKUP = {
  queues: { label: 'queues', sql: 'select id, code, name from wfm.queues' },
  agents: { label: 'agents', sql: 'select id, code, name from wfm.agents' },
  shifts: { label: 'shifts', sql: 'select id, code, code as name from wfm.shifts' },
  leave: { label: 'leave requests', sql: 'select id, code, code as name from wfm.leave_requests' },
};

const HELP = {
  reads: [...Object.keys(READS), ...Object.keys(OPTION_READS)].sort(),
  details: ['agent <ref>', 'queue <ref>', 'shift <ref>'],
  writes: ['add <type> --data=<file.json>', 'log <agent|queue|shift|leave> <ref> --author= --text=', 'publish --from=<date> --to=<date> [--queue=]',
    'move-shift <shift> --start="YYYY-MM-DD HH:MM" --end="YYYY-MM-DD HH:MM" --basis=notice|agreed|emergency --reason= --by=',
    'cancel-shift <shift> --reason= --by=', 'decide-leave <leave> --status=approved|declined --by=', 'exclude-day <queue> --date= --reason= --by=',
    'import verint --file=<csv> [--dry-run]', 'import agents --file=<csv> [--dry-run]', 'export --out=<file.json>', 'draft-weekly', 'draft-roster <agent>'],
};

// ------------------------------------------------------------------ helpers
export function date(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw Error(`Invalid date "${v}". Use YYYY-MM-DD.`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw Error(`Invalid date "${v}".`);
  return v;
}
const dateArg = date;
export function stamp(v) {
  const m = String(v).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw Error(`Invalid date and time "${v}". Use "YYYY-MM-DD HH:MM".`);
  date(m[1]);
  if (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] || 0) > 59) throw Error(`Invalid time in "${v}".`);
  return `${m[1]} ${m[2]}:${m[3]}:${m[4] || '00'}`;
}
// "330", "5:30", "00:05:30" -> seconds
export function seconds(v) {
  const s = String(v ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) throw Error(`Cannot read "${v}" as a handle time. Use seconds or mm:ss.`);
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
function count(v, label) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!/^\d+$/.test(s)) throw Error(`${label} must be a whole number, got "${v}"`);
  return Number(s);
}
function parseArgs(args) {
  const pos = []; const opts = {};
  for (const a of args) {
    if (a.startsWith('--')) { const eq = a.indexOf('='); opts[eq < 0 ? a.slice(2) : a.slice(2, eq)] = eq < 0 ? true : a.slice(eq + 1); }
    else pos.push(a);
  }
  return { pos, opts };
}
function allow(opts, names) {
  for (const k of Object.keys(opts)) if (!['json', ...names].includes(k)) throw Error(`Unknown option --${k}`);
}
function need(opts, k) { if (opts[k] === undefined || opts[k] === true || String(opts[k]).trim() === '') throw Error(`--${k} is required`); return String(opts[k]).trim(); }
function noExtra(pos, n) { if (pos.length > n) throw Error(`Unexpected argument "${pos[n]}"`); }

// Code, name (case insensitive), or UUID prefix. Ambiguity lists the candidates.
export async function resolve(db, kind, ref) {
  const l = LOOKUP[kind];
  if (!ref) throw Error(`Name a ${kind.replace(/s$/, '')}`);
  const rows = await db.query(`select * from (${l.sql}) t where lower(code) = lower($1) or lower(name) = lower($1) or id::text like lower($1) || '%'
    or lower(name) like '%' || lower($1) || '%'`, [ref]);
  const exact = rows.filter((r) => r.code.toLowerCase() === ref.toLowerCase() || r.name.toLowerCase() === ref.toLowerCase());
  const hits = exact.length ? exact : rows;
  if (!hits.length) throw Error(`No ${l.label} match "${ref}"`);
  if (hits.length > 1) throw Error(`Ambiguous ${l.label} "${ref}": ${hits.map((r) => `${r.code} (${r.name})`).join(', ')}`);
  return hits[0];
}

async function tx(db, fn, { dryRun = false } = {}) {
  await db.exec('BEGIN');
  try { const out = await fn(); await db.exec(dryRun ? 'ROLLBACK' : 'COMMIT'); return out; }
  catch (e) { await db.exec('ROLLBACK'); throw e; }
}

// ------------------------------------------------------------------ commands
export async function run(db, argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  if (!cmd || cmd === 'help') return HELP;
  if (READS[cmd]) { allow(opts, []); noExtra(pos, 0); return db.query(READS[cmd]); }
  if (OPTION_READS[cmd]) { allow(opts, OPTION_READS[cmd].opts); noExtra(pos, 0); return OPTION_READS[cmd].run(db, opts); }

  switch (cmd) {
    case 'attention': { allow(opts, []); noExtra(pos, 0); return attention(db); }
    case 'agent': {
      allow(opts, []); noExtra(pos, 1);
      const a = await resolve(db, 'agents', pos[0]);
      return {
        agent: (await db.query(`select a.*, q.code queue from wfm.agents a join wfm.queues q on q.id = a.queue_id where a.id = $1`, [a.id]))[0],
        shifts: await db.query(`select code, starts_at, ends_at, status, rest_breaks, meal_breaks, on_leave from wfm.shift_detail
          where agent = $1 and work_date >= current_date order by starts_at`, [a.code]),
        leave: await db.query('select code, kind, starts_on, ends_on, status from wfm.leave_requests where agent_id = $1 order by starts_on', [a.id]),
        adherence: await db.query('select work_date, scheduled_minutes, adherent_minutes from wfm.adherence where agent_id = $1 order by work_date desc limit 10', [a.id]),
        notes: await db.query("select created_at, author, body from wfm.notes where subject_type = 'agent' and subject_id = $1 order by created_at", [a.id]),
      };
    }
    case 'queue': {
      allow(opts, []); noExtra(pos, 1);
      const q = await resolve(db, 'queues', pos[0]);
      return {
        queue: (await db.query('select * from wfm.queues where id = $1', [q.id]))[0],
        forecast: (await db.query(READS.forecast)).filter((r) => r.queue === q.code),
        notes: await db.query("select created_at, author, body from wfm.notes where subject_type = 'queue' and subject_id = $1 order by created_at", [q.id]),
      };
    }
    case 'shift': {
      allow(opts, []); noExtra(pos, 1);
      const s = await resolve(db, 'shifts', pos[0]);
      return {
        shift: (await db.query('select * from wfm.shift_detail where id = $1', [s.id]))[0],
        activities: await db.query('select kind, starts_at, ends_at from wfm.activities where shift_id = $1 order by starts_at', [s.id]),
        changes: await db.query('select changed_at, old_starts_at, new_starts_at, new_ends_at, basis, reason, changed_by from wfm.shift_changes where shift_id = $1 order by changed_at', [s.id]),
        notes: await db.query("select created_at, author, body from wfm.notes where subject_type = 'shift' and subject_id = $1 order by created_at", [s.id]),
      };
    }
    case 'add': return add(db, pos, opts);
    case 'log': {
      allow(opts, ['author', 'text']); noExtra(pos, 2);
      const kinds = { agent: 'agents', queue: 'queues', shift: 'shifts', leave: 'leave' };
      if (!kinds[pos[0]]) throw Error('log needs agent, queue, shift or leave first');
      const target = await resolve(db, kinds[pos[0]], pos[1]);
      const [row] = await db.query('insert into wfm.notes (subject_type, subject_id, author, body) values ($1, $2, $3, $4) returning created_at, author, body',
        [pos[0], target.id, need(opts, 'author'), need(opts, 'text')]);
      return { logged: target.code, ...row };
    }
    case 'publish': {
      allow(opts, ['from', 'to', 'queue']); noExtra(pos, 0);
      const from = date(need(opts, 'from')); const to = date(need(opts, 'to'));
      const rows = await db.query(`update wfm.shifts s set status = 'published', published_at = localtimestamp(0)
        from wfm.agents a join wfm.queues q on q.id = a.queue_id
        where a.id = s.agent_id and s.status = 'draft' and s.starts_at::date between $1 and $2 and ($3 = '' or lower(q.code) = lower($3))
        returning s.code`, [from, to, opts.queue || '']);
      return { published: rows.length, shifts: rows.map((r) => r.code) };
    }
    case 'move-shift': return moveShift(db, pos, opts);
    case 'cancel-shift': {
      allow(opts, ['reason', 'by']); noExtra(pos, 1);
      const s = await resolve(db, 'shifts', pos[0]);
      return tx(db, async () => {
        const [row] = await db.query("update wfm.shifts set status = 'cancelled' where id = $1 and status <> 'cancelled' returning code, starts_at", [s.id]);
        if (!row) throw Error(`${s.code} is already cancelled`);
        await db.query("insert into wfm.notes (subject_type, subject_id, author, body) values ('shift', $1, $2, $3)", [s.id, need(opts, 'by'), `Cancelled: ${need(opts, 'reason')}`]);
        return { cancelled: row.code, starts_at: row.starts_at };
      });
    }
    case 'decide-leave': {
      allow(opts, ['status', 'by']); noExtra(pos, 1);
      const status = need(opts, 'status');
      if (!['approved', 'declined'].includes(status)) throw Error('--status must be approved or declined');
      const l = await resolve(db, 'leave', pos[0]);
      const [row] = await db.query(`update wfm.leave_requests set status = $2, decided_by = $3, decided_on = current_date
        where id = $1 and status = 'pending' returning code, status, starts_on, ends_on`, [l.id, status, need(opts, 'by')]);
      if (!row) throw Error(`${l.code} has already been decided`);
      return row;
    }
    case 'exclude-day': {
      allow(opts, ['date', 'reason', 'by']); noExtra(pos, 1);
      const q = await resolve(db, 'queues', pos[0]);
      const [row] = await db.query(`insert into wfm.history_exclusions (queue_id, day, reason, created_by) values ($1, $2, $3, $4)
        on conflict (queue_id, day) do nothing returning day`, [q.id, date(need(opts, 'date')), need(opts, 'reason'), need(opts, 'by')]);
      return { queue: q.code, excluded: row ? row.day : null, already_excluded: !row };
    }
    case 'import': return importCsv(db, pos, opts);
    case 'export': {
      allow(opts, ['out']); noExtra(pos, 0);
      const out = path.resolve(need(opts, 'out'));
      const data = {};
      for (const t of TABLES) data[t] = await db.query(`select * from wfm.${t} order by id`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ exported_at: new Date().toISOString(), tables: data }, null, 2), { mode: 0o600 });
      return { file: out, counts: Object.fromEntries(TABLES.map((t) => [t, data[t].length])) };
    }
    case 'draft-weekly': { allow(opts, []); noExtra(pos, 0); return draftWeekly(db); }
    case 'draft-roster': { allow(opts, []); noExtra(pos, 1); return draftRoster(db, pos[0]); }
    default: throw Error(`Unknown command "${cmd}". Run: npm run wfm -- help`);
  }
}

async function attention(db) {
  const items = [];
  for (const r of await db.query(READS['coverage-gaps'])) {
    if (r.day && items.filter((i) => i.area === 'coverage').length < 6)
      items.push({ area: 'coverage', item: `${r.queue} ${r.day}`, detail: `${r.short_intervals} half hours short, worst ${r.worst_gap} at ${r.worst_at}, projected service level as low as ${r.lowest_projected_sl}%` });
  }
  for (const r of await db.query(READS.intraday))
    if (Math.abs(Number(r.variance_pct)) >= 10) items.push({ area: 'intraday', item: r.queue, detail: `running ${r.variance_pct}% against forecast; ${r.short_after_reforecast} half hours short for the rest of today if it holds` });
  for (const r of await db.query(READS['leave-impact']))
    if (r.newly_short > 0) items.push({ area: 'leave', item: `${r.code} ${r.name}`, detail: `${r.kind} ${r.starts_on}: approving opens ${r.newly_short} new short half hours; waiting ${r.days_waiting} days` });
  for (const r of await db.query(READS.compliance)) items.push({ area: 'rules', item: `${r.rule} ${r.agent}`, detail: `${r.shift}: ${r.detail}` });
  for (const r of await db.query(READS.adherence)) if (r.flag) items.push({ area: 'adherence', item: `${r.agent} ${r.name}`, detail: `${r.adherence_pct}% over ${r.days} days, worst day ${r.worst_day_pct}%` });
  for (const r of await db.query(READS['history-outliers'])) if (!r.excluded) items.push({ area: 'forecast', item: `${r.queue} ${r.day}`, detail: `${r.variance_pct}% against its weekday pattern and still in the forecast history` });
  return items;
}

async function add(db, pos, opts) {
  allow(opts, ['data']); noExtra(pos, 1);
  const type = pos[0];
  if (!ADD_FIELDS[type]) throw Error(`add needs one of: ${Object.keys(ADD_FIELDS).join(', ')}`);
  const data = JSON.parse(fs.readFileSync(need(opts, 'data'), 'utf8'));
  const unknown = Object.keys(data).filter((k) => !ADD_FIELDS[type].includes(k));
  if (unknown.length) throw Error(`Unknown field(s) for ${type}: ${unknown.join(', ')}`);
  for (const [k, kind] of Object.entries(REFS)) if (data[k]) data[k] = (await resolve(db, kind, String(data[k]))).id;
  const cols = Object.keys(data);
  if (!cols.length) throw Error('No fields supplied');
  const [row] = await db.query(`insert into wfm.${type} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`, cols.map((c) => data[c]));
  return row;
}

async function moveShift(db, pos, opts) {
  allow(opts, ['start', 'end', 'basis', 'reason', 'by']); noExtra(pos, 1);
  const s = await resolve(db, 'shifts', pos[0]);
  const start = stamp(need(opts, 'start')); const end = stamp(need(opts, 'end'));
  const basis = need(opts, 'basis');
  if (!['notice', 'agreed', 'emergency'].includes(basis)) throw Error('--basis must be notice, agreed or emergency');
  const reason = need(opts, 'reason'); const by = need(opts, 'by');
  return tx(db, async () => {
    const [old] = await db.query("select id, code, status, starts_at, ends_at from wfm.shifts where id = $1", [s.id]);
    if (old.status === 'cancelled') throw Error(`${old.code} is cancelled`);
    const acts = await db.query('select kind, starts_at, ends_at from wfm.activities where shift_id = $1 order by starts_at', [s.id]);
    await db.query('delete from wfm.activities where shift_id = $1', [s.id]);
    await db.query('update wfm.shifts set starts_at = $2, ends_at = $3 where id = $1', [s.id, start, end]);
    for (const a of acts) {
      // Breaks keep their place relative to the start of the shift.
      await db.query(`insert into wfm.activities (shift_id, kind, starts_at, ends_at)
        values ($1, $2, $3::timestamp + ($4::timestamp - $5::timestamp), $3::timestamp + ($6::timestamp - $5::timestamp))`,
        [s.id, a.kind, start, a.starts_at, old.starts_at, a.ends_at]);
    }
    let change = null;
    if (old.status === 'published') {
      [change] = await db.query(`insert into wfm.shift_changes (shift_id, changed_at, old_starts_at, old_ends_at, new_starts_at, new_ends_at, basis, reason, changed_by)
        values ($1, localtimestamp(0), $2, $3, $4, $5, $6, $7, $8) returning basis,
        round(extract(epoch from least(old_starts_at, new_starts_at) - changed_at) / 3600)::int hours_notice`,
        [s.id, old.starts_at, old.ends_at, start, end, basis, reason, by]);
    }
    const findings = await db.query('select rule, detail from wfm.compliance_findings where shift = $1', [old.code]);
    return { moved: old.code, from: `${old.starts_at} to ${old.ends_at}`, to: `${start} to ${end}`, breaks_moved: acts.length,
      recorded_change: change, rule_findings: findings };
  });
}

// ------------------------------------------------------------------ imports
const INTERVAL_COLUMNS = {
  queue: ['Queue', 'Queue Name', 'Skill', 'Skill Name', 'Activity'],
  start: ['Interval Start', 'Interval', 'Start Time', 'Period', 'Date Time'],
  day: ['Date'],
  offered: ['Offered', 'Calls Offered', 'Contacts Offered', 'Offered Calls'],
  handled: ['Handled', 'Calls Handled', 'Contacts Handled', 'Answered'],
  answered_in_sl: ['Answered Within SL', 'Answered in SL', 'Within Service Level', 'Answered Within Service Level'],
  abandoned: ['Abandoned', 'Calls Abandoned', 'Contacts Abandoned'],
  aht: ['AHT', 'AHT (s)', 'Average Handle Time', 'Handle Time'],
};
export function mapIntervalRow(r, n) {
  const get = (k) => pick(r, ...INTERVAL_COLUMNS[k]);
  const queue = get('queue'); if (!queue) throw Error(`Row ${n}: no queue column`);
  let start = get('start'); const day = get('day');
  if (!start) throw Error(`Row ${n}: no interval start column`);
  if (/^\d{1,2}:\d{2}/.test(start)) { if (!day) throw Error(`Row ${n}: interval "${start}" has no Date column`); start = `${day} ${start.padStart(5, '0')}`; }
  start = stamp(start.replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
  if (!/:(00|30):00$/.test(start)) throw Error(`Row ${n}: ${start} is not on a half hour. Export 30 minute intervals.`);
  const offered = count(get('offered'), `Row ${n} offered`);
  const handled = count(get('handled'), `Row ${n} handled`);
  const abandoned = get('abandoned') === '' ? 0 : count(get('abandoned'), `Row ${n} abandoned`);
  const inSl = get('answered_in_sl') === '' ? 0 : count(get('answered_in_sl'), `Row ${n} answered within service level`);
  const aht = get('aht') === '' ? 0 : seconds(get('aht'));
  if (handled > offered || inSl > handled || handled + abandoned > offered) throw Error(`Row ${n}: handled, abandoned and answered counts do not add up to offered`);
  return { queue, starts_at: start, offered, handled, answered_in_sl: inSl, abandoned, aht_seconds: aht };
}
const AGENT_COLUMNS = {
  code: ['Agent ID', 'Employee ID', 'Code', 'ID'], name: ['Agent Name', 'Name', 'Full Name'], team: ['Team', 'Team Name', 'Site'],
  queue: ['Queue', 'Primary Queue', 'Skill', 'Primary Skill'], employment: ['Employment', 'Employment Type', 'Contract Type'],
  hours: ['Contract Hours', 'Weekly Hours', 'Hours Per Week'], jurisdiction: ['Country', 'Jurisdiction'], award: ['Award'],
};
function mapAgentRow(r, n) {
  const get = (k) => pick(r, ...AGENT_COLUMNS[k]);
  const code = get('code'); const name = get('name');
  if (!code || !name) throw Error(`Row ${n}: agent ID and name are required`);
  const emp = (get('employment') || 'full_time').toLowerCase().replace(/[\s-]+/g, '_');
  if (!['full_time', 'part_time', 'casual'].includes(emp)) throw Error(`Row ${n}: employment "${get('employment')}" must be full time, part time or casual`);
  const j = (get('jurisdiction') || '').toUpperCase().replace('NEW ZEALAND', 'NZ').replace('AUSTRALIA', 'AU');
  if (!['NZ', 'AU'].includes(j)) throw Error(`Row ${n}: country must be NZ or AU`);
  const hours = get('hours') === '' ? 0 : Number(get('hours'));
  if (!Number.isFinite(hours) || hours < 0 || hours > 80) throw Error(`Row ${n}: contract hours "${get('hours')}" is not a weekly figure`);
  return { code, name, team: get('team') || 'Unassigned', queue: get('queue'), employment: emp, contract_minutes_week: Math.round(hours * 60), jurisdiction: j, award: get('award') || null };
}

async function importCsv(db, pos, opts) {
  allow(opts, ['file', 'dry-run']); noExtra(pos, 1);
  const kind = pos[0];
  if (!['verint', 'agents'].includes(kind)) throw Error('import needs verint (interval statistics) or agents');
  const file = need(opts, 'file');
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) throw Error('The file has no rows');
  const source = kind === 'verint' ? 'verint-intervals' : 'agents';
  const mapped = rows.map((r, i) => (kind === 'verint' ? mapIntervalRow(r, i + 2) : mapAgentRow(r, i + 2)));
  const dryRun = opts['dry-run'] === true;
  return tx(db, async () => {
    const result = { file: path.basename(file), rows: rows.length, inserted: 0, skipped_identical: 0, dry_run: dryRun };
    for (let i = 0; i < mapped.length; i++) {
      const m = mapped[i];
      const hash = crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
      if ((await db.query('select 1 from wfm.import_rows where source = $1 and row_hash = $2', [source, hash])).length) { result.skipped_identical++; continue; }
      const q = await resolve(db, 'queues', m.queue).catch((e) => { throw Error(`Row ${i + 2}: ${e.message}. Add the queue first.`); });
      let id;
      if (kind === 'verint') {
        const existing = await db.query('select id, offered, handled, answered_in_sl, abandoned, aht_seconds from wfm.intervals where queue_id = $1 and starts_at = $2', [q.id, m.starts_at]);
        if (existing.length) {
          const e = existing[0];
          const same = ['offered', 'handled', 'answered_in_sl', 'abandoned', 'aht_seconds'].every((k) => Number(e[k]) === m[k]);
          if (!same) throw Error(`Row ${i + 2}: ${q.code} ${m.starts_at} is already recorded with different figures. Nothing was imported. Reconcile the export first.`);
          result.skipped_identical++; id = e.id;
        } else {
          [{ id }] = await db.query(`insert into wfm.intervals (queue_id, starts_at, offered, handled, answered_in_sl, abandoned, aht_seconds, source)
            values ($1, $2, $3, $4, $5, $6, $7, 'verint-import') returning id`, [q.id, m.starts_at, m.offered, m.handled, m.answered_in_sl, m.abandoned, m.aht_seconds]);
          result.inserted++;
        }
      } else {
        const existing = await db.query('select id, name from wfm.agents where lower(code) = lower($1)', [m.code]);
        if (existing.length) throw Error(`Row ${i + 2}: agent ${m.code} already exists. Nothing was imported.`);
        [{ id }] = await db.query(`insert into wfm.agents (code, name, team, queue_id, employment, contract_minutes_week, jurisdiction, award)
          values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [m.code, m.name, m.team, q.id, m.employment, m.contract_minutes_week, m.jurisdiction, m.award]);
        result.inserted++;
      }
      await db.query('insert into wfm.import_rows (source, file_name, row_number, row_hash, target_id) values ($1, $2, $3, $4, $5)', [source, path.basename(file), i + 2, hash, id]);
    }
    return result;
  }, { dryRun });
}

// ------------------------------------------------------------------ drafts (never sent)
function draftsDir() { const d = path.resolve(process.env.OUTPUT_DIR || REPO_ROOT, 'drafts'); fs.mkdirSync(d, { recursive: true }); return d; }
function md(rows) {
  if (!rows.length) return '_None._\n';
  const keys = Object.keys(rows[0]);
  return [`| ${keys.join(' | ')} |`, `| ${keys.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${keys.map((k) => String(r[k] ?? '').replace(/\|/g, '/')).join(' | ')} |`)].join('\n') + '\n';
}
async function draftWeekly(db) {
  const [{ today }] = await db.query("select current_date::text today");
  const body = [`# Workforce review, week of ${today}`, '',
    'Draft for the operations lead. Figures come from the scheduling database at the time of writing. Nothing has been sent.', '',
    '## What needs attention', md(await attention(db)),
    '## Coverage gaps, next seven days', md(await db.query(READS['coverage-gaps'])),
    '## Service level, last two weeks (days missed)', md((await db.query(READS['service-level'])).filter((r) => r.flag)),
    '## Leave waiting for a decision', md(await db.query(READS['leave-impact'])),
    '## Rule checks', md(await db.query(READS.compliance)),
    '## Forecast accuracy, last 28 days', md(await db.query(READS['forecast-accuracy']))].join('\n');
  const file = path.join(draftsDir(), `weekly-review-${today}.md`);
  fs.writeFileSync(file, body);
  return { draft: file, sections: 6 };
}
async function draftRoster(db, ref) {
  const a = await resolve(db, 'agents', ref);
  const shifts = await db.query(`select to_char(d.starts_at, 'Dy DD Mon') as day, to_char(d.starts_at, 'HH24:MI') starts, to_char(d.ends_at, 'HH24:MI') ends,
    d.status, (select string_agg(x.kind || ' ' || to_char(x.starts_at, 'HH24:MI'), ', ' order by x.starts_at) from wfm.activities x where x.shift_id = d.id) breaks
    from wfm.shift_detail d where d.agent = $1 and d.work_date between current_date and current_date + 13 and d.status <> 'cancelled' and not d.on_leave order by d.starts_at`, [a.code]);
  const [{ today }] = await db.query("select current_date::text today");
  const body = [`Hi ${a.name.split(' ')[0]},`, '', 'Here is your roster for the next two weeks.', '', md(shifts),
    'Shifts marked draft may still change. Published shifts change only with notice or by agreement.', ''].join('\n');
  const file = path.join(draftsDir(), `roster-${a.code}-${today}.md`);
  fs.writeFileSync(file, body);
  return { draft: file, shifts: shifts.length };
}

// ------------------------------------------------------------------ main
function print(out) {
  if (Array.isArray(out)) {
    if (!out.length) return console.log('  (none)');
    const keys = Object.keys(out[0]);
    return console.log(table(out, keys.map((k) => ({ key: k, label: k.replace(/_/g, ' '), width: 70,
      align: typeof out[0][k] === 'number' || /^-?\d+(\.\d+)?$/.test(String(out[0][k] ?? '')) ? 'right' : 'left' }))));
  }
  if (out && typeof out === 'object') {
    for (const [k, v] of Object.entries(out)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') { console.log(`\n${k}`); print(v); }
      else if (v && typeof v === 'object' && !Array.isArray(v)) { console.log(`\n${k}`); for (const [k2, v2] of Object.entries(v)) console.log(`  ${k2}: ${v2 ?? ''}`); }
      else console.log(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
  }
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const db = await getDb();
  try {
    const out = await run(db, args.filter((a) => a !== '--json'));
    if (json) console.log(JSON.stringify(out, null, 2)); else print(out);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
