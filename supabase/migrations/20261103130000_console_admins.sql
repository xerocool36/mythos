-- Staff console accounts, 2026-11-03.
--
--   mythos.tuscolana@gmail.com  the restaurant (owner-supplied address)
--   x3roautomations@gmail.com   x3ro maintenance, same account MASTO uses
--
-- The restaurant's auth user was created through the public signup endpoint, so
-- it arrives unconfirmed and cannot sign in until confirmed here: this project
-- sends no auth mail (Resend is wired to the booking functions only).
-- Only email_confirmed_at: auth.users.confirmed_at is a generated column.
-- Applied with `supabase db query --linked` (shared migration ledger). Idempotent.

update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, now())
 where email = 'mythos.tuscolana@gmail.com';

insert into mythos.admins (user_id, email)
select id, email from auth.users
 where email in ('mythos.tuscolana@gmail.com', 'x3roautomations@gmail.com')
on conflict (user_id) do nothing;
