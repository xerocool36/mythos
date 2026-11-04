/* Mythos — console di servizio (area riservata)
 * ---------------------------------------------------------------------------
 * Vanilla ES module. No framework, no build step, no bundler.
 *
 * SECURITY MODEL — read before changing anything in here.
 *   Login is Supabase Auth (email + password). There is no PIN and there must
 *   never be one: a client-side PIN is decoration, not access control.
 *   This file holds ZERO authority. Every data call carries the user's access
 *   token to the `mythos-admin` Edge Function, which verifies the JWT and
 *   checks the caller against mythos.admins. A non-admin gets HTTP 403 — we
 *   sign them out and stop; we never retry and never render a half console.
 *   Nothing is stored by us: the SDK owns the session. No token is ever logged.
 *
 * TIMEZONE CONTRACT
 *   The restaurant's clock is Europe/Rome. The device clock is irrelevant.
 *     - Clock times come from the ISO instants the API returns (starts_at),
 *       formatted with Intl.DateTimeFormat('it-IT', {timeZone:'Europe/Rome'}).
 *     - `new Date("2026-08-08 20:00")` is FORBIDDEN — it parses in the browser's
 *       own zone and would show the owner the wrong service while travelling.
 *     - Calendar labels for a bare "YYYY-MM-DD" use a UTC-midnight instant
 *       formatted with timeZone:'UTC', which reads identically in every zone.
 *     - "Today" in Rome is derived by formatting the real instant `new Date()`
 *       into Europe/Rome, then reconciled against the server's `rome_now`.
 *
 * ERROR CONTRACT
 *   A raw Postgres or HTTP string never reaches the screen. The API's error
 *   slug is mapped to an Italian sentence written here; structured numbers
 *   (peak, capacity, party, existing_bookings) are re-rendered by us. Unknown
 *   slugs fall back to one generic Italian line.
 */

/* ========================================================== 0. bootstrap */

const CFG = window.MYTHOS_CONFIG || {};
const ROME = 'Europe/Rome';
const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm';

const $ = (sel, root = document) => root.querySelector(sel);
const elBoot = $('#boot');

function fatal(text) {
  elBoot.hidden = false;
  elBoot.replaceChildren(h('div', { class: 'login-box' },
    h('h1', { text: 'Mythos' }),
    h('p', { class: 'msg msg-err', role: 'alert', text }),
    h('p', { class: 'login-foot' },
      'Se il problema resta, chiama ', h('a', { href: 'tel:+390687774778', text: '06 8777 4778' }), '.')
  ));
}

function configReady() {
  for (const k of ['supabaseUrl', 'anonKey', 'functionsUrl']) {
    const v = CFG[k];
    if (typeof v !== 'string' || !v || v.includes('REPLACE_ME')) return false;
  }
  return true;
}

if (!configReady()) {
  fatal('Console non ancora configurata. Mancano i parametri di collegamento al server.');
  throw new Error('config');
}

let createClient;
try {
  ({ createClient } = await import(SUPABASE_ESM));
} catch {
  fatal('Non riesco a caricare la libreria di accesso. Controlla la connessione e ricarica la pagina.');
  throw new Error('sdk');
}

const sb = createClient(CFG.supabaseUrl, CFG.anonKey, {
  auth: {
    persistSession: true,          // the SDK owns the session; we never touch storage
    autoRefreshToken: true,
    detectSessionInUrl: false,     // no OAuth redirect flow here
    storageKey: 'mythos-admin-auth'
  }
});

const ENDPOINT = String(CFG.functionsUrl).replace(/\/+$/, '') + '/mythos-admin';
const AVAILABILITY = String(CFG.functionsUrl).replace(/\/+$/, '') + '/mythos-availability';

/* ============================================================ 1. helpers */

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;                 // all untrusted data goes here
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false || kid === '') continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const pad2 = (n) => String(n).padStart(2, '0');

function num(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/* --- dates -------------------------------------------------------------- */

// The Rome calendar date of a real instant. `new Date()` is an instant, so this
// is correct even if the device sits in another timezone.
function romeYmd(instant) {
  const parts = new Intl.DateTimeFormat('it-IT', {
    timeZone: ROME, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const y = get('year'), m = get('month'), d = get('day');
  return (y && m && d) ? `${y}-${m}-${d}` : null;
}

function romeToday() { return romeYmd(new Date()); }

// Calendar arithmetic in UTC: no DST, no local-zone drift.
function ymdShift(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function ymdUTC(ymd) {
  const p = String(ymd).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
}

const FMT_DAY_LONG = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
});
const FMT_DAY_SHORT = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short'
});
// Clock times always come from a real instant, rendered in Rome.
const FMT_TIME = new Intl.DateTimeFormat('it-IT', {
  timeZone: ROME, hour: '2-digit', minute: '2-digit', hour12: false
});

function dayLong(ymd) { return ymd ? FMT_DAY_LONG.format(ymdUTC(ymd)) : ''; }
function dayShort(ymd) { return ymd ? FMT_DAY_SHORT.format(ymdUTC(ymd)) : ''; }

function romeTime(iso, fallback) {
  if (iso) {
    const d = new Date(iso);                 // iso carries an explicit offset
    if (!Number.isNaN(d.getTime())) return FMT_TIME.format(d);
  }
  return typeof fallback === 'string' ? fallback : '--:--';
}

/* --- labels ------------------------------------------------------------- */

const STATUS_LABEL = {
  pending: 'Da approvare',
  refused: 'Rifiutata',
  confirmed: 'Confermata',
  seated: 'Seduti',
  cancelled: 'Annullata',
  noshow: 'No-show'
};
const SVC_LABEL = { pranzo: 'Pranzo', cena: 'Cena' };
const DOW_NAME = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const DOW_ABBR = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];      // Italian week starts on Monday
const OCCUPYING = new Set(['confirmed', 'seated']);

function people(n) { return n === 1 ? '1 persona' : `${n} persone`; }

/* ====================================================== 2. error mapping */

/* Italian, written here. The server's own `message` field is deliberately
   never rendered — that keeps a Postgres string from ever reaching the owner,
   whatever the Edge Function decides to pass through. */
const ERR_IT = {
  network: 'Connessione assente. Controlla la rete e riprova.',
  unauthorized: 'Sessione scaduta. Accedi di nuovo.',
  forbidden: 'Questo account non è abilitato.',
  rate_limited: 'Troppe richieste. Aspetta un minuto e riprova.',
  server_error: 'Il server non risponde. Riprova tra poco.',
  unknown_action: 'Operazione non riconosciuta. Ricarica la pagina.',
  invalid_body: 'Dati non validi. Ricarica la pagina e riprova.',
  payload_too_large: 'Troppi dati da inviare. Riduci le note e riprova.',
  method_not_allowed: 'Richiesta non valida. Ricarica la pagina.',

  not_found: 'Prenotazione non trovata. Aggiorna la giornata.',
  bad_status: 'Stato non valido.',
  duplicate: 'C’è già una prenotazione confermata con questo numero per quella data.',
  full: 'Non c’è più posto per riattivare questa prenotazione.',
  bad_input: 'Dati non validi.',

  bad_patch: 'Valore non valido nelle impostazioni.',
  invalid_capacity_seats: 'I posti in sala devono essere tra 1 e 500.',
  invalid_turn_minutes: 'La durata del turno deve essere tra 30 e 300 minuti.',
  invalid_small_party_max: 'Il limite “tavolo piccolo” deve essere tra 1 e 40.',
  invalid_max_party: 'Il massimo per prenotazione deve essere tra 1 e 40.',
  invalid_lead_minutes: 'Il preavviso deve essere tra 0 e 1440 minuti.',
  invalid_horizon_days: 'I giorni prenotabili devono essere tra 1 e 365.',
  invalid_accepting: 'Valore non valido.',

  bad_rows: 'Orari non validi.',
  bad_row: 'Una riga degli orari non è valida.',
  bad_dow: 'Giorno non valido.',
  bad_service: 'Servizio non valido.',
  bad_times: 'L’apertura deve venire prima dell’ultima entrata.',
  bad_slot_minutes: 'L’intervallo tra gli orari può essere solo 15 o 30 minuti.',
  duplicate_window: 'Ci sono due righe per lo stesso giorno e servizio.'
};
const GENERIC_ERR = 'Qualcosa non ha funzionato. Riprova.';

class AdminError extends Error {
  constructor(slug, extra) {
    super(String(slug || 'server_error'));
    this.slug = String(slug || 'server_error');
    this.extra = extra && typeof extra === 'object' ? extra : {};
  }
}
// Thrown once the session is gone and the login screen is already on screen.
// Callers must stop quietly: no flash, no retry, no half-rendered console.
class SessionGone extends Error {}

function errText(err) {
  if (err instanceof AdminError) return ERR_IT[err.slug] || GENERIC_ERR;
  return GENERIC_ERR;
}

/* ========================================================= 3. API client */

async function callApi(action, payload, attempt = 0) {
  const { data, error } = await sb.auth.getSession();
  const session = data && data.session;
  if (error || !session) { await endSession('unauthorized'); throw new SessionGone(); }

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: CFG.anonKey,
        authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify(Object.assign({ action }, payload || {}))
    });
  } catch {
    throw new AdminError('network');
  }

  // 403 — the JWT is valid but the caller is not in mythos.admins.
  // Terminal by design: sign out, say so plainly, never retry.
  if (res.status === 403) { await endSession('forbidden'); throw new SessionGone(); }

  // 401 — refresh once, retry once, then fall back to the login screen.
  if (res.status === 401) {
    if (attempt === 0) {
      let refreshed = null;
      try { refreshed = await sb.auth.refreshSession(); } catch { refreshed = null; }
      if (refreshed && !refreshed.error && refreshed.data && refreshed.data.session) {
        return callApi(action, payload, 1);
      }
    }
    await endSession('unauthorized');
    throw new SessionGone();
  }

  if (res.status === 429) throw new AdminError('rate_limited');

  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') throw new AdminError('server_error');

  if (body.ok === false || !res.ok) throw new AdminError(body.error, body);

  // The SQL functions return their own {ok:false,error:…} envelope. Depending on
  // how the Edge Function forwards an expected failure it can arrive either at
  // the top level (handled above) or nested inside `data` — accept both.
  const out = body.data;
  if (out && typeof out === 'object' && out.ok === false) throw new AdminError(out.error, out);
  return out;
}

/* ==================================================== 4. session / views */

const elLogin = $('#login');
const elApp = $('#app');
const loginForm = $('#login-form');
const loginBtn = $('#login-btn');
const loginMsg = $('#login-msg');

let loginNotice = null;   // survives a re-show of the login screen

function showLogin(message) {
  stopPoll();
  if (message) loginNotice = message;
  elBoot.hidden = true;
  elApp.hidden = true;
  elLogin.hidden = false;
  if (loginNotice) { loginMsg.textContent = loginNotice; loginMsg.hidden = false; }
  else { loginMsg.textContent = ''; loginMsg.hidden = true; }
  const pass = $('#li-pass');
  if (pass) pass.value = '';
  clearFlash();
}

async function endSession(reason) {
  try { await sb.auth.signOut(); } catch { /* already gone */ }
  showLogin(ERR_IT[reason] || GENERIC_ERR);
}

function enterApp(session) {
  loginNotice = null;
  elBoot.hidden = true;
  elLogin.hidden = true;
  elApp.hidden = false;
  const who = $('#who');
  who.textContent = (session && session.user && session.user.email) || '';
  state.today = romeToday();
  state.date = state.today;
  selectTab('servizio');
  loadDay(state.date);
  loadRequests();
  startPoll();
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('#li-email').value.trim();
  const password = $('#li-pass').value;

  loginMsg.hidden = true;
  loginNotice = null;

  if (!email || !password) {
    loginNotice = 'Inserisci email e password.';
    loginMsg.textContent = loginNotice; loginMsg.hidden = false;
    return;
  }

  run('login', {
    btn: loginBtn,
    label: 'Accedo…',
    onError: () => { loginMsg.textContent = GENERIC_ERR; loginMsg.hidden = false; }
  }, async () => {
    let result;
    try {
      result = await sb.auth.signInWithPassword({ email, password });
    } catch {
      result = { error: { status: 0 } };
    }
    if (result.error) {
      // Mapped from the status code, never from the provider's raw message.
      const st = result.error.status;
      loginNotice =
        st === 400 || st === 401 ? 'Email o password non corretti.'
          : st === 422 ? 'Email o password non corretti.'
            : st === 429 ? 'Troppi tentativi. Aspetta un minuto e riprova.'
              : !st ? ERR_IT.network
                : 'Accesso non riuscito. Riprova.';
      loginMsg.textContent = loginNotice;
      loginMsg.hidden = false;
      $('#li-pass').value = '';
      return;
    }
    $('#li-pass').value = '';
    enterApp(result.data && result.data.session);
  });
});

$('#logout').addEventListener('click', () => {
  run('logout', { btn: $('#logout'), label: '…' }, async () => {
    loginNotice = null;
    try { await sb.auth.signOut(); } catch { /* noop */ }
    showLogin();
  });
});

// Another tab signing out must not leave this one on a live-looking console.
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' && !elApp.hidden) showLogin();
});

/* ================================================= 5. pending / confirm */

const inflight = new Set();

function setBusy(btn, on, label) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.lbl == null) btn.dataset.lbl = btn.textContent;
    if (label) btn.textContent = label;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  } else {
    if (btn.dataset.lbl != null) { btn.textContent = btn.dataset.lbl; delete btn.dataset.lbl; }
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

/* Every async action goes through here: one pending state, one error path,
   and the same key can never be in flight twice (no double-fire). */
async function run(key, opts, work) {
  if (inflight.has(key)) return;
  inflight.add(key);
  const o = opts || {};
  const group = o.group ? [...o.group] : [];
  for (const g of group) if (g !== o.btn) g.disabled = true;
  setBusy(o.btn, true, o.label);
  try {
    await work();
  } catch (err) {
    if (err instanceof SessionGone) return;           // login screen already shown
    if (o.onError) o.onError(err); else flash('err', errText(err));
  } finally {
    inflight.delete(key);
    setBusy(o.btn, false);
    for (const g of group) if (g !== o.btn) g.disabled = false;
    // Runs after the pending state is torn down, so a handler can set a
    // resting state (e.g. "save is disabled again") without it being undone.
    if (o.after) o.after();
  }
}

const dlg = $('#confirm');

function confirmDlg(title, body, yesLabel, danger = true) {
  return new Promise((resolve) => {
    if (!dlg || typeof dlg.showModal !== 'function') {
      resolve(window.confirm(`${title}\n\n${body}`));
      return;
    }
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    const yes = $('#confirm-yes');
    yes.textContent = yesLabel || 'Conferma';
    yes.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
    dlg.showModal();
  });
}

/* ------------------------------------------------------------- flash bar */

const elFlash = $('#flash');
let flashTimer = null;

function clearFlash() {
  if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
  elFlash.hidden = true;
  elFlash.replaceChildren();
}

function flash(kind, text) {
  clearFlash();
  elFlash.className = 'flash flash-' + kind;
  elFlash.replaceChildren(
    h('p', { text }),
    h('button', { type: 'button', 'aria-label': 'Chiudi', onclick: clearFlash, text: '×' })
  );
  elFlash.hidden = false;
  if (kind === 'ok') flashTimer = setTimeout(clearFlash, 5000);
}

function panelMsg(el, kind, text) {
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.className = 'msg msg-' + kind;
  el.textContent = text;
  el.hidden = false;
}

/* ================================================================ 6. tabs */

const state = {
  tab: 'servizio',
  today: romeToday(),
  date: romeToday(),
  settingsLoaded: false,
  windowsLoaded: false,
  winDirty: false
};

const TABS = ['servizio', 'impostazioni', 'chiusure'];

function selectTab(name) {
  state.tab = name;
  for (const t of TABS) {
    const tab = $('#tab-' + t);
    const panel = $('#panel-' + t);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  // Each half retries independently: if settings loaded but the weekly grid
  // failed, coming back to the tab must retry the grid.
  if (name === 'impostazioni') {
    if (!state.settingsLoaded) loadSettings();
    if (!state.windowsLoaded) loadWindows();
  }
  if (name === 'chiusure' && !$('#clo-date').value) $('#clo-date').value = state.date || state.today;
}

for (const t of TABS) {
  $('#tab-' + t).addEventListener('click', () => selectTab(t));
}
$('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(state.tab);
  let next = null;
  if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
  else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
  else if (e.key === 'Home') next = TABS[0];
  else if (e.key === 'End') next = TABS[TABS.length - 1];
  if (!next) return;
  e.preventDefault();
  selectTab(next);
  $('#tab-' + next).focus();
});

/* ========================================================= 7. servizio */

const dayInput = $('#day-input');
const dayHead = $('#day-head');
const dayBody = $('#day-body');
const dayReload = $('#day-reload');

function markDayButtons() {
  for (const b of document.querySelectorAll('.btn-day')) {
    const target = ymdShift(state.today, num(b.dataset.day) || 0);
    b.classList.toggle('is-on', target === state.date);
    b.setAttribute('aria-pressed', String(target === state.date));
  }
}

// The server tells us what "today" is in Rome; trust it over the device clock.
function adoptToday(romeNowIso) {
  if (!romeNowIso) return;
  const d = new Date(romeNowIso);
  if (Number.isNaN(d.getTime())) return;
  const ymd = romeYmd(d);
  if (ymd && ymd !== state.today) { state.today = ymd; markDayButtons(); }
}

async function loadDay(ymd, opts = {}) {
  const silent = !!opts.silent;
  state.date = ymd;
  dayInput.value = ymd;
  markDayButtons();

  if (!silent) {
    dayHead.replaceChildren(h('div', { class: 'loading', text: 'Carico la giornata…' }));
    dayBody.replaceChildren();
  }

  await run('day:' + ymd, {
    // Only the explicit "Aggiorna" button gets a spinner label. Day switching
    // shows its pending state in the panel itself, so two rapid taps on
    // different days can never leave the shared button stuck on "…".
    btn: opts.btn || null,
    label: '…',
    onError: (err) => {
      if (silent) return;                     // a failed background poll stays quiet
      const msg = errText(err);
      dayHead.replaceChildren(h('div', { class: 'day-empty' },
        h('strong', { text: 'Non riesco a caricare la giornata' }),
        h('span', { text: msg })));
      dayBody.replaceChildren();
      flash('err', msg);
    }
  }, async () => {
    const data = await callApi('day', { from: ymd, to: ymd });
    if (state.date !== ymd) return;           // he moved on while this was in flight
    adoptToday(data && data.rome_now);
    renderDay((data && data.days || [])[0], data || {});
  });
}

for (const b of document.querySelectorAll('.btn-day')) {
  b.addEventListener('click', () => loadDay(ymdShift(state.today, num(b.dataset.day) || 0)));
}
dayInput.addEventListener('change', () => {
  if (dayInput.value) loadDay(dayInput.value);
});
dayReload.addEventListener('click', () => loadDay(state.date, { btn: dayReload }));

/* --- group requests inbox --------------------------------------------- */

const reqBox = $('#req-box');

// Every open group request, whatever the day on screen: a request that waits
// unseen is a table the guest thinks they asked for and nobody answered.
async function loadRequests() {
  let data;
  try {
    data = await callApi('pending', {});
  } catch {
    return;                                   // the day view still works; retried on the next load
  }
  const list = (data && data.requests) || [];
  if (!list.length) { reqBox.replaceChildren(); return; }

  const box = h('section', { class: 'reqbox', 'aria-label': 'Richieste di gruppo da approvare' },
    h('div', { class: 'reqbox-h' },
      h('h2', { text: list.length === 1 ? '1 richiesta di gruppo da approvare' : `${list.length} richieste di gruppo da approvare` }),
      h('p', { text: 'I posti non sono ancora occupati. Approva o rifiuta: il cliente riceve la risposta via email.' })));

  for (const r of list) {
    const b = { ...r, status: 'pending' };
    const errBox = h('p', { class: 'bk-err', role: 'alert', hidden: true });
    const acts = h('div', { class: 'bk-act' });
    const buttons = [];
    for (const a of actionsFor('pending')) {
      const btn = h('button', { type: 'button', class: 'btn ' + a.cls, text: a.label });
      btn.addEventListener('click', () => setStatus(b, a, btn, buttons, errBox));
      buttons.push(btn);
      acts.append(btn);
    }
    const open = h('button', { type: 'button', class: 'btn btn-ghost', text: 'Vedi la giornata' });
    open.addEventListener('click', () => loadDay(r.date));
    acts.append(open);

    box.append(h('article', { class: 'req' },
      h('div', { class: 'req-when', text: `${dayLong(r.date)} · ${r.time}` }),
      h('div', { class: 'req-who', text: `${r.name || '—'} · ${people(num(r.party) || 0)}` }),
      h('span', {
        class: 'req-fit ' + (r.fits ? 'ok' : 'no'),
        text: r.fits ? 'C’è posto in sala' : 'Sala piena a quell’ora: approvando non entra'
      }),
      r.notes ? h('p', { class: 'bk-notes', text: r.notes }) : null,
      acts, errBox));
  }
  reqBox.replaceChildren(box);
}

function relativeBadge(ymd) {
  if (ymd === state.today) return 'Oggi';
  if (ymd === ymdShift(state.today, -1)) return 'Ieri';
  if (ymd === ymdShift(state.today, 1)) return 'Domani';
  return null;
}

function renderDay(day, meta) {
  dayHead.replaceChildren();
  dayBody.replaceChildren();

  if (!day) {
    dayHead.append(h('div', { class: 'day-empty' },
      h('strong', { text: 'Giornata non disponibile' }),
      h('span', { text: 'Riprova con Aggiorna.' })));
    return;
  }

  const ymd = day.date || state.date;
  const capacity = num(day.capacity) ?? num(meta.capacity) ?? 0;
  const peak = num(day.peak) ?? 0;

  const bookings = (Array.isArray(day.bookings) ? day.bookings.slice() : [])
    .sort((a, b) => String(a.starts_at || a.time || '').localeCompare(String(b.starts_at || b.time || '')));

  const totals = {};
  for (const t of (Array.isArray(day.totals) ? day.totals : [])) {
    if (t && t.service) totals[t.service] = t;
  }
  const dayCovers = Object.values(totals).reduce((s, t) => s + (num(t.covers) || 0), 0);

  /* ---- header ---- */
  const badge = relativeBadge(ymd);
  const head = h('div', { class: 'dayhead' },
    h('div', { class: 'dh-l1' },
      h('span', { class: 'dh-date', text: dayLong(ymd) }),
      badge ? h('span', { class: 'dh-badge', text: badge }) : null)
  );

  if (day.closed) {
    head.append(h('p', {
      class: 'dh-shut',
      text: day.note
        ? `Chiuso — ${day.note}. Le prenotazioni qui sotto restano valide.`
        : 'Chiuso. Le prenotazioni qui sotto restano valide.'
    }));
  }

  // Peak occupancy is the number that says whether the room fits. It is NOT
  // the day's total covers: 40 covers over two sittings can peak at 20.
  const ratio = capacity > 0 ? peak / capacity : 0;
  const peakCls = capacity > 0 && peak >= capacity ? ' is-full' : ratio >= 0.8 ? ' is-warn' : '';
  head.append(h('div', { class: 'peak' + peakCls },
    h('div', { class: 'peak-n' },
      h('strong', { text: String(peak) }),
      h('span', { text: `su ${capacity} posti` })),
    h('div', { class: 'peak-bar' },
      h('i', { style: `width:${capacity > 0 ? Math.min(100, Math.round(ratio * 100)) : 0}%` })),
    h('p', { class: 'peak-lab', text: 'Punta di sala: il massimo di persone sedute nello stesso momento.' })
  ));

  const tot = h('div', { class: 'dh-tot' });
  for (const s of ['pranzo', 'cena']) {
    const t = totals[s];
    tot.append(
      h('span', {}, `${SVC_LABEL[s]} `, h('b', { text: String(num(t && t.covers) || 0) }), ' coperti'),
      ' · '
    );
  }
  tot.append(h('span', {}, 'totale giornata ', h('b', { text: String(dayCovers) }), ' coperti'));
  head.append(tot);
  dayHead.append(head);

  /* ---- body ---- */
  if (!bookings.length) {
    dayBody.append(h('div', { class: 'day-empty' },
      h('strong', { text: 'Nessuna prenotazione' }),
      h('span', { text: day.closed ? 'Giornata chiusa e agenda vuota.' : 'Non c’è nessuno in agenda per questa data.' })));
    return;
  }

  for (const s of ['pranzo', 'cena']) {
    dayBody.append(serviceBlock(s, bookings.filter((b) => b.service === s), totals[s]));
  }

  // Defensive: a booking whose service is neither pranzo nor cena would
  // otherwise vanish from the screen. Never silently drop a guest.
  const orphans = bookings.filter((b) => b.service !== 'pranzo' && b.service !== 'cena');
  if (orphans.length) dayBody.append(serviceBlock(null, orphans, null));
}

function serviceBlock(service, list, tot) {
  const covers = num(tot && tot.covers) ?? list.filter((b) => OCCUPYING.has(b.status))
    .reduce((s, b) => s + (num(b.party) || 0), 0);
  const count = num(tot && tot.bookings) ?? list.filter((b) => OCCUPYING.has(b.status)).length;

  const box = h('section', { class: 'svc' },
    h('div', { class: 'svc-h' },
      h('h2', { text: service ? SVC_LABEL[service] : 'Altro' }),
      h('span', {
        class: 'svc-sum',
        text: `${covers} coperti · ${count === 1 ? '1 prenotazione' : count + ' prenotazioni'}`
      }))
  );

  if (!list.length) {
    box.append(h('p', { class: 'svc-empty', text: 'Nessuna prenotazione' }));
    return box;
  }
  for (const b of list) box.append(bookingRow(b));
  return box;
}

function telHref(b) {
  const raw = String(b.phone || '');
  if (b.anonymized_at || /^anon-/i.test(raw)) return null;   // gdpr_purge() placeholder
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return 'tel:' + (raw.trim().startsWith('+') ? '+' : '') + digits;
}

function actionsFor(status) {
  if (status === 'pending') {
    // A group request holds no seats: approving re-checks the room server-side
    // and can come back `full`. Either answer mails the guest.
    return [
      { to: 'confirmed', label: 'Approva', cls: 'btn-ok', confirm: 'approve' },
      { to: 'refused', label: 'Rifiuta', cls: 'btn-danger', confirm: 'refuse' }
    ];
  }
  if (status === 'confirmed') {
    return [
      { to: 'seated', label: 'Seduti', cls: 'btn-ok' },
      { to: 'noshow', label: 'No-show', cls: '', confirm: 'noshow' },
      { to: 'cancelled', label: 'Annulla', cls: 'btn-danger', confirm: 'cancel' }
    ];
  }
  if (status === 'seated') {
    return [
      { to: 'confirmed', label: 'Non ancora seduti', cls: '' },
      { to: 'cancelled', label: 'Annulla', cls: 'btn-danger', confirm: 'cancel' }
    ];
  }
  // cancelled / noshow — re-confirming re-runs the capacity check server-side
  // and can legitimately come back `full`.
  return [{ to: 'confirmed', label: 'Riattiva', cls: 'btn-primary' }];
}

function bookingRow(b) {
  const status = STATUS_LABEL[b.status] ? b.status : 'confirmed';
  const off = status === 'cancelled' || status === 'noshow' || status === 'refused';
  const party = num(b.party) || 0;

  const row = h('article', {
    class: 'bk' + (off ? ' is-off' : '') + (status === 'pending' ? ' is-pending' : ''),
    dataset: { id: String(b.id || '') }
  });

  row.append(h('div', { class: 'bk-l1' },
    h('span', { class: 'bk-time', text: romeTime(b.starts_at, b.time) }),
    h('span', { class: 'bk-party', text: `${party} pers.` }),
    h('span', { class: 'pill pill-' + status, text: STATUS_LABEL[status] })
  ));

  row.append(h('div', { class: 'bk-name' },
    b.name || '—',
    b.code ? h('span', { class: 'bk-code', text: b.code }) : null));

  const href = telHref(b);
  if (href) row.append(h('a', { class: 'bk-tel', href, text: String(b.phone) }));
  else if (b.phone) row.append(h('p', { class: 'bk-tel-off', text: 'Telefono non disponibile' }));

  if (b.notes) row.append(h('p', { class: 'bk-notes', text: b.notes }));

  const errBox = h('p', { class: 'bk-err', role: 'alert', hidden: true });
  const acts = h('div', { class: 'bk-act' });
  const buttons = [];

  for (const a of actionsFor(status)) {
    const btn = h('button', { type: 'button', class: 'btn ' + a.cls, text: a.label });
    btn.addEventListener('click', () => setStatus(b, a, btn, buttons, errBox));
    buttons.push(btn);
    acts.append(btn);
  }
  row.append(acts, errBox);
  return row;
}

function setStatus(b, action, btn, group, errBox) {
  const when = romeTime(b.starts_at, b.time);
  const who = `${b.name || 'questa prenotazione'} (${people(num(b.party) || 0)}, ${when})`;

  const ask =
    action.confirm === 'noshow'
      ? { title: 'Segnare no-show?', body: `${who} risulterà come no-show e i posti tornano liberi.`, yes: 'Sì, no-show' }
      : action.confirm === 'cancel'
        ? { title: 'Annullare la prenotazione?', body: `${who} verrà annullata e i posti tornano liberi.`, yes: 'Sì, annulla' }
        : action.confirm === 'approve'
          ? { title: 'Approvare la richiesta?', body: `${who} diventa una prenotazione confermata e occupa i posti. Il cliente riceve subito la conferma via email.`, yes: 'Sì, approva' }
          : action.confirm === 'refuse'
            ? { title: 'Rifiutare la richiesta?', body: `${who} viene rifiutata. Il cliente riceve un'email che lo invita a chiamarvi per un'altra data.`, yes: 'Sì, rifiuta' }
            : null;

  run('status:' + b.id, {
    btn, group, label: '…',
    onError: (err) => {
      // A rejection must never look like a silent no-op: say what happened and
      // say that the row did NOT change.
      const text = err instanceof AdminError && err.slug === 'full'
        ? fullText(err.extra, status0(b))
        : errText(err) + ' La prenotazione non è stata modificata.';
      errBox.textContent = text;
      errBox.hidden = false;
      flash('err', text);
    }
  }, async () => {
    errBox.hidden = true;
    if (ask && !(await confirmDlg(ask.title, ask.body, ask.yes))) return;

    await callApi('set_status', { id: b.id, status: action.to });
    const answered = b.status === 'pending';
    const word = answered && action.to === 'confirmed' ? 'approvata' : STATUS_LABEL[action.to].toLowerCase();
    flash('ok', `${b.name || 'Prenotazione'} · ${word}.${answered && b.email ? ' Email inviata al cliente.' : ''}`);
    await Promise.all([loadDay(state.date, { silent: true }), loadRequests()]);   // peak, totals and the inbox all move
  });
}

function status0(b) { return STATUS_LABEL[b.status] ? STATUS_LABEL[b.status].toLowerCase() : 'invariata'; }

// `full` on re-confirm: rebuild the sentence from the numbers, never from the
// server's string, and state plainly that nothing changed.
function fullText(extra, current) {
  const peak = num(extra.peak), party = num(extra.party), cap = num(extra.capacity);
  if (peak != null && party != null && cap != null) {
    return `Non c’è posto: a quell’ora ci sono già ${peak} coperti su ${cap} e questa prenotazione ne chiede ${party}. Nulla è cambiato: resta ${current}.`;
  }
  return `Non c’è più posto per riattivare questa prenotazione. Nulla è cambiato: resta ${current}.`;
}

/* --- polite background refresh ----------------------------------------- */

let pollId = null;
function stopPoll() { if (pollId) { clearInterval(pollId); pollId = null; } }
function startPoll() {
  stopPoll();
  pollId = setInterval(() => {
    if (elApp.hidden || state.tab !== 'servizio') return;
    if (document.visibilityState !== 'visible') return;
    if (inflight.size || (dlg && dlg.open)) return;      // never fight a pending action
    loadDay(state.date, { silent: true });
    loadRequests();
  }, 90000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (elApp.hidden || state.tab !== 'servizio') return;
  if (inflight.size || (dlg && dlg.open)) return;
  loadDay(state.date, { silent: true });
  loadRequests();
});

/* ===================================================== 8. impostazioni */

const setWrap = $('#set-wrap');
const setLoad = $('#set-load');
const setForm = $('#set-form');
const setMsg = $('#set-msg');
const setSave = $('#set-save');
const killBox = $('#killbox');
const killState = $('#kill-state');
const killBtn = $('#kill-btn');

const SET_FIELDS = [
  ['capacity_seats', 1, 500, 'Posti in sala'],
  ['turn_minutes_small', 30, 300, 'Durata turno tavoli piccoli'],
  ['turn_minutes_large', 30, 300, 'Durata turno tavoli grandi'],
  ['max_party', 1, 40, 'Massimo persone per prenotazione'],
  ['lead_minutes', 0, 1440, 'Preavviso minimo'],
  ['horizon_days', 1, 365, 'Giorni prenotabili']
];

function paintSettings(s) {
  for (const [name] of SET_FIELDS) {
    const input = setForm.elements[name];
    if (input && s[name] != null) input.value = String(s[name]);
  }
  const smallMax = num(s.small_party_max);
  const hint = $('#small-hint');
  if (hint) {
    hint.textContent = smallMax
      ? `Per quanto tempo il tavolo resta occupato. “Piccolo” = fino a ${people(smallMax)}.`
      : 'Per quanto tempo il tavolo resta occupato.';
  }

  const on = s.accepting !== false;
  killBox.classList.toggle('is-off', !on);
  killState.textContent = on ? 'Sono ATTIVE' : 'Sono FERME';
  killBtn.textContent = on ? 'Ferma le prenotazioni online' : 'Riattiva le prenotazioni online';
  killBtn.className = 'btn btn-big ' + (on ? 'btn-danger' : 'btn-ok');
  killBtn.dataset.next = on ? 'off' : 'on';
  // We just rewrote the label to match the NEW state; drop the label the
  // pending-state machinery saved, or its teardown would put the old one back.
  delete killBtn.dataset.lbl;

  state.settingsLoaded = true;
  setLoad.hidden = true;
  setWrap.hidden = false;
}

function loadSettings() {
  setLoad.hidden = false;
  setWrap.hidden = true;
  // The contract has no read-only action, so an empty patch is the documented
  // way to read the current settings back. It changes no value.
  run('settings:load', {
    onError: (err) => {
      setLoad.replaceChildren(h('p', { class: 'msg msg-err', role: 'alert', text: errText(err) }));
      setLoad.hidden = false;
    }
  }, async () => {
    const data = await callApi('settings', { patch: {} });
    paintSettings((data && data.settings) || data || {});
  });
}

setForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const patch = {};
  for (const [name, min, max, label] of SET_FIELDS) {
    const raw = (setForm.elements[name].value || '').trim();
    const v = num(raw);
    if (raw === '' || v == null || v < min || v > max) {
      panelMsg(setMsg, 'err', `“${label}”: inserisci un numero tra ${min} e ${max}.`);
      setForm.elements[name].focus();
      return;
    }
    patch[name] = v;
  }
  if (patch.turn_minutes_large < patch.turn_minutes_small) {
    panelMsg(setMsg, 'warn', 'Il turno dei tavoli grandi è più corto di quello dei tavoli piccoli. Controlla i due valori.');
    return;
  }

  run('settings:save', {
    btn: setSave, label: 'Salvo…',
    onError: (err) => panelMsg(setMsg, 'err', errText(err))
  }, async () => {
    panelMsg(setMsg, null, null);
    const data = await callApi('settings', { patch });
    paintSettings((data && data.settings) || patch);
    panelMsg(setMsg, 'ok', 'Impostazioni salvate.');
  });
});

killBtn.addEventListener('click', () => {
  const turningOff = killBtn.dataset.next === 'off';
  run('settings:kill', {
    btn: killBtn, label: '…',
    onError: (err) => panelMsg(setMsg, 'err', errText(err))
  }, async () => {
    if (turningOff) {
      const ok = await confirmDlg(
        'Fermare le prenotazioni online?',
        'Le prenotazioni online si fermano. Il sito mostra il numero di telefono. Le prenotazioni già confermate restano valide.',
        'Sì, ferma tutto'
      );
      if (!ok) return;
    }
    const data = await callApi('settings', { patch: { accepting: !turningOff } });
    paintSettings((data && data.settings) || {});
    flash(turningOff ? 'warn' : 'ok', turningOff
      ? 'Prenotazioni online ferme. Il sito mostra il numero di telefono.'
      : 'Prenotazioni online riattivate.');
  });
});

/* --- weekly service windows -------------------------------------------- */

const winGrid = $('#win-grid');
const winForm = $('#win-form');
const winMsg = $('#win-msg');
const winSave = $('#win-save');

function hhmmMin(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/* The admin endpoint's `windows` action only WRITES — there is no read action
   in the contract. The current template is therefore reconstructed from the
   public availability calendar, which lists exactly the active windows:
   the first slot of a service is `opens`, the last is `last_seating`, and the
   gap between the first two is `slot_minutes`. We scan three weeks and take the
   first NON-closed occurrence of each weekday, so a one-off closure on a date
   cannot make a whole weekday look inactive. */
async function fetchTemplate() {
  const from = state.today || romeToday();
  let body;
  try {
    const res = await fetch(AVAILABILITY, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: CFG.anonKey,
        authorization: 'Bearer ' + CFG.anonKey
      },
      body: JSON.stringify({ party: 1, from, to: ymdShift(from, 20) })
    });
    body = await res.json();
  } catch {
    throw new AdminError('network');
  }
  if (!body || !Array.isArray(body.days)) throw new AdminError('server_error');

  const tpl = Object.create(null);
  const seenDows = new Set();
  const closedSeen = Object.create(null);
  for (const d of body.days) {
    if (d && d.closed) closedSeen[d.dow] = (closedSeen[d.dow] || 0) + 1;
    if (!d || d.closed) continue;
    seenDows.add(d.dow);
    for (const sv of (Array.isArray(d.services) ? d.services : [])) {
      const key = d.dow + ':' + sv.service;
      if (tpl[key]) continue;                      // first open occurrence wins
      const slots = Array.isArray(sv.slots) ? sv.slots : [];
      if (!slots.length) continue;
      let step = slots.length > 1 ? (hhmmMin(slots[1].time) - hhmmMin(slots[0].time)) : 15;
      if (step !== 15 && step !== 30) step = 15;
      tpl[key] = {
        opens: slots[0].time,
        last_seating: slots[slots.length - 1].time,
        slot_minutes: step,
        active: true
      };
    }
  }
  // A weekday closed on every occurrence in the 3-week probe is a weekly
  // closing day (Mythos: Monday), not unreadable data. One-off closures only
  // hit a single occurrence, so they still fall through to the warning.
  for (const dow in closedSeen) {
    if (closedSeen[dow] >= 2 && !seenDows.has(Number(dow))) seenDows.add(Number(dow));
  }
  return { tpl, seenDows };
}

function renderWindows(tpl, seenDows) {
  winGrid.replaceChildren();
  for (const dow of DOW_ORDER) {
    const box = h('div', { class: 'win-day' }, h('div', { class: 'win-dayname', text: DOW_NAME[dow] }));
    for (const service of ['pranzo', 'cena']) {
      const cur = tpl[dow + ':' + service] || null;
      const label = `${DOW_NAME[dow]} ${SVC_LABEL[service]}`;
      const row = h('div', {
        class: 'win-row' + (cur ? '' : ' is-off'),
        dataset: { dow: String(dow), service }
      });

      const chk = h('input', { type: 'checkbox', 'data-f': 'active' });
      chk.checked = !!cur;
      const onLabel = h('label', { class: 'win-on' }, chk, h('span', { text: SVC_LABEL[service] }));

      const opens = h('input', { type: 'time', 'data-f': 'opens', step: '900', 'aria-label': `${label}: apertura` });
      const last = h('input', { type: 'time', 'data-f': 'last_seating', step: '900', 'aria-label': `${label}: ultima entrata` });
      opens.value = cur ? cur.opens : '';
      last.value = cur ? cur.last_seating : '';

      const sel = h('select', { 'data-f': 'slot_minutes', 'aria-label': `${label}: intervallo tra gli orari` },
        h('option', { value: '15', text: '15′' }),
        h('option', { value: '30', text: '30′' }));
      sel.value = String(cur ? cur.slot_minutes : 15);

      chk.addEventListener('change', () => row.classList.toggle('is-off', !chk.checked));
      row.append(onLabel, h('div', { class: 'win-times' }, opens, h('span', { class: 'win-arrow', text: '→' }), last, sel));
      box.append(row);
    }
    winGrid.append(box);
  }

  const missing = DOW_ORDER.filter((d) => !seenDows.has(d));
  if (missing.length) {
    panelMsg(winMsg, 'warn',
      `Non ho potuto leggere gli orari di: ${missing.map((d) => DOW_NAME[d]).join(', ')}. ` +
      'Controllali e compilali a mano prima di salvare.');
  } else {
    panelMsg(winMsg, null, null);
  }

  state.windowsLoaded = true;
  state.winDirty = false;
  winSave.disabled = true;
}

function loadWindows() {
  winGrid.replaceChildren(h('p', { class: 'loading', text: 'Leggo gli orari…' }));
  winSave.disabled = true;
  run('windows:load', {
    onError: (err) => {
      // Never enable a full-week replace on top of a template we failed to read.
      winGrid.replaceChildren();
      panelMsg(winMsg, 'err', errText(err) + ' Gli orari non sono modificabili finché non si caricano.');
      winSave.disabled = true;
    }
  }, async () => {
    const { tpl, seenDows } = await fetchTemplate();
    renderWindows(tpl, seenDows);
  });
}

winGrid.addEventListener('input', markWinDirty);
winGrid.addEventListener('change', markWinDirty);
function markWinDirty() {
  if (!state.windowsLoaded) return;
  state.winDirty = true;
  winSave.disabled = false;
}

function collectWindows() {
  const rows = [];
  const errors = [];
  const activeDows = new Set();

  for (const row of winGrid.querySelectorAll('.win-row')) {
    const dow = num(row.dataset.dow);
    const service = row.dataset.service;
    const label = `${DOW_NAME[dow]} · ${SVC_LABEL[service]}`;
    const active = $('[data-f="active"]', row).checked;
    const opens = $('[data-f="opens"]', row).value;
    const last = $('[data-f="last_seating"]', row).value;
    const slot = num($('[data-f="slot_minutes"]', row).value) || 15;

    if (!opens || !last) {
      if (active) errors.push(`${label}: manca un orario.`);
      continue;                                   // no times = the row does not exist
    }
    if (hhmmMin(opens) >= hhmmMin(last)) {
      errors.push(`${label}: l’apertura deve venire prima dell’ultima entrata.`);
      continue;
    }
    rows.push({
      dow, service,
      opens: opens.slice(0, 5),
      last_seating: last.slice(0, 5),
      slot_minutes: slot,
      active
    });
    if (active) activeDows.add(dow);
  }
  return { rows, errors, activeDows };
}

winForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.windowsLoaded) return;

  const { rows, errors, activeDows } = collectWindows();
  if (errors.length) { panelMsg(winMsg, 'err', errors.join(' ')); return; }

  const days = DOW_ORDER.filter((d) => activeDows.has(d)).map((d) => DOW_ABBR[d]);
  const activeRows = rows.filter((r) => r.active).length;
  const body = days.length
    ? `Sostituisci tutti gli orari della settimana. Dopo il salvataggio si prenota in questi giorni: ${days.join(', ')} (${activeRows} fasce attive). I giorni non elencati risultano chiusi.`
    : 'Nessun servizio attivo: dopo il salvataggio il ristorante risulterà CHIUSO tutti i giorni e non si potrà prenotare online.';

  run('windows:save', {
    btn: winSave, label: 'Salvo…',
    onError: (err) => panelMsg(winMsg, 'err', errText(err)),
    after: () => { winSave.disabled = !state.winDirty; }
  }, async () => {
    if (!(await confirmDlg('Salvare gli orari?', body, 'Sì, salva'))) return;
    panelMsg(winMsg, null, null);
    await callApi('windows', { rows });
    state.winDirty = false;
    panelMsg(winMsg, days.length ? 'ok' : 'warn', days.length
      ? 'Orari salvati.'
      : 'Orari salvati: nessun giorno attivo, il ristorante risulta chiuso.');
  });
});

/* ========================================================= 9. chiusure */

const cloDate = $('#clo-date');
const cloNote = $('#clo-note');
const cloBlock = $('#clo-block');
const cloOpen = $('#clo-open');
const cloMsg = $('#clo-msg');
const cloResult = $('#clo-result');

function cloReset() { panelMsg(cloMsg, null, null); cloResult.replaceChildren(); }

cloBlock.addEventListener('click', () => {
  const d = cloDate.value;
  if (!d) { panelMsg(cloMsg, 'err', 'Scegli una data.'); return; }

  run('closure:block', {
    btn: cloBlock, group: [cloBlock, cloOpen], label: '…',
    onError: (err) => panelMsg(cloMsg, 'err', errText(err))
  }, async () => {
    cloReset();

    // Read the day first, so the warning carries a real number BEFORE he confirms.
    const data = await callApi('day', { from: d, to: d });
    const day = (data && data.days || [])[0] || {};
    const live = (Array.isArray(day.bookings) ? day.bookings : []).filter((b) => OCCUPYING.has(b.status));
    const covers = live.reduce((s, b) => s + (num(b.party) || 0), 0);

    const warn = live.length
      ? `Attenzione: ${dayLong(d)} ha già ${live.length === 1 ? '1 prenotazione attiva' : live.length + ' prenotazioni attive'} (${covers} coperti). Chiudendo la data NON vengono cancellate: restano in agenda e vanno gestite una per una dalla schermata Servizio. Vuoi chiudere lo stesso?`
      : `Chiudere ${dayLong(d)}? Il sito non accetterà più prenotazioni online per questa data.`;

    if (!(await confirmDlg('Chiudi la data', warn, 'Sì, chiudi'))) return;

    const res = await callApi('block', { date: d, note: (cloNote.value || '').trim(), on: true });
    showClosureResult(d, true, res);
  });
});

cloOpen.addEventListener('click', () => {
  const d = cloDate.value;
  if (!d) { panelMsg(cloMsg, 'err', 'Scegli una data.'); return; }

  run('closure:open', {
    btn: cloOpen, group: [cloBlock, cloOpen], label: '…',
    onError: (err) => panelMsg(cloMsg, 'err', errText(err))
  }, async () => {
    cloReset();
    const res = await callApi('block', { date: d, note: '', on: false });
    showClosureResult(d, false, res);
  });
});

/* Numbers come from the response; the sentence is written here. It must never
   suggest the existing bookings were cancelled — admin_block does not touch them. */
function showClosureResult(d, blocked, res) {
  const n = num(res && res.existing_bookings) || 0;
  const covers = num(res && res.existing_covers) || 0;

  const card = h('div', { class: 'card' },
    h('h2', { text: blocked ? 'Data chiusa' : 'Data riaperta' }),
    h('p', { class: 'hint', text: dayLong(d) })
  );

  if (blocked) {
    card.append(h('p', {
      class: 'msg ' + (n ? 'msg-warn' : 'msg-ok'),
      text: n
        ? `Online non si prenota più per questa data. Le ${n === 1 ? 'prenotazione già in agenda' : n + ' prenotazioni già in agenda'} (${covers} coperti) NON sono state cancellate: restano valide finché non le gestisci tu.`
        : 'Online non si prenota più per questa data. Non c’era nessuna prenotazione in agenda.'
    }));
    if (n) {
      const go = h('button', { type: 'button', class: 'btn btn-primary', text: 'Vedi le prenotazioni di questa data' });
      go.addEventListener('click', () => { selectTab('servizio'); loadDay(d); window.scrollTo(0, 0); });
      card.append(go);
    }
  } else {
    card.append(h('p', { class: 'msg msg-ok', text: 'La data è di nuovo aperta alle prenotazioni online, secondo gli orari della settimana.' }));
  }

  cloResult.replaceChildren(card);
  if (state.date === d) loadDay(d, { silent: true });
}

/* ============================================================== 10. boot */

try {
  const { data } = await sb.auth.getSession();
  if (data && data.session) enterApp(data.session);
  else showLogin();
} catch {
  showLogin();
}
