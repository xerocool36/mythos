/* Mythos — prenotazioni
 *
 * Talks to three Supabase Edge Functions: mythos-availability, mythos-book, mythos-cancel.
 *
 * TIMEZONE CONTRACT — the whole reason this file is careful:
 *   The restaurant's clock is Europe/Rome. The visitor's clock is irrelevant and must never
 *   leak into a calculation. Two rules make that true:
 *     1. `new Date("2026-08-08 20:00")` is FORBIDDEN. That form parses in the browser's own
 *        zone, so a guest in Tokyo would book a different instant than the one they clicked.
 *        Every instant here is built from an explicit offset the server sent us:
 *        `2026-08-08T20:00:00+02:00`.
 *     2. Calendar labels come from a UTC-midnight Date formatted with timeZone:'UTC', so
 *        "sab 8 ago" reads the same in Los Angeles and Kiritimati.
 *   "Today" is whatever the server says rome_today is. The browser clock is never consulted.
 */
(function () {
  'use strict';

  var CFG = window.MYTHOS_CONFIG || {};
  var API = (CFG.functionsUrl || '').replace(/\/$/, '');
  var ANON = CFG.anonKey || '';
  var ROME = 'Europe/Rome';
  var HORIZON = 45;
  var TEL = '+390687774778';

  var root = document.getElementById('prenota-app');
  if (!root) return;

  /* ---------------------------------------------------------------- i18n */

  var STR = {
    it: {
      people: 'Quante persone', person: 'persona', people_n: 'persone',
      more: 'Più di 10? Chiamaci', date: 'Quando', service: 'Servizio',
      pranzo: 'Pranzo', cena: 'Cena', slot: 'A che ora',
      left: 'posti', full: 'esaurito', closed: 'Chiuso',
      you: 'I tuoi dati', name: 'Nome e cognome', phone: 'Telefono',
      email: 'Email (facoltativa)', notes: 'Allergie, seggiolone, altro (facoltativo)',
      consent: 'Ho letto la <a href="privacy.html">privacy policy</a> e acconsento al trattamento dei dati per la prenotazione.',
      submit: 'Prenota il tavolo', sending: 'Un attimo…',
      done: 'Tavolo prenotato', code: 'Il tuo codice',
      keep: 'Tienilo da parte: serve per annullare.',
      ics: 'Aggiungi al calendario', cancel_link: 'Devi annullare?',
      cancel_title: 'Annulla la prenotazione', cancel_code: 'Codice prenotazione',
      cancel_tail: 'Ultime 4 cifre del telefono', cancel_do: 'Annulla prenotazione',
      cancel_done: 'Prenotazione annullata. I posti sono di nuovo liberi.',
      closed_day: 'Chiuso questo giorno',
      no_slots: 'Nessun orario disponibile per questo servizio.',
      phone_only: 'Le prenotazioni online sono momentaneamente sospese. Chiamaci allo',
      rome_note: 'Tutti gli orari sono ora di Roma.',
      your_time: 'da te', back: 'Indietro', another: 'Nuova prenotazione',
      err_generic: 'Qualcosa non ha funzionato. Riprova o chiamaci.',
      err_network: 'Connessione assente. Controlla la rete e riprova.',
      err_consent: 'Serve il consenso per registrare la prenotazione.',
      err_name: 'Scrivi nome e cognome.',
      err_phone: 'Serve un numero di telefono valido.',
      err_slot: 'Scegli un orario.',
      err_taken: 'Quell’orario si è appena riempito. Scegline un altro.',
      loading: 'Carico le disponibilità…'
    },
    en: {
      people: 'How many', person: 'guest', people_n: 'guests',
      more: 'More than 10? Call us', date: 'When', service: 'Service',
      pranzo: 'Lunch', cena: 'Dinner', slot: 'What time',
      left: 'seats', full: 'full', closed: 'Closed',
      you: 'Your details', name: 'Full name', phone: 'Phone',
      email: 'Email (optional)', notes: 'Allergies, high chair, anything else (optional)',
      consent: 'I have read the <a href="privacy.html">privacy policy</a> and agree to my data being used for this booking.',
      submit: 'Book the table', sending: 'One moment…',
      done: 'Table booked', code: 'Your code',
      keep: 'Keep it — you need it to cancel.',
      ics: 'Add to calendar', cancel_link: 'Need to cancel?',
      cancel_title: 'Cancel a booking', cancel_code: 'Booking code',
      cancel_tail: 'Last 4 digits of your phone', cancel_do: 'Cancel booking',
      cancel_done: 'Booking cancelled. The seats are free again.',
      closed_day: 'Closed this day',
      no_slots: 'No times available for this service.',
      phone_only: 'Online booking is paused right now. Please call',
      rome_note: 'All times are Rome time.',
      your_time: 'your time', back: 'Back', another: 'New booking',
      err_generic: 'Something went wrong. Try again or give us a call.',
      err_network: 'No connection. Check your network and try again.',
      err_consent: 'We need your consent to store the booking.',
      err_name: 'Please enter your name.',
      err_phone: 'Please enter a valid phone number.',
      err_slot: 'Pick a time.',
      err_taken: 'That time just filled up. Please pick another.',
      loading: 'Loading availability…'
    }
  };

  function lang() { return document.documentElement.lang === 'en' ? 'en' : 'it'; }
  function t(k) { return (STR[lang()] && STR[lang()][k]) || STR.it[k] || k; }
  function locale() { return lang() === 'en' ? 'en-GB' : 'it-IT'; }

  /* --------------------------------------------------------------- state */

  var S = {
    party: 2,
    date: null,
    service: null,
    time: null,
    meta: null,      // capacity / accepting / max_party / rome_today
    days: [],
    busy: false,
    booking: null,   // set once confirmed
    flash: null      // message to surface after a re-render
  };

  /* ------------------------------------------------- date & time helpers */

  // A UTC-midnight Date for a "YYYY-MM-DD". Formatted with timeZone:'UTC' this
  // yields the same calendar label in every zone on earth.
  function ymdUTC(ymd) {
    var p = ymd.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  function fmt(ymd, opts) {
    return new Intl.DateTimeFormat(locale(), Object.assign({ timeZone: 'UTC' }, opts)).format(ymdUTC(ymd));
  }

  function dayShort(ymd) { return fmt(ymd, { weekday: 'short' }); }
  function dayNum(ymd) { return fmt(ymd, { day: 'numeric' }); }
  function monShort(ymd) { return fmt(ymd, { month: 'short' }); }
  function dayLong(ymd) { return fmt(ymd, { weekday: 'long', day: 'numeric', month: 'long' }); }

  // The one sanctioned way to turn a Rome wall-clock slot into a real instant.
  // day.utc_offset comes from Postgres and is correct for that specific date,
  // so this stays right across both DST transitions.
  function instantOf(day, hhmm) {
    return new Date(day.date + 'T' + hhmm + ':00' + day.utc_offset);
  }

  var visitorTZ = (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; }
  })();
  var otherZone = !!visitorTZ && visitorTZ !== ROME;

  function inVisitorTime(day, hhmm) {
    return new Intl.DateTimeFormat(locale(), {
      timeZone: visitorTZ, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(instantOf(day, hhmm));
  }

  /* ----------------------------------------------------------------- api */

  function api(fn, body) {
    return fetch(API + '/' + fn, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: ANON,
        authorization: 'Bearer ' + ANON
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json()
        .catch(function () { return { ok: false, error: 'server_error' }; })
        .then(function (j) { j.status = r.status; return j; });
    }).catch(function () {
      return { ok: false, error: 'network', status: 0 };
    });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function prefersReduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ----------------------------------------------------------- rendering */

  function shell(inner, cls) {
    root.className = 'bk' + (cls ? ' ' + cls : '');
    root.innerHTML = inner;
  }

  function loadAvailability() {
    shell('<p class="bk-loading" role="status">' + esc(t('loading')) + '</p>');
    return api('mythos-availability', { party: S.party }).then(function (r) {
      if (r.ok === false || !r.days) {
        shell('<p class="bk-error" role="alert">' + esc(t('err_generic')) + '</p>');
        return;
      }
      S.meta = r;
      S.days = r.days;

      // Keep the chosen date if it survived the reload, else jump to the first
      // day that is actually open.
      var still = S.date && S.days.some(function (d) { return d.date === S.date && !d.closed; });
      if (!still) {
        var open = S.days.filter(function (d) { return !d.closed; })[0];
        S.date = open ? open.date : (S.days[0] && S.days[0].date) || null;
      }
      S.service = null;
      S.time = null;
      render();
    });
  }

  function currentDay() {
    for (var i = 0; i < S.days.length; i++) if (S.days[i].date === S.date) return S.days[i];
    return null;
  }

  function render() {
    if (S.booking) return renderDone();
    if (S.meta && S.meta.accepting === false) return renderPhoneOnly();

    var day = currentDay();
    var services = day && !day.closed ? (day.services || []) : [];
    if (!S.service && services.length) S.service = services[0].service;

    var h = [];
    h.push('<form class="bk-form" novalidate>');

    /* party ----------------------------------------------------------- */
    h.push('<fieldset class="bk-step"><legend>' + esc(t('people')) + '</legend>');
    h.push('<div class="bk-party" role="group">');
    var maxP = (S.meta && S.meta.max_party) || 10;
    for (var n = 1; n <= maxP; n++) {
      h.push('<button type="button" class="bk-chip' + (n === S.party ? ' is-on' : '') +
        '" data-party="' + n + '" aria-pressed="' + (n === S.party) + '">' + n + '</button>');
    }
    h.push('</div>');
    h.push('<p class="bk-hint">' + esc(t('more')) + ' <a href="tel:' + TEL + '">06 8777 4778</a></p>');
    h.push('</fieldset>');

    /* date ------------------------------------------------------------ */
    h.push('<fieldset class="bk-step"><legend>' + esc(t('date')) + '</legend>');
    h.push('<div class="bk-dates" role="group">');
    S.days.slice(0, HORIZON).forEach(function (d) {
      var on = d.date === S.date;
      h.push('<button type="button" class="bk-day' + (on ? ' is-on' : '') + (d.closed ? ' is-closed' : '') +
        '" data-date="' + esc(d.date) + '"' + (d.closed ? ' disabled' : '') +
        ' aria-pressed="' + on + '" aria-label="' + esc(dayLong(d.date)) + (d.closed ? ' — ' + esc(t('closed')) : '') + '">' +
        '<span class="bk-day-w">' + esc(dayShort(d.date)) + '</span>' +
        '<span class="bk-day-n">' + esc(dayNum(d.date)) + '</span>' +
        '<span class="bk-day-m">' + esc(monShort(d.date)) + '</span>' +
        '</button>');
    });
    h.push('</div></fieldset>');

    /* service + slots -------------------------------------------------- */
    if (day && day.closed) {
      h.push('<p class="bk-note">' + esc(day.note || t('closed_day')) + '</p>');
    } else if (services.length) {
      if (services.length > 1) {
        h.push('<fieldset class="bk-step"><legend>' + esc(t('service')) + '</legend><div class="bk-serv" role="group">');
        services.forEach(function (sv) {
          var on = sv.service === S.service;
          h.push('<button type="button" class="bk-tab' + (on ? ' is-on' : '') + '" data-service="' +
            esc(sv.service) + '" aria-pressed="' + on + '">' + esc(t(sv.service)) + '</button>');
        });
        h.push('</div></fieldset>');
      }

      var slots = [];
      services.forEach(function (sv) { if (sv.service === S.service) slots = sv.slots || []; });

      h.push('<fieldset class="bk-step"><legend>' + esc(t('slot')) + '</legend>');
      if (!slots.length) {
        h.push('<p class="bk-note">' + esc(t('no_slots')) + '</p>');
      } else {
        h.push('<div class="bk-slots" role="group">');
        slots.forEach(function (sl) {
          var on = sl.time === S.time;
          var sub = sl.ok ? (sl.remaining + ' ' + t('left')) : (sl.remaining <= 0 ? t('full') : '—');
          h.push('<button type="button" class="bk-slot' + (on ? ' is-on' : '') + '" data-time="' + esc(sl.time) + '"' +
            (sl.ok ? '' : ' disabled') + ' aria-pressed="' + on + '">' +
            '<span class="bk-slot-t">' + esc(sl.time) + '</span>' +
            '<span class="bk-slot-s">' + esc(sub) + '</span>' +
            '</button>');
        });
        h.push('</div>');

        var tz = esc(t('rome_note'));
        if (otherZone && S.time && day) {
          tz += ' <strong>' + esc(S.time) + ' → ' + esc(inVisitorTime(day, S.time)) + ' ' +
            esc(t('your_time')) + ' (' + esc(visitorTZ) + ')</strong>';
        }
        h.push('<p class="bk-hint bk-tz">' + tz + '</p>');
      }
      h.push('</fieldset>');
    }

    /* details ---------------------------------------------------------- */
    h.push('<fieldset class="bk-step bk-you"><legend>' + esc(t('you')) + '</legend>');
    h.push('<label class="bk-f"><span>' + esc(t('name')) + '</span><input name="name" type="text" autocomplete="name" maxlength="80" required></label>');
    h.push('<label class="bk-f"><span>' + esc(t('phone')) + '</span><input name="phone" type="tel" autocomplete="tel" maxlength="32" required></label>');
    h.push('<label class="bk-f"><span>' + esc(t('email')) + '</span><input name="email" type="email" autocomplete="email" maxlength="120"></label>');
    h.push('<label class="bk-f"><span>' + esc(t('notes')) + '</span><textarea name="notes" rows="2" maxlength="400"></textarea></label>');
    // Honeypot. Positioned off-screen rather than display:none — some bots skip hidden fields.
    h.push('<div class="bk-hp" aria-hidden="true"><label>Azienda<input name="company" type="text" tabindex="-1" autocomplete="off"></label></div>');
    h.push('<label class="bk-consent"><input name="consent" type="checkbox" required><span>' + t('consent') + '</span></label>');
    if (CFG.turnstileSiteKey) {
      h.push('<div class="cf-turnstile" data-sitekey="' + esc(CFG.turnstileSiteKey) + '" data-theme="auto"></div>');
    }
    h.push('<p class="bk-error" role="alert"' + (S.flash ? '' : ' hidden') + '>' + esc(S.flash || '') + '</p>');
    h.push('<button type="submit" class="btn bk-submit">' + esc(t('submit')) + '</button>');
    h.push('</fieldset>');

    h.push('</form>');
    h.push('<p class="bk-cancel-link"><button type="button" class="linkish" data-open-cancel>' + esc(t('cancel_link')) + '</button></p>');

    shell(h.join(''));
    S.flash = null;
    if (window.turnstile && CFG.turnstileSiteKey) {
      try { window.turnstile.render('.cf-turnstile'); } catch (e) { /* already rendered */ }
    }
  }

  function renderPhoneOnly() {
    shell('<p class="bk-note bk-phoneonly">' + esc(t('phone_only')) +
      ' <a href="tel:' + TEL + '">06 8777 4778</a>.</p>');
  }

  function renderDone() {
    var b = S.booking;
    var day = { date: b.service_date, utc_offset: b.utc_offset };
    var h = [];
    h.push('<div class="bk-done" role="status">');
    h.push('<p class="bk-done-k">' + esc(t('done')) + '</p>');
    h.push('<p class="bk-done-l">' + esc(dayLong(b.service_date)) + ' · ' + esc(b.slot_time) + ' · ' +
      esc(b.party) + ' ' + esc(b.party === 1 ? t('person') : t('people_n')) + '</p>');
    if (otherZone && b.utc_offset) {
      h.push('<p class="bk-done-tz">' + esc(b.slot_time) + ' Roma → ' +
        esc(inVisitorTime(day, b.slot_time)) + ' ' + esc(t('your_time')) + '</p>');
    }
    h.push('<p class="bk-code-k">' + esc(t('code')) + '</p>');
    h.push('<p class="bk-code">' + esc(b.code) + '</p>');
    h.push('<p class="bk-hint">' + esc(t('keep')) + '</p>');
    h.push('<div class="bk-done-act">');
    h.push('<button type="button" class="btn btn-ghost" data-ics>' + esc(t('ics')) + '</button>');
    h.push('<button type="button" class="linkish" data-again>' + esc(t('another')) + '</button>');
    h.push('</div></div>');
    shell(h.join(''), 'is-done');
  }

  function renderCancel() {
    var h = [];
    h.push('<form class="bk-form bk-cancelform" novalidate>');
    h.push('<fieldset class="bk-step"><legend>' + esc(t('cancel_title')) + '</legend>');
    h.push('<label class="bk-f"><span>' + esc(t('cancel_code')) + '</span><input name="code" type="text" maxlength="16" autocomplete="off" required placeholder="MY-XXXXX"></label>');
    h.push('<label class="bk-f"><span>' + esc(t('cancel_tail')) + '</span><input name="tail" type="text" inputmode="numeric" maxlength="4" autocomplete="off" required></label>');
    h.push('<p class="bk-error" role="alert" hidden></p>');
    h.push('<button type="submit" class="btn">' + esc(t('cancel_do')) + '</button> ');
    h.push('<button type="button" class="linkish" data-again>' + esc(t('back')) + '</button>');
    h.push('</fieldset></form>');
    shell(h.join(''), 'is-cancel');
  }

  /* ------------------------------------------------------------- events */

  root.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('button');
    if (!el || S.busy) return;

    if (el.dataset.party) {
      S.party = +el.dataset.party;
      S.time = null;
      loadAvailability();                 // remaining seats depend on party size
      return;
    }
    if (el.dataset.date) { S.date = el.dataset.date; S.service = null; S.time = null; render(); return; }
    if (el.dataset.service) { S.service = el.dataset.service; S.time = null; render(); return; }
    if (el.dataset.time) { S.time = el.dataset.time; render(); focusDetails(); return; }
    if (el.hasAttribute('data-open-cancel')) { renderCancel(); return; }
    if (el.hasAttribute('data-again')) { S.booking = null; loadAvailability(); return; }
    if (el.hasAttribute('data-ics')) { downloadIcs(); return; }
  });

  function focusDetails() {
    var f = root.querySelector('.bk-you input[name=name]');
    if (f && !f.value) f.focus({ preventScroll: true });
  }

  root.addEventListener('submit', function (e) {
    e.preventDefault();
    if (S.busy) return;
    var form = e.target;
    if (form.classList.contains('bk-cancelform')) submitCancel(form);
    else submitBooking(form);
  });

  function showErr(form, msg) {
    var box = form.querySelector('.bk-error');
    if (!box) return;
    box.textContent = msg;
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest', behavior: prefersReduced() ? 'auto' : 'smooth' });
  }

  function submitBooking(form) {
    var d = new FormData(form);
    var name = (d.get('name') || '').toString().trim();
    var phone = (d.get('phone') || '').toString().trim();

    if (!S.time) return showErr(form, t('err_slot'));
    if (name.length < 2) return showErr(form, t('err_name'));
    if ((phone.match(/\d/g) || []).length < 6) return showErr(form, t('err_phone'));
    if (!d.get('consent')) return showErr(form, t('err_consent'));

    var tf = form.querySelector('[name="cf-turnstile-response"]');
    var token = tf ? tf.value : '';

    var btn = form.querySelector('.bk-submit');
    S.busy = true;
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = t('sending'); }

    api('mythos-book', {
      party: S.party,
      date: S.date,
      time: S.time,
      name: name,
      phone: phone,
      email: (d.get('email') || '').toString().trim(),
      notes: (d.get('notes') || '').toString().trim(),
      company: (d.get('company') || '').toString(),
      consent: true,
      token: token
    }).then(function (r) {
      S.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || t('submit'); }

      if (r.ok) {
        var day = currentDay();
        S.booking = {
          code: r.code,
          service_date: S.date,
          slot_time: S.time,
          party: S.party,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          utc_offset: day ? day.utc_offset : null
        };
        renderDone();
        root.scrollIntoView({ block: 'start', behavior: prefersReduced() ? 'auto' : 'smooth' });
        return;
      }

      if (r.error === 'network') return showErr(form, t('err_network'));

      // A rejection usually means the room filled up while the form sat open,
      // so refresh the grid rather than leaving stale seat counts on screen.
      if (r.error === 'full' || r.error === 'too_late' || r.error === 'no_such_slot') {
        S.flash = r.message || t('err_taken');
        loadAvailability();
        return;
      }

      showErr(form, r.message || t('err_generic'));
      if (window.turnstile) { try { window.turnstile.reset(); } catch (e) { /* noop */ } }
    });
  }

  function submitCancel(form) {
    var d = new FormData(form);
    var code = (d.get('code') || '').toString().trim().toUpperCase();
    var tail = (d.get('tail') || '').toString().replace(/\D/g, '');
    if (!code || tail.length !== 4) return showErr(form, t('err_generic'));

    S.busy = true;
    api('mythos-cancel', { code: code, phone_tail: tail }).then(function (r) {
      S.busy = false;
      if (r.ok) {
        shell('<p class="bk-note bk-cancelled" role="status">' + esc(t('cancel_done')) +
          '</p><p><button type="button" class="linkish" data-again>' + esc(t('another')) + '</button></p>', 'is-cancel');
        return;
      }
      showErr(form, r.error === 'network' ? t('err_network') : (r.message || t('err_generic')));
    });
  }

  /* ----------------------------------------------------------------- ics */

  function icsStamp(iso) {
    // iso is a real instant from the server; render it as UTC basic format.
    return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  function downloadIcs() {
    var b = S.booking;
    if (!b || !b.starts_at) return;
    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mythos//Prenotazioni//IT',
      'BEGIN:VEVENT',
      'UID:' + b.code + '@mythos',
      'DTSTAMP:' + icsStamp(new Date().toISOString()),
      'DTSTART:' + icsStamp(b.starts_at),
      b.ends_at ? 'DTEND:' + icsStamp(b.ends_at) : '',
      'SUMMARY:Mythos — tavolo per ' + b.party,
      'LOCATION:Via Tuscolana 596, 00178 Roma',
      'DESCRIPTION:Codice prenotazione ' + b.code + '. Tel 06 8777 4778.',
      'END:VEVENT', 'END:VCALENDAR'
    ].filter(Boolean);

    var blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mythos-' + b.code + '.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ---------------------------------------------------------------- boot */

  document.addEventListener('mythos:lang', function () {
    if (S.booking) renderDone(); else render();
  });

  if (!API || !ANON) {
    renderPhoneOnly();
    return;
  }

  loadAvailability();
})();
