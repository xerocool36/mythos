/**
 * mythos-book — creates a reservation. This is the security-critical endpoint.
 *
 * Order of operations, and the order matters:
 *   1. CORS allowlist check
 *   2. body size cap + hard field validation
 *   3. honeypot (`company`) — fake success, nothing written
 *   4. Cloudflare Turnstile verification
 *   5. per-IP rate limit through mythos.rate_hit()
 *   6. mythos.book() — the single source of truth for capacity
 *   7. owner notification, which can never fail the booking
 *
 * Overbooking is prevented inside the database function, not here.
 *
 * Deployed with verify_jwt = false.
 */

import { evaluateCors, preflightResponse } from '../_shared/cors.ts';
import { db } from '../_shared/db.ts';
import {
  asInt,
  asString,
  clientIp,
  describeError,
  escapeHtml,
  fail,
  fetchWithTimeout,
  ipTag,
  isHhMm,
  isIsoDate,
  json,
  MESSAGES,
  rateKey,
  readJsonBody,
  romeDateLabel,
  romeTimeLabel,
  runBackground,
  sendOwnerEmail,
} from '../_shared/util.ts';

const LABEL = 'mythos-book';
const MAX_BODY_BYTES = 8192;

/**
 * Rate limit per hashed IP. mythos.rate_hit(ip_hash, max_hour, max_day) — both
 * numbers are caps: booking attempts in the current hour and across a rolling
 * 24 hours. These are the function's own defaults, passed explicitly.
 */
const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 20;

/**
 * 8th text argument of mythos.book(): the channel the reservation came from.
 * Kept as a named constant so the SQL owner can see exactly what the web
 * widget records.
 */
const BOOKING_SOURCE = 'web';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface BookingInput {
  party: number;
  date: string;
  time: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  token: string;
}

export type BookErrorSlug =
  | 'not_accepting'
  | 'closed'
  | 'no_such_slot'
  | 'too_late'
  | 'too_far'
  | 'party_too_large'
  | 'duplicate'
  | 'full';

export interface BookSuccess {
  ok: true;
  code: string;
  starts_at: string;
  ends_at: string;
  service: string;
  party: number;
  phone_tail: string;
}

export interface BookFailure {
  ok: false;
  error: BookErrorSlug;
  message: string;
}

export type BookResult = BookSuccess | BookFailure;

/** Slugs that mean "the slot is gone", i.e. a conflict rather than bad input. */
const CONFLICT_SLUGS: ReadonlySet<string> = new Set(['full', 'duplicate']);

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

type Validation =
  | { ok: true; value: BookingInput }
  | { ok: false; field: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate(body: Record<string, unknown>): Validation {
  const party = asInt(body.party);
  if (party === null || party < 1 || party > 20) return { ok: false, field: 'party' };

  if (!isIsoDate(body.date)) return { ok: false, field: 'date' };
  if (!isHhMm(body.time)) return { ok: false, field: 'time' };

  const name = asString(body.name);
  if (name.length < 2 || name.length > 80) return { ok: false, field: 'name' };

  const phone = asString(body.phone);
  const digits = phone.replace(/\D/g, '').length;
  if (phone.length < 6 || phone.length > 32 || digits < 6) return { ok: false, field: 'phone' };

  const email = asString(body.email);
  if (email.length > 0 && (email.length > 120 || !EMAIL_SHAPE.test(email))) {
    return { ok: false, field: 'email' };
  }

  const notes = asString(body.notes);
  if (notes.length > 400) return { ok: false, field: 'notes' };

  if (body.consent !== true) return { ok: false, field: 'consent' };

  return {
    ok: true,
    value: {
      party,
      date: body.date,
      time: body.time,
      name,
      phone,
      email,
      notes,
      token: asString(body.token),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Bot defences                                                                */
/* -------------------------------------------------------------------------- */

/** True when the hidden `company` field was filled in — i.e. a bot. */
function honeypotTripped(body: Record<string, unknown>): boolean {
  const value = body.company;
  if (value === undefined || value === null) return false;
  return asString(value).length > 0;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A plausible-looking code for the honeypot reply. Never touches the database. */
function decoyCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

/**
 * Verify the Turnstile token. Fails closed on a network error or a bad token.
 * With TURNSTILE_SECRET unset the check is skipped so local development works —
 * that path logs loudly, because in production it is a hole.
 */
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = Deno.env.get('TURNSTILE_SECRET');
  if (!secret) {
    console.warn(
      `[${LABEL}] TURNSTILE_SECRET is not set — CAPTCHA verification is DISABLED. ` +
        'This is acceptable only in local development.',
    );
    return true;
  }
  if (!token) return false;

  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);

  try {
    const response = await fetchWithTimeout(
      TURNSTILE_VERIFY_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(), // contains the secret — never log this
      },
      5000,
    );
    if (!response.ok) {
      console.error(`[${LABEL}] turnstile http ${response.status}`);
      return false;
    }
    const outcome = await response.json() as { success?: boolean; 'error-codes'?: string[] };
    if (outcome.success !== true) {
      console.warn(`[${LABEL}] turnstile rejected: ${(outcome['error-codes'] ?? []).join(',')}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[${LABEL}] turnstile verify failed: ${describeError(error)}`);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Owner notification                                                          */
/* -------------------------------------------------------------------------- */

function buildOwnerEmail(booking: BookSuccess, input: BookingInput) {
  const startsAt = new Date(booking.starts_at);
  const dateLabel = romeDateLabel(startsAt);
  const timeLabel = romeTimeLabel(startsAt);

  const name = escapeHtml(input.name);
  const phone = escapeHtml(input.phone);
  const telHref = escapeHtml(input.phone.replace(/[^\d+]/g, ''));
  const email = input.email ? escapeHtml(input.email) : '—';
  const notes = input.notes ? escapeHtml(input.notes) : '—';
  const service = escapeHtml(booking.service);

  const subject =
    `Nuova prenotazione · ${dateLabel} ${timeLabel} · ${booking.party} pax · ${input.name}`;

  const text = [
    'NUOVA PRENOTAZIONE — Mythos Cucina Greca',
    '',
    `Data:      ${dateLabel}`,
    `Ora:       ${timeLabel} (${booking.service})`,
    `Coperti:   ${booking.party}`,
    `Nome:      ${input.name}`,
    `Telefono:  ${input.phone}`,
    `Email:     ${input.email || '—'}`,
    `Note:      ${input.notes || '—'}`,
    '',
    `Codice prenotazione: ${booking.code}`,
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1b1b1b;line-height:1.55">
      <h2 style="margin:0 0 4px;font-size:18px">Nuova prenotazione</h2>
      <p style="margin:0 0 16px;color:#666">Mythos Cucina Greca — Via Tuscolana 596, Roma</p>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr><td style="padding:3px 14px 3px 0;color:#666">Data</td><td style="padding:3px 0"><strong>${
    escapeHtml(dateLabel)
  }</strong></td></tr>
        <tr><td style="padding:3px 14px 3px 0;color:#666">Ora</td><td style="padding:3px 0"><strong>${timeLabel}</strong> (${service})</td></tr>
        <tr><td style="padding:3px 14px 3px 0;color:#666">Coperti</td><td style="padding:3px 0"><strong>${booking.party}</strong></td></tr>
        <tr><td style="padding:3px 14px 3px 0;color:#666">Nome</td><td style="padding:3px 0">${name}</td></tr>
        <tr><td style="padding:3px 14px 3px 0;color:#666">Telefono</td><td style="padding:3px 0"><a href="tel:${telHref}">${phone}</a></td></tr>
        <tr><td style="padding:3px 14px 3px 0;color:#666">Email</td><td style="padding:3px 0">${email}</td></tr>
        <tr><td style="padding:3px 14px 3px 0;color:#666">Note</td><td style="padding:3px 0">${notes}</td></tr>
        <tr><td style="padding:3px 14px 3px 0;color:#666">Codice</td><td style="padding:3px 0"><code>${
    escapeHtml(booking.code)
  }</code></td></tr>
      </table>
    </div>`;

  return { subject, text, html, replyTo: input.email || undefined };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

Deno.serve(async (req: Request): Promise<Response> => {
  // 1 — CORS
  const cors = evaluateCors(req);
  if (req.method === 'OPTIONS') return preflightResponse(cors);
  if (cors.rejected) return fail('origin_not_allowed', 403);
  if (req.method !== 'POST') return fail('method_not_allowed', 405, cors.headers);

  // 2 — body + validation
  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return fail(parsed.slug, parsed.slug === 'payload_too_large' ? 413 : 400, cors.headers);
  }

  const ip = clientIp(req);

  // 3 — honeypot: answer like a success so the bot learns nothing, write nothing.
  if (honeypotTripped(parsed.body)) {
    const key = await rateKey(ip, 'honeypot').catch(() => 'unhashed');
    console.warn(`[${LABEL}] honeypot tripped ip=${ipTag(key)} — no database write`);
    const now = new Date();
    return json({
      ok: true,
      code: decoyCode(),
      starts_at: now.toISOString(),
      ends_at: new Date(now.getTime() + 90 * 60_000).toISOString(),
      service: 'cena',
      party: 2,
      phone_tail: '0000',
    }, 200, cors.headers);
  }

  const check = validate(parsed.body);
  if (!check.ok) {
    if (check.field === 'consent') return fail('consent_required', 400, cors.headers);
    return fail('invalid_body', 400, cors.headers, { field: check.field });
  }
  const input = check.value;

  // 4 — Turnstile
  if (!await verifyTurnstile(input.token, ip)) {
    return fail('captcha_failed', 403, cors.headers);
  }

  try {
    const sql = db();

    // 5 — rate limit on the salted IP hash
    const key = await rateKey(ip);
    const gate = await sql<{ allowed: boolean }[]>`
      select mythos.rate_hit(${key}::text, ${MAX_PER_HOUR}::int, ${MAX_PER_DAY}::int) as allowed
    `;
    if (gate[0]?.allowed !== true) {
      console.warn(`[${LABEL}] rate limited ip=${ipTag(key)}`);
      return fail('rate_limited', 429, { ...cors.headers, 'Retry-After': '600' });
    }

    // 6 — the booking itself; capacity is enforced inside the function
    const rows = await sql<{ result: BookResult }[]>`
      select mythos.book(
        ${input.party}::int,
        ${input.date}::date,
        ${input.time}::time,
        ${input.name}::text,
        ${input.phone}::text,
        ${input.email || null}::text,
        ${input.notes || null}::text,
        ${BOOKING_SOURCE}::text
      ) as result
    `;
    const result = rows[0]?.result;
    if (!result) throw new Error('mythos.book() returned no row');

    if (result.ok === false) {
      const status = CONFLICT_SLUGS.has(result.error) ? 409 : 400;
      console.log(`[${LABEL}] refused: ${result.error} ip=${ipTag(key)}`);
      return json({
        ok: false,
        error: result.error,
        message: result.message || MESSAGES.server_error,
      }, status, cors.headers);
    }

    console.log(
      `[${LABEL}] confirmed code=${result.code} party=${result.party} service=${result.service}`,
    );

    // 7 — notify the owner without ever risking the confirmed booking
    runBackground(
      (async () => {
        try {
          await sendOwnerEmail(buildOwnerEmail(result, input), LABEL);
        } catch (error) {
          console.error(`[${LABEL}] owner e-mail failed: ${describeError(error)}`);
        }
      })(),
      LABEL,
    );

    return json(result, 200, cors.headers);
  } catch (error) {
    console.error(`[${LABEL}] ${describeError(error)}`);
    return fail('server_error', 500, cors.headers);
  }
});
