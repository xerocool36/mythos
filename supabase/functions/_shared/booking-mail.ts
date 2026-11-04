/**
 * booking-mail — every e-mail about a table, in one place.
 *
 *   guestConfirmation   to the guest, when the booking is taken
 *   guestCancellation   to the guest, when they cancel from the site
 *   ownerNewBooking     to the restaurant, for every new booking
 *   ownerCancellation   to the restaurant, when a guest cancels
 *
 * All four go through mail-template.ts so they share one look: the Mythos
 * roundel on top, a ticket-style booking card, the x3ro credit at the foot.
 * The cancel link reuses the widget's form via prenota.html?annulla=CODE&t=TAIL;
 * the pair (code + last phone digits) is the token, and the link only travels
 * to the address on the booking.
 */

import { C, codeChip, rowsTable, SANS, SERIF, shell, siteUrl, VENUE } from './mail-template.ts';
import { escapeHtml, romeDateLabel, romeTimeLabel, ROME } from './util.ts';

export interface BookingMailInput {
  name: string;
  code: string;
  party: number;
  /** ISO instant of the table. */
  startsAt: string;
  /** 'pranzo' | 'cena' */
  service?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Last digits of the phone: one half of the cancel token. */
  phoneTail: string;
  notes?: string | null;
}

export interface OutboundMail {
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

const TURN_MINUTES = 90;

export function cancelLink(code: string, phoneTail: string): string {
  const params = new URLSearchParams({ annulla: code, t: phoneTail });
  return `${siteUrl()}/prenota.html?${params.toString()}`;
}

/** "giulia DE rossi" -> "Giulia De Rossi": guests type names any old way. */
function properName(name: string): string {
  return name.trim().split(/\s+/)
    .map((w) => w.charAt(0).toLocaleUpperCase('it-IT') + w.slice(1).toLocaleLowerCase('it-IT'))
    .join(' ');
}

function firstName(name: string): string {
  return properName(name).split(' ')[0] || name;
}

function people(party: number): string {
  return party === 1 ? '1 persona' : `${party} persone`;
}

function serviceWord(service: string | null | undefined, startsAt: Date): string {
  if (service === 'pranzo' || service === 'cena') return service;
  const hour = Number(new Intl.DateTimeFormat('it-IT', { timeZone: ROME, hour: 'numeric', hour12: false }).format(startsAt));
  return hour < 17 ? 'pranzo' : 'cena';
}

function parts(startsAt: Date) {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('it-IT', { timeZone: ROME, ...o }).format(startsAt);
  return {
    weekday: f({ weekday: 'long' }),
    day: f({ day: 'numeric' }),
    month: f({ month: 'long' }),
    dateLabel: romeDateLabel(startsAt),
    time: romeTimeLabel(startsAt),
  };
}

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** "Add to Google Calendar" — a plain link, works from any mail client. */
function calendarLink(b: BookingMailInput, startsAt: Date): string {
  const end = new Date(startsAt.getTime() + TURN_MINUTES * 60_000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${VENUE.name} — tavolo per ${b.party}`,
    dates: `${icsStamp(startsAt)}/${icsStamp(end)}`,
    location: `${VENUE.name}, ${VENUE.address}`,
    details: `Codice prenotazione ${b.code}. Tel ${VENUE.phone}.\nPer annullare: ${cancelLink(b.code, b.phoneTail)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** wa.me wants the number in international form, digits only. */
function whatsappLink(phone: string): string | null {
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (/^3\d{8,9}$/.test(digits)) digits = '39' + digits;
  return /^\d{8,15}$/.test(digits) ? `https://wa.me/${digits}` : null;
}

/** The ticket: a date tile on the left, time and details on the right. */
function ticket(b: BookingMailInput, startsAt: Date, struck = false): string {
  const p = parts(startsAt);
  const service = serviceWord(b.service, startsAt);
  const strike = struck ? 'text-decoration:line-through;' : '';
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border:1.5px solid ${struck ? C.hair : C.blue};border-radius:8px">
      <tr>
        <td width="104" align="center" valign="middle" style="width:104px;background:${struck ? C.dim : C.blue};border-radius:6px 0 0 6px;padding:16px 8px">
          <div style="font-family:${SANS};font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${C.goldPale}">${escapeHtml(p.weekday)}</div>
          <div style="font-family:${SERIF};font-size:40px;line-height:1.1;color:#FFFFFF;${strike}">${escapeHtml(p.day)}</div>
          <div style="font-family:${SANS};font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${C.goldPale}">${escapeHtml(p.month)}</div>
        </td>
        <td valign="middle" style="padding:14px 18px">
          <div style="font-family:${SERIF};font-size:30px;line-height:1.1;color:${C.ink};${strike}">${escapeHtml(p.time)}</div>
          <div style="padding-top:4px;font-family:${SANS};font-size:14px;color:${C.soft}">${service === 'pranzo' ? 'Pranzo' : 'Cena'} &middot; ${escapeHtml(people(b.party))}</div>
          <div style="padding-top:10px;font-family:${SANS};font-size:12px;color:${C.dim}">Codice&nbsp; ${codeChip(b.code)}</div>
        </td>
      </tr>
    </table>`;
}

function notesBox(notes: string, heading: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:14px">
      <tr><td style="background:${C.alertBg};border-left:4px solid ${C.gold};padding:12px 14px">
        <div style="font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase;color:${C.alertInk}">${escapeHtml(heading)}</div>
        <div style="padding-top:4px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink}">${escapeHtml(notes)}</div>
      </td></tr>
    </table>`;
}

const SPACER = '<div style="height:16px;line-height:16px;font-size:0">&nbsp;</div>';

/* ------------------------------------------------------------------ guest */

export function guestConfirmation(b: BookingMailInput): OutboundMail {
  b = { ...b, name: properName(b.name) };
  const startsAt = new Date(b.startsAt);
  const p = parts(startsAt);
  const name = firstName(b.name);
  const service = serviceWord(b.service, startsAt);
  const cancel = cancelLink(b.code, b.phoneTail);
  const calendar = calendarLink(b, startsAt);

  return {
    subject: `${name}, il tuo tavolo è confermato · ${p.weekday} ${p.day} ${p.month} alle ${p.time}`,
    text: [
      `Ciao ${name},`,
      '',
      `il tuo tavolo da ${VENUE.name} è confermato. Ti aspettiamo a ${service}!`,
      '',
      `Quando:   ${p.dateLabel}, ore ${p.time}`,
      `Persone:  ${people(b.party)}`,
      `A nome:   ${b.name}`,
      `Codice:   ${b.code}`,
      ...(b.notes ? [`Note:     ${b.notes}`] : []),
      '',
      `Dove:     ${VENUE.address} (${VENUE.metro})`,
      `Mappa:    ${VENUE.maps}`,
      `Telefono: ${VENUE.phone}`,
      '',
      'Aggiungi al calendario:',
      calendar,
      '',
      'Contrattempo? Annulla da qui, così il tavolo torna libero per qualcun altro:',
      cancel,
      '',
      'Kalí órexi! Buon appetito, e a presto.',
      'Lo staff di Mythos',
    ].join('\n'),
    html: shell({
      preheader: `${people(b.party)}, ${p.weekday} ${p.day} ${p.month} alle ${p.time}. Codice ${b.code}.`,
      eyebrow: 'Prenotazione confermata',
      title: `Ciao ${name}, ti aspettiamo!`,
      intro: `Il tuo tavolo a ${service} è prenotato. Qui sotto trovi tutto quello che serve.`,
      body: ticket(b, startsAt) + (b.notes ? notesBox(b.notes, 'Le tue note per la cucina') : ''),
      buttons: [
        { label: 'Aggiungi al calendario', href: calendar },
        { label: 'Come arrivare', href: VENUE.maps, kind: 'ghost' },
      ],
      notes: [
        `<strong style="color:${C.ink}">Allergie o esigenze particolari?</strong> Chiamaci allo ` +
        `<a href="tel:${VENUE.phoneHref}" style="color:${C.blue};text-decoration:none">${VENUE.phone}</a> ` +
        'e prepariamo tutto prima del tuo arrivo.',
        `Contrattempo? <a href="${escapeHtml(cancel)}" style="color:${C.red}">Annulla la prenotazione</a> ` +
        'per tempo: il tavolo torna libero per qualcun altro.',
      ],
    }),
  };
}

export function guestCancellation(b: BookingMailInput): OutboundMail {
  b = { ...b, name: properName(b.name) };
  const startsAt = new Date(b.startsAt);
  const p = parts(startsAt);
  const name = firstName(b.name);
  const again = `${siteUrl()}/prenota.html`;

  return {
    subject: `Prenotazione annullata · ${p.weekday} ${p.day} ${p.month} alle ${p.time} · ${VENUE.name}`,
    text: [
      `Ciao ${name},`,
      '',
      `abbiamo annullato la tua prenotazione per ${p.dateLabel} alle ${p.time} (${people(b.party)}, codice ${b.code}).`,
      'Grazie per averci avvisato: il tavolo è di nuovo libero.',
      '',
      'Quando vuoi tornare, prenoti da qui:',
      again,
      '',
      'A presto,',
      'Lo staff di Mythos',
    ].join('\n'),
    html: shell({
      preheader: `Il tavolo del ${p.day} ${p.month} alle ${p.time} è stato annullato.`,
      eyebrow: 'Prenotazione annullata',
      title: `Grazie per averci avvisato, ${name}`,
      intro: 'La tua prenotazione è annullata e il tavolo è di nuovo libero. Speriamo di vederti presto.',
      body: ticket(b, startsAt, true),
      buttons: [{ label: 'Prenota un altro giorno', href: again }],
      signoff: 'bye',
    }),
  };
}

/* ------------------------------------------------------------------ staff */

function guestRows(b: BookingMailInput): string {
  const phone = b.phone ?? '';
  return rowsTable([
    { label: 'Nome', value: `<strong>${escapeHtml(b.name)}</strong>` },
    ...(phone
      ? [{
        label: 'Telefono',
        value: `<a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}" style="color:${C.blue};text-decoration:none">${escapeHtml(phone)}</a>`,
      }]
      : []),
    ...(b.email
      ? [{ label: 'Email', value: `<a href="mailto:${escapeHtml(b.email)}" style="color:${C.blue};text-decoration:none">${escapeHtml(b.email)}</a>` }]
      : []),
  ]);
}

function staffButtons(b: BookingMailInput) {
  const phone = b.phone ?? '';
  const wa = phone ? whatsappLink(phone) : null;
  return [
    ...(phone ? [{ label: 'Chiama', href: `tel:${phone.replace(/[^\d+]/g, '')}` }] : []),
    ...(wa ? [{ label: 'WhatsApp', href: wa, kind: 'ghost' as const }] : []),
    { label: 'Apri la console', href: `${siteUrl()}/admin.html`, kind: 'ghost' as const },
  ];
}

export function ownerNewBooking(b: BookingMailInput): OutboundMail {
  b = { ...b, name: properName(b.name) };
  const startsAt = new Date(b.startsAt);
  const p = parts(startsAt);
  const service = serviceWord(b.service, startsAt);

  return {
    subject: `Nuova prenotazione · ${p.weekday} ${p.day} ${p.month} ${p.time} · ${b.party} pax · ${b.name}`,
    replyTo: b.email || undefined,
    text: [
      'NUOVA PRENOTAZIONE — Mythos Cucina Greca',
      '',
      `Quando:    ${p.dateLabel}, ore ${p.time} (${service})`,
      `Coperti:   ${b.party}`,
      `Nome:      ${b.name}`,
      `Telefono:  ${b.phone || '—'}`,
      `Email:     ${b.email || '—'}`,
      `Note:      ${b.notes || '—'}`,
      `Codice:    ${b.code}`,
      '',
      `Console:   ${siteUrl()}/admin.html`,
    ].join('\n'),
    html: shell({
      internal: true,
      preheader: `${b.name}, ${people(b.party)}, ${p.weekday} ${p.day} alle ${p.time}${b.notes ? ' — con note' : ''}.`,
      eyebrow: 'Nuova prenotazione dal sito',
      title: `${b.name} · ${people(b.party)}`,
      body: ticket(b, startsAt) +
        (b.notes ? notesBox(b.notes, 'Note del cliente — leggere prima del servizio') : '') +
        SPACER + guestRows(b),
      buttons: staffButtons(b),
      notes: [
        'La prenotazione è già confermata e i posti sono stati scalati. ' +
        (b.email
          ? 'Il cliente ha ricevuto la conferma via email: rispondendo a questa mail scrivi direttamente a lui.'
          : 'Il cliente non ha lasciato l’email: ha solo il codice a schermo.'),
      ],
    }),
  };
}

export function ownerCancellation(b: BookingMailInput): OutboundMail {
  b = { ...b, name: properName(b.name) };
  const startsAt = new Date(b.startsAt);
  const p = parts(startsAt);

  return {
    subject: `Annullata · ${p.weekday} ${p.day} ${p.month} ${p.time} · ${b.party} pax · ${b.name}`,
    replyTo: b.email || undefined,
    text: [
      'PRENOTAZIONE ANNULLATA DAL CLIENTE — Mythos Cucina Greca',
      '',
      `Quando:    ${p.dateLabel}, ore ${p.time}`,
      `Coperti liberati: ${b.party}`,
      `Nome:      ${b.name}`,
      `Telefono:  ${b.phone || '—'}`,
      `Codice:    ${b.code}`,
    ].join('\n'),
    html: shell({
      internal: true,
      preheader: `${b.name} ha annullato: ${b.party} posti di nuovo liberi ${p.weekday} ${p.day} alle ${p.time}.`,
      eyebrow: 'Annullata dal cliente',
      title: `${people(b.party)} di nuovo liberi`,
      intro: `${b.name} ha annullato dal sito. I posti sono già tornati disponibili per le prenotazioni online.`,
      body: ticket(b, startsAt, true) + SPACER + guestRows(b),
      buttons: staffButtons(b),
    }),
  };
}
