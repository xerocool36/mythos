/**
 * mail-template — one house style for every e-mail the Mythos site sends.
 *
 * Old-fashioned HTML on purpose: nested tables, inline styles, no <style> block,
 * no web fonts. Outlook strips all three. The only images are the two logos,
 * hosted on the site as PNG (Outlook and older Gmail apps do not render WebP),
 * each with alt text so the mail still reads with images blocked. Every mail
 * also ships a text/plain part, built by the caller.
 */

import { escapeHtml } from './util.ts';

export const C = {
  plaster: '#EEF0F6',
  card: '#FFFFFF',
  ink: '#131851',
  soft: '#4A4F7A',
  dim: '#6A6F92',
  blue: '#0B14A0',
  navy: '#131851',
  gold: '#C4922E',
  goldPale: '#FBF5EA',
  hair: '#DCDEEA',
  alertBg: '#FFF4E0',
  alertInk: '#7A4B00',
  red: '#A3241B',
};

export const SERIF = "Georgia,'Times New Roman',serif";
export const SANS = 'Helvetica,Arial,sans-serif';

export const VENUE = {
  name: 'Mythos Cucina Greca',
  address: 'Via Tuscolana 596, Roma',
  metro: 'Metro A, Arco di Travertino',
  phone: '06 8777 4778',
  phoneHref: '+390687774778',
  maps: 'https://www.google.com/maps/place/?q=place_id:ChIJJd0U9yYzLxMRcFHSK2lnc4o',
};

export function siteUrl(): string {
  return (Deno.env.get('MYTHOS_SITE_URL') ?? 'https://tavernamythos.com').replace(/\/+$/, '');
}

/** One label/value line. `value` is trusted markup: escape before passing. */
export interface Row {
  label: string;
  value: string;
}

export interface Button {
  label: string;
  href: string;
  /** solid = blue fill, ghost = outlined, danger = red outline */
  kind?: 'solid' | 'ghost' | 'danger';
}

export interface ShellInput {
  /** Hidden preview line shown by inbox lists next to the subject. */
  preheader: string;
  eyebrow: string;
  title: string;
  /** Lead paragraph, plain text. */
  intro?: string;
  /** Pre-rendered block (ticket, guest card…) placed under the intro. */
  body?: string;
  buttons?: Button[];
  /** Trusted markup paragraphs, after the buttons. */
  notes?: string[];
  /** Staff mail: drops the guest sign-off, keeps the x3ro footer. */
  internal?: boolean;
  /** Guest sign-off: 'meal' (default) wishes buon appetito, 'bye' just says a presto. */
  signoff?: 'meal' | 'bye';
}

function buttonCell(b: Button): string {
  const kind = b.kind ?? 'solid';
  const bg = kind === 'solid' ? C.blue : C.card;
  const fg = kind === 'solid' ? '#FFFFFF' : kind === 'danger' ? C.red : C.blue;
  const border = kind === 'solid' ? C.blue : kind === 'danger' ? C.red : C.blue;
  return `<td style="padding:0 8px 10px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">
        <tr><td style="background:${bg};border:1.5px solid ${border};border-radius:6px;padding:11px 18px">
          <a href="${escapeHtml(b.href)}" style="font-family:${SANS};font-size:14px;font-weight:bold;color:${fg};text-decoration:none;display:inline-block;white-space:nowrap">${escapeHtml(b.label)}</a>
        </td></tr>
      </table>
    </td>`;
}

/** Buttons wrap on narrow screens: each sits in its own inline table. */
function buttonsBlock(buttons: Button[]): string {
  return buttons.map((b) => `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" style="border-collapse:collapse">
          <tr>${buttonCell(b)}</tr>
        </table>`).join('') + '<div style="clear:both;line-height:0;font-size:0">&nbsp;</div>';
}

export function rowsTable(rows: Row[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${
    rows.map(({ label, value }) => `
      <tr>
        <td style="padding:8px 14px 8px 0;border-top:1px solid ${C.hair};font-family:${SANS};font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${C.dim};white-space:nowrap;vertical-align:top;width:1%">${escapeHtml(label)}</td>
        <td style="padding:8px 0;border-top:1px solid ${C.hair};font-family:${SANS};font-size:15px;color:${C.ink};vertical-align:top">${value}</td>
      </tr>`).join('')
  }</table>`;
}

export function codeChip(code: string): string {
  return `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:15px;font-weight:bold;letter-spacing:.1em;color:${C.blue};background:${C.plaster};padding:3px 8px;border-radius:4px;white-space:nowrap">${escapeHtml(code)}</span>`;
}

export function shell(input: ShellInput): string {
  const base = siteUrl();
  const { preheader, eyebrow, title, intro, body, buttons, notes, internal, signoff: farewell } = input;

  const signoff = internal ? '' : farewell === 'bye'
    ? `
          <tr><td style="padding:4px 32px 28px">
            <p style="margin:0;font-family:${SANS};font-size:14px;color:${C.soft};line-height:1.6">A presto,<br>lo staff di Mythos</p>
          </td></tr>`
    : `
          <tr><td style="padding:4px 32px 28px">
            <p style="margin:0 0 4px;font-family:${SERIF};font-size:20px;font-style:italic;color:${C.blue}">Kalí órexi!</p>
            <p style="margin:0;font-family:${SANS};font-size:14px;color:${C.soft};line-height:1.6">Buon appetito, e a presto.<br>Lo staff di Mythos</p>
          </td></tr>`;

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.plaster};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.plaster}">${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.plaster}">
    <tr>
      <td align="center" style="padding:24px 12px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="580" style="max-width:580px;width:100%;background:${C.card};border-radius:10px;overflow:hidden;border:1px solid ${C.hair}">

          <tr><td align="center" style="padding:26px 24px 16px;background:${C.card}">
            <a href="${base}/" style="text-decoration:none">
              <img src="${base}/assets/img/mail/mythos-logo.png" width="76" height="76" alt="Mythos" style="display:block;border:0;width:76px;height:76px;margin:0 auto">
            </a>
            <div style="padding-top:10px;font-family:${SANS};font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:${C.gold}">Cucina greca &middot; Roma</div>
          </td></tr>
          <tr><td style="height:3px;line-height:3px;font-size:0;background:${C.gold}">&nbsp;</td></tr>
          <tr><td style="height:6px;line-height:6px;font-size:0;background:${C.blue}">&nbsp;</td></tr>

          <tr><td style="padding:30px 32px 6px">
            <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:.22em;text-transform:uppercase;color:${C.gold}">${escapeHtml(eyebrow)}</p>
            <h1 style="margin:0 0 12px;font-family:${SERIF};font-size:28px;font-weight:normal;line-height:1.2;color:${C.ink}">${escapeHtml(title)}</h1>
            ${intro ? `<p style="margin:0 0 22px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.soft}">${escapeHtml(intro)}</p>` : ''}
            ${body ?? ''}
            ${buttons && buttons.length ? `<div style="padding-top:20px">${buttonsBlock(buttons)}</div>` : ''}
            ${(notes ?? []).map((n) => `<p style="margin:14px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.dim}">${n}</p>`).join('')}
          </td></tr>

          <tr><td style="height:22px;line-height:22px;font-size:0">&nbsp;</td></tr>
          ${signoff}

          <tr><td style="padding:20px 32px;background:${C.plaster};border-top:1px solid ${C.hair}">
            <p style="margin:0 0 4px;font-family:${SANS};font-size:13px;font-weight:bold;color:${C.ink}">${escapeHtml(VENUE.name)}</p>
            <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.soft}">
              ${escapeHtml(VENUE.address)} &middot; ${escapeHtml(VENUE.metro)}<br>
              <a href="tel:${VENUE.phoneHref}" style="color:${C.blue};text-decoration:none">${escapeHtml(VENUE.phone)}</a>
              &middot; <a href="${base}/" style="color:${C.blue};text-decoration:none">tavernamythos.com</a>
            </p>
          </td></tr>

          <tr><td align="center" style="padding:16px 24px 18px;background:${C.card};border-top:1px solid ${C.hair}">
            <a href="https://x3roautomations.it" style="text-decoration:none">
              <img src="${base}/assets/img/mail/x3ro-logo.png" width="96" height="60" alt="x3ro Automations" style="display:block;border:0;width:96px;height:60px;margin:0 auto">
            </a>
            <p style="margin:6px 0 0;font-family:${SANS};font-size:11px;color:${C.dim}">Sito e prenotazioni online realizzati da <a href="https://x3roautomations.it" style="color:${C.dim}">x3ro Automations</a></p>
          </td></tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
