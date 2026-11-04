/**
 * Postgres access for the Mythos functions.
 *
 * The `mythos` schema is NOT exposed through PostgREST and the `anon` /
 * `authenticated` roles have zero privileges on it — this database is shared
 * with other clients. So we never touch supabase-js for data: we open a direct
 * Postgres connection and call the `mythos.*` functions by name.
 *
 * The connection string is read from MYTHOS_DB_URL first (so a pooler URL can
 * be supplied explicitly) and falls back to the platform-injected
 * SUPABASE_DB_URL. It is never logged and never returned.
 */

import postgres from 'https://deno.land/x/postgresjs@v3.4.5/mod.js';

/**
 * The slice of the postgres.js client we actually use.
 * Declared structurally so nothing in this codebase depends on `any`.
 */
export interface SqlClient {
  <T extends readonly unknown[] = readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
  /**
   * Bind a value as a json parameter. Required for anything jsonb:
   * `${JSON.stringify(x)}::jsonb` makes the driver encode it a second time, so
   * the function receives a jsonb *string* and every jsonb_typeof guard fires
   * (settings -> bad_patch, windows -> bad_rows). Same trap MASTO hit.
   */
  json(value: unknown): unknown;
}

let client: SqlClient | null = null;

function connectionString(): string {
  const url = Deno.env.get('MYTHOS_DB_URL') ?? Deno.env.get('SUPABASE_DB_URL');
  if (!url) {
    // Name only — the value must never reach a log line.
    throw new Error('missing connection string: set MYTHOS_DB_URL or SUPABASE_DB_URL');
  }
  return url;
}

/**
 * Lazily created singleton. Edge function instances are reused between
 * invocations, so the small pool is kept warm rather than reopened per request.
 */
export function db(): SqlClient {
  if (client === null) {
    client = postgres(connectionString(), {
      prepare: false, // required when going through the transaction pooler
      max: 3,
      idle_timeout: 20,
    }) as unknown as SqlClient;
  }
  return client;
}
