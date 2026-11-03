/**
 * booking-mail — the confirmation a guest receives when they leave an e-mail.
 *
 * Ported from the MASTO engine and cut down to the one mail Mythos needs: every
 * online booking here is confirmed on the spot, so there is no request/refusal
 * pair. The cancel link reuses the widget's own form through
 * prenota.html?annulla=CODE&t=TAIL.
 *
 * Deliberately old-fashioned HTML — nested tables, inline styles, no <style>
 * block, no web fonts, no images. Outlook strips or ignores all three. Every
 * mail also ships a text/plain part.
 */

import { escapeHtml, romeDateLabel, romeTimeLabel } from './util.ts';

const PLASTER = '#F5F6F8';
const CARD_BG = '#FFFFFF';
const INK = '#131851';
const INK_SOFT = '#4A4F7A';
const INK_DIM = '#6A6F92';
const BLUE = '#0B14A0';
const GOLD = '#C4922E';
const HAIRLINE = '#DCDEEA';

const SERIF = "Georgia,'Times New Roman',serif";
const SANS = 'Helvetica,Arial,sans-serif';

const VENUE_NAME = 'Mythos Cucina Greca';
const VENUE_ADDRESS = 'Via Tuscolana 596, Roma';
const VENUE_PHONE = '06 8777 4778';
const VENUE_PHONE_HREF = '+390687774778';

export interface BookingMailInput {
  name: string;
  code: string;
  party: number;
  /** ISO instant of the table. */
  startsAt: string;
  /** Last digits of the phone: one half of the cancel token. */
  phoneTail: string;
  notes?: string | null;
}

export interface OutboundMail {
  subject: string;
  text: string;
  html: string;
}

function siteUrl(): string {
  return (Deno.env.get('MYTHOS_SITE_URL') ?? 'https://tavernamythos.com').replace(/\/+$/, '');
}

/**
 * The pair (booking code + last phone digits) IS the cancel token —
 * mythos.cancel() refuses anything else with an indistinguishable not_found —
 * and the link only travels to the address on the booking.
 */
export function cancelLink(code: string, phoneTail: string): string {
  const params = new URLSearchParams({ annulla: code, t: phoneTail });
  return `${siteUrl()}/prenota.html?${params.toString()}`;
}

function people(party: number): string {
  return party === 1 ? '1 persona' : `${party} persone`;
}

function row(label: string, value: string): string {
  return `
          <tr>
            <td style="padding:7px 20px 7px 0;font-family:${SANS};font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${INK_DIM};white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
            <td style="padding:7px 0;font-family:${SANS};font-size:15px;color:${INK};vertical-align:top">${value}</td>
          </tr>`;
}

export function confirmationMail(b: BookingMailInput): OutboundMail {
  const startsAt = new Date(b.startsAt);
  const dateLabel = romeDateLabel(startsAt);
  const timeLabel = romeTimeLabel(startsAt);
  const link = cancelLink(b.code, b.phoneTail);
  const title = `${dateLabel} alle ${timeLabel}`;

  const text = [
    `Ciao ${b.name},`,
    '',
    `la tua prenotazione da ${VENUE_NAME} è confermata.`,
    '',
    `Data:     ${dateLabel}`,
    `Ora:      ${timeLabel}`,
    `Persone:  ${people(b.party)}`,
    `Nome:     ${b.name}`,
    `Codice:   ${b.code}`,
    ...(b.notes ? [`Note:     ${b.notes}`] : []),
    '',
    `Dove siamo: ${VENUE_ADDRESS} (Metro A, Arco di Travertino)`,
    `Telefono:   ${VENUE_PHONE}`,
    '',
    'Se hai un imprevisto puoi annullare da qui:',
    link,
    '',
    'Ti chiediamo solo di avvisarci per tempo: il tavolo torna disponibile per qualcun altro.',
    '',
    'A presto,',
    'lo staff di Mythos',
  ].join('\n');

  const rows = [
    row('Persone', escapeHtml(people(b.party))),
    row('A nome di', escapeHtml(b.name)),
    row('Codice', `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:15px;letter-spacing:.08em;color:${BLUE}">${escapeHtml(b.code)}</span>`),
    ...(b.notes ? [row('Note', escapeHtml(b.notes))] : []),
  ].join('');

  const html = `<!doctype html>
<html lang="it">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${PLASTER}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PLASTER};padding:28px 14px">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:${CARD_BG};border:1px solid ${HAIRLINE}">

          <tr><td style="background:${BLUE};padding:24px 32px 20px;border-bottom:3px solid ${GOLD}" align="center">
            <div style="font-family:${SERIF};font-size:24px;letter-spacing:.28em;color:${PLASTER}">MYTHOS</div>
            <div style="font-family:${SANS};font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:${GOLD};padding-top:7px">Cucina greca · Roma</div>
          </td></tr>

          <tr><td style="padding:30px 32px 26px">
            <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:${BLUE}">Prenotazione confermata</p>
            <h1 style="margin:0 0 14px;font-family:${SERIF};font-size:27px;font-weight:400;line-height:1.2;color:${INK}">${escapeHtml(title)}</h1>
            <p style="margin:0 0 24px;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_SOFT}">${escapeHtml(`Ciao ${b.name}, il tuo tavolo è prenotato. Ti aspettiamo.`)}</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 26px">${rows}
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 26px">
              <tr>
                <td style="background:${BLUE};padding:13px 26px">
                  <a href="${escapeHtml(link)}" style="font-family:${SANS};font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:${PLASTER};text-decoration:none;display:inline-block">Annulla la prenotazione</a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${INK_DIM}">Se hai un imprevisto annulla per tempo: il tavolo torna libero per qualcun altro.</p>
          </td></tr>

          <tr><td style="padding:22px 32px 26px;border-top:1px solid ${HAIRLINE}">
            <p style="margin:0 0 10px;font-family:${SANS};font-size:14px;color:${INK_SOFT};line-height:1.6">
              ${escapeHtml(VENUE_ADDRESS)} · Metro A, Arco di Travertino<br>
              <a href="tel:${VENUE_PHONE_HREF}" style="color:${BLUE};text-decoration:none">${escapeHtml(VENUE_PHONE)}</a>
            </p>
            <p style="margin:0;font-family:${SANS};font-size:14px;color:${INK_SOFT}">A presto,<br>lo staff di Mythos</p>
          </td></tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: `Prenotazione confermata · ${title} · ${VENUE_NAME}`,
    text,
    html,
  };
}
