# Mythos Cucina Greca — project status

Last updated 2026-11-05. **Live in production** on <https://tavernamythos.com>.

## What is live

| Piece | Where |
|---|---|
| Site (home, menu, booking, privacy) | `docs/`, Netlify site `tavernamythos`, domain on IONOS DNS |
| Staff console | `docs/admin.html` + `docs/assets/js/admin.js` |
| Booking engine | Supabase schema `mythos` (shared x3ro project), Edge Functions `mythos-availability` / `-book` / `-cancel` / `-admin` |
| Booking e-mails | Resend, domain `tavernamythos.com` verified, sender `prenotazioni@tavernamythos.com` |
| Anti-bot | Cloudflare Turnstile on `prenota.html` |

Booking rules: 28 covers, 90-minute turns, Tue–Sun, lunch seatings 12:45–15:30 and
dinner 19:00–22:30, closed Monday. Parties 1–6 are confirmed at once; 7–20 arrive as
`pending` requests the staff approve or refuse in the console; above 20 is a phone call.
E-mail is required online. Staff can add phone / walk-in bookings from the console.

## Deploy

- **Site:** Netlify is not git-linked. From the repo root:
  `git archive HEAD docs | tar -x -C <stage>` then
  `netlify deploy --prod --site 7b00a2bf-e2b7-4085-a815-c8eb85094cfe --dir <stage>/docs`.
- **Functions:** `supabase functions deploy <name> --no-verify-jwt`.
- **Database:** the migration ledger is shared with other projects. Apply SQL with
  `supabase db query --linked -f supabase/migrations/<file>.sql`, never `db push`, and
  never run the `migration repair` the CLI suggests.
- **Order when a change spans both:** site first if the new page also works with the
  old functions; functions first otherwise. Turnstile: site key before secret.
- Every secret name is `MYTHOS_`-prefixed (the Supabase project is shared): see
  `supabase/functions/README.md`.

## Checks

- `node tools/verify.mjs` with `docs/` served on port 3000: 4 pages × 5 widths.
- Turnstile only accepts the production hostnames, so the real booking form can only be
  tested by a person on tavernamythos.com.

## Handover guide

`bash tools/guida/build-guida.sh` builds `deliverables/MYTHOS-guida-completa.pdf`
(owner, with credentials) and `MYTHOS-guida-staff.pdf`. `deliverables/` is gitignored
because it holds the console password.

## Open

- Owner: change the restaurant Gmail password; Google Business Profile website +
  booking link; own photos to replace the provisional ones; the menu prices still
  blank; confirm the postcode.
- Resend key in use has full access: swap for a sending-only key.
- Optional: an English version of the booking e-mails.
