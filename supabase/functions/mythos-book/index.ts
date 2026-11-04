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
 *   7. owner notification + guest confirmation, which can never fail the booking
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
  fail,
  fetchWithTimeout,
  ipTag,
  isHhMm,
  isIsoDate,
  json,
  MESSAGES,
  rateKey,
  readJsonBody,
  runBackground,
  sendGuestEmail,
  sendOwnerEmail,
} from '../_shared/util.ts';
import {
  type BookingMailInput,
  guestConfirmation,
  guestRequestReceived,
  ownerNewBooking,
  ownerRequest,
} from '../_shared/booking-mail.ts';

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
  /** 'pending' for groups above settings.max_party: a request, not a table yet. */
  status: 'confirmed' | 'pending';
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

  // Required since 2026-11-04: the confirmation, the cancel link and every
  // reply about a group request travel by e-mail.
  const email = asString(body.email);
  if (email.length < 5 || email.length > 120 || !EMAIL_SHAPE.test(email)) {
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
 * With MYTHOS_TURNSTILE_SECRET unset the check is skipped so local development works —
 * that path logs loudly, because in production it is a hole.
 */
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = Deno.env.get('MYTHOS_TURNSTILE_SECRET');
  if (!secret) {
    console.warn(
      `[${LABEL}] MYTHOS_TURNSTILE_SECRET is not set — CAPTCHA verification is DISABLED. ` +
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
      status: 'confirmed',
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
      `[${LABEL}] ${result.status} code=${result.code} party=${result.party} service=${result.service}`,
    );

    // 7 — notify the owner and the guest without ever risking the confirmed booking
    const isRequest = result.status === 'pending';
    const mail: BookingMailInput = {
      name: input.name,
      code: result.code,
      party: result.party,
      startsAt: result.starts_at,
      service: result.service,
      phone: input.phone,
      email: input.email || null,
      phoneTail: result.phone_tail,
      notes: input.notes || null,
    };
    runBackground(
      (async () => {
        try {
          await sendOwnerEmail(isRequest ? ownerRequest(mail) : ownerNewBooking(mail), LABEL);
        } catch (error) {
          console.error(`[${LABEL}] owner e-mail failed: ${describeError(error)}`);
        }
        if (!input.email) return;
        try {
          await sendGuestEmail(
            input.email,
            isRequest ? guestRequestReceived(mail) : guestConfirmation(mail),
            LABEL,
          );
        } catch (error) {
          console.error(`[${LABEL}] guest e-mail failed: ${describeError(error)}`);
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
