/* Mythos — menu.html only.
 *
 * The menu itself is already in the HTML; this file adds the three things a
 * table menu needs on a phone and nothing else: a search filter, a category
 * bar that knows which section you are looking at, and a runtime measurement
 * of both sticky bars so an anchor jump never parks a heading underneath them.
 *
 * Vanilla, no dependencies, degrades to a plain readable page with JS off.
 */
(function () {
  'use strict';

  var cats     = document.getElementById('cats');
  var catbar   = document.getElementById('catbar');
  var findbtn  = document.getElementById('findbtn');
  var findrow  = document.getElementById('findrow');
  var find     = document.getElementById('find');
  var findcnt  = document.getElementById('findcount');
  var noresult = document.getElementById('noresults');
  if (!cats || !catbar) return;

  var sections = [].slice.call(document.querySelectorAll('.msec'));
  var items    = [].slice.call(document.querySelectorAll('.item'));
  var links    = [].slice.call(cats.querySelectorAll('a'));
  var reduced  = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------ sticky metrics */

  // The header wraps to two lines on a narrow phone and the search row adds a
  // second row to the category bar, so both heights are read from the DOM
  // rather than assumed. core.js publishes --bar-h; --cat-h is ours.
  function measure() {
    document.documentElement.style.setProperty('--cat-h', catbar.offsetHeight + 'px');
  }
  measure();
  window.addEventListener('resize', measure, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(measure).observe(catbar);

  function stickyBottom() {
    return catbar.getBoundingClientRect().bottom;
  }

  /* -------------------------------------------------------------- search */

  function fold(s) {
    // Accent-insensitive: "moussaka" has to find "Moussakà".
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function haystack(li) {
    var d = li.querySelector('.item__d');
    return fold(li.getAttribute('data-q') + ' ' + (d ? d.textContent : ''));
  }

  var filtering = false;

  function filter(raw) {
    var q = fold(raw).trim();
    filtering = q.length > 0;

    if (!filtering) {
      items.forEach(function (li) { li.hidden = false; });
      sections.forEach(function (s) { s.hidden = false; });
      if (noresult) noresult.hidden = true;
      if (findcnt) findcnt.textContent = '';
      spy();
      return;
    }

    var terms = q.split(/\s+/);
    var hits = 0;

    items.forEach(function (li) {
      var hay = haystack(li);
      var ok = terms.every(function (t) { return hay.indexOf(t) !== -1; });
      li.hidden = !ok;
      if (ok) hits++;
    });

    sections.forEach(function (s) {
      s.hidden = !s.querySelector('.item:not([hidden])');
    });

    if (noresult) noresult.hidden = hits > 0;
    if (findcnt) {
      var en = document.documentElement.lang === 'en';
      findcnt.textContent = hits === 0
        ? ''
        : (en ? (hits + (hits === 1 ? ' dish' : ' dishes'))
              : (hits + (hits === 1 ? ' piatto' : ' piatti')));
    }
  }

  if (findbtn && findrow && find) {
    // Only offered when JS is running — with JS off the control would be a lie.
    findbtn.hidden = false;

    var open = function (want) {
      findrow.hidden = !want;
      findbtn.setAttribute('aria-expanded', String(want));
      measure();
      if (want) {
        find.focus();
      } else {
        find.value = '';
        filter('');
      }
    };

    findbtn.addEventListener('click', function () {
      open(findbtn.getAttribute('aria-expanded') !== 'true');
    });

    var t = null;
    find.addEventListener('input', function () {
      // Cheap debounce: 76 nodes is nothing, but typing on a phone fires fast.
      if (t) clearTimeout(t);
      t = setTimeout(function () { filter(find.value); }, 90);
    });

    find.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (find.value) { find.value = ''; filter(''); }
        else { open(false); findbtn.focus(); }
      }
    });

    // type="search" clear button fires `search`, not `input`, in Safari.
    find.addEventListener('search', function () { filter(find.value); });

    // The language toggle swaps copy through core.js; the placeholder and the
    // result count are attributes/text it does not own, so they follow here.
    document.addEventListener('mythos:lang', function (e) {
      var en = e.detail.lang === 'en';
      find.placeholder = en ? 'Search the menu…' : 'Cerca un piatto…';
      find.setAttribute('aria-label', en ? 'Search the menu' : 'Cerca un piatto nel menù');
      findbtn.setAttribute('aria-label', en ? 'Search the menu' : 'Cerca un piatto');
      if (filtering) filter(find.value);
    });
    if (document.documentElement.lang === 'en') {
      find.placeholder = 'Search the menu…';
      findbtn.setAttribute('aria-label', 'Search the menu');
    }
  }

  /* ----------------------------------------------------------- scroll-spy */

  var current = null;

  function setCurrent(id) {
    if (id === current) return;
    current = id;
    links.forEach(function (a) {
      var on = a.getAttribute('href') === '#' + id;
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
      if (on) keepVisible(a);
    });
  }

  function keepVisible(a) {
    var r = a.getBoundingClientRect();
    var c = cats.getBoundingClientRect();
    if (r.left >= c.left && r.right <= c.right) return;
    var to = cats.scrollLeft + (r.left - c.left) - 16;
    if (reduced || !cats.scrollTo) cats.scrollLeft = to;
    else cats.scrollTo({ left: to, behavior: 'smooth' });
  }

  // A section counts as "current" once its top has passed the very same line an
  // anchor jump parks it on — its scroll-margin-top, which is itself derived
  // from the two measured bar heights. Deriving the two from one number is what
  // stops the highlight landing one section behind after a jump.
  function line(sec) {
    var sm = parseFloat(getComputedStyle(sec).scrollMarginTop);
    return (isFinite(sm) ? sm : stickyBottom()) + 2;
  }

  function spy() {
    if (filtering) return;
    var id = sections.length ? sections[0].id : null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= line(sections[i])) id = sections[i].id;
    }
    // At the very bottom the last section may never cross the line.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      id = sections[sections.length - 1].id;
    }
    if (id) setCurrent(id);
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; spy(); });
  }, { passive: true });

  links.forEach(function (a) {
    a.addEventListener('click', function () {
      setCurrent(a.getAttribute('href').slice(1));
    });
  });

  spy();
})();
