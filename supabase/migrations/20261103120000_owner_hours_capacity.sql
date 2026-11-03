-- Owner-confirmed booking rules, 2026-11-03.
--
--   Open Tuesday to Sunday, 12:30-16:30 and 18:30-23:45. Closed Monday.
--   Bookable seatings: lunch 12:45 (first) to 15:30 (last),
--                      dinner 19:00 (first) to 22:30 (last).
--   28 covers in total, every table held for 90 minutes whatever the party size.
--
-- Applied with `supabase db query --linked` rather than `db push`: the migration
-- ledger is shared with masto and porca on this project (see README). Idempotent.

begin;

update mythos.settings
   set capacity_seats     = 28,
       turn_minutes_small = 90,
       turn_minutes_large = 90,
       updated_at         = now();

delete from mythos.service_windows;

insert into mythos.service_windows (dow, service, opens, last_seating, slot_minutes, active)
select d, s.service, s.opens, s.last_seating, 15, true
  from generate_series(0, 6) as d
 cross join (values ('pranzo', time '12:45', time '15:30'),
                    ('cena',   time '19:00', time '22:30')) as s(service, opens, last_seating)
 where d <> 1;   -- 1 = Monday, closed

commit;
