"""Generate supabase/migrations/20261104140000_group_requests.sql (already applied).
Usage: python3 tools/gen_group_requests.py <repo root>. Patches the live function bodies from 0001
(and the already-applied cancel() from 20261104120000) with asserted anchors."""
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
base = (root / 'supabase/migrations/0001_mythos.sql').read_text()
cancel_src = (root / 'supabase/migrations/20261104120000_cancel_returns_guest.sql').read_text()

def fn(src, name):
    m = re.search(r'create or replace function mythos\.' + name + r'\(.*?\$fn\$;\n', src, re.S)
    assert m, name
    return m.group(0)

def patch(body, pairs, label):
    for a, b in pairs:
        assert body.count(a) == 1, (label, body.count(a), a[:80])
        body = body.replace(a, b)
    return body

# ---------------------------------------------------------------- availability
avail = patch(fn(base, 'availability'), [
  ("""        v_ok     := s.accepting
                    and v_party <= s.max_party
                    and v_rem >= v_party""",
   """        -- Parties above max_party are still offered a slot, as a REQUEST,
        -- up to request_party_max; the slot must fit the room right now.
        v_ok     := s.accepting
                    and v_party <= s.request_party_max
                    and v_rem >= v_party"""),
  ("""    'max_party',    s.max_party,""",
   """    'max_party',    s.max_party,
    'request_party_max', s.request_party_max,
    'is_request',   v_party > s.max_party,"""),
], 'availability')

# ---------------------------------------------------------------- book
book = patch(fn(base, 'book'), [
  ("""  v_con    text;
begin""",
   """  v_con    text;
  v_status text;
begin"""),
  ("""  if p_party > s.max_party then
    return jsonb_build_object('ok', false, 'error', 'party_too_large',
      'message', format('Per gruppi oltre %s persone contattaci direttamente.', s.max_party));
  end if;""",
   """  -- Up to max_party: confirmed at once. Up to request_party_max: a 'pending'
  -- request the staff approve from the console. Above that: phone.
  if p_party > s.request_party_max then
    return jsonb_build_object('ok', false, 'error', 'party_too_large',
      'message', format('Per gruppi oltre %s persone contattaci direttamente.', s.request_party_max));
  end if;
  v_status := case when p_party > s.max_party then 'pending' else 'confirmed' end;"""),
  ("""                and b.status = 'confirmed'
                and regexp_replace(b.phone, '[^0-9]', '', 'g') = v_digits) then""",
   """                and b.status in ('confirmed','pending')
                and regexp_replace(b.phone, '[^0-9]', '', 'g') = v_digits) then"""),
  ("""         party, name, phone, phone_tail, email, notes, source)
      values
        (v_code, p_date, p_time, w.service, v_starts, v_ends,
         p_party, v_name, v_phone, v_tail, v_email, v_notes, v_source)""",
   """         party, name, phone, phone_tail, email, notes, source, status)
      values
        (v_code, p_date, p_time, w.service, v_starts, v_ends,
         p_party, v_name, v_phone, v_tail, v_email, v_notes, v_source, v_status)"""),
  ("""    'service', w.service, 'party', p_party, 'source', v_source));""",
   """    'service', w.service, 'party', p_party, 'source', v_source, 'status', v_status));"""),
  ("""    'ok',         true,
    'code',       v_code,""",
   """    'ok',         true,
    'status',     v_status,
    'code',       v_code,"""),
], 'book')

# ---------------------------------------------------------------- cancel (guest may withdraw a request too)
cancel = patch(fn(cancel_src, 'cancel'), [
  ("""     and b.status = 'confirmed'
     and b.starts_at > now()""",
   """     and b.status in ('confirmed','pending')
     and b.starts_at > now()"""),
  ("""      'phone_tail', v_row.phone_tail));""",
   """      'phone_tail', v_row.phone_tail,
      'was_request', v_row.party > (select s.max_party from mythos.settings s where s.id = true)));"""),
], 'cancel')

# ---------------------------------------------------------------- admin_set_status
setst = patch(fn(base, 'admin_set_status'), [
  ("""  if p_status is null or p_status not in ('confirmed','cancelled','noshow','seated') then""",
   """  if p_status is null or p_status not in ('confirmed','cancelled','noshow','seated','refused') then"""),
  ("""     where id = p_id;
  exception when unique_violation then""",
   """     where id = p_id;
  exception when unique_violation then"""),
  ("""  return jsonb_build_object('ok', true, 'id', b.id, 'code', b.code,
                            'status', p_status, 'previous', v_prev, 'changed', true);""",
   """  -- The guest block lets mythos-admin send the approval / refusal mail.
  return jsonb_build_object('ok', true, 'id', b.id, 'code', b.code,
                            'status', p_status, 'previous', v_prev, 'changed', true,
                            'guest', jsonb_build_object(
                              'code', b.code, 'name', b.name, 'phone', b.phone,
                              'email', b.email, 'party', b.party, 'service', b.service,
                              'starts_at', b.starts_at, 'phone_tail', b.phone_tail,
                              'notes', b.notes));"""),
], 'admin_set_status')
# cancelled_at also stamps refusals
setst = patch(setst, [
  ("""           cancelled_at = case when p_status = 'cancelled' then coalesce(cancelled_at, now())""",
   """           cancelled_at = case when p_status in ('cancelled','refused') then coalesce(cancelled_at, now())"""),
], 'admin_set_status2')

admin_pending = """create or replace function mythos.admin_pending()
returns jsonb
language sql
stable
security definer
set search_path = mythos, pg_temp
as $fn$
  -- Every open group request from today on, oldest table first, with whether it
  -- still fits the room right now (requests hold no seats until approved).
  select jsonb_build_object('ok', true, 'requests', coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'code', b.code, 'date', b.service_date::text,
           'time', to_char(b.slot_time, 'HH24:MI'), 'service', b.service,
           'party', b.party, 'name', b.name, 'phone', b.phone, 'email', b.email,
           'notes', b.notes, 'created_at', mythos.rome_iso(b.created_at),
           'fits', mythos.peak_covers(b.starts_at, b.ends_at, b.id) + b.party
                   <= (select s.capacity_seats from mythos.settings s where s.id = true))
           order by b.starts_at), '[]'::jsonb))
    from mythos.bookings b
   where b.status = 'pending'
     and b.starts_at > now();
$fn$;
"""

out = f"""-- Groups above six become requests the restaurant approves, 2026-11-04.
--
-- Owner rule (via Sihab): "prenotazioni piu di 6 persone devono essere accettate come
-- masto". Up to settings.max_party (now 6) a table is confirmed on the spot. From 7 to
-- settings.request_party_max (20) it is stored as status 'pending': it HOLDS NO SEATS
-- (peak_covers counts confirmed/seated only) and the staff approve or refuse it from
-- the console. Approving re-runs the capacity check under the per-date lock, so an
-- approval can fail late if the room filled meanwhile; the console shows whether each
-- request still fits. 'refused' is its own status, distinct from a guest's cancel.
--
-- Generated by scratchpad gen_groups.py: every function body below is the one already
-- live, patched at asserted anchors. Applied with `supabase db query --linked`.

begin;

alter table mythos.settings
  add column if not exists request_party_max int not null default 20;
comment on column mythos.settings.request_party_max is
  'Largest party accepted online at all. Between max_party+1 and this it arrives as a pending request.';

update mythos.settings set max_party = 6, updated_at = now() where id = true;

-- Postgres stores IN (...) checks as `status = ANY (ARRAY[...])`: find it by value.
do $$
declare v_con text;
begin
  for v_con in
    select conname from pg_constraint
     where conrelid = 'mythos.bookings'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%noshow%'
  loop
    execute format('alter table mythos.bookings drop constraint %I', v_con);
  end loop;
end $$;

alter table mythos.bookings
  add constraint bookings_status_chk
  check (status in ('confirmed','pending','refused','cancelled','noshow','seated'));

{avail}revoke execute on function mythos.availability(int, date, date) from public;

{book}revoke execute on function mythos.book(int, date, time, text, text, text, text, text) from public;

{cancel}revoke execute on function mythos.cancel(text, text) from public;

{setst}revoke execute on function mythos.admin_set_status(uuid, text) from public;

{admin_pending}revoke execute on function mythos.admin_pending() from public;
comment on function mythos.admin_pending() is
  $c$STAFF ONLY. Open group requests from now on, with a live `fits` flag.$c$;

commit;
"""
(root / 'supabase/migrations/20261104140000_group_requests.sql').write_text(out)
print('written', len(out.splitlines()), 'lines')
