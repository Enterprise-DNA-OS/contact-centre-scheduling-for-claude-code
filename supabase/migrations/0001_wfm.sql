-- Contact centre forecasting and scheduling.
-- Times are the centre's local wall-clock time (timestamp without time zone).
-- Intervals are 30 minutes. Money is not held here: this is a workforce plan, not payroll.
create schema if not exists wfm;

create or replace function wfm.touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table wfm.queues (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  channel text not null check (channel in ('voice','chat','email')),
  sl_target_pct numeric(5,2) not null default 80 check (sl_target_pct > 0 and sl_target_pct < 100),
  sl_seconds integer not null default 20 check (sl_seconds > 0),
  max_occupancy_pct numeric(5,2) not null default 85 check (max_occupancy_pct > 0 and max_occupancy_pct <= 100),
  shrinkage_pct numeric(5,2) not null default 30 check (shrinkage_pct >= 0 and shrinkage_pct < 100),
  opens time not null default '08:00',
  closes time not null default '18:00',
  open_days integer[] not null default '{1,2,3,4,5}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (closes > opens)
);

create table wfm.agents (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  team text not null,
  queue_id uuid not null references wfm.queues(id),
  employment text not null check (employment in ('full_time','part_time','casual')),
  contract_minutes_week integer not null default 0 check (contract_minutes_week >= 0),
  jurisdiction text not null check (jurisdiction in ('NZ','AU')),
  award text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wfm.intervals (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references wfm.queues(id),
  starts_at timestamp not null,
  offered integer not null check (offered >= 0),
  handled integer not null check (handled >= 0),
  answered_in_sl integer not null default 0 check (answered_in_sl >= 0),
  abandoned integer not null default 0 check (abandoned >= 0),
  aht_seconds integer not null default 0 check (aht_seconds >= 0),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (queue_id, starts_at),
  check (extract(minute from starts_at) in (0,30) and extract(second from starts_at) = 0),
  check (handled <= offered and answered_in_sl <= handled and handled + abandoned <= offered)
);

-- Days left out of the forecast pattern: outages, public holidays, one-off events.
create table wfm.history_exclusions (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references wfm.queues(id),
  day date not null,
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (queue_id, day)
);

create table wfm.forecast_adjustments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  queue_id uuid not null references wfm.queues(id),
  starts_at timestamp not null,
  ends_at timestamp not null,
  volume_pct numeric(6,2) not null check (volume_pct > -100),
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table wfm.shifts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  agent_id uuid not null references wfm.agents(id),
  starts_at timestamp not null,
  ends_at timestamp not null,
  status text not null default 'draft' check (status in ('draft','published','cancelled')),
  published_at timestamp,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '16 hours'),
  check ((status = 'published') = (published_at is not null) or status = 'cancelled')
);
create index on wfm.shifts (agent_id, starts_at);

create table wfm.activities (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references wfm.shifts(id) on delete cascade,
  kind text not null check (kind in ('rest','meal','training','coaching','meeting')),
  starts_at timestamp not null,
  ends_at timestamp not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on wfm.activities (shift_id);

create or replace function wfm.activity_inside_shift() returns trigger language plpgsql as $$
declare s record;
begin
  select starts_at, ends_at into s from wfm.shifts where id = new.shift_id;
  if new.starts_at < s.starts_at or new.ends_at > s.ends_at then
    raise exception 'Activity % to % falls outside its shift % to %', new.starts_at, new.ends_at, s.starts_at, s.ends_at;
  end if;
  if exists (select 1 from wfm.activities a where a.shift_id = new.shift_id and a.id <> new.id
             and a.starts_at < new.ends_at and new.starts_at < a.ends_at) then
    raise exception 'Activity overlaps another activity on the same shift';
  end if;
  return new;
end $$;
create trigger activity_inside_shift before insert or update on wfm.activities
  for each row execute function wfm.activity_inside_shift();

create or replace function wfm.no_double_shift() returns trigger language plpgsql as $$
begin
  if new.status <> 'cancelled' and exists (select 1 from wfm.shifts s where s.agent_id = new.agent_id and s.id <> new.id
      and s.status <> 'cancelled' and s.starts_at < new.ends_at and new.starts_at < s.ends_at) then
    raise exception 'Agent already has a shift overlapping % to %', new.starts_at, new.ends_at;
  end if;
  return new;
end $$;
create trigger no_double_shift before insert or update on wfm.shifts
  for each row execute function wfm.no_double_shift();

-- Every change to a published shift is kept, with the notice given.
create table wfm.shift_changes (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references wfm.shifts(id),
  changed_at timestamp not null,
  old_starts_at timestamp not null,
  old_ends_at timestamp not null,
  new_starts_at timestamp not null,
  new_ends_at timestamp not null,
  basis text not null check (basis in ('notice','agreed','emergency')),
  reason text not null,
  changed_by text not null,
  created_at timestamptz not null default now()
);

create table wfm.leave_requests (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  agent_id uuid not null references wfm.agents(id),
  kind text not null check (kind in ('annual','sick','training','other')),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  requested_on date not null default current_date,
  decided_by text,
  decided_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check ((status = 'pending') = (decided_on is null))
);

create table wfm.adherence (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references wfm.agents(id),
  work_date date not null,
  scheduled_minutes integer not null check (scheduled_minutes >= 0),
  adherent_minutes integer not null check (adherent_minutes >= 0),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (agent_id, work_date),
  check (adherent_minutes <= scheduled_minutes)
);

create table wfm.notes (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('queue','agent','shift','leave')),
  subject_id uuid not null,
  author text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create or replace function wfm.notes_append_only() returns trigger language plpgsql as $$
begin raise exception 'Notes are append-only. Add a new note that corrects the earlier one.'; end $$;
create trigger notes_append_only before update or delete on wfm.notes
  for each row execute function wfm.notes_append_only();

create table wfm.import_rows (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  file_name text not null,
  row_number integer not null,
  row_hash text not null,
  target_id uuid,
  imported_at timestamptz not null default now(),
  unique (source, row_hash)
);

create trigger queues_touch before update on wfm.queues for each row execute function wfm.touch();
create trigger agents_touch before update on wfm.agents for each row execute function wfm.touch();
create trigger shifts_touch before update on wfm.shifts for each row execute function wfm.touch();
create trigger leave_touch before update on wfm.leave_requests for each row execute function wfm.touch();
