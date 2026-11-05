-- Staff add phone / walk-in bookings from the console, 2026-11-05.
--
-- Until now every booking came from the website, so a table promised on the
-- phone did not exist for the engine: those seats were never counted and the
-- site could sell them again. Ported from MASTO (admin_manual_entry).
--
-- Staff are not held to the online rules (slot grid, lead time, horizon, group
-- requests, the "online bookings off" switch): they are the people who decide
-- those. What they ARE told about, and must confirm with p_force, is anything
-- that would surprise them later:
--   past        the time has already gone
--   closed      the date is in mythos.closures
--   off_hours   no opening window covers that time on that weekday
--   full        the room would go over capacity_seats at some point in the turn
-- A second table for the same phone on the same day is still refused, as on the
-- web. E-mail is optional here (a phone guest may not give one); source 'telefono'.
--
-- Applied with `supabase db query --linked` (shared migration ledger).

create or replace function mythos.admin_add_booking(
  p_date   date,
  p_time   time,
  p_party  int,
  p_name   text,
  p_phone  text,
  p_email  text,
  p_notes  text,
  p_force  boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mythos, pg_temp
as $fn$
declare
  s         mythos.settings%rowtype;
  v_alpha   constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- same glyphs as mythos.book()
  v_name    text := left(btrim(coalesce(p_name, '')), 80);
  v_phone   text := left(btrim(coalesce(p_phone, '')), 32);
  v_email   text := nullif(lower(left(btrim(coalesce(p_email, '')), 120)), '');
  v_notes   text := nullif(left(btrim(coalesce(p_notes, '')), 400), '');
  v_digits  text;
  v_dow     int;
  v_service text;
  v_starts  timestamptz;
  v_ends    timestamptz;
  v_peak    int;
  v_warn    jsonb := '[]'::jsonb;
  v_code    text;
  v_hex     text;
  v_id      uuid;
  v_con     text;
  v_try     int;
  v_i       int;
begin
  select * into s from mythos.settings where id = true;
  v_digits := regexp_replace(v_phone, '[^0-9]', '', 'g');

  if p_date is null or p_time is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_when', 'message', 'Indica data e ora.');
  end if;
  if length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'error', 'invalid_name', 'message', 'Scrivi il nome del cliente.');
  end if;
  if length(v_digits) < 6 then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone', 'message', 'Serve un numero di telefono.');
  end if;
  if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_email', 'message', 'L''email non sembra valida.');
  end if;
  if coalesce(p_party, 0) not between 1 and 40 then
    return jsonb_build_object('ok', false, 'error', 'invalid_party', 'message', 'Le persone vanno da 1 a 40.');
  end if;

  -- Same lock mythos.book() takes: a phone booking and a web booking for the
  -- same date cannot both read "there is room".
  perform pg_advisory_xact_lock(hashtext('mythos:' || p_date::text));

  v_starts := (p_date + p_time) at time zone 'Europe/Rome';
  v_ends   := v_starts + (mythos.turn_minutes(p_party) || ' minutes')::interval;
  v_dow    := extract(dow from p_date)::int;

  if exists (select 1 from mythos.bookings b
              where b.service_date = p_date
                and b.status in ('confirmed', 'pending')
                and regexp_replace(b.phone, '[^0-9]', '', 'g') = v_digits) then
    return jsonb_build_object('ok', false, 'error', 'duplicate',
      'message', 'C''è già una prenotazione con questo numero per questa data.');
  end if;

  -- service: the window that covers the time; outside every window, split at 17:00.
  select sw.service into v_service
    from mythos.service_windows sw
   where sw.dow = v_dow and sw.active and p_time between sw.opens and sw.last_seating
   order by sw.opens limit 1;
  if v_service is null then
    v_warn := v_warn || '["off_hours"]'::jsonb;
    v_service := case when p_time < time '17:00' then 'pranzo' else 'cena' end;
  end if;

  if v_starts < now() then
    v_warn := v_warn || '["past"]'::jsonb;
  end if;

  if exists (select 1 from mythos.closures c where c.d = p_date) then
    v_warn := v_warn || '["closed"]'::jsonb;
  end if;

  v_peak := mythos.peak_covers(v_starts, v_ends);
  if v_peak + p_party > s.capacity_seats then
    v_warn := v_warn || '["full"]'::jsonb;
  end if;

  if jsonb_array_length(v_warn) > 0 and not coalesce(p_force, false) then
    return jsonb_build_object('ok', false, 'error', 'needs_force', 'warnings', v_warn,
      'remaining', greatest(s.capacity_seats - v_peak, 0));
  end if;

  for v_try in 1..5 loop
    v_hex  := replace(gen_random_uuid()::text, '-', '');
    v_code := 'MY-';
    for v_i in 0..4 loop
      v_code := v_code || substr(v_alpha,
                  1 + (('x' || substr(v_hex, v_i * 2 + 1, 2))::bit(8)::int % 32), 1);
    end loop;
    begin
      insert into mythos.bookings
        (code, service_date, slot_time, service, starts_at, ends_at,
         party, name, phone, phone_tail, email, notes, source)
      values
        (v_code, p_date, p_time, v_service, v_starts, v_ends,
         p_party, v_name, v_phone, right(v_digits, 4), v_email, v_notes, 'telefono')
      returning id into v_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_con = constraint_name;
      if v_con is distinct from 'bookings_code_key' then
        return jsonb_build_object('ok', false, 'error', 'duplicate',
          'message', 'C''è già una prenotazione con questo numero per questa data.');
      end if;
      v_id := null;
    end;
  end loop;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'retry', 'message', 'Errore temporaneo, riprova.');
  end if;

  perform mythos.audit_write('admin_add_booking', jsonb_build_object(
    'code', v_code, 'date', p_date::text, 'time', to_char(p_time, 'HH24:MI'),
    'party', p_party, 'forced', v_warn));

  -- The guest block lets mythos-admin mail a confirmation when an address was given.
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'forced', v_warn,
    'guest', jsonb_build_object(
      'code', v_code, 'name', v_name, 'phone', v_phone, 'email', v_email,
      'party', p_party, 'service', v_service, 'starts_at', v_starts,
      'phone_tail', right(v_digits, 4), 'notes', v_notes));
end;
$fn$;

revoke execute on function mythos.admin_add_booking(date, time, int, text, text, text, text, boolean) from public;
comment on function mythos.admin_add_booking(date, time, int, text, text, text, text, boolean) is
  $c$STAFF ONLY. Confirmed booking entered by hand (source 'telefono'). Off-rule cases come back as needs_force + warnings; resend with p_force.$c$;
