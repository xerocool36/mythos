/**
 * CORS for the Mythos reservation endpoints.
 *
 * Allowlist only — never `*`. The matched origin is echoed back verbatim;
 * an unmatched origin receives NO CORS headers at all (and is refused), so a
 * random site cannot read a response even if it manages to issue the request.
 *
 * Extra origins come from the optional MYTHOS_ALLOWED_ORIGINS env var as a
 * comma-separated list.
 *
 * github.io stays only until tavernamythos.com is serving: an origin is a whole
 * host, so it also opens these endpoints to every other Pages site on that
 * account. Remove it at cutover.
 */

const STATIC_ORIGINS: readonly string[] = [
  'https://tavernamythos.com',
  'https://www.tavernamythos.com',
  'https://xerocool36.github.io',
  // Local preview ports: python http.server / `npx serve` (3000), Vite (5173), misc (8080).
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const ALLOW_HEADERS = 'authorization, apikey, content-type, x-client-info';
const ALLOW_METHODS = 'POST, OPTIONS';
const MAX_AGE_SECONDS = '86400';

export interface CorsDecision {
  /** The matched origin, or null when the request had none / an unknown one. */
  readonly origin: string | null;
  /** CORS headers to merge into every response. Empty when there is no match. */
  readonly headers: Record<string, string>;
  /** True when an Origin header was present but is not on the allowlist. */
  readonly rejected: boolean;
}

/** Static allowlist plus anything configured in MYTHOS_ALLOWED_ORIGINS. */
export function allowedOrigins(): readonly string[] {
  const extra = (Deno.env.get('MYTHOS_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => value.length > 0);
  return [...STATIC_ORIGINS, ...extra];
}

function headersFor(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Max-Age': MAX_AGE_SECONDS,
    'Vary': 'Origin',
  };
}

/**
 * Classify the request's Origin.
 *
 * No Origin header at all (curl, server-to-server, some health checks) is not
 * treated as a rejection: there is no browser to protect, so the request runs
 * and simply gets no CORS headers back.
 */
export function evaluateCors(req: Request): CorsDecision {
  const raw = req.headers.get('origin');
  if (!raw) return { origin: null, headers: {}, rejected: false };

  const origin = raw.trim().replace(/\/+$/, '');
  if (!allowedOrigins().includes(origin)) {
    return { origin: null, headers: {}, rejected: true };
  }
  return { origin, headers: headersFor(origin), rejected: false };
}

/** Response for an OPTIONS preflight. 204 when allowed, bare 403 otherwise. */
export function preflightResponse(decision: CorsDecision): Response {
  if (decision.rejected || !decision.origin) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: decision.headers });
}
