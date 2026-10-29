-- Erlang C, the forecast, staffing requirements, coverage and the checks.
-- One definition here serves the CLI, the HTML views and the documents.

-- Percentage of contacts answered within sl_seconds with n agents on the phone.
create or replace function wfm.service_level(calls numeric, aht_seconds numeric, n integer, sl_seconds integer, channel text, interval_seconds integer default 1800)
returns numeric language plpgsql immutable as $$
declare a numeric; b numeric := 1; c numeric; i integer;
begin
  if channel = 'email' then return null; end if;
  if calls is null or calls <= 0 or aht_seconds <= 0 then return 100; end if;
  a := calls * aht_seconds / interval_seconds;
  if n is null or n <= a then return 0; end if;
  for i in 1..n loop b := a * b / (i + a * b); end loop;          -- Erlang B
  c := n * b / (n - a * (1 - b));                                  -- Erlang C: chance a contact waits
  return round(greatest(0, (1 - c * exp(-(n - a) * sl_seconds / aht_seconds))) * 100, 1);
end $$;

-- Fewest agents on the phone that meet the service level target without passing maximum occupancy.
-- Email has no queue wait in this model: workload divided by maximum occupancy.
create or replace function wfm.agents_needed(calls numeric, aht_seconds numeric, sl_target_pct numeric, sl_seconds integer,
  max_occupancy_pct numeric, channel text, interval_seconds integer default 1800)
returns integer language plpgsql immutable as $$
declare a numeric; n integer; b numeric := 1; c numeric; sl numeric; i integer;
begin
  if calls is null or calls <= 0 or aht_seconds <= 0 then return 0; end if;
  a := calls * aht_seconds / interval_seconds;
  if channel = 'email' then return ceil(a / (max_occupancy_pct / 100)); end if;
  n := greatest(1, ceil(a)::integer);
  for i in 1..n loop b := a * b / (i + a * b); end loop;
  loop
    if n > a then
      c := n * b / (n - a * (1 - b));
      sl := 1 - c * exp(-(n - a) * sl_seconds / aht_seconds);
      if sl * 100 >= sl_target_pct and a / n * 100 <= max_occupancy_pct then return n; end if;
    end if;
    exit when n >= 2000;
    n := n + 1;
    b := a * b / (n + a * b);
  end loop;
  return n;
end $$;

-- Forecast for today and the next 13 days: the average of the same weekday and half hour over the
-- last six weeks of history, adjusted by any planner adjustment that covers the interval.
create view wfm.forecast as
with profile as (
  select i.queue_id, extract(isodow from i.starts_at)::int dow, i.starts_at::time tod,
    avg(i.offered)::numeric calls,
    coalesce(sum(i.aht_seconds::numeric * i.handled) / nullif(sum(i.handled), 0), 0) aht_seconds,
    count(*)::int weeks_of_history
  from wfm.intervals i
  where i.starts_at >= current_date - 42 and i.starts_at < current_date
    and not exists (select 1 from wfm.history_exclusions e where e.queue_id = i.queue_id and e.day = i.starts_at::date)
  group by 1, 2, 3
), slots as (
  select q.id queue_id, q.code queue, q.channel, g.slot starts_at
  from wfm.queues q
  cross join generate_series(current_date::timestamp, (current_date + 13)::timestamp, interval '1 day') d(dt)
  cross join lateral generate_series(d.dt + q.opens, d.dt + q.closes - interval '30 minutes', interval '30 minutes') g(slot)
  where extract(isodow from d.dt)::int = any(q.open_days)
)
select s.queue_id, s.queue, s.channel, s.starts_at,
  round(coalesce(p.calls, 0) * (1 + coalesce(adj.pct, 0) / 100), 1) calls,
  round(coalesce(p.aht_seconds, 0)) aht_seconds,
  coalesce(adj.pct, 0) adjustment_pct,
  coalesce(p.weeks_of_history, 0) weeks_of_history
from slots s
left join profile p on p.queue_id = s.queue_id and p.dow = extract(isodow from s.starts_at)::int and p.tod = s.starts_at::time
left join lateral (
  select sum(a.volume_pct) pct from wfm.forecast_adjustments a
  where a.queue_id = s.queue_id and a.starts_at <= s.starts_at and a.ends_at > s.starts_at
) adj on true;

create view wfm.requirements as
select f.*, wfm.agents_needed(f.calls, f.aht_seconds, q.sl_target_pct, q.sl_seconds, q.max_occupancy_pct, q.channel) required
from wfm.forecast f join wfm.queues q on q.id = f.queue_id;

-- Each agent's share of each half hour actually available for contacts: shift time minus breaks,
-- meals, training, coaching and meetings. A shift on a day of approved leave counts as zero.
create view wfm.on_phone as
select s.id shift_id, s.code shift_code, a.id agent_id, a.code agent, a.queue_id, g.slot starts_at,
  round((extract(epoch from (least(s.ends_at, g.slot + interval '30 minutes') - greatest(s.starts_at, g.slot)))
   - coalesce((select sum(extract(epoch from (least(x.ends_at, g.slot + interval '30 minutes') - greatest(x.starts_at, g.slot))))
       from wfm.activities x where x.shift_id = s.id and x.starts_at < g.slot + interval '30 minutes' and x.ends_at > g.slot), 0)
  ) / 1800.0, 3) fte
from wfm.shifts s
join wfm.agents a on a.id = s.agent_id
cross join lateral generate_series(date_trunc('hour', s.starts_at), s.ends_at - interval '1 second', interval '30 minutes') g(slot)
where s.status <> 'cancelled' and a.active
  and g.slot + interval '30 minutes' > s.starts_at
  and not exists (select 1 from wfm.leave_requests l where l.agent_id = a.id and l.status = 'approved'
                  and s.starts_at::date between l.starts_on and l.ends_on);

create view wfm.coverage as
select r.queue_id, r.queue, r.channel, r.starts_at, r.calls, r.aht_seconds, r.required,
  round(coalesce(p.scheduled, 0), 2) scheduled,
  round(coalesce(p.scheduled, 0) - r.required, 2) gap,
  wfm.service_level(r.calls, r.aht_seconds, floor(coalesce(p.scheduled, 0))::int, q.sl_seconds, r.channel) projected_sl_pct,
  q.sl_target_pct
from wfm.requirements r
join wfm.queues q on q.id = r.queue_id
left join (select queue_id, starts_at, sum(fte) scheduled from wfm.on_phone group by 1, 2) p
  on p.queue_id = r.queue_id and p.starts_at = r.starts_at;

-- What each pending leave request does to coverage if approved as it stands.
create view wfm.leave_impact as
select l.id, l.code, a.code agent, a.name, q.code queue, l.kind, l.starts_on, l.ends_on, l.requested_on,
  count(c.starts_at) filter (where c.required > 0 and c.scheduled >= c.required and c.scheduled - coalesce(o.fte, 0) < c.required)::int newly_short,
  count(c.starts_at) filter (where c.required > 0 and c.scheduled < c.required)::int already_short,
  (l.starts_on > current_date + 13) beyond_forecast
from wfm.leave_requests l
join wfm.agents a on a.id = l.agent_id
join wfm.queues q on q.id = a.queue_id
left join wfm.coverage c on c.queue_id = a.queue_id and c.starts_at::date between l.starts_on and l.ends_on
left join wfm.on_phone o on o.agent_id = a.id and o.starts_at = c.starts_at
where l.status = 'pending'
group by l.id, a.id, q.id;

create view wfm.shift_detail as
select s.id, s.code, a.code agent, a.name, a.team, q.code queue, a.jurisdiction, a.award, a.employment,
  s.starts_at::date work_date, s.starts_at, s.ends_at, s.status, s.published_at,
  (extract(epoch from s.ends_at - s.starts_at) / 60)::int shift_minutes,
  ((extract(epoch from s.ends_at - s.starts_at) / 60) - coalesce(sum(extract(epoch from x.ends_at - x.starts_at) / 60) filter (where x.kind = 'meal'), 0))::int paid_minutes,
  count(x.id) filter (where x.kind = 'rest' and x.ends_at - x.starts_at >= interval '10 minutes')::int rest_breaks,
  count(x.id) filter (where x.kind = 'meal' and x.ends_at - x.starts_at >= interval '30 minutes')::int meal_breaks,
  coalesce(sum(extract(epoch from x.ends_at - x.starts_at) / 60) filter (where x.kind in ('training','coaching','meeting')), 0)::int development_minutes,
  (select max(extract(epoch from (coalesce((select min(m2.starts_at) from wfm.activities m2 where m2.shift_id = s.id and m2.kind = 'meal' and m2.starts_at >= b.t), s.ends_at) - b.t)) / 60)
     from (select s.starts_at t union all select m.ends_at from wfm.activities m where m.shift_id = s.id and m.kind = 'meal') b)::int longest_without_meal,
  exists (select 1 from wfm.leave_requests l where l.agent_id = a.id and l.status = 'approved' and s.starts_at::date between l.starts_on and l.ends_on) on_leave
from wfm.shifts s
join wfm.agents a on a.id = s.agent_id
join wfm.queues q on q.id = a.queue_id
left join wfm.activities x on x.shift_id = s.id
group by s.id, a.id, q.id;

create view wfm.daily_service as
select q.code queue, i.starts_at::date as day, sum(i.offered)::int offered, sum(i.handled)::int handled, sum(i.abandoned)::int abandoned,
  round(100.0 * sum(i.answered_in_sl) / nullif(sum(i.offered), 0), 1) sl_pct, q.sl_target_pct,
  round(100.0 * sum(i.abandoned) / nullif(sum(i.offered), 0), 1) abandon_pct,
  round(sum(i.aht_seconds::numeric * i.handled) / nullif(sum(i.handled), 0)) aht_seconds
from wfm.intervals i join wfm.queues q on q.id = i.queue_id
group by q.id, i.starts_at::date;

-- How the forecast method would have done over the last 28 days: each day's actual volume
-- against the average of the same weekday over the six weeks before it.
create view wfm.forecast_accuracy as
with daily as (
  select i.queue_id, i.starts_at::date as day, sum(i.offered)::numeric actual
  from wfm.intervals i where i.starts_at < current_date
    and not exists (select 1 from wfm.history_exclusions e where e.queue_id = i.queue_id and e.day = i.starts_at::date)
  group by 1, 2
), backcast as (
  select d.queue_id, d.day, d.actual,
    (select avg(h.actual) from daily h where h.queue_id = d.queue_id and h.day < d.day and h.day >= d.day - 42
       and extract(isodow from h.day) = extract(isodow from d.day)) predicted
  from daily d where d.day >= current_date - 28
)
select q.code queue, count(*) filter (where predicted is not null)::int days,
  round(avg(abs(actual - predicted) / nullif(actual, 0)) * 100, 1) mape_pct,
  round((sum(predicted) - sum(actual) filter (where predicted is not null)) / nullif(sum(actual) filter (where predicted is not null), 0) * 100, 1) bias_pct,
  (select b2.day from backcast b2 where b2.queue_id = q.id and b2.predicted is not null order by abs(b2.actual - b2.predicted) desc limit 1) worst_day
from backcast b join wfm.queues q on q.id = b.queue_id
group by q.id;

create view wfm.planned_shrinkage as
select queue, date_trunc('week', work_date)::date week_of, sum(paid_minutes)::int paid_minutes,
  sum(case when on_leave then 0 else development_minutes end)::int development_minutes,
  sum(case when on_leave then 0 else rest_minutes end)::int rest_minutes,
  sum(case when on_leave then paid_minutes else 0 end)::int leave_minutes,
  round(100.0 * sum(case when on_leave then paid_minutes else development_minutes + rest_minutes end) / nullif(sum(paid_minutes), 0), 1) planned_pct,
  max(assumed) assumed_pct
from (
  select d.*, q.shrinkage_pct assumed,
    coalesce((select sum(extract(epoch from x.ends_at - x.starts_at) / 60) from wfm.activities x where x.shift_id = d.id and x.kind = 'rest'), 0)::int rest_minutes
  from wfm.shift_detail d join wfm.queues q on q.code = d.queue
  where d.status <> 'cancelled' and d.work_date between current_date and current_date + 13
) t
group by queue, date_trunc('week', work_date);

create view wfm.adherence_week as
select a.code agent, a.name, a.team, count(h.id)::int days, sum(h.scheduled_minutes)::int scheduled_minutes,
  sum(h.adherent_minutes)::int adherent_minutes,
  round(100.0 * sum(h.adherent_minutes) / nullif(sum(h.scheduled_minutes), 0), 1) adherence_pct,
  min(round(100.0 * h.adherent_minutes / nullif(h.scheduled_minutes, 0), 1)) worst_day_pct
from wfm.adherence h join wfm.agents a on a.id = h.agent_id
where h.work_date >= current_date - 7 and h.work_date < current_date
group by a.id;

-- Rule checks. Each row cites its rule; docs/compliance.md holds the sources and limits.
create view wfm.compliance_findings as
-- Contract Call Centres Award 2020 cl 14.1: not more than 5 hours without a meal break, where practicable.
select 'au-meal-5h' rule, d.code shift, d.agent, d.work_date,
  format('%s minutes worked without a meal break', d.longest_without_meal) detail
from wfm.shift_detail d
where d.award = 'MA000023' and d.status <> 'cancelled' and not d.on_leave and d.longest_without_meal > 300
union all
-- Contract Call Centres Award 2020 cl 10.3: part-time shifts at least 3 consecutive hours.
select 'au-part-time-3h', d.code, d.agent, d.work_date, format('part-time shift of %s minutes', d.shift_minutes)
from wfm.shift_detail d
where d.award = 'MA000023' and d.employment = 'part_time' and d.status <> 'cancelled' and d.shift_minutes < 180
union all
-- Contract Call Centres Award 2020 cl 11.2: casual paid at least 3 hours per attendance.
select 'au-casual-3h-pay', d.code, d.agent, d.work_date, format('casual shift of %s minutes is paid as 180', d.shift_minutes)
from wfm.shift_detail d
where d.award = 'MA000023' and d.employment = 'casual' and d.status <> 'cancelled' and d.shift_minutes < 180
union all
-- Contract Call Centres Award 2020 cl 20.4: arrange at least 10 consecutive hours off between successive days.
select 'au-10h-rest', x.code, x.agent, x.work_date, format('%s hours off before this shift', round(x.gap_hours, 1))
from (
  select d.code, d.agent, d.work_date, d.award, d.status,
    extract(epoch from d.starts_at - lag(d.ends_at) over (partition by d.agent order by d.starts_at)) / 3600 gap_hours
  from wfm.shift_detail d where d.status <> 'cancelled'
) x
where x.award = 'MA000023' and x.gap_hours < 10
union all
-- Contract Call Centres Award 2020 cl 13.5: one week's notice of a roster change, 48 hours in an emergency, or agreement.
select 'au-roster-notice', s.code, a.code, s.starts_at::date,
  format('%s change made %s hours before the shift', c.basis, round(extract(epoch from least(c.old_starts_at, c.new_starts_at) - c.changed_at) / 3600))
from wfm.shift_changes c join wfm.shifts s on s.id = c.shift_id join wfm.agents a on a.id = s.agent_id
where a.award = 'MA000023' and (
  (c.basis = 'notice' and least(c.old_starts_at, c.new_starts_at) - c.changed_at < interval '7 days') or
  (c.basis = 'emergency' and least(c.old_starts_at, c.new_starts_at) - c.changed_at < interval '48 hours'))
union all
-- Employment Relations Act 2000 Part 6D: minimum paid rest and unpaid meal breaks by work period length.
select 'nz-breaks', d.code, d.agent, d.work_date,
  format('%s hour work period has %s rest and %s meal breaks; minimum is %s and %s', round(d.shift_minutes / 60.0, 1), d.rest_breaks, d.meal_breaks, n.rest, n.meal)
from wfm.shift_detail d
cross join lateral (select
  case when d.shift_minutes < 120 then 0 when d.shift_minutes <= 360 then 1 when d.shift_minutes < 600 then 2 when d.shift_minutes <= 840 then 3 else 4 end rest,
  case when d.shift_minutes <= 240 then 0 when d.shift_minutes <= 720 then 1 else 2 end meal) n
where d.jurisdiction = 'NZ' and d.status <> 'cancelled' and not d.on_leave and (d.rest_breaks < n.rest or d.meal_breaks < n.meal)
union all
-- Operator policy: shifts starting within 7 days are published so agents have the roster.
select 'roster-unpublished', d.code, d.agent, d.work_date, format('draft shift starts %s', d.starts_at)
from wfm.shift_detail d
where d.status = 'draft' and d.starts_at::date between current_date and current_date + 6;

-- Days in the last eight weeks that ran far from their own weekday pattern. Candidates to exclude.
create view wfm.history_outliers as
with daily as (
  select i.queue_id, i.starts_at::date as day, sum(i.offered)::numeric actual
  from wfm.intervals i where i.starts_at >= current_date - 56 and i.starts_at < current_date group by 1, 2
)
select q.code queue, d.day, d.actual::int offered, round(p.typical)::int typical,
  round((d.actual / nullif(p.typical, 0) - 1) * 100, 1) variance_pct,
  exists (select 1 from wfm.history_exclusions e where e.queue_id = d.queue_id and e.day = d.day) excluded
from daily d
join wfm.queues q on q.id = d.queue_id
cross join lateral (select avg(h.actual) typical from daily h where h.queue_id = d.queue_id and h.day <> d.day
  and extract(isodow from h.day) = extract(isodow from d.day)) p
where abs(d.actual / nullif(p.typical, 0) - 1) >= 0.25;
