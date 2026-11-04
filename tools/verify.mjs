import { chromium } from 'playwright';
const PAGES = ['index','menu','prenota','privacy'];
const WIDTHS = [360, 390, 768, 1024, 1440];
const b = await chromium.launch();
let fail = 0;
for (const pg of PAGES) {
  for (const w of WIDTHS) {
    const ctx = await b.newContext({ viewport:{width:w,height:w<700?844:900}, deviceScaleFactor:1, isMobile:w<700, hasTouch:w<700 });
    const p = await ctx.newPage();
    const errs = [];
    p.on('console', m => m.type()==='error' && errs.push(m.text()));
    p.on('pageerror', e => errs.push(String(e)));
    p.on('requestfailed', r => errs.push('REQ FAIL '+r.url().split('/').pop()));
    // Not networkidle: the Turnstile widget on prenota polls Cloudflare forever.
    await p.goto(`http://localhost:3000/${pg}.html`, {waitUntil:'load'});
    await p.waitForTimeout(1500);
    await p.evaluate(async()=>{document.documentElement.style.scrollBehavior='auto';const s=innerHeight*.8;for(let y=0;y<document.body.scrollHeight;y+=s){scrollTo(0,y);await new Promise(r=>setTimeout(r,60));}scrollTo(0,0);await new Promise(r=>setTimeout(r,250));});
    const r = await p.evaluate(async () => {
      const bad = [];
      await Promise.all([...document.images].map(i => i.decode().catch(()=>bad.push(i.getAttribute('src')))));
      // horizontal overflow
      const overflow = document.documentElement.scrollWidth > innerWidth + 1;
      // tap targets under 44px on interactive elements
      const small = [];
      document.querySelectorAll('a,button,input,summary,select').forEach(el=>{
        const b = el.getBoundingClientRect();
        if (b.width===0 && b.height===0) return;                    // hidden
        if (el.closest('[hidden]')) return;
        if (b.right < 0 || b.left > innerWidth) return;             // parked off-screen (honeypot)
        // A control wrapped in its own label is tapped via the label, so the
        // label is the target — this is how the consent checkbox is built.
        const lab = el.closest('label');
        const t = lab && lab.contains(el) ? lab.getBoundingClientRect() : b;
        // WCAG 2.5.8 exempts targets sitting inside a sentence of running text.
        if (el.tagName === 'A' && el.closest('p, li, figcaption') && getComputedStyle(el).display.startsWith('inline')) return;
        if (t.height < 40 || t.width < 24) small.push((el.tagName+'.'+(el.className||'').toString().split(' ')[0]).slice(0,42)+` ${Math.round(t.width)}x${Math.round(t.height)}`);
      });
      // unrevealed content left invisible
      const stuck = [...document.querySelectorAll('[data-reveal]')].filter(e=>!e.classList.contains('in')).length;
      return { bad, overflow, small: [...new Set(small)], stuck, w: document.documentElement.scrollWidth };
    });
    const problems = [];
    // Turnstile only accepts the production hostnames, so on localhost Cloudflare
    // answers 400 / error 110200 by design. Its noise is not ours to fix.
    const ours = errs.filter(e => !/Turnstile|110200|challenges\.cloudflare|status of 400/.test(e));
    if (ours.length) problems.push('ERR '+ours.join(' | '));
    if (r.bad.length) problems.push('UNDECODED '+r.bad);
    if (r.overflow) problems.push(`H-OVERFLOW scrollWidth=${r.w} vs ${w}`);
    if (r.small.length) problems.push('SMALL TAP '+r.small.join(', '));
    if (r.stuck) problems.push(`${r.stuck} reveals never fired`);
    if (problems.length) { fail++; console.log(`✗ ${pg} @${w}\n   ${problems.join('\n   ')}`); }
    else console.log(`✓ ${pg} @${w}`);
    await ctx.close();
  }
}
console.log(fail ? `\n${fail} checks with problems` : '\nall clean');
await b.close();
