-- =====================================================================================
-- 0001_mythos.sql  —  Mythos (Via Tuscolana 596, Roma) booking engine
-- Target: EXISTING shared Supabase project "x3ro". Everything is namespaced in schema
--         `mythos`. Nothing outside that schema is created, altered or referenced,
--         except a read-only FK to auth.users(id) for the admin allow-list.
--
-- APPLY AS ONE TRANSACTION, e.g.
--     psql -v ON_ERROR_STOP=1 -1 -f 0001_mythos.sql "$SUPABASE_DB_URL"
-- There is deliberately no BEGIN/COMMIT in this file: migration runners already wrap
-- it, and a stray COMMIT here would end the outer transaction early. Every statement
-- below is transactional DDL (no CREATE INDEX CONCURRENTLY, no CREATE DATABASE).
--
-- SECURITY MODEL
--   * `mythos` is NOT added to the project's PostgREST exposed schemas. PostgREST is
--     not used at all.
--   * `anon`, `authenticated` (and `service_role`) end with ZERO privileges on the
--     schema, its tables, sequences and functions. No GRANT in this file names them.
--   * RLS is enabled on every table with NO policies — defence in depth: if somebody
--     later adds a GRANT by mistake, the tables still read back empty. RLS is *not*
--     FORCEd, because the SECURITY DEFINER functions run as the table owner and must
--     keep bypassing it.
--   * Every SECURITY DEFINER function pins `search_path = mythos, pg_temp` (closes the
--     search-path hijack) and has EXECUTE revoked from PUBLIC.
--   * Reachability: Supabase Edge Functions connect directly as the DB owner over
--     SUPABASE_DB_URL and call mythos.* by name. Admin authorisation (is the caller
--     staff?) is decided in the Edge Function by verifying the JWT and calling
--     mythos.is_admin(uid) BEFORE any mythos.admin_* call.
--
-- NO EXTENSIONS NEEDED
--   gen_random_uuid() is built into pg_catalog since PG13, so it resolves regardless
--   of search_path. pgcrypto is deliberately NOT required: on Supabase it usually
--   lives in the `extensions` schema, which our pinned search_path excludes, so
--   gen_random_bytes() would fail at runtime. Booking codes therefore draw their
--   entropy from gen_random_uuid() (CSPRNG) instead — see mythos.book().
--
-- TIME
--   All wall-clock columns (service_windows.opens/last_seating, bookings.slot_time)
--   are ROME LOCAL. Local -> instant conversion is always
--       (some_date + some_time) at time zone 'Europe/Rome'
--   i.e. `at time zone` applied to a `timestamp without time zone` yields timestamptz.
--   "Now" is always now(); Rome-local today is (now() at time zone 'Europe/Rome')::date.
--   The session TimeZone GUC is never assumed anywhere — 'Europe/Rome' is always named.
--
--   DST: Rome switches at 02:00 local (last Sun of March 02:00->03:00, last Sun of
--   October 03:00->02:00). Service runs 12:30–15:00 and 18:30–23:00 local, and the
--   latest possible ends_at (last seating 23:00 + a 120' turn) is 01:00 — so no local
--   wall time we ever convert falls in the 02:00–03:00 seam. No ambiguous ("repeated")
--   or skipped local times can arise. ends_at is derived by adding an interval to a
--   timestamptz, which is absolute-time arithmetic and DST-safe by construction.
-- =====================================================================================

create schema if not exists mythos;

comment on schema mythos is
  $c$Mythos (Via Tuscolana 596, Roma) — tenant-isolated booking engine. Not exposed to PostgREST; reached only by Edge Functions connecting as the DB owner.$c$;

-- Lock the schema down before anything is created inside it.
revoke all on schema mythos from public;

-- Future-proofing: functions are created WITH EXECUTE TO PUBLIC by default. Kill that
-- default now, so it applies to every function created below as well as any added later.
alter default privileges in schema mythos revoke execute on functions from public;
alter default privileges in schema mythos revoke all on tables from public;
alter default privileges in schema mythos revoke all on sequences from public;


-- =====================================================================================
-- TABLES
-- =====================================================================================

-- settings ---------------------------------------------------------------------------
-- Exactly one row, forced by `id boolean primary key default true check (id)`:
-- id can only ever be true, and true can only exist once.
create table if not exists mythos.settings (
  id                 boolean     primary key default true check (id),
  capacity_seats     int         not null default 30,   -- peak simultaneous covers allowed
  turn_minutes_small int         not null default 90,   -- party <= small_party_max
  turn_minutes_large int         not null default 120,  -- party >  small_party_max
  small_party_max    int         not null default 4,
  max_party          int         not null default 10,   -- above this: phone the restaurant
  lead_minutes       int         not null default 60,   -- no online booking inside this window
  horizon_days       int         not null default 45,
  accepting          boolean     not null default true, -- global kill switch
  updated_at         timestamptz not null default now()
);

-- service_windows --------------------------------------------------------------------
-- Weekly template. All times ROME LOCAL. dow follows extract(dow from date): 0 = Sunday.
create table if not exists mythos.service_windows (
  id            int         generated always as identity primary key,
  dow           int         not null check (dow between 0 and 6),   -- 0 = Sunday
  service       text        not null check (service in ('pranzo','cena')),
  opens         time        not null,
  last_seating  time        not null,
  slot_minutes  int         not null default 15 check (slot_minutes in (15,30)),
  active        boolean     not null default true,
  constraint service_windows_dow_service_key unique (dow, service),
  constraint service_windows_order_chk check (opens < last_seating)
);

-- closures ---------------------------------------------------------------------------
create table if not exists mythos.closures (
  d          date        primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- bookings ---------------------------------------------------------------------------
-- phone_tail is a plain column, NOT a generated column: gdpr_purge() must be able to
-- overwrite it, and GENERATED ALWAYS columns cannot be written.
create table if not exists mythos.bookings (
  id            uuid        primary key default gen_random_uuid(),
  code          text        not null,
  service_date  date        not null,   -- Rome-local calendar date of the meal
  slot_time     time        not null,   -- Rome-local wall time of the seating
  service       text        not null check (service in ('pranzo','cena')),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,   -- starts_at + turn_minutes(party)
  party         int         not null check (party between 1 and 40),
  name          text        not null,
  phone         text        not null,
  phone_tail    text        not null,   -- last 4 digits; guest self-cancel secret
  email         text,
  notes         text,
  status        text        not null default 'confirmed'
                            check (status in ('confirmed','cancelled','noshow','seated')),
  source        text        not null default 'web',
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  anonymized_at timestamptz,
  constraint bookings_code_key unique (code),
  constraint bookings_span_chk check (ends_at > starts_at)
);

-- admins -----------------------------------------------------------------------------
-- FK added separately + guarded, so the file also applies on a plain Postgres instance
-- that has no Supabase `auth` schema (local test / CI).
create table if not exists mythos.admins (
  user_id  uuid        primary key,
  email    text,
  added_at timestamptz not null default now()
);

do $guard$
begin
  if to_regclass('auth.users') is not null
     and not exists (select 1 from pg_constraint where conname = 'admins_user_id_fkey'
                       and conrelid = 'mythos.admins'::regclass) then
    execute 'alter table mythos.admins
               add constraint admins_user_id_fkey
               foreign key (user_id) references auth.users(id) on delete cascade';
  end if;
end
$guard$;

-- rate -------------------------------------------------------------------------------
create table if not exists mythos.rate (
  ip_hash text        not null,
  bucket  timestamptz not null,   -- UTC hour bucket, see mythos.rate_hit()
  n       int         not null default 0,
  primary key (ip_hash, bucket)
);

-- audit ------------------------------------------------------------------------------
-- NEVER write guest PII into audit.detail: audit rows are outside the gdpr_purge()
-- anonymisation sweep. Booking code + date + party only.
create table if not exists mythos.audit (
  id     bigint      generated always as identity primary key,
  at     timestamptz not null default now(),
  actor  text,
  action text        not null,
  detail jsonb
);


-- =====================================================================================
-- INDEXES
-- =====================================================================================

create index if not exists bookings_service_date_active_idx
  on mythos.bookings (service_date)
  where status in ('confirmed','seated');

-- Supports the "does this booking overlap the candidate window" probe.
-- tstzrange(timestamptz, timestamptz) is immutable, so it is indexable; range types
-- have core GiST support (range_ops), no btree_gist extension required.
create index if not exists bookings_span_gist
  on mythos.bookings using gist (tstzrange(starts_at, ends_at))
  where status in ('confirmed','seated');

-- Drives the occupancy scan in mythos.peak_covers().
create index if not exists bookings_starts_at_active_idx
  on mythos.bookings (starts_at)
  where status in ('confirmed','seated');

-- One phone number cannot hold several tables on the same day.
-- NOTE: this matches the stored `phone` string exactly, so "+39 333 1234567" and
-- "00393331234567" are different keys. mythos.book() therefore ALSO runs a
-- digits-only pre-check under the per-date advisory lock, which catches the
-- formatting variants; this index is the hard backstop.
create unique index if not exists bookings_phone_day_uniq
  on mythos.bookings (phone, service_date)
  where status = 'confirmed';


-- =====================================================================================
-- ROW LEVEL SECURITY — enabled everywhere, zero policies, on purpose.
-- Not FORCEd: the table owner (and therefore every SECURITY DEFINER function here)
-- must keep bypassing RLS. Any other role sees nothing even if granted SELECT.
-- =====================================================================================

alter table mythos.settings        enable row level security;
alter table mythos.service_windows enable row level security;
alter table mythos.closures        enable row level security;
alter table mythos.bookings        enable row level security;
alter table mythos.admins          enable row level security;
alter table mythos.rate            enable row level security;
alter table mythos.audit           enable row level security;


-- =====================================================================================
-- HELPERS
-- =====================================================================================

-- mythos.rome_iso(ts) -> ISO-8601 string in Rome local time WITH the correct offset.
-- Contract: pure formatting. Never relies on the session TimeZone GUC — the offset is
-- computed as (ts at Rome) - (ts at UTC), so DST is handled by the tz database.
-- Returns null for null input.
create or replace function mythos.rome_iso(p_ts timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  v_off  interval;
  v_sec  int;
  v_sign text;
begin
  if p_ts is null then
    return null;
  end if;
  v_off  := (p_ts at time zone 'Europe/Rome') - (p_ts at time zone 'UTC');
  v_sign := case when extract(epoch from v_off) < 0 then '-' else '+' end;
  v_sec  := floor(abs(extract(epoch from v_off)))::int;
  return to_char(p_ts at time zone 'Europe/Rome', 'YYYY-MM-DD"T"HH24:MI:SS')
      || v_sign
      || to_char(v_sec / 3600, 'FM00') || ':' || to_char((v_sec % 3600) / 60, 'FM00');
end;
$fn$;
revoke execute on function mythos.rome_iso(timestamptz) from public;
comment on function mythos.rome_iso(timestamptz) is
  $c$Render a timestamptz as ISO-8601 in Europe/Rome with an explicit UTC offset.$c$;


-- mythos.rome_offset(d) -> the UTC offset of Europe/Rome ON THAT DATE, as '+HH:MM'.
-- The frontend needs this per day so it can build an unambiguous instant from a Rome
-- wall-clock slot ("2026-08-08T20:00:00+02:00") instead of new Date("2026-08-08 20:00"),
-- which would silently parse in the visitor's own timezone.
--
-- It MUST be per day, not once per range: a 45-day horizon can straddle a DST change.
-- The probe time is midday, so the probe itself can never land inside the 02:00-03:00
-- transition window. The offset is derived as (probe at Rome) - (probe at UTC) and the
-- sign is formatted by hand: to_char(..., 'OF') renders the offset of the SESSION
-- timezone, which this codebase never assumes.
--
-- Expected values (Rome DST: last Sun of March 02:00->03:00, last Sun of Oct 03:00->02:00):
--     2026-08-01 -> '+02:00'      2026-12-01 -> '+01:00'
--     2026-10-24 -> '+02:00'      2026-10-25 -> '+01:00'   (fall back, last Sun of Oct)
--     2027-03-27 -> '+01:00'      2027-03-28 -> '+02:00'   (spring forward, last Sun of Mar)
create or replace function mythos.rome_offset(p_d date)
returns text
language plpgsql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  v_probe timestamptz;
  v_off   interval;
  v_sec   int;
  v_sign  text;
begin
  if p_d is null then
    return null;
  end if;
  v_probe := (p_d + time '12:00') at time zone 'Europe/Rome';   -- midday, never in the seam
  v_off   := (v_probe at time zone 'Europe/Rome') - (v_probe at time zone 'UTC');
  v_sign  := case when extract(epoch from v_off) < 0 then '-' else '+' end;
  v_sec   := floor(abs(extract(epoch from v_off)))::int;
  return v_sign || to_char(v_sec / 3600, 'FM00') || ':' || to_char((v_sec % 3600) / 60, 'FM00');
end;
$fn$;
revoke execute on function mythos.rome_offset(date) from public;
comment on function mythos.rome_offset(date) is
  $c$UTC offset of Europe/Rome on a given date, as +HH:MM. Probed at midday so it never falls inside the DST transition window.$c$;


-- mythos.audit_write(action, detail) — internal, PII-free audit trail.
-- actor = the Edge Function may `select set_config('mythos.actor', <admin email>, true)`
-- on its connection; otherwise it falls back to current_user (the DB owner).
create or replace function mythos.audit_write(p_action text, p_detail jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
begin
  insert into mythos.audit (actor, action, detail)
  values (coalesce(nullif(current_setting('mythos.actor', true), ''), current_user),
          p_action, p_detail);
end;
$fn$;
revoke execute on function mythos.audit_write(text, jsonb) from public;
comment on function mythos.audit_write(text, jsonb) is
  $c$Append a PII-free row to mythos.audit. Actor from GUC mythos.actor, else current_user.$c$;


-- mythos.turn_minutes(party) -> how long that party holds its table.
-- settings.small_party_max decides which of the two turn lengths applies.
create or replace function mythos.turn_minutes(p_party int)
returns int
language sql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
  select case
           when coalesce(p_party, 1) <= s.small_party_max then s.turn_minutes_small
           else s.turn_minutes_large
         end
    from mythos.settings s
   where s.id = true;
$fn$;
revoke execute on function mythos.turn_minutes(int) from public;
comment on function mythos.turn_minutes(int) is
  $c$Turn length in minutes for a party, per settings.small_party_max.$c$;


-- =====================================================================================
-- CORE INVARIANT: peak simultaneous covers <= capacity_seats
--
-- A booking holds its seats for a whole turn, so the constraint is NOT "covers per
-- slot" — it is "at no instant are more than capacity_seats guests seated".
-- Occupancy is a step function that can only STEP UP at an interval start, so the
-- maximum over [p_starts, p_ends) is attained at one of:
--     * p_starts itself (covers everything that started earlier and is still running)
--     * the start of any already-committed booking that begins inside the window
-- Evaluating exactly those points is therefore both exact and complete.
--
-- Adding a party of p at [starts, ends) is legal iff
--     peak_covers(starts, ends, null) + p <= capacity_seats
--
-- WORKED EXAMPLES (capacity 30, turn 90 minutes)
--
--   Case A — must be REJECTED:
--     committed : 20:00 x 20  ->  [20:00, 21:30)
--     requested : 20:30 x 15  ->  [20:30, 22:00)
--     evaluation points in [20:30, 22:00) = { 20:30 }   (the 20:00 booking starts
--       before the window, so it is not a point, but it IS counted in the occupancy)
--     occ(20:30) = 20
--     20 + 15 = 35 > 30  ->  REJECTED.  Correct.
--
--   Case B — 20:00 x 4, then 20:30 x 6, then 21:00 x 20:
--     committed : 20:00 x 4 -> [20:00, 21:30);  20:30 x 6 -> [20:30, 22:00)
--     requested : 21:00 x 20 -> [21:00, 22:30)
--     evaluation points in [21:00, 22:30) = { 21:00 }
--     occ(21:00) = 4 + 6 = 10
--     10 + 20 = 30 <= 30  ->  ACCEPTED, at exactly capacity.
--     Full occupancy timeline: 20:00-20:30 = 4, 20:30-21:00 = 10, 21:00-21:30 = 30,
--     21:30-22:00 = 26, 22:00-22:30 = 20.  Peak = 30 = capacity.
--     NOTE FOR THE OWNER: the brief described this case as "must also be rejected".
--     Under the stated rule (peak <= capacity) it is legal — the room is exactly full,
--     not over-full. It flips to REJECTED at party 21 (31 > 30), or if capacity_seats
--     is lowered to 29. If the intent is to keep a safety cushion, lower
--     settings.capacity_seats rather than change this function.
-- =====================================================================================

create or replace function mythos.peak_covers(
  p_starts  timestamptz,
  p_ends    timestamptz,
  p_exclude uuid default null
)
returns int
language sql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
  with pts as (
    select p_starts as t
    union
    select b.starts_at from mythos.bookings b
     where b.status in ('confirmed','seated')
       and b.starts_at < p_ends and b.ends_at > p_starts
       and b.starts_at >= p_starts
       and (p_exclude is null or b.id <> p_exclude)
  )
  select coalesce(max(occ), 0) from (
    select (select coalesce(sum(b2.party), 0) from mythos.bookings b2
             where b2.status in ('confirmed','seated')
               and b2.starts_at <= pts.t and b2.ends_at > pts.t
               and (p_exclude is null or b2.id <> p_exclude)) as occ
    from pts) s;
$fn$;
revoke execute on function mythos.peak_covers(timestamptz, timestamptz, uuid) from public;
comment on function mythos.peak_covers(timestamptz, timestamptz, uuid) is
  $c$Max concurrent committed covers at any interval start inside [p_starts, p_ends). p_exclude ignores one booking (used when re-confirming it).$c$;


-- =====================================================================================
-- 1. mythos.availability(party, from, to) -> jsonb
--
-- PUBLIC RESPONSE. Contains NO personal data of any kind — only counts.
-- p_to is clamped to rome_today + horizon_days (and the span is hard-capped, so a
-- pathological horizon setting cannot turn this into a year-long scan). p_from is
-- clamped forward to rome_today: past days are never bookable anyway.
-- Closed day = no active service_windows row for that dow, or a row in closures;
-- it returns closed:true, services:[] and the closure note.
-- Every day carries utc_offset (the Europe/Rome offset ON THAT DATE, '+HH:MM'), computed
-- per day because a 45-day range can cross a DST transition. The browser combines it
-- with a slot time to get an unambiguous instant. See mythos.rome_offset().
-- Slots run opens .. last_seating inclusive, stepping slot_minutes.
--   remaining = capacity_seats - peak_covers(slot window), floored at 0
--   ok        = accepting AND party <= max_party AND remaining >= party
--               AND starts_at > now() + lead_minutes
-- =====================================================================================

create or replace function mythos.availability(p_party int, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  s          mythos.settings%rowtype;
  w          record;
  v_today    date;
  v_from     date;
  v_to       date;
  v_party    int;
  v_turn     int;
  v_days     jsonb := '[]'::jsonb;
  v_services jsonb;
  v_slots    jsonb;
  v_d        date;
  v_dow      int;
  v_note     text;
  v_closed   boolean;
  v_i        int;
  v_n        int;
  v_slot     time;
  v_starts   timestamptz;
  v_ends     timestamptz;
  v_rem      int;
  v_ok       boolean;
begin
  select * into s from mythos.settings where id = true;

  v_today := (now() at time zone 'Europe/Rome')::date;
  v_party := least(greatest(coalesce(p_party, 2), 1), 40);
  v_turn  := mythos.turn_minutes(v_party);

  v_from := greatest(coalesce(p_from, v_today), v_today);
  v_to   := least(coalesce(p_to, v_from), v_today + s.horizon_days);
  -- Hard span cap for a public endpoint (horizon_days may legitimately be up to 365).
  v_to   := least(v_to, v_from + 62);

  for v_d in select v_from + g from generate_series(0, greatest(v_to - v_from, -1)) g loop
    v_dow  := extract(dow from v_d)::int;   -- 0 = Sunday, matches service_windows.dow
    v_note := null;
    select c.note into v_note from mythos.closures c where c.d = v_d;
    v_closed := found;

    if not exists (select 1 from mythos.service_windows sw
                    where sw.dow = v_dow and sw.active) then
      v_closed := true;
    end if;

    if v_closed then
      v_days := v_days || jsonb_build_array(jsonb_build_object(
        'date', v_d::text, 'dow', v_dow, 'closed', true,
        'utc_offset', mythos.rome_offset(v_d),
        'note', v_note, 'services', '[]'::jsonb));
      continue;
    end if;

    v_services := '[]'::jsonb;
    for w in select * from mythos.service_windows sw
              where sw.dow = v_dow and sw.active
              order by sw.opens loop
      v_slots := '[]'::jsonb;
      v_n := floor(extract(epoch from (w.last_seating - w.opens)) / 60.0 / w.slot_minutes)::int;
      v_n := least(v_n, 96);   -- paranoia against a malformed window

      for v_i in 0..v_n loop
        v_slot   := w.opens + (v_i * w.slot_minutes) * interval '1 minute';
        -- Rome local wall time -> instant. Direction matters: `timestamp AT TIME ZONE tz`
        -- yields timestamptz. Never in the 02:00-03:00 DST seam (see header).
        v_starts := (v_d + v_slot) at time zone 'Europe/Rome';
        v_ends   := v_starts + (v_turn || ' minutes')::interval;
        v_rem    := greatest(s.capacity_seats - mythos.peak_covers(v_starts, v_ends), 0);
        v_ok     := s.accepting
                    and v_party <= s.max_party
                    and v_rem >= v_party
                    and v_starts > now() + (s.lead_minutes || ' minutes')::interval;

        v_slots := v_slots || jsonb_build_array(jsonb_build_object(
          'time', to_char(v_slot, 'HH24:MI'), 'remaining', v_rem, 'ok', v_ok));
      end loop;

      v_services := v_services || jsonb_build_array(jsonb_build_object(
        'service', w.service, 'slots', v_slots));
    end loop;

    v_days := v_days || jsonb_build_array(jsonb_build_object(
      'date', v_d::text, 'dow', v_dow, 'closed', false,
      'utc_offset', mythos.rome_offset(v_d),
      'note', v_note, 'services', v_services));
  end loop;

  return jsonb_build_object(
    'rome_now',     mythos.rome_iso(now()),
    'rome_today',   v_today::text,
    'capacity',     s.capacity_seats,
    'max_party',    s.max_party,
    'accepting',    s.accepting,
    'turn_minutes', v_turn,
    'party',        v_party,
    'days',         v_days);
end;
$fn$;
revoke execute on function mythos.availability(int, date, date) from public;
comment on function mythos.availability(int, date, date) is
  $c$Public availability calendar. No personal data. p_to clamped to rome_today + horizon_days; remaining = capacity - peak concurrent covers.$c$;


-- =====================================================================================
-- 2. mythos.book(...) -> jsonb
--
-- Success: {"ok":true,"code":"MY-7K3QD","starts_at":"...","ends_at":"...",
--           "service":"cena","party":4,"phone_tail":"1234"}
-- EXPECTED failures return {"ok":false,"error":"<slug>","message":"<italiano>"}
-- instead of raising, so the Edge Function can map them to HTTP cleanly.
--   Slugs from the brief : not_accepting, closed, no_such_slot, too_late, too_far,
--                          party_too_large, duplicate, full
--   Added (input hygiene): invalid_name, invalid_phone, invalid_party, retry
--
-- Order of operations (the lock placement is load-bearing):
--   1. validate + normalise input
--   2. pg_advisory_xact_lock on the service date — taken BEFORE any occupancy read,
--      otherwise two concurrent requests both see room and both insert
--   3. prove the slot really exists in service_windows and DERIVE `service` from the
--      matching window (a client-supplied service is never trusted)
--   4. closures / lead time / horizon / accepting / max_party
--   5. compute starts_at+ends_at, peak-covers check, insert, return
--
-- Booking code: 5 chars drawn from an unambiguous alphabet (no I, O, 0, 1), each char
-- from one CSPRNG byte of gen_random_uuid()'s first 5 (fully random in v4). 256 % 32 = 0
-- so the modulo is unbiased. 32^5 = 33.5M; retried up to 5 times on collision.
-- =====================================================================================

create or replace function mythos.book(
  p_party  int,
  p_date   date,
  p_time   time,
  p_name   text,
  p_phone  text,
  p_email  text,
  p_notes  text,
  p_source text default 'web'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  s        mythos.settings%rowtype;
  w        mythos.service_windows%rowtype;
  v_alpha  constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 glyphs, no I/O/0/1
  v_today  date;
  v_name   text;
  v_phone  text;
  v_email  text;
  v_notes  text;
  v_source text;
  v_digits text;
  v_tail   text;
  v_dow    int;
  v_turn   int;
  v_starts timestamptz;
  v_ends   timestamptz;
  v_peak   int;
  v_code   text;
  v_hex    text;
  v_try    int;
  v_i      int;
  v_id     uuid;
  v_con    text;
begin
  select * into s from mythos.settings where id = true;
  v_today := (now() at time zone 'Europe/Rome')::date;

  ------------------------------------------------------------------ 1. normalise
  v_name   := left(btrim(coalesce(p_name, '')), 80);
  v_phone  := left(btrim(coalesce(p_phone, '')), 32);
  v_email  := nullif(left(btrim(coalesce(p_email, '')), 120), '');
  v_notes  := nullif(left(btrim(coalesce(p_notes, '')), 400), '');
  v_source := left(coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'web'), 24);
  v_digits := regexp_replace(v_phone, '[^0-9]', '', 'g');

  if p_date is null or p_time is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_slot',
      'message', 'Orario non disponibile. Scegli un altro orario.');
  end if;
  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_name',
      'message', 'Inserisci il tuo nome.');
  end if;
  if length(v_digits) < 6 then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone',
      'message', 'Inserisci un numero di telefono valido.');
  end if;
  if coalesce(p_party, 0) < 1 then
    return jsonb_build_object('ok', false, 'error', 'invalid_party',
      'message', 'Indica per quante persone vuoi prenotare.');
  end if;
  v_tail := right(v_digits, 4);

  ------------------------------------------------------------------ 2. serialise the date
  -- Everything that can consume capacity on this date now queues behind this lock,
  -- for the remainder of the transaction. Taken BEFORE reading occupancy.
  perform pg_advisory_xact_lock(hashtext('mythos:' || p_date::text));

  ------------------------------------------------------------------ 3. does the slot exist?
  v_dow := extract(dow from p_date)::int;

  if not exists (select 1 from mythos.service_windows sw
                  where sw.dow = v_dow and sw.active) then
    return jsonb_build_object('ok', false, 'error', 'closed',
      'message', 'Siamo chiusi in questa data.');
  end if;

  select * into w
    from mythos.service_windows sw
   where sw.dow = v_dow
     and sw.active
     and p_time >= sw.opens
     and p_time <= sw.last_seating
     and mod(extract(epoch from (p_time - sw.opens))::int, sw.slot_minutes * 60) = 0
   order by sw.opens
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_such_slot',
      'message', 'Orario non disponibile. Scegli un altro orario.');
  end if;
  -- `service` comes from the matched window, never from the caller.

  ------------------------------------------------------------------ 4. policy checks
  if not s.accepting then
    return jsonb_build_object('ok', false, 'error', 'not_accepting',
      'message', 'Le prenotazioni online sono momentaneamente sospese. Contattaci telefonicamente.');
  end if;

  if p_party > s.max_party then
    return jsonb_build_object('ok', false, 'error', 'party_too_large',
      'message', format('Per gruppi oltre %s persone contattaci direttamente.', s.max_party));
  end if;

  if exists (select 1 from mythos.closures c where c.d = p_date) then
    return jsonb_build_object('ok', false, 'error', 'closed',
      'message', 'Siamo chiusi in questa data.');
  end if;

  if p_date > v_today + s.horizon_days then
    return jsonb_build_object('ok', false, 'error', 'too_far',
      'message', format('Puoi prenotare online fino a %s giorni in anticipo.', s.horizon_days));
  end if;

  ------------------------------------------------------------------ 5. capacity + insert
  v_turn   := mythos.turn_minutes(p_party);
  v_starts := (p_date + p_time) at time zone 'Europe/Rome';   -- Rome local -> instant
  v_ends   := v_starts + (v_turn || ' minutes')::interval;    -- absolute arithmetic, DST-safe

  if v_starts <= now() + (s.lead_minutes || ' minutes')::interval then
    return jsonb_build_object('ok', false, 'error', 'too_late',
      'message', 'Questo orario non e piu prenotabile online. Contattaci telefonicamente.');
  end if;

  -- Digits-only duplicate pre-check: catches the formatting variants the unique index
  -- cannot see. Race-free because we hold the advisory lock for this date.
  if exists (select 1 from mythos.bookings b
              where b.service_date = p_date
                and b.status = 'confirmed'
                and regexp_replace(b.phone, '[^0-9]', '', 'g') = v_digits) then
    return jsonb_build_object('ok', false, 'error', 'duplicate',
      'message', 'Risulta gia una prenotazione con questo numero per questa data.');
  end if;

  v_peak := mythos.peak_covers(v_starts, v_ends);
  if v_peak + p_party > s.capacity_seats then
    return jsonb_build_object('ok', false, 'error', 'full',
      'message', 'Non ci sono piu posti per questo orario. Prova con un altro orario.',
      'remaining', greatest(s.capacity_seats - v_peak, 0));
  end if;

  for v_try in 1..5 loop
    v_code := 'MY-';
    v_hex  := replace(gen_random_uuid()::text, '-', '');
    for v_i in 0..4 loop
      -- bytes 0..4 of a v4 uuid are fully random (version/variant live in bytes 6 and 8)
      v_code := v_code || substr(v_alpha,
                  1 + (('x' || substr(v_hex, v_i * 2 + 1, 2))::bit(8)::int % 32), 1);
    end loop;

    begin
      insert into mythos.bookings
        (code, service_date, slot_time, service, starts_at, ends_at,
         party, name, phone, phone_tail, email, notes, source)
      values
        (v_code, p_date, p_time, w.service, v_starts, v_ends,
         p_party, v_name, v_phone, v_tail, v_email, v_notes, v_source)
      returning id into v_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_con = constraint_name;
      if v_con is distinct from 'bookings_code_key' then
        -- bookings_phone_day_uniq (or any future one): same number, same day.
        return jsonb_build_object('ok', false, 'error', 'duplicate',
          'message', 'Risulta gia una prenotazione con questo numero per questa data.');
      end if;
      v_id := null;   -- code collision: loop and draw another
    end;
  end loop;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'retry',
      'message', 'Errore temporaneo, riprova tra un istante.');
  end if;

  -- PII-free audit line.
  perform mythos.audit_write('book', jsonb_build_object(
    'code', v_code, 'date', p_date::text, 'time', to_char(p_time, 'HH24:MI'),
    'service', w.service, 'party', p_party, 'source', v_source));

  return jsonb_build_object(
    'ok',         true,
    'code',       v_code,
    'starts_at',  mythos.rome_iso(v_starts),
    'ends_at',    mythos.rome_iso(v_ends),
    'service',    w.service,
    'party',      p_party,
    'phone_tail', v_tail);
end;
$fn$;
revoke execute on function mythos.book(int, date, time, text, text, text, text, text) from public;
comment on function mythos.book(int, date, time, text, text, text, text, text) is
  $c$Create a booking. Serialises on the service date with an advisory xact lock, derives the service from service_windows, enforces peak-covers capacity. Expected failures come back as {"ok":false,"error":slug,"message":it}.$c$;


-- =====================================================================================
-- 3. mythos.cancel(code, phone_tail) -> jsonb
--
-- Guest self-service. Codes are always generated uppercase, so upper(input) is an exact,
-- index-usable, case-insensitive match. Requires: code matches, phone_tail matches,
-- status is 'confirmed', and the seating is still in the future.
-- SECURITY: a wrong code and a wrong phone tail both return the SAME `not_found`.
-- This endpoint must never confirm that a booking code exists.
-- =====================================================================================

create or replace function mythos.cancel(p_code text, p_phone_tail text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  v_code text;
  v_tail text;
  v_row  mythos.bookings%rowtype;
begin
  v_code := upper(btrim(coalesce(p_code, '')));
  v_tail := right(regexp_replace(coalesce(p_phone_tail, ''), '[^0-9]', '', 'g'), 4);

  if v_code = '' or length(v_tail) < 4 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  update mythos.bookings b
     set status = 'cancelled',
         cancelled_at = now()
   where b.code = v_code
     and b.phone_tail = v_tail
     and b.status = 'confirmed'
     and b.starts_at > now()
  returning b.* into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  perform mythos.audit_write('cancel', jsonb_build_object(
    'code', v_row.code, 'date', v_row.service_date::text, 'party', v_row.party,
    'by', 'guest'));

  return jsonb_build_object('ok', true, 'freed', v_row.party);
end;
$fn$;
revoke execute on function mythos.cancel(text, text) from public;
comment on function mythos.cancel(text, text) is
  $c$Guest self-cancel by code + last 4 phone digits. Returns not_found for BOTH a wrong code and a wrong tail (no existence oracle).$c$;


-- =====================================================================================
-- 4. mythos.admin_day(from, to) -> jsonb    [STAFF ONLY — contains PII]
--
-- Full booking rows (every status), per-service cover totals for the committed rows,
-- and the day's true peak occupancy. Span hard-capped at 92 days.
-- Peak is computed over the whole Rome-local calendar day, so a late seating that
-- spills past midnight is still counted while it overlaps.
-- =====================================================================================

create or replace function mythos.admin_day(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  s          mythos.settings%rowtype;
  v_from     date;
  v_to       date;
  v_d        date;
  v_dow      int;
  v_note     text;
  v_closed   boolean;
  v_bookings jsonb;
  v_totals   jsonb;
  v_peak     int;
  v_days     jsonb := '[]'::jsonb;
begin
  select * into s from mythos.settings where id = true;

  v_from := coalesce(p_from, (now() at time zone 'Europe/Rome')::date);
  v_to   := coalesce(p_to, v_from);
  v_to   := least(v_to, v_from + 92);

  for v_d in select v_from + g from generate_series(0, greatest(v_to - v_from, -1)) g loop
    v_dow  := extract(dow from v_d)::int;
    v_note := null;
    select c.note into v_note from mythos.closures c where c.d = v_d;
    v_closed := found;
    if not exists (select 1 from mythos.service_windows sw
                    where sw.dow = v_dow and sw.active) then
      v_closed := true;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id',            b.id,
             'code',          b.code,
             'time',          to_char(b.slot_time, 'HH24:MI'),
             'service',       b.service,
             'starts_at',     mythos.rome_iso(b.starts_at),
             'ends_at',       mythos.rome_iso(b.ends_at),
             'party',         b.party,
             'name',          b.name,
             'phone',         b.phone,
             'phone_tail',    b.phone_tail,
             'email',         b.email,
             'notes',         b.notes,
             'status',        b.status,
             'source',        b.source,
             'created_at',    mythos.rome_iso(b.created_at),
             'cancelled_at',  mythos.rome_iso(b.cancelled_at),
             'anonymized_at', mythos.rome_iso(b.anonymized_at))
             order by b.slot_time, b.created_at), '[]'::jsonb)
      into v_bookings
      from mythos.bookings b
     where b.service_date = v_d;

    select coalesce(jsonb_agg(jsonb_build_object(
             'service', t.service, 'covers', t.covers, 'bookings', t.n)
             order by t.service), '[]'::jsonb)
      into v_totals
      from (select b.service, sum(b.party)::int as covers, count(*)::int as n
              from mythos.bookings b
             where b.service_date = v_d
               and b.status in ('confirmed','seated')
             group by b.service) t;

    v_peak := mythos.peak_covers((v_d + time '00:00') at time zone 'Europe/Rome',
                                 ((v_d + 1) + time '00:00') at time zone 'Europe/Rome');

    v_days := v_days || jsonb_build_array(jsonb_build_object(
      'date', v_d::text, 'dow', v_dow, 'closed', v_closed, 'note', v_note,
      'peak', v_peak, 'capacity', s.capacity_seats,
      'totals', v_totals, 'bookings', v_bookings));
  end loop;

  return jsonb_build_object(
    'ok', true, 'from', v_from::text, 'to', v_to::text,
    'capacity', s.capacity_seats, 'rome_now', mythos.rome_iso(now()),
    'days', v_days);
end;
$fn$;
revoke execute on function mythos.admin_day(date, date) from public;
comment on function mythos.admin_day(date, date) is
  $c$STAFF ONLY. Full booking rows incl. PII for a date range, plus per-service cover totals and the day peak occupancy. Span capped at 92 days.$c$;


-- =====================================================================================
-- 5. mythos.admin_set_status(id, status) -> jsonb    [STAFF ONLY]
--
-- Moving a booking back into an occupying status ('confirmed' or 'seated') RE-RUNS the
-- capacity check, excluding the booking itself, and refuses with `full` if the room no
-- longer fits it. The unique phone/day index is respected too (-> `duplicate`).
-- Lock order matches book(): advisory lock on the date FIRST, then the row lock,
-- so the two functions can never deadlock against each other.
-- =====================================================================================

create or replace function mythos.admin_set_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  s      mythos.settings%rowtype;
  b      mythos.bookings%rowtype;
  v_prev text;
  v_peak int;
begin
  if p_status is null or p_status not in ('confirmed','cancelled','noshow','seated') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;

  select * into b from mythos.bookings where id = p_id;          -- learn the date
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtext('mythos:' || b.service_date::text));

  select * into b from mythos.bookings where id = p_id for update;   -- re-read under lock
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  v_prev := b.status;
  if v_prev = p_status then
    return jsonb_build_object('ok', true, 'id', b.id, 'status', p_status,
                              'previous', v_prev, 'changed', false);
  end if;

  if p_status in ('confirmed','seated') and v_prev not in ('confirmed','seated') then
    select * into s from mythos.settings where id = true;
    v_peak := mythos.peak_covers(b.starts_at, b.ends_at, b.id);
    if v_peak + b.party > s.capacity_seats then
      return jsonb_build_object('ok', false, 'error', 'full',
        'message', 'Non ci sono piu posti per riattivare questa prenotazione.',
        'peak', v_peak, 'party', b.party, 'capacity', s.capacity_seats);
    end if;
  end if;

  begin
    update mythos.bookings
       set status       = p_status,
           cancelled_at = case when p_status = 'cancelled' then coalesce(cancelled_at, now())
                               else null end
     where id = p_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'duplicate',
      'message', 'Esiste gia una prenotazione confermata con questo numero per quella data.');
  end;

  perform mythos.audit_write('admin_set_status', jsonb_build_object(
    'code', b.code, 'date', b.service_date::text, 'party', b.party,
    'from', v_prev, 'to', p_status));

  return jsonb_build_object('ok', true, 'id', b.id, 'code', b.code,
                            'status', p_status, 'previous', v_prev, 'changed', true);
end;
$fn$;
revoke execute on function mythos.admin_set_status(uuid, text) from public;
comment on function mythos.admin_set_status(uuid, text) is
  $c$STAFF ONLY. Change a booking status; re-confirming re-runs the peak-covers capacity check (excluding itself) and refuses with `full` if the room no longer fits.$c$;


-- =====================================================================================
-- 6. mythos.admin_block(date, note, on) -> jsonb    [STAFF ONLY]
--
-- Upsert (p_on = true) or delete (p_on = false) a closures row.
-- Blocking a date NEVER touches existing bookings — it reports how many committed
-- bookings that date already holds so the console can warn the operator, who then
-- decides what to do with them (each one is cancelled explicitly via admin_set_status).
-- =====================================================================================

create or replace function mythos.admin_block(p_date date, p_note text, p_on boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  v_on   boolean := coalesce(p_on, true);
  v_note text    := nullif(left(btrim(coalesce(p_note, '')), 200), '');
  v_n    int;
  v_cov  int;
begin
  if p_date is null then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  perform pg_advisory_xact_lock(hashtext('mythos:' || p_date::text));

  select count(*)::int, coalesce(sum(b.party), 0)::int
    into v_n, v_cov
    from mythos.bookings b
   where b.service_date = p_date
     and b.status in ('confirmed','seated');

  if v_on then
    insert into mythos.closures (d, note) values (p_date, v_note)
      on conflict (d) do update set note = excluded.note;
  else
    delete from mythos.closures where d = p_date;
  end if;

  perform mythos.audit_write('admin_block', jsonb_build_object(
    'date', p_date::text, 'blocked', v_on, 'note', v_note,
    'existing_bookings', v_n, 'existing_covers', v_cov));

  return jsonb_build_object(
    'ok', true,
    'date', p_date::text,
    'blocked', v_on,
    'existing_bookings', v_n,
    'existing_covers', v_cov,
    'warning', case when v_on and v_n > 0
                    then format('Attenzione: questa data ha gia %s prenotazioni attive (%s coperti). Non sono state cancellate.', v_n, v_cov)
                    else null end);
end;
$fn$;
revoke execute on function mythos.admin_block(date, text, boolean) from public;
comment on function mythos.admin_block(date, text, boolean) is
  $c$STAFF ONLY. Open/close a date in mythos.closures. Never deletes bookings; returns how many active bookings the date already holds so the console can warn.$c$;


-- =====================================================================================
-- 7. mythos.admin_settings(patch) -> jsonb    [STAFF ONLY]
--
-- Patches only the keys present in p_patch. Ranges enforced:
--   capacity_seats 1..500, max_party 1..40, small_party_max 1..40,
--   turn_minutes_small / turn_minutes_large 30..300, lead_minutes 0..1440,
--   horizon_days 1..365, accepting boolean.
-- Unknown keys are ignored. Returns the resulting row.
-- =====================================================================================

create or replace function mythos.admin_settings(p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  s    mythos.settings%rowtype;
  v_ks text[];
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_patch');
  end if;

  select * into s from mythos.settings where id = true;

  begin
    if p_patch ? 'capacity_seats'     then s.capacity_seats     := (p_patch->>'capacity_seats')::int;     end if;
    if p_patch ? 'turn_minutes_small' then s.turn_minutes_small := (p_patch->>'turn_minutes_small')::int; end if;
    if p_patch ? 'turn_minutes_large' then s.turn_minutes_large := (p_patch->>'turn_minutes_large')::int; end if;
    if p_patch ? 'small_party_max'    then s.small_party_max    := (p_patch->>'small_party_max')::int;    end if;
    if p_patch ? 'max_party'          then s.max_party          := (p_patch->>'max_party')::int;          end if;
    if p_patch ? 'lead_minutes'       then s.lead_minutes       := (p_patch->>'lead_minutes')::int;       end if;
    if p_patch ? 'horizon_days'       then s.horizon_days       := (p_patch->>'horizon_days')::int;       end if;
    if p_patch ? 'accepting'          then s.accepting          := (p_patch->>'accepting')::boolean;      end if;
  exception when invalid_text_representation or datatype_mismatch then
    return jsonb_build_object('ok', false, 'error', 'bad_patch',
      'message', 'Valore non valido nelle impostazioni.');
  end;

  -- Every check is null-safe on purpose: a patch like {"capacity_seats": null} makes
  -- ->> return SQL NULL, and `NULL not between ...` is NULL, which IF treats as false.
  -- Without the explicit `is null` the row would sail through and blow up on the
  -- NOT NULL constraint, aborting the caller's whole transaction.
  if s.capacity_seats is null or s.capacity_seats not between 1 and 500 then
    return jsonb_build_object('ok', false, 'error', 'invalid_capacity_seats',
      'message', 'capacity_seats deve essere tra 1 e 500.');
  end if;
  if s.turn_minutes_small is null or s.turn_minutes_large is null
     or s.turn_minutes_small not between 30 and 300
     or s.turn_minutes_large not between 30 and 300 then
    return jsonb_build_object('ok', false, 'error', 'invalid_turn_minutes',
      'message', 'La durata del turno deve essere tra 30 e 300 minuti.');
  end if;
  if s.small_party_max is null or s.small_party_max not between 1 and 40 then
    return jsonb_build_object('ok', false, 'error', 'invalid_small_party_max',
      'message', 'small_party_max deve essere tra 1 e 40.');
  end if;
  if s.max_party is null or s.max_party not between 1 and 40 then
    return jsonb_build_object('ok', false, 'error', 'invalid_max_party',
      'message', 'max_party deve essere tra 1 e 40.');
  end if;
  if s.lead_minutes is null or s.lead_minutes not between 0 and 1440 then
    return jsonb_build_object('ok', false, 'error', 'invalid_lead_minutes',
      'message', 'lead_minutes deve essere tra 0 e 1440.');
  end if;
  if s.horizon_days is null or s.horizon_days not between 1 and 365 then
    return jsonb_build_object('ok', false, 'error', 'invalid_horizon_days',
      'message', 'horizon_days deve essere tra 1 e 365.');
  end if;
  if s.accepting is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_accepting',
      'message', 'accepting deve essere true o false.');
  end if;

  update mythos.settings
     set capacity_seats     = s.capacity_seats,
         turn_minutes_small = s.turn_minutes_small,
         turn_minutes_large = s.turn_minutes_large,
         small_party_max    = s.small_party_max,
         max_party          = s.max_party,
         lead_minutes       = s.lead_minutes,
         horizon_days       = s.horizon_days,
         accepting          = s.accepting,
         updated_at         = now()
   where id = true;

  select array_agg(k order by k) into v_ks from jsonb_object_keys(p_patch) k;
  perform mythos.audit_write('admin_settings', jsonb_build_object(
    'keys', to_jsonb(coalesce(v_ks, array[]::text[])), 'patch', p_patch));

  return jsonb_build_object(
    'ok', true,
    'settings', jsonb_build_object(
      'capacity_seats',     s.capacity_seats,
      'turn_minutes_small', s.turn_minutes_small,
      'turn_minutes_large', s.turn_minutes_large,
      'small_party_max',    s.small_party_max,
      'max_party',          s.max_party,
      'lead_minutes',       s.lead_minutes,
      'horizon_days',       s.horizon_days,
      'accepting',          s.accepting));
end;
$fn$;
revoke execute on function mythos.admin_settings(jsonb) from public;
comment on function mythos.admin_settings(jsonb) is
  $c$STAFF ONLY. Patch the single settings row (only keys present in the jsonb), with range validation. Returns the resulting settings.$c$;


-- =====================================================================================
-- 8. mythos.admin_windows(rows) -> jsonb    [STAFF ONLY]
--
-- Replaces the whole weekly template transactionally: the payload is fully validated
-- first, then the table is emptied and re-filled inside this transaction, so a bad row
-- leaves the existing schedule untouched.
-- Row shape: {"dow":2,"service":"cena","opens":"18:30","last_seating":"22:00",
--             "slot_minutes":15,"active":true}
-- =====================================================================================

create or replace function mythos.admin_windows(p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  r        jsonb;
  v_seen   text[] := array[]::text[];
  v_key    text;
  v_dow    int;
  v_svc    text;
  v_opens  time;
  v_last   time;
  v_slot   int;
  v_active boolean;
  v_n      int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_rows');
  end if;

  ---------------------------------------------------------------- validate everything first
  for r in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then
      return jsonb_build_object('ok', false, 'error', 'bad_rows');
    end if;

    begin
      v_dow    := (r->>'dow')::int;
      v_svc    := btrim(coalesce(r->>'service', ''));
      v_opens  := (r->>'opens')::time;
      v_last   := (r->>'last_seating')::time;
      v_slot   := coalesce((r->>'slot_minutes')::int, 15);
      v_active := coalesce((r->>'active')::boolean, true);
    exception when invalid_text_representation or datatype_mismatch or invalid_datetime_format then
      return jsonb_build_object('ok', false, 'error', 'bad_row',
        'message', 'Formato riga non valido.', 'row', r);
    end;

    if v_dow is null or v_dow not between 0 and 6 then
      return jsonb_build_object('ok', false, 'error', 'bad_dow', 'row', r);
    end if;
    if v_svc not in ('pranzo','cena') then
      return jsonb_build_object('ok', false, 'error', 'bad_service', 'row', r);
    end if;
    if v_opens is null or v_last is null or v_opens >= v_last then
      return jsonb_build_object('ok', false, 'error', 'bad_times',
        'message', 'opens deve essere precedente a last_seating.', 'row', r);
    end if;
    if v_slot not in (15, 30) then
      return jsonb_build_object('ok', false, 'error', 'bad_slot_minutes', 'row', r);
    end if;

    v_key := v_dow::text || ':' || v_svc;
    if v_key = any (v_seen) then
      return jsonb_build_object('ok', false, 'error', 'duplicate_window',
        'message', 'Due righe per lo stesso giorno e servizio.', 'row', r);
    end if;
    v_seen := v_seen || v_key;
  end loop;

  ---------------------------------------------------------------- swap
  delete from mythos.service_windows;

  for r in select value from jsonb_array_elements(p_rows) loop
    insert into mythos.service_windows (dow, service, opens, last_seating, slot_minutes, active)
    values ((r->>'dow')::int,
            btrim(r->>'service'),
            (r->>'opens')::time,
            (r->>'last_seating')::time,
            coalesce((r->>'slot_minutes')::int, 15),
            coalesce((r->>'active')::boolean, true));
    v_n := v_n + 1;
  end loop;

  perform mythos.audit_write('admin_windows', jsonb_build_object('rows', v_n, 'template', p_rows));

  return jsonb_build_object(
    'ok', true, 'rows', v_n,
    'warning', case when v_n = 0
                    then 'Nessuna fascia oraria attiva: il ristorante risulta chiuso tutti i giorni.'
                    else null end);
end;
$fn$;
revoke execute on function mythos.admin_windows(jsonb) from public;
comment on function mythos.admin_windows(jsonb) is
  $c$STAFF ONLY. Replace the weekly service_windows template transactionally. Validates the whole payload (dow, service, opens < last_seating, slot_minutes, no duplicate dow+service) before deleting anything.$c$;


-- =====================================================================================
-- 9. mythos.is_admin(uid) -> boolean
-- Called by the Edge Function after it has verified the Supabase JWT, BEFORE any
-- mythos.admin_* call. Never trust a uid that did not come out of a verified JWT.
-- =====================================================================================

create or replace function mythos.is_admin(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
  select exists (select 1 from mythos.admins a where a.user_id = p_uid);
$fn$;
revoke execute on function mythos.is_admin(uuid) from public;
comment on function mythos.is_admin(uuid) is
  $c$True if the (JWT-verified) auth user id is in the mythos.admins allow-list.$c$;


-- =====================================================================================
-- 10. mythos.rate_hit(ip_hash, max_hour, max_day) -> boolean
--
-- Increments the current hour bucket and returns TRUE when the call is ALLOWED.
-- Checks the hour bucket AND the sum of the last 24 buckets. The counter is bumped
-- even when the call is denied, so hammering keeps the caller locked out.
-- Buckets are truncated in UTC explicitly: date_trunc('hour', timestamptz) would use
-- the session TimeZone GUC, which this codebase never assumes.
-- Rows older than 48h are pruned opportunistically — only on the call that creates a
-- new bucket for that ip_hash, i.e. at most once per hour per client.
-- ip_hash must already be a salted hash of the IP; a raw IP is personal data.
-- =====================================================================================

create or replace function mythos.rate_hit(
  p_ip_hash  text,
  p_max_hour int default 5,
  p_max_day  int default 20
)
returns boolean
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  v_bucket timestamptz;
  v_hour   int;
  v_day    int;
begin
  if p_ip_hash is null or btrim(p_ip_hash) = '' then
    return false;
  end if;

  v_bucket := date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC';

  insert into mythos.rate (ip_hash, bucket, n)
  values (left(btrim(p_ip_hash), 128), v_bucket, 1)
  on conflict (ip_hash, bucket) do update set n = rate.n + 1
  returning n into v_hour;

  if v_hour = 1 then
    delete from mythos.rate where bucket < now() - interval '48 hours';
  end if;

  select coalesce(sum(rt.n), 0)::int into v_day
    from mythos.rate rt
   where rt.ip_hash = left(btrim(p_ip_hash), 128)
     and rt.bucket > now() - interval '24 hours';

  return v_hour <= greatest(p_max_hour, 1) and v_day <= greatest(p_max_day, 1);
end;
$fn$;
revoke execute on function mythos.rate_hit(text, int, int) from public;
comment on function mythos.rate_hit(text, int, int) is
  $c$Increment the hourly bucket for a hashed IP and return true if the call is allowed (hour limit AND rolling 24h limit). Prunes buckets older than 48h opportunistically.$c$;


-- =====================================================================================
-- 11. mythos.gdpr_purge() -> int
--
-- Anonymises name / phone / phone_tail / email / notes on bookings older than 120 days
-- and stamps anonymized_at. Aggregate columns (party, service, dates, status, source)
-- are kept so historical covers reporting still works.
--
-- phone is set to 'anon-' || id rather than a constant: the partial unique index
-- (phone, service_date) where status='confirmed' would otherwise collide as soon as two
-- confirmed bookings on the same old date were anonymised.
-- Returns the number of rows anonymised.
-- =====================================================================================

create or replace function mythos.gdpr_purge()
returns int
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  v_today date := (now() at time zone 'Europe/Rome')::date;
  v_n     int;
begin
  update mythos.bookings b
     set name          = 'Anonimizzato',
         phone         = 'anon-' || b.id::text,
         phone_tail    = '0000',
         email         = null,
         notes         = null,
         anonymized_at = now()
   where b.anonymized_at is null
     and b.service_date < v_today - 120
     and b.created_at   < now() - interval '120 days';

  get diagnostics v_n = row_count;

  if v_n > 0 then
    perform mythos.audit_write('gdpr_purge', jsonb_build_object('rows', v_n));
  end if;

  return v_n;
end;
$fn$;
revoke execute on function mythos.gdpr_purge() from public;
comment on function mythos.gdpr_purge() is
  $c$Anonymise PII on bookings older than 120 days, keeping aggregate columns. Returns the row count.$c$;

-- Enable the nightly purge later, once pg_cron is enabled on the project.
-- Run manually, NOT part of this migration:
--   create extension if not exists pg_cron;
--   select cron.schedule('mythos-gdpr-purge', '30 4 * * *', $$select mythos.gdpr_purge();$$);
-- To remove it:  select cron.unschedule('mythos-gdpr-purge');


-- =====================================================================================
-- SEED
--
-- !!! PLACEHOLDER HOURS — NOT CONFIRMED BY THE OWNER !!!
-- Public sources (Google, TheFork, social) disagree about Mythos' opening hours, so the
-- template below is deliberately CONSERVATIVE: it never offers a seating we are unsure
-- about. Confirm with the owner and then replace the whole template in one shot via
-- mythos.admin_windows(...) — do not hand-edit rows here.
--
--   Monday    (dow 1)  : CLOSED — no rows at all
--   Tue-Thu   (2,3,4)  : cena only,  18:30 -> last seating 22:00
--   Fri, Sat  (5,6)    : pranzo 12:30 -> 14:30,  cena 18:30 -> 22:15
--   Sunday    (dow 0)  : pranzo 12:30 -> 14:30,  cena 18:30 -> 22:00
--
-- `on conflict do nothing` so re-applying this migration never stomps hours the owner
-- has since corrected through the admin console.
-- =====================================================================================

insert into mythos.settings (id) values (true)
  on conflict (id) do nothing;

insert into mythos.service_windows (dow, service, opens, last_seating, slot_minutes, active) values
  -- Sunday
  (0, 'pranzo', time '12:30', time '14:30', 15, true),
  (0, 'cena',   time '18:30', time '22:00', 15, true),
  -- Monday (dow 1): closed, intentionally absent
  -- Tuesday
  (2, 'cena',   time '18:30', time '22:00', 15, true),
  -- Wednesday
  (3, 'cena',   time '18:30', time '22:00', 15, true),
  -- Thursday
  (4, 'cena',   time '18:30', time '22:00', 15, true),
  -- Friday
  (5, 'pranzo', time '12:30', time '14:30', 15, true),
  (5, 'cena',   time '18:30', time '22:15', 15, true),
  -- Saturday
  (6, 'pranzo', time '12:30', time '14:30', 15, true),
  (6, 'cena',   time '18:30', time '22:15', 15, true)
on conflict (dow, service) do nothing;


-- =====================================================================================
-- FINAL LOCKDOWN
--
-- Runs after every object exists. `anon` and `authenticated` must end with ZERO
-- privileges on the schema and everything in it. `service_role` is included too: this
-- schema is never reached through PostgREST, only through Edge Functions connecting as
-- the DB owner over SUPABASE_DB_URL — and the owner's rights come from ownership, not
-- from any grant, so none of this affects them.
--
-- NOTE: no GRANT statement appears anywhere in this file. Nothing is handed to anon or
-- authenticated at any point; these REVOKEs are belt-and-braces against inherited
-- default privileges.
-- =====================================================================================

revoke all on schema mythos                     from public;
revoke all on all tables    in schema mythos    from public;
revoke all on all sequences in schema mythos    from public;
revoke all on all functions in schema mythos    from public;
revoke all on all routines  in schema mythos    from public;

do $guard$
declare
  r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema mythos from %I', r);
      execute format('revoke all on all tables    in schema mythos from %I', r);
      execute format('revoke all on all sequences in schema mythos from %I', r);
      execute format('revoke all on all functions in schema mythos from %I', r);
      execute format('revoke all on all routines  in schema mythos from %I', r);
      -- and nothing they might inherit for objects created later
      execute format('alter default privileges in schema mythos revoke all on tables    from %I', r);
      execute format('alter default privileges in schema mythos revoke all on sequences from %I', r);
      execute format('alter default privileges in schema mythos revoke all on functions from %I', r);
    end if;
  end loop;
end
$guard$;

-- Self-checks for a human after applying.
--
--   -- 1) must return ZERO rows
--   select grantee, table_schema, table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'mythos'
--      and grantee in ('anon','authenticated','service_role','PUBLIC');
--
--   -- 2) must return false / false on both rows
--   select r.rolname,
--          has_schema_privilege(r.rolname, 'mythos', 'USAGE')  as usage_priv,
--          has_schema_privilege(r.rolname, 'mythos', 'CREATE') as create_priv
--     from pg_roles r
--    where r.rolname in ('anon','authenticated');
--
--   -- 3) must return ZERO rows (no function executable by anon/authenticated/PUBLIC)
--   select p.proname, r.rolname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     cross join (values ('anon'),('authenticated'),('public')) as r(rolname)
--    where n.nspname = 'mythos'
--      and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
--
--   -- 4) DST offsets: expect +02:00, +01:00, +02:00, +01:00, +01:00, +02:00
--   select mythos.rome_offset(d)
--     from unnest(array['2026-08-01','2026-12-01','2026-10-24',
--                       '2026-10-25','2027-03-27','2027-03-28']::date[]) d;
-- =====================================================================================
