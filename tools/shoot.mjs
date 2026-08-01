// Screenshot harness for the Mythos preview.
//
// Two traps this works around, both of which cost a previous session real time:
//   1. `fullPage` screenshots do not scroll the page, so lazy images never load
//      and IntersectionObserver reveals never fire. We scroll the page in steps
//      first, then shoot.
//   2. `img.complete` is true for an image that has been fetched but never
//      painted. Only `await img.decode()` proves a screenshot will show it.
//
// Usage: node tools/shoot.mjs <page> <label> [--full] [widths...]
//   node tools/shoot.mjs index hero 390 768 1440
//   node tools/shoot.mjs menu qa --full 390

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const [, , pageName = 'index', label = 'shot', ...rest] = process.argv;
const full = rest.includes('--full');
const widths = rest.filter((a) => /^\d+$/.test(a)).map(Number);
const sizes = widths.length ? widths : [390, 768, 1440];
const out = new URL('../.tmp/shots/', import.meta.url).pathname;

await mkdir(out, { recursive: true });
const browser = await chromium.launch();

for (const w of sizes) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: w < 700 ? 844 : 900 },
    deviceScaleFactor: 2,
    isMobile: w < 700,
    hasTouch: w < 700,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://localhost:3000/${pageName}.html`, { waitUntil: 'networkidle' });

  // walk the page so lazy images load and reveals fire, then come back up
  await page.evaluate(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });

  // decode everything before judging anything
  const undecoded = await page.evaluate(async () => {
    const imgs = [...document.images];
    const bad = [];
    await Promise.all(
      imgs.map((i) => i.decode().catch(() => bad.push(i.getAttribute('src'))))
    );
    return bad;
  });

  await page.screenshot({ path: `${out}${label}-${w}.jpg`, quality: 82, type: 'jpeg', fullPage: full });
  console.log(`${label}-${w}.jpg`, undecoded.length ? `UNDECODED: ${undecoded}` : '', errors.length ? `ERRORS: ${errors}` : '');
  await ctx.close();
}

await browser.close();
