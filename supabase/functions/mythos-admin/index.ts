/**
 * mythos-admin — the restaurant's back-office endpoint.
 *
 * Declared with verify_jwt = false in config.toml, but authentication is
 * enforced here in code: a Supabase user JWT is required, it is verified with
 * supabase-js, and the user id must pass mythos.is_admin(). supabase-js is used
 * for that check only — never for data, because the `mythos` schema is not
 * exposed through PostgREST.
 *
 * POST { action, ... }
 *   day         { from?: date, to?: date }        -> mythos.admin_day()
 *   set_status  { id: uuid, status: text }        -> mythos.admin_set_status()
 *   block       { date: date, note?, on? }        -> mythos.admin_block()
 *   settings    { patch: object }                 -> mythos.admin_settings()
 *   windows     { rows: array }                   -> mythos.admin_windows()
 * Anything else is a 400. There is no default branch that acts.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { evaluateCors, preflightResponse } from '../_shared/cors.ts';
import { db } from '../_shared/db.ts';
import {
  asString,
  describeError,
  fail,
  isIsoDate,
  json,
  readJsonBody,
  romeToday,
  runBackground,
  sendGuestEmail,
} from '../_shared/util.ts';
import { type BookingMailInput, guestConfirmation, guestRefusal } from '../_shared/booking-mail.ts';

const LABEL = 'mythos-admin';
const MAX_BODY_BYTES = 32_768;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdminAction = 'day' | 'pending' | 'set_status' | 'block' | 'settings' | 'windows';

const ACTIONS: ReadonlySet<string> = new Set<AdminAction>([
  'day',
  'pending',
  'set_status',
  'block',
  'settings',
  'windows',
]);

interface SetStatusResult {
  ok: boolean;
  changed?: boolean;
  status?: string;
  previous?: string;
  guest?: {
    code: string;
    name: string;
    phone: string;
    email: string | null;
    party: number;
    service: string;
    starts_at: string;
    phone_tail: string;
    notes: string | null;
  };
}

/**
 * A group request answered from the console: approval sends the normal
 * confirmation, refusal sends the refusal. Nothing else mails the guest from
 * here — moving a table to "seated" or "no-show" is staff bookkeeping.
 */
function mailAnswer(r: SetStatusResult): void {
  const g = r.guest;
  if (!r.ok || !r.changed || r.previous !== 'pending' || !g?.email) return;
  const build = r.status === 'confirmed' ? guestConfirmation : r.status === 'refused' ? guestRefusal : null;
  if (!build) return;
  const mail: BookingMailInput = {
    name: g.name,
    code: g.code,
    party: g.party,
    startsAt: g.starts_at,
    service: g.service,
    phone: g.phone,
    email: g.email,
    phoneTail: g.phone_tail,
    notes: g.notes,
  };
  const to = g.email;
  runBackground(
    sendGuestEmail(to, build(mail), LABEL).catch((error) => {
      console.error(`[${LABEL}] guest e-mail failed: ${describeError(error)}`);
    }),
    LABEL,
  );
}

/** Resolve the caller's user id from the bearer token, or null. */
async function authenticate(req: Request): Promise<string | null> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) {
    throw new Error('missing SUPABASE_URL or SUPABASE_ANON_KEY');
  }

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = evaluateCors(req);
  if (req.method === 'OPTIONS') return preflightResponse(cors);
  if (cors.rejected) return fail('origin_not_allowed', 403);
  if (req.method !== 'POST') return fail('method_not_allowed', 405, cors.headers);

  let userId: string | null;
  try {
    userId = await authenticate(req);
  } catch (error) {
    console.error(`[${LABEL}] auth setup failed: ${describeError(error)}`);
    return fail('server_error', 500, cors.headers);
  }
  if (!userId) return fail('unauthorized', 401, cors.headers);

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return fail(parsed.slug, parsed.slug === 'payload_too_large' ? 413 : 400, cors.headers);
  }
  const body = parsed.body;

  try {
    const sql = db();

    const adminRows = await sql<{ ok: boolean }[]>`
      select mythos.is_admin(${userId}::uuid) as ok
    `;
    if (adminRows[0]?.ok !== true) {
      console.warn(`[${LABEL}] non-admin user rejected`);
      return fail('forbidden', 403, cors.headers);
    }

    const action = asString(body.action);
    if (!ACTIONS.has(action)) return fail('unknown_action', 400, cors.headers);

    switch (action) {
      case 'day': {
        const from = isIsoDate(body.from) ? body.from : romeToday();
        const to = isIsoDate(body.to) ? body.to : from;
        const rows = await sql<{ data: unknown }[]>`
          select mythos.admin_day(${from}::date, ${to}::date) as data
        `;
        return json({ ok: true, action, data: rows[0]?.data ?? null }, 200, cors.headers);
      }

      case 'set_status': {
        const id = asString(body.id);
        const status = asString(body.status);
        if (!UUID_SHAPE.test(id)) return fail('invalid_body', 400, cors.headers, { field: 'id' });
        if (status.length < 2 || status.length > 32) {
          return fail('invalid_body', 400, cors.headers, { field: 'status' });
        }
        const rows = await sql<{ data: SetStatusResult }[]>`
          select mythos.admin_set_status(${id}::uuid, ${status}::text) as data
        `;
        const data = rows[0]?.data ?? null;
        if (data) mailAnswer(data);
        // The guest block exists for the mail only; the console already has the row.
        const { guest: _guest, ...visible } = data ?? { ok: false };
        return json({ ok: true, action, data: data ? visible : null }, 200, cors.headers);
      }

      case 'pending': {
        const rows = await sql<{ data: unknown }[]>`select mythos.admin_pending() as data`;
        return json({ ok: true, action, data: rows[0]?.data ?? null }, 200, cors.headers);
      }

      case 'block': {
        if (!isIsoDate(body.date)) {
          return fail('invalid_body', 400, cors.headers, { field: 'date' });
        }
        const note = asString(body.note);
        if (note.length > 200) return fail('invalid_body', 400, cors.headers, { field: 'note' });
        const on = body.on === undefined ? true : body.on === true;
        const rows = await sql<{ data: unknown }[]>`
          select mythos.admin_block(${body.date}::date, ${note || null}::text, ${on}::boolean) as data
        `;
        return json({ ok: true, action, data: rows[0]?.data ?? null }, 200, cors.headers);
      }

      case 'settings': {
        const patch = body.patch;
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          return fail('invalid_body', 400, cors.headers, { field: 'patch' });
        }
        const rows = await sql<{ data: unknown }[]>`
          select mythos.admin_settings(${sql.json(patch)}::jsonb) as data
        `;
        return json({ ok: true, action, data: rows[0]?.data ?? null }, 200, cors.headers);
      }

      case 'windows': {
        const windowRows = body.rows;
        if (!Array.isArray(windowRows)) {
          return fail('invalid_body', 400, cors.headers, { field: 'rows' });
        }
        const rows = await sql<{ data: unknown }[]>`
          select mythos.admin_windows(${sql.json(windowRows)}::jsonb) as data
        `;
        return json({ ok: true, action, data: rows[0]?.data ?? null }, 200, cors.headers);
      }

      // No default that acts: anything unrecognised is refused outright.
      default:
        return fail('unknown_action', 400, cors.headers);
    }
  } catch (error) {
    console.error(`[${LABEL}] ${describeError(error)}`);
    return fail('server_error', 500, cors.headers);
  }
});
