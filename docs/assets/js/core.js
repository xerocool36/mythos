/* Mythos — shared page behaviour: language toggle, scroll reveals, sticky nav.
 * Vanilla only. No framework, no scroll library, no scrollbar hijacking. */
(function () {
  'use strict';

  var KEY = 'mythos-lang';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ language */

  // Copy lives in the markup as data-it / data-en attribute pairs so the page
  // is readable with JS off — the Italian text is the real DOM content and the
  // English is the attribute overlay.
  function apply(lang) {
    document.documentElement.lang = lang;
    var nodes = document.querySelectorAll('[data-en]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset.itHtml == null) el.dataset.itHtml = el.innerHTML;   // capture original once
      var next = lang === 'en' ? el.getAttribute('data-en') : el.dataset.itHtml;
      if (next != null) el.innerHTML = next;
    }
    var toggles = document.querySelectorAll('[data-lang-toggle]');
    for (var k = 0; k < toggles.length; k++) {
      toggles[k].textContent = lang === 'en' ? 'IT' : 'EN';
      toggles[k].setAttribute('aria-label', lang === 'en' ? 'Passa all’italiano' : 'Switch to English');
    }
    try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
    document.dispatchEvent(new CustomEvent('mythos:lang', { detail: { lang: lang } }));
  }

  var saved;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  if (saved === 'en') apply('en');

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-lang-toggle]');
    if (!b) return;
    e.preventDefault();
    apply(document.documentElement.lang === 'en' ? 'it' : 'en');
  });

  /* ------------------------------------------------------------- reveals */

  var reveals = document.querySelectorAll('[data-reveal]');
  if (reveals.length) {
    if (reduced || !('IntersectionObserver' in window)) {
      for (var r = 0; r < reveals.length; r++) reveals[r].classList.add('in');
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          en.target.classList.add('in');
          io.unobserve(en.target);
        });
      }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
      for (var q = 0; q < reveals.length; q++) io.observe(reveals[q]);
    }
  }

  /* ----------------------------------------------------------------- nav */

  var nav = document.querySelector('.nav');
  if (nav) {
    var stuck = false;
    var onScroll = function () {
      var should = window.scrollY > 24;
      if (should !== stuck) { stuck = should; nav.classList.toggle('stuck', stuck); }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var burger = document.querySelector('[data-menu-toggle]');
  var drawer = document.getElementById('nav-drawer');
  if (burger && drawer) {
    var setOpen = function (open) {
      drawer.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('no-scroll', open);
    };
    burger.addEventListener('click', function () {
      setOpen(burger.getAttribute('aria-expanded') !== 'true');
    });
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        burger.focus();
      }
    });
  }

  /* --------------------------------------------------- sticky bar height */

  // Anything that pins below the header measures the header at runtime rather
  // than trusting a hard-coded offset, which drifts the moment the bar grows.
  function measure() {
    if (!nav) return;
    document.documentElement.style.setProperty('--bar-h', nav.offsetHeight + 'px');
  }
  measure();
  window.addEventListener('resize', measure, { passive: true });
  if ('ResizeObserver' in window && nav) new ResizeObserver(measure).observe(nav);
})();
