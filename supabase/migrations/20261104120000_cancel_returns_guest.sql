-- mythos.cancel() also returns the cancelled booking's details, 2026-11-04.
--
-- mythos-cancel now mails the guest a cancellation receipt and gives the
-- restaurant the name/time/party instead of a bare code. The extra fields reach
-- the Edge Function only: mythos-cancel still answers the browser with
-- {ok, freed} and nothing else. Body otherwise unchanged.
--
-- Applied with `supabase db query --linked` (shared migration ledger).

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

  return jsonb_build_object(
    'ok', true,
    'freed', v_row.party,
    'guest', jsonb_build_object(
      'code', v_row.code,
      'name', v_row.name,
      'phone', v_row.phone,
      'email', v_row.email,
      'party', v_row.party,
      'service', v_row.service,
      'starts_at', v_row.starts_at,
      'phone_tail', v_row.phone_tail));
end;
$fn$;

revoke execute on function mythos.cancel(text, text) from public;
