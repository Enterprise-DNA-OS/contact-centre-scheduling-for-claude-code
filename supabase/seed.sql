-- Demo data: Tasman Contact Services, a fictional contract call centre with an Auckland team
-- (general enquiries and email for a utility client) and a Brisbane team (claims for an insurer).
-- Everything is relative to today, so the attention commands always have something to say.
-- Idempotent: codes and unique keys make a second run a no-op. Never run this on a live database.

insert into wfm.queues (code, name, channel, sl_target_pct, sl_seconds, max_occupancy_pct, shrinkage_pct, opens, closes) values
  ('GEN', 'General enquiries (Auckland)', 'voice', 80, 20, 85, 32, '08:00', '18:00'),
  ('CLM', 'Claims (Brisbane)', 'voice', 80, 30, 85, 30, '08:00', '20:00'),
  ('EML', 'Email (Auckland)', 'email', 80, 20, 85, 25, '08:00', '17:00')
on conflict (code) do nothing;

insert into wfm.agents (code, name, team, queue_id, employment, contract_minutes_week, jurisdiction, award)
select v.code, v.name, v.team, q.id, v.employment, v.minutes, v.jurisdiction, v.award
from (values
  ('G01','Aroha Ngata','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G02','Ben Whitfield','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G03','Chloe Tanaka','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G04','Dev Patel','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G05','Ella Fonoti','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G06','Finn McAllister','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G07','Grace Liu','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G08','Hemi Walker','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('G09','Isla Brennan','Auckland voice','GEN','full_time',2400,'NZ',null),
  ('C01','Jack Moretti','Brisbane claims','CLM','full_time',2280,'AU','MA000023'),
  ('C02','Kiara Simmons','Brisbane claims','CLM','full_time',2280,'AU','MA000023'),
  ('C03','Liam O''Connor','Brisbane claims','CLM','full_time',2280,'AU','MA000023'),
  ('C04','Mei Chen','Brisbane claims','CLM','full_time',2280,'AU','MA000023'),
  ('C05','Noah Fraser','Brisbane claims','CLM','part_time',1440,'AU','MA000023'),
  ('C06','Olivia Grant','Brisbane claims','CLM','full_time',2280,'AU','MA000023'),
  ('C07','Priya Nair','Brisbane claims','CLM','casual',0,'AU','MA000023'),
  ('C08','Quinn Harper','Brisbane claims','CLM','full_time',2280,'AU','MA000023'),
  ('E01','Rangi Tuhoe','Auckland digital','EML','full_time',2400,'NZ',null),
  ('E02','Sophie Martin','Auckland digital','EML','full_time',2400,'NZ',null),
  ('E03','Tom Rees','Auckland digital','EML','full_time',2400,'NZ',null),
  ('E04','Uma Kaur','Auckland digital','EML','full_time',2400,'NZ',null)
) v(code, name, team, queue, employment, minutes, jurisdiction, award)
join wfm.queues q on q.code = v.queue
on conflict (code) do nothing;

-- Eight weeks of half-hour history, weekdays. Shape: a mid-morning peak and a busy Monday.
-- Three weeks ago today the utility client had an outage and general enquiries ran 45 per cent over.
with profile(queue, slot, weight) as (
  select 'GEN', s, w from unnest(array[9,13,19,21,20,18,16,15,14,15,16,15,14,13,12,11,10,8,6,4]) with ordinality t(w, s)
  union all select 'CLM', s, w from unnest(array[5,7,9,10,10,9,8,8,7,7,8,8,7,7,6,6,6,5,5,4,4,3,3,2]) with ordinality t(w, s)
  union all select 'EML', s, w from unnest(array[14,12,10,9,8,8,7,7,7,7,8,8,7,7,6,6,5,4]) with ordinality t(w, s)
), days as (
  select d::date dt from generate_series(current_date - 56, current_date - 1, interval '1 day') d where extract(isodow from d) < 6
), base as (
  select q.id queue_id, q.code, (d.dt + q.opens + (p.slot - 1) * interval '30 minutes')::timestamp starts_at,
    p.weight * (array[1.25,1.05,1.0,0.95,0.85])[extract(isodow from d.dt)::int]
      * (1 + ((abs(hashtext(q.code || d.dt::text || p.slot::text)) % 21) - 10) / 100.0)
      * (1 + ((abs(hashtext(d.dt::text || q.code)) % 17) - 8) / 100.0)
      * case when q.code = 'GEN' and d.dt = current_date - 21 then 1.45 else 1 end volume,
    case q.code when 'GEN' then 330 when 'CLM' then 540 else 420 end aht,
    (abs(hashtext(d.dt::text || q.code || p.slot::text)) % 9) - 4 wobble
  from days d cross join profile p join wfm.queues q on q.code = p.queue
)
insert into wfm.intervals (queue_id, starts_at, offered, handled, answered_in_sl, abandoned, aht_seconds, source)
select queue_id, starts_at, round(volume), round(volume) - round(volume * 0.04),
  least(round(volume) - round(volume * 0.04), round((round(volume) - round(volume * 0.04)) * (0.82 + wobble / 100.0))),
  round(volume * 0.04), round(aht * (1 + wobble / 100.0)), 'demo'
from base
on conflict (queue_id, starts_at) do nothing;

-- Today so far (08:00 to 10:30): claims running well above forecast after an overnight storm.
insert into wfm.intervals (queue_id, starts_at, offered, handled, answered_in_sl, abandoned, aht_seconds, source)
select q.id, current_date + q.opens + (s - 1) * interval '30 minutes',
  round(w * m), round(w * m) - round(w * m * a), round((round(w * m) - round(w * m * a)) * sl), round(w * m * a), aht, 'demo'
from (values ('GEN', 1.0, 0.04, 0.83, 335), ('CLM', 1.45, 0.12, 0.58, 610)) v(code, m, a, sl, aht)
join wfm.queues q on q.code = v.code
cross join lateral unnest(case v.code when 'GEN' then array[9,13,19,21,20,18] else array[5,7,9,10,10,9] end) with ordinality t(w, s)
where extract(isodow from current_date) < 6
on conflict (queue_id, starts_at) do nothing;

-- A planner adjustment: billing letters land, so next Wednesday morning runs 15 per cent above the pattern.
insert into wfm.forecast_adjustments (code, queue_id, starts_at, ends_at, volume_pct, reason, created_by)
select 'ADJ-001', q.id, next_wed + time '08:00', next_wed + time '12:00', 15, 'Quarterly billing letters land the day before', 'Sam Planner'
from wfm.queues q, (select current_date + ((9 - extract(isodow from current_date)::int) % 7 + 1) next_wed) w
where q.code = 'GEN'
on conflict (code) do nothing;

-- Shifts for today and the next 13 days, weekdays. Published one week out, draft after that.
with days as (
  select d::date dt from generate_series(current_date, current_date + 13, interval '1 day') d where extract(isodow from d) < 6
), pattern(code, starts, minutes) as (values
  ('G01','08:00',510),('G02','08:00',510),('G03','08:30',510),('G04','08:30',510),('G05','09:00',510),
  ('G06','09:00',510),('G07','09:30',510),('G08','09:30',510),('G09','09:30',510),
  ('C01','08:00',510),('C02','08:00',510),('C03','11:30',510),('C04','08:00',510),('C05','09:00',240),
  ('C06','08:30',510),('C07','16:00',240),('C08','11:30',510),
  ('E01','08:00',510),('E02','08:00',510),('E03','08:30',510),('E04','09:00',510)
)
insert into wfm.shifts (code, agent_id, starts_at, ends_at, status, published_at)
select p.code || '-' || to_char(d.dt, 'YYYYMMDD'), a.id, d.dt + p.starts::time, d.dt + p.starts::time + p.minutes * interval '1 minute',
  case when d.dt <= current_date + 6 and p.code <> 'E03' then 'published' else 'draft' end,
  case when d.dt <= current_date + 6 and p.code <> 'E03' then (current_date - 7) + time '15:00' end
from days d cross join pattern p join wfm.agents a on a.code = p.code
where not exists (select 1 from wfm.shifts x where x.code = p.code || '-' || to_char(d.dt, 'YYYYMMDD'));

-- Deliberate problems for the checks to find, set before breaks are generated.
-- Liam works a late close and an early start the next day.
with c3 as (select s.starts_at::date work_date from wfm.shifts s join wfm.agents a on a.id = s.agent_id where a.code = 'C03'),
p as (select min(work_date) d1, min(work_date) + 1 d2 from c3 where work_date > current_date and (work_date + 1) in (select work_date from c3))
update wfm.shifts s set starts_at = case when s.starts_at::date = p.d1 then p.d1 + time '13:30' else p.d2 + time '07:00' end,
  ends_at = case when s.starts_at::date = p.d1 then p.d1 + time '22:00' else p.d2 + time '15:30' end
from p, wfm.agents a
where a.id = s.agent_id and a.code = 'C03' and s.starts_at::date in (p.d1, p.d2)
  and not exists (select 1 from wfm.activities x where x.shift_id = s.id);
-- Noah, part-time, rostered for two and a half hours on his first shift after today.
update wfm.shifts s set ends_at = s.starts_at + interval '150 minutes'
from wfm.agents a
where a.id = s.agent_id and a.code = 'C05'
  and s.starts_at = (select min(s2.starts_at) from wfm.shifts s2 where s2.agent_id = a.id and s2.starts_at::date > current_date);

-- Breaks: a 15 minute rest two hours in, a 30 minute meal four hours in, and a second rest at six and a half hours.
insert into wfm.activities (shift_id, kind, starts_at, ends_at)
select s.id, b.kind, s.starts_at + b.at_min * interval '1 minute', s.starts_at + (b.at_min + b.len) * interval '1 minute'
from wfm.shifts s
cross join (values ('rest', 120, 15), ('meal', 240, 30), ('rest', 390, 15)) b(kind, at_min, len)
where (s.starts_at + (b.at_min + b.len) * interval '1 minute') <= s.ends_at
  and not exists (select 1 from wfm.activities x where x.shift_id = s.id)
order by s.code, b.at_min;

-- Kiara's first meal after today pushed to five and a half hours in.
update wfm.activities x set starts_at = s.starts_at + interval '330 minutes', ends_at = s.starts_at + interval '360 minutes'
from wfm.shifts s, wfm.agents a
where x.shift_id = s.id and a.id = s.agent_id and a.code = 'C02' and x.kind = 'meal'
  and s.starts_at = (select min(s2.starts_at) from wfm.shifts s2 where s2.agent_id = a.id and s2.starts_at::date > current_date);
-- Dev's first shift after today is missing its second rest break.
delete from wfm.activities x using wfm.shifts s, wfm.agents a
where x.shift_id = s.id and a.id = s.agent_id and a.code = 'G04' and x.kind = 'rest' and x.starts_at > s.starts_at + interval '5 hours'
  and s.starts_at = (select min(s2.starts_at) from wfm.shifts s2 where s2.agent_id = a.id and s2.starts_at::date > current_date);
-- Isla in product training through next Monday's peak.
insert into wfm.activities (shift_id, kind, starts_at, ends_at)
select s.id, 'training', s.starts_at, s.starts_at + interval '90 minutes'
from wfm.shifts s join wfm.agents a on a.id = s.agent_id
where a.code = 'G09' and s.starts_at::date = current_date + (8 - extract(isodow from current_date)::int)
  and not exists (select 1 from wfm.activities x where x.shift_id = s.id and x.kind = 'training');

-- Ella's adherence coaching next Tuesday afternoon.
insert into wfm.activities (shift_id, kind, starts_at, ends_at)
select s.id, 'coaching', s.starts_at::date + time '14:00', s.starts_at::date + time '14:30'
from wfm.shifts s join wfm.agents a on a.id = s.agent_id
where a.code = 'G05' and s.starts_at::date = current_date + ((8 - extract(isodow from current_date)::int) % 7 + 1)
  and not exists (select 1 from wfm.activities x where x.shift_id = s.id and x.kind = 'coaching');

-- Jack's published shift moved half an hour earlier, yesterday, with less than a week's notice.
insert into wfm.shift_changes (shift_id, changed_at, old_starts_at, old_ends_at, new_starts_at, new_ends_at, basis, reason, changed_by)
select s.id, (current_date - 1) + time '16:00', s.starts_at, s.ends_at, s.starts_at - interval '30 minutes', s.ends_at - interval '30 minutes',
  'notice', 'Cover the early claims spike', 'Sam Planner'
from wfm.shifts s join wfm.agents a on a.id = s.agent_id
where a.code = 'C01' and s.starts_at = (select min(s2.starts_at) from wfm.shifts s2 where s2.agent_id = a.id and s2.starts_at::date >= current_date + 2)
  and not exists (select 1 from wfm.shift_changes c where c.shift_id = s.id);
update wfm.shifts s set starts_at = c.new_starts_at, ends_at = c.new_ends_at
from wfm.shift_changes c where c.shift_id = s.id and s.starts_at = c.old_starts_at;

-- Leave: two pending requests that matter, one far out, one approved sick day.
insert into wfm.leave_requests (code, agent_id, kind, starts_on, ends_on, status, requested_on, decided_by, decided_on)
select v.code, a.id, v.kind, current_date + v.from_day, current_date + v.to_day, v.status, current_date - v.asked, v.by_whom,
  case when v.status <> 'pending' then current_date - 1 end
from (values
  ('LV-001','G02','annual', (8 - extract(isodow from current_date)::int), (8 - extract(isodow from current_date)::int), 'pending', 3, null),
  ('LV-002','G07','sick', (9 - extract(isodow from current_date)::int), (9 - extract(isodow from current_date)::int), 'approved', 1, 'Sam Planner'),
  ('LV-003','E01','annual', 30, 34, 'pending', 2, null),
  ('LV-004','C04','annual', (10 - extract(isodow from current_date)::int), (10 - extract(isodow from current_date)::int), 'pending', 6, null)
) v(code, agent, kind, from_day, to_day, status, asked, by_whom)
join wfm.agents a on a.code = v.agent
on conflict (code) do nothing;

-- Adherence from the phone system for the last seven days. Ella and Olivia are drifting.
insert into wfm.adherence (agent_id, work_date, scheduled_minutes, adherent_minutes, source)
select a.id, d::date, 480,
  case when a.code in ('G05','C06') then 370 + abs(hashtext(a.code || d::text)) % 25 else 445 + abs(hashtext(a.code || d::text)) % 30 end, 'demo'
from wfm.agents a cross join generate_series(current_date - 7, current_date - 1, interval '1 day') d
where extract(isodow from d) < 6
on conflict (agent_id, work_date) do nothing;

insert into wfm.notes (subject_type, subject_id, author, body)
select 'queue', q.id, 'Sam Planner', 'Storm overnight in south-east Queensland. Expect claims volume well above pattern today and tomorrow.'
from wfm.queues q
where q.code = 'CLM' and not exists (select 1 from wfm.notes n where n.subject_id = q.id and n.body like 'Storm overnight%');
