import { chromium } from 'playwright';
const b = await chromium.launch();
for (const w of [390, 1440]) {
  const p = await (await b.newContext({viewport:{width:w,height:900},isMobile:w<700,hasTouch:w<700})).newPage();
  await p.goto('http://localhost:3000/index.html',{waitUntil:'networkidle'});
  const r = await p.evaluate(()=>{
    const out=[];
    document.querySelectorAll('.btn, .burger, .langbtn').forEach(el=>{
      const b=el.getBoundingClientRect(); if(!b.height) return;
      const cs=getComputedStyle(el);
      out.push({ cls:String(el.className), txt:(el.textContent||'').trim().slice(0,20),
        box:`${Math.round(b.width)}x${Math.round(b.height)}`,
        pad:cs.paddingLeft+'/'+cs.paddingRight, fs:cs.fontSize, ls:cs.letterSpacing,
        area: el.closest('header')?'nav':(el.closest('.hero')?'hero':(el.closest('.acts')?'acts':'other')) });
    });
    return out;
  });
  console.log(`--- ${w} ---`); r.forEach(x=>console.log(`  [${x.area}] ${x.box}  pad ${x.pad}  fs ${x.fs} ls ${x.ls}  "${x.txt}"`));
  await p.context().close();
}
await b.close();
