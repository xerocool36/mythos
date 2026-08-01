#!/usr/bin/env python3
"""Render docs/menu.html from docs/assets/data/menu.json.

The whole menu is baked into the HTML so the page is readable with JS off and
needs no second round trip on a bad indoor connection. menu.js only adds
search, scroll-spy and the sticky offset measurement.
"""
import json, html, pathlib

ROOT = pathlib.Path("/Users/sihabhaque/Downloads/documents/Claude-Projects/websites/mythos/docs")
DATA = json.loads((ROOT / "assets/data/menu.json").read_text(encoding="utf-8"))

TAG_LABEL = {
    "veg":      ("veg", "veg"),
    "vegan":    ("vegano", "vegan"),
    "piccante": ("piccante", "spicy"),
}


def esc(s):
    return html.escape(s, quote=True)


def money(p):
    """'7.50' -> '7,50'. Italian menus use a comma."""
    return p.replace(".", ",")


def item_html(it):
    tags = ""
    for t in it.get("tags") or []:
        if t not in TAG_LABEL:
            continue
        it_l, en_l = TAG_LABEL[t]
        tags += ('<span class="tag tag--%s" data-en="%s">%s</span>'
                 % (t, esc(en_l), esc(it_l)))

    price = ""
    if it.get("price"):
        price = '<p class="item__p"><span class="item__cur">€</span>%s</p>' % esc(money(it["price"]))

    desc = ""
    if it.get("desc"):
        de = it.get("desc_en") or ""
        attr = ' data-en="%s"' % esc(de) if de else ""
        desc = '<p class="item__d"%s>%s</p>' % (attr, esc(it["desc"]))

    return (
        '\n      <li class="item" data-q="%s">'
        '\n        <div class="item__t"><h3 class="item__n">%s%s</h3>%s</div>%s'
        '\n      </li>'
    ) % (esc((it["name"] + " " + (it.get("desc") or "")).lower()),
         esc(it["name"]), tags, desc, price)


def section_html(sec):
    note = ""
    if sec.get("note"):
        note = ('\n      <p class="msec__note" data-en="%s">%s</p>'
                % (esc(sec["note"]["en"]), esc(sec["note"]["it"])))
    items = "".join(item_html(i) for i in sec["items"])
    return (
        '\n  <section class="msec" id="%s" aria-labelledby="h-%s">'
        '\n    <h2 class="msec__h" id="h-%s" data-en="%s">%s</h2>%s'
        '\n    <ul class="items">%s\n    </ul>'
        '\n  </section>\n'
    ) % (sec["id"], sec["id"], sec["id"],
         esc(sec["name"]["en"]), esc(sec["name"]["it"]), note, items)


def chip_html(sec):
    return ('\n        <li><a href="#%s" data-en="%s">%s</a></li>'
            % (sec["id"], esc(sec["name"]["en"]), esc(sec["name"]["it"])))


chips = "".join(chip_html(s) for s in DATA["sections"])
sections = "".join(section_html(s) for s in DATA["sections"])
n_items = sum(len(s["items"]) for s in DATA["sections"])

FONTS = ("https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..700"
         "&amp;family=Newsreader:opsz,wght@6..72,300..600&amp;display=swap")

PAGE = """<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<!-- Table menu, reached from a QR code. Never wanted in a search index. -->
<meta name="robots" content="noindex,nofollow">

<title>Menù — Mythos Cucina Greca, Via Tuscolana 596 Roma</title>
<meta name="description" content="Il menù di Mythos Cucina Greca, Via Tuscolana 596, Roma: pite, souvlaki, moussakà, meze e dolci greci.">
<meta name="theme-color" content="#0B14A0">

<link rel="icon" href="assets/img/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="assets/img/logo-disc-sm.png">

<!-- Fonts load out of the critical path: the menu paints immediately in the
     system fallback and swaps when (if) Archivo/Newsreader arrive. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" media="print" onload="this.media='all';this.onload=null" href="__FONTS__">
<noscript><link rel="stylesheet" href="__FONTS__"></noscript>

<link rel="stylesheet" href="assets/css/core.css">

<style>
/* ------------------------------------------------------------------ menu --
   Page-specific only. Everything here leans on the tokens in core.css; the
   shared stylesheet is owned by another file and is not touched.
   Art direction: Minoan. Ultramarine as a structural field, plaster ground,
   gold only as a hairline. No meander strip, no taverna letterforms.
   -------------------------------------------------------------------- */

/* The category bar pins under the header, so it has to know how tall the
   header actually is. core.js writes --bar-h; menu.js writes --cat-h. Neither
   is ever hard-coded: on a 360px phone the header wraps and both grow. */
.catbar {
  position: sticky;
  top: var(--bar-h, 64px);
  z-index: 40;
  background: var(--plaster);
  border-bottom: 1px solid var(--rule);
}
.catbar__in {
  max-width: var(--wrap);
  margin: 0 auto;
  padding: .3rem var(--gut);
  display: flex;
  align-items: center;
  gap: .35rem;
}
.cats-wrap { position: relative; flex: 1 1 auto; min-width: 0; }
/* A hint that the chip row keeps going — without it the clipped chip at the
   right edge reads as a rendering fault rather than as more menu. */
.cats-wrap::after {
  content: "";
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 22px;
  pointer-events: none;
  background: linear-gradient(to right, rgba(245, 246, 248, 0), var(--plaster));
}
.cats {
  display: flex;
  gap: .3rem;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.cats::-webkit-scrollbar { display: none; }
.cats a {
  flex: 0 0 auto;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  padding: 0 .85rem;
  border: 1px solid var(--rule);
  border-radius: 999px;
  text-decoration: none;
  white-space: nowrap;
  font-family: var(--f-disp);
  font-weight: 600;
  font-stretch: 108%;
  font-size: .82rem;
  letter-spacing: .085em;
  text-transform: uppercase;
  color: var(--blue-deep);
  background: transparent;
  transition: background-color .18s var(--ease), color .18s var(--ease), border-color .18s var(--ease);
}
.cats a:hover { border-color: var(--blue); color: var(--blue); }
.cats a[aria-current="true"] {
  background: var(--blue);
  border-color: var(--blue);
  color: var(--plaster);
}

.findbtn {
  flex: 0 0 auto;
  width: 44px; height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  background: none;
  border: 1px solid var(--rule);
  border-radius: 999px;
  cursor: pointer;
  color: var(--blue);
}
.findbtn svg { width: 19px; height: 19px; display: block; }
.findbtn:hover { border-color: var(--blue); }
.findbtn[aria-expanded="true"] { background: var(--blue); border-color: var(--blue); color: var(--plaster); }

.findrow {
  max-width: var(--wrap);
  margin: 0 auto;
  /* top padding leaves room for the input's focus ring, which would otherwise
     draw over the chip row sitting immediately above it */
  padding: .4rem var(--gut) .5rem;
}
.findrow input {
  width: 100%;
  min-height: 48px;
  padding: .55rem .8rem;
  font-size: 1rem;          /* 16px — anything smaller makes iOS zoom the page */
  font-family: var(--f-body);
  background: #fff;
  border: 1px solid var(--rule);
  border-radius: 2px;
  color: var(--blue-deep);
}
.findrow input::placeholder { color: rgba(19, 24, 81, .5); }
.findcount { margin: .45rem 0 0; font-size: .92rem; color: rgba(19, 24, 81, .72); }

/* ------------------------------------------------------------ blue band -- */

.mtop { padding: clamp(1.5rem, 5vw, 2.6rem) 0 clamp(1.5rem, 5vw, 2.4rem); }
.mtop__in { display: flex; align-items: center; gap: clamp(.9rem, 3vw, 1.5rem); }
.mtop__disc { width: clamp(58px, 15vw, 84px); height: auto; flex: 0 0 auto; }
.mtop__h {
  font-family: var(--f-disp);
  font-weight: 600;
  font-stretch: 112%;
  font-size: clamp(1.5rem, 1.05rem + 2vw, 2.3rem);
  line-height: 1.04;
  letter-spacing: -.01em;
  text-transform: uppercase;
  color: var(--plaster);
  margin: 0;
}
.mtop__sub {
  margin: .5rem 0 0;
  font-size: 1rem;
  line-height: 1.5;
  color: var(--on-blue-dim);
}
.mtop__act { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1.1rem; }
.mtop__act .btn { flex: 1 1 auto; justify-content: center; }

/* --------------------------------------------------------------- notices -- */

.mnotes {
  border-top: 2px solid var(--gold);
  background: var(--plaster-2);
  padding: 1rem 0 1.05rem;
}
.mnotes p { margin: 0 0 .35rem; font-size: 1rem; line-height: 1.5; color: var(--blue-deep); }
.mnotes p:last-child { margin-bottom: 0; }
.mnotes strong { font-weight: 600; }

/* ------------------------------------------------------------- sections -- */

.mbody { padding-block: clamp(1.6rem, 4vw, 2.6rem) clamp(2.5rem, 7vw, 4rem); }

.msec {
  /* Jumping to a section must not park its first line under two sticky bars. */
  scroll-margin-top: calc(var(--bar-h, 64px) + var(--cat-h, 52px) + 14px);
  padding-top: clamp(1.6rem, 4vw, 2.4rem);
}
.msec:first-child { padding-top: .4rem; }
.msec[hidden] { display: none; }

.msec__h {
  font-family: var(--f-disp);
  font-weight: 600;
  font-stretch: 112%;
  font-size: clamp(1.25rem, 1rem + 1.3vw, 1.7rem);
  line-height: 1.1;
  letter-spacing: .01em;
  text-transform: uppercase;
  color: var(--blue);
  margin: 0 0 .2rem;
  padding-bottom: .5rem;
  border-bottom: 2px solid var(--gold);
}
.msec__note {
  margin: .7rem 0 0;
  font-size: .98rem;
  line-height: 1.5;
  color: rgba(19, 24, 81, .78);
}
.msec__empty { margin: .9rem 0 0; font-size: 1rem; color: rgba(19, 24, 81, .72); }

.items { margin: .3rem 0 0; }

.item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  column-gap: 1rem;
  align-items: baseline;
  padding: .85rem 0;
  border-bottom: 1px solid var(--rule-soft);
}
.item:last-child { border-bottom: 0; }
.item[hidden] { display: none; }

.item__t { min-width: 0; }

.item__n {
  margin: 0;
  font-family: var(--f-disp);
  font-weight: 600;
  font-stretch: 104%;
  font-size: 1.08rem;      /* ~17px — a dim room, read one-handed */
  line-height: 1.3;
  letter-spacing: .002em;
  color: var(--ink);
}
.item__d {
  margin: .2rem 0 0;
  font-size: 1rem;         /* 16px floor */
  line-height: 1.45;
  color: rgba(19, 24, 81, .8);
}

.item__p {
  margin: 0;
  justify-self: end;
  min-width: 4.9ch;
  text-align: right;
  font-family: var(--f-disp);
  font-weight: 600;
  font-size: 1.08rem;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  color: var(--blue);
  white-space: nowrap;
}
.item__cur { font-weight: 400; opacity: .62; margin-right: .18em; }

.tag {
  display: inline-block;
  margin-left: .45em;
  padding: .12em .5em .16em;
  vertical-align: .1em;
  border: 1px solid var(--gold);
  border-radius: 999px;
  font-family: var(--f-disp);
  font-weight: 600;
  font-size: .64rem;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: #7A5A15;
  background: rgba(196, 146, 46, .09);
}

/* ---------------------------------------------------------------- foot -- */

.mfoot { padding: clamp(1.8rem, 5vw, 2.6rem) 0; }
.mfoot__act { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.1rem; }
.mfoot p { margin: 0 0 .4rem; font-size: 1rem; line-height: 1.55; color: var(--on-blue-dim); }
.mfoot p:last-child { margin-bottom: 0; }
.mfoot a:not(.btn) { color: var(--plaster); text-underline-offset: .22em; text-decoration-color: var(--gold-lift); }
.mfoot__name {
  font-family: var(--f-disp);
  font-weight: 700;
  font-stretch: 118%;
  font-size: 1.1rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--plaster) !important;
  margin-bottom: .55rem !important;
}

/* --------------------------------------------------------------- print -- */

@page { margin: 14mm; }

@media print {
  .nav, .catbar, .findrow, .mtop__act, .mfoot__act, .skip, .noprint { display: none !important; }

  html, body { background: #fff; color: #000; }
  body { font-size: 10.5pt; line-height: 1.4; }

  .mtop { background: #fff !important; color: #000 !important; padding: 0 0 8mm; }
  .mtop__h, .mfoot__name { color: #000 !important; }
  .mtop__sub, .mfoot p { color: #333 !important; }
  .mnotes { background: #fff; border-top-color: #000; padding: 0 0 6mm; }
  .mfoot { background: #fff !important; color: #000 !important; padding: 6mm 0 0; border-top: 1px solid #000; }
  .mfoot a:not(.btn) { color: #000; }

  .wrap { padding-left: 0; padding-right: 0; max-width: none; }
  .mbody { padding: 0; }

  .msec { padding-top: 6mm; }
  .msec__h { color: #000; border-bottom-color: #000; font-size: 13pt; break-after: avoid; }
  .item { break-inside: avoid; padding: 1.6mm 0; border-bottom: .2pt solid #bbb; }
  .item__n { font-size: 10.5pt; color: #000; }
  .item__d { font-size: 9pt; color: #333; }
  .item__p { font-size: 10.5pt; color: #000; }
  .tag { border-color: #666; color: #444; background: none; }
}

/* -------------------------------------------------------------- motion -- */

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
</style>
</head>

<body class="is-menu">
<a class="skip" href="#menu" data-en="Skip to the menu">Vai al menù</a>

<!-- ─────────────────────────────────────────────────────────────── nav ── -->
<header class="nav">
  <div class="nav__in">
    <a class="brand" href="index.html" aria-label="Mythos Cucina Greca — torna alla home">
      <img class="brand__disc" src="assets/img/logo-disc-sm.png" width="96" height="96" alt="">
      <span class="brand__name">Mythos</span>
    </a>
    <div class="nav__act">
      <button type="button" class="langbtn" data-lang-toggle aria-label="Switch to English">EN</button>
      <a class="btn btn-sm" href="tel:+390687774778" data-en="Call">Chiama</a>
    </div>
  </div>
</header>

<!-- ──────────────────────────────────────────────────── category bar ── -->
<div class="catbar" id="catbar">
  <div class="catbar__in">
    <nav aria-label="Sezioni del menù" class="cats-wrap">
      <ul class="cats" id="cats">__CHIPS__
      </ul>
    </nav>
    <button type="button" class="findbtn" id="findbtn" hidden aria-expanded="false" aria-controls="findrow" aria-label="Cerca un piatto">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4.2-4.2"></path>
      </svg>
    </button>
  </div>
  <div class="findrow" id="findrow" hidden>
    <input type="search" id="find" autocomplete="off" autocapitalize="off" spellcheck="false"
           placeholder="Cerca un piatto…" data-en-placeholder="Search the menu…"
           aria-label="Cerca un piatto nel menù">
    <p class="findcount" id="findcount" role="status" aria-live="polite"></p>
  </div>
</div>

<!-- ──────────────────────────────────────────────────────── blue band ── -->
<section class="mtop on-blue">
  <div class="wrap mtop__in">
    <img class="mtop__disc" src="assets/img/logo-disc-sm.png" width="96" height="96" alt="">
    <div>
      <h1 class="mtop__h">Menù</h1>
      <p class="mtop__sub"><span data-en="Greek kitchen">Cucina greca</span> · Via Tuscolana 596, Roma</p>
      <p class="mtop__act noprint">
        <a class="btn btn-sm" href="index.html#prenota" data-en="Book a table">Prenota un tavolo</a>
        <a class="btn btn-sm btn-ghost" href="index.html" data-en="Home">Torna al sito</a>
      </p>
    </div>
  </div>
</section>

<!-- ────────────────────────────────────────────────────────── notices ── -->
<div class="mnotes">
  <div class="wrap">
    <p data-en="&lt;strong&gt;Allergies:&lt;/strong&gt; the printed menu carries no allergen information, so neither does this page. Please tell a member of staff about any allergy or intolerance before you order."><strong>Allergie:</strong> il menù stampato non riporta informazioni sugli allergeni e questa pagina non ne aggiunge. Segnala sempre al personale qualsiasi allergia o intolleranza prima di ordinare.</p>
    <p data-en="Some prices are still awaiting confirmation from the restaurant and are shown without a figure. Ask a member of staff.">Alcuni prezzi sono in attesa di conferma dal ristorante e sono mostrati senza cifra. Chiedi al personale.</p>
    <p data-en="* frozen product">* prodotto surgelato</p>
  </div>
</div>

<!-- ───────────────────────────────────────────────────────────── menu ── -->
<main class="mbody" id="menu">
  <div class="wrap">
__SECTIONS__
    <p class="msec__empty" id="noresults" hidden data-en="No dish matches your search.">Nessun piatto corrisponde alla ricerca.</p>
  </div>
</main>

<!-- ─────────────────────────────────────────────────────────── footer ── -->
<footer class="mfoot on-blue">
  <div class="wrap">
    <p class="mfoot__act noprint">
      <a class="btn btn-sm" href="index.html#prenota" data-en="Book a table">Prenota un tavolo</a>
      <a class="btn btn-sm btn-ghost" href="tel:+390687774778" data-en="Call 06 8777 4778">Chiama 06 8777 4778</a>
    </p>
    <p class="mfoot__name">Mythos Cucina Greca</p>
    <p>Via Tuscolana 596, Roma · <a class="tel" href="tel:+390687774778">06 8777 4778</a></p>
    <p><a href="index.html" data-en="Back to the site">Torna al sito</a> · <a href="privacy.html">Privacy</a></p>
    <p data-en="Menu transcribed from the restaurant's printed menu. Dishes and prices may change.">Menù trascritto dal menù stampato del ristorante. Piatti e prezzi possono variare.</p>
  </div>
</footer>

<script defer src="assets/js/core.js"></script>
<script defer src="assets/js/menu.js"></script>
</body>
</html>
"""

out = (PAGE
       .replace("__FONTS__", FONTS)
       .replace("__CHIPS__", chips)
       .replace("__SECTIONS__", sections.rstrip()))

(ROOT / "menu.html").write_text(out, encoding="utf-8")
print("wrote menu.html — %d sections, %d items" % (len(DATA["sections"]), n_items))
