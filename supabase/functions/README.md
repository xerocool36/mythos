# Mythos — Supabase Edge Functions

Reservation backend for **Mythos Cucina Greca**, Via Tuscolana 596, Roma.
Timezone `Europe/Rome`, 30 seats, no overbooking — capacity is decided inside
the database, never here.

```
_shared/cors.ts        origin allowlist + preflight
_shared/db.ts          postgres.js singleton (direct Postgres, NOT PostgREST)
_shared/util.ts        json(), clientIp(), sha256Hex(), Italian error messages, Resend
mythos-availability/   public  — slot map for the widget
mythos-book/           public  — creates a reservation (security-critical)
mythos-cancel/         public  — guest self-service cancellation
mythos-admin/          private — back office, auth enforced in code
```

## Why there is no supabase-js data access

This is a **shared** Supabase project holding other clients' data. Everything for
Mythos lives in schema `mythos`, `anon` / `authenticated` have zero privileges
there, and `mythos` is deliberately **not** in the PostgREST exposed-schemas
list. So the functions open a direct Postgres connection with `postgres.js` and
call the `mythos.*` functions by name. `supabase-js` appears only in
`mythos-admin`, only to verify the caller's JWT.

Connection string: `MYTHOS_DB_URL` if set (use this to pin the transaction
pooler), otherwise the platform-injected `SUPABASE_DB_URL`. `prepare: false` is
required behind the pooler.

## Secrets

Names only — never commit a value, never print one in a log.

```bash
supabase secrets set MYTHOS_DB_URL="postgres://USER:PASSWORD@HOST:6543/postgres"
supabase secrets set TURNSTILE_SECRET="0x0000000000000000000000000000000000000000"
supabase secrets set RESEND_API_KEY="re_xxxxxxxxxxxxxxxxxxxxxxxx"
supabase secrets set MYTHOS_NOTIFY_EMAIL="owner@example.com,manager@example.com"
supabase secrets set MYTHOS_IP_SALT="<32+ random chars, e.g. openssl rand -hex 24>"
supabase secrets set MYTHOS_ALLOWED_ORIGINS="https://mythoscucinagreca.it,https://www.mythoscucinagreca.it"
```

| Name | Required | Used by | If missing |
|---|---|---|---|
| `MYTHOS_DB_URL` | optional | all | falls back to `SUPABASE_DB_URL` |
| `SUPABASE_DB_URL` | injected | all | function returns `server_error` |
| `SUPABASE_URL` | injected | admin | admin returns `server_error` |
| `SUPABASE_ANON_KEY` | injected | admin | admin returns `server_error` |
| `TURNSTILE_SECRET` | **yes in prod** | book | CAPTCHA skipped + loud log warning |
| `RESEND_API_KEY` | yes | book, cancel | owner e-mail skipped silently |
| `MYTHOS_NOTIFY_EMAIL` | yes | book, cancel | owner e-mail skipped silently |
| `MYTHOS_IP_SALT` | **yes in prod** | all | rate-limit keys are unsalted + warning |
| `MYTHOS_ALLOWED_ORIGINS` | optional | all | only the built-in origins (GitHub Pages + local dev ports) are allowed |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_DB_URL` are injected by the
platform — do not set them by hand.

## Deploy

`verify_jwt` must be **false** for all four functions: the three public ones are
called by anonymous visitors, and `mythos-admin` does its own, stricter check in
code. Add this to `supabase/config.toml` (owned outside this folder):

```toml
[functions.mythos-availability]
verify_jwt = false
[functions.mythos-book]
verify_jwt = false
[functions.mythos-cancel]
verify_jwt = false
[functions.mythos-admin]
verify_jwt = false
```

```bash
supabase functions deploy mythos-availability --project-ref <REF>
supabase functions deploy mythos-book         --project-ref <REF>
supabase functions deploy mythos-cancel       --project-ref <REF>
supabase functions deploy mythos-admin        --project-ref <REF>
```

Pre-flight checklist:

1. `deno task check` (from `supabase/functions/`) — type-checks all four entry points.
2. Secrets set, above all `TURNSTILE_SECRET` and `MYTHOS_IP_SALT`.
3. Production origin added to `MYTHOS_ALLOWED_ORIGINS` before the domain goes live.
4. `prenotazioni@x3roautomations.it` verified as a Resend sender.
5. Smoke test: availability → book → owner e-mail arrives → cancel.

Local: `supabase functions serve --no-verify-jwt`, with the same names in
`supabase/.env.local`. Without `TURNSTILE_SECRET` the CAPTCHA step is skipped and
says so in the log on every request.

## Endpoints

All endpoints are `POST`, all responses are JSON, all errors carry an Italian
`message`. CORS is an allowlist: `https://xerocool36.github.io`, plus
`localhost` and `127.0.0.1` on ports 8000, 3000 (`npx serve`), 5173 (Vite) and
8080, plus anything in `MYTHOS_ALLOWED_ORIGINS`. An unlisted origin gets a bare
403 with no CORS headers.

### `POST /mythos-availability`

```jsonc
// request — every field optional
{ "party": 4, "from": "2026-08-01", "to": "2026-09-15" }
```

`party` is clamped to 1..20 (default 2), `from` defaults to today in Rome, `to`
to `from + 45 days`, and the window is capped at 60 days. The body is the
`mythos.availability()` payload verbatim:

```jsonc
{
  "rome_now": "2026-08-01T18:22:41+02:00",
  "rome_today": "2026-08-01",
  "capacity": 30, "max_party": 20, "accepting": true, "turn_minutes": 90, "party": 4,
  "days": [
    { "date": "2026-08-01", "dow": 6, "closed": false, "note": null,
      "services": [ { "service": "cena", "slots": [ { "time": "19:30", "remaining": 12, "ok": true } ] } ] }
  ]
}
```

`Cache-Control: public, max-age=20`. Rate limit 120/hour and 600/day per IP → `429`.
On failure: `{ "ok": false, "error": "server_error", "message": "…" }` — a
successful response has no `ok` field, so branch on `days`.

### `POST /mythos-book`

```jsonc
{
  "party": 4,                    // int 1..20, required
  "date": "2026-08-09",          // YYYY-MM-DD, required
  "time": "20:00",               // HH:MM, required
  "name": "Mario Rossi",         // 2..80
  "phone": "+39 333 123 4567",   // 6..32 chars, >= 6 digits
  "email": "mario@example.com",  // optional, <= 120
  "notes": "tavolo tranquillo",  // optional, <= 400
  "consent": true,               // must be exactly true
  "token": "<turnstile token>",  // required in production
  "company": ""                  // honeypot: hidden field, must stay empty
}
```

Body cap 8 KB. Success (`200`):

```jsonc
{ "ok": true, "code": "M7K2QD", "starts_at": "2026-08-09T18:00:00Z",
  "ends_at": "2026-08-09T19:30:00Z", "service": "cena", "party": 4, "phone_tail": "4567" }
```

Failure — the Italian `message` comes straight from the database:

| HTTP | `error` |
|---|---|
| 400 | `invalid_body` (with `field`), `consent_required`, `not_accepting`, `closed`, `no_such_slot`, `too_late`, `too_far`, `party_too_large` |
| 403 | `captcha_failed`, `origin_not_allowed` |
| 409 | `full`, `duplicate` |
| 413 | `payload_too_large` |
| 429 | `rate_limited` (5/hour and 20/day per IP, `Retry-After` set) |
| 500 | `server_error` |

Notes for the frontend:

- Render the hidden `company` input off-screen and never autofill it. A filled
  honeypot returns a normal-looking `ok:true` with a throwaway code and writes
  nothing — that reply is intentionally indistinguishable from a real one.
- Turnstile failure is fail-closed, including on network timeout.
- The owner e-mail is sent after the response is committed; a mail outage can
  never turn a confirmed booking into an error.

### `POST /mythos-cancel`

```jsonc
{ "code": "M7K2QD", "phone_tail": "4567" }
```

`200` → `{ "ok": true, "freed": 4 }`.
`404` → `{ "ok": false, "error": "not_found", "message": "…" }` — identical for an
unknown code and a wrong tail, so existence of a code is never revealed.
`429` after 10/hour or 40/day per IP. `400` `invalid_body` for a malformed code.

### `POST /mythos-admin`

Requires `Authorization: Bearer <supabase user JWT>`; the user must pass
`mythos.is_admin()`. `401` without a valid token, `403` for a non-admin — nothing
else leaks.

```jsonc
{ "action": "day",        "from": "2026-08-01", "to": "2026-08-07" }
{ "action": "set_status", "id": "<uuid>", "status": "seated" }
{ "action": "block",      "date": "2026-08-15", "note": "Ferragosto", "on": true }
{ "action": "settings",   "patch": { "accepting": false } }
{ "action": "windows",    "rows": [ { "dow": 5, "service": "cena", "from": "19:00", "to": "22:30" } ] }
```

Success: `{ "ok": true, "action": "day", "data": <jsonb from the SQL function> }`.
Unknown action → `400 unknown_action`. There is no default branch that acts.

## Conventions worth keeping

- **Rate limiting.** `mythos.rate_hit(p_ip_hash, p_max_hour, p_max_day)` returns
  true when the call is ALLOWED. Both numbers are caps — calls in the current
  hour and across a rolling 24 hours; there is no window argument, the function
  buckets hourly and sums the last 24 buckets. Availability 120/600, book 5/20,
  cancel 10/40. Keep the daily cap above the hourly one or the daily figure
  silently becomes the real limit. The key is `sha256(ip + MYTHOS_IP_SALT)`;
  availability and cancel prefix a scope so one endpoint cannot exhaust
  another's budget. Raw IPs are never stored or logged — logs carry the first
  12 hex chars of the hash only.
- **Errors.** A Postgres message never reaches the client. It is logged, and the
  caller gets `{ok:false,error:'server_error'}` with a generic Italian message.
- **Dates.** Anything shown to a human is produced with
  `Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', … })` applied to the
  instant returned by the database. Never slice a timestamp string.
- **Outbound calls.** Turnstile and Resend both run with a 5 s timeout.
- **Logs.** No secret, no raw IP, no guest name, phone or e-mail. Booking codes
  are logged because the owner needs them for support.

## One assumption to confirm with the SQL owner

`mythos.book()` takes eight arguments; seven map to the form
(party, date, time, name, phone, email, notes). The eighth `text` is passed as
the booking channel, the constant `BOOKING_SOURCE = 'web'` in
`mythos-book/index.ts`. If that parameter is meant to be something else (a hashed
IP, a locale, a user agent), change that one constant — nothing else depends on it.
