import { chromium } from 'playwright';
const [,, pageName='index', width='390'] = process.argv;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:+width,height:844}, deviceScaleFactor:1, isMobile:+width<700, hasTouch:+width<700 });
const p = await ctx.newPage();
await p.goto(`http://localhost:3000/${pageName}.html`, {waitUntil:'networkidle'});
await p.evaluate(async()=>{document.documentElement.style.scrollBehavior='auto';const s=innerHeight*.8;for(let y=0;y<document.body.scrollHeight;y+=s){scrollTo(0,y);await new Promise(r=>setTimeout(r,80));}scrollTo(0,0);await new Promise(r=>setTimeout(r,300));});
const out = await p.evaluate(()=>{
  const total = document.documentElement.scrollHeight;
  const rows = [];
  document.querySelectorAll('main > section, main > div, footer, header').forEach(el=>{
    const r = el.getBoundingClientRect();
    rows.push({ el: el.tagName.toLowerCase()+'.'+(el.className||'').split(' ')[0], h: Math.round(r.height) });
  });
  return { total, screens:+(total/innerHeight).toFixed(2), rows };
});
console.log(`${pageName} @${width}  total=${out.total}px  = ${out.screens} screens`);
out.rows.forEach(r=>console.log(`  ${String(r.h).padStart(5)}px  ${r.el}`));
await b.close();
