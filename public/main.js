/* =========================================================================
   Vision Guard — main.js
   Zero dependencies. One rAF loop drives every scroll-linked effect and
   shuts itself down when nothing needs a frame.
   ========================================================================= */
(function () {
  'use strict';

  var root    = document.documentElement;
  var reduce  = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse  = window.matchMedia('(hover: none), (pointer: coarse)').matches;

  /* ---------------- math ---------------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function inOutCubic(t)  { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  /* =======================================================================
     1. FRAME SCHEDULER
     Subscribers return `true` while they still need frames. When every
     subscriber is idle the loop stops — no background battery cost.
     ======================================================================= */
  var jobs = [], running = false;

  /* ---------------------------------------------------------------------
     THE SHARED LAYOUT READ

     document.scrollHeight cannot be answered from anything the browser has
     already computed: asking for it forces a synchronous layout, and it is
     only worth what it costs if the answer is then used more than once.

     It was being asked for on every wheel event and again on every frame, by
     two different subscribers — so a single flick of the wheel bought several
     full layout passes, each one blocking the frame it happened in, on the
     page a first-time visitor sees.

     Now it is asked once per frame at most. The cache is dropped at the top
     of each frame, so the first job that wants the number pays the layout and
     every job after it in that frame reads the answer. A wheel event landing
     between two frames reuses the previous frame's value; the most that can
     be wrong is the scroll ceiling on a page that grew taller within the last
     16ms, which the next frame corrects and which the scroll listener below
     re-syncs from the real position anyway.
     --------------------------------------------------------------------- */
  var maxCache = -1;
  function invalidateMax() { maxCache = -1; }
  function maxScroll() {
    if (maxCache < 0) {
      maxCache = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    }
    return maxCache;
  }

  function onFrame(fn) { jobs.push(fn); }
  function kick() {
    if (running) return;
    running = true;
    requestAnimationFrame(tick);
  }
  function tick(t) {
    invalidateMax();
    var busy = false;
    for (var i = 0; i < jobs.length; i++) if (jobs[i](t) === true) busy = true;
    if (busy) requestAnimationFrame(tick);
    else running = false;
  }

  /* Runs once the scroll settles. IntersectionObserver never fires for
     content the viewport jumps clean over (hash landings, scroll
     restoration, a hard flick), which would leave that content hidden for
     good. These sweeps rescue it, and cost nothing once everything has
     resolved. */
  var idleFns = [], idleT;
  function onScrollIdle(fn) { idleFns.push(fn); }
  window.addEventListener('scroll', function () {
    clearTimeout(idleT);
    idleT = setTimeout(function () {
      /* Content that loaded during the scroll — images resolving, home.js
         painting the catalogue — has settled by now, so the cached page
         height is the most likely thing here to be out of date. */
      invalidateMax();
      for (var i = idleFns.length - 1; i >= 0; i--) {
        if (idleFns[i]() === 'done') idleFns.splice(i, 1);
      }
    }, 150);
  }, { passive: true });

  /* =======================================================================
     2. LANGUAGE — Arabic default, English on demand
     Every translatable node carries data-en; the Arabic original is
     captured from the markup itself, so the HTML stays readable and there
     is no separate dictionary to drift out of sync.
     ======================================================================= */
  var i18nEls = [].slice.call(document.querySelectorAll('[data-en]'));
  i18nEls.forEach(function (el) { el.setAttribute('data-ar', el.innerHTML); });

  var LANG = 'ar';
  try { LANG = localStorage.getItem('vg-lang') || 'ar'; } catch (e) {}

  var langBtn = document.getElementById('lang');

  function applyLang(lang, resplit) {
    LANG = lang === 'en' ? 'en' : 'ar';
    root.setAttribute('lang', LANG);
    root.setAttribute('dir', LANG === 'ar' ? 'rtl' : 'ltr');
    i18nEls.forEach(function (el) {
      el.innerHTML = el.getAttribute(LANG === 'en' ? 'data-en' : 'data-ar');
    });
    if (langBtn) {
      langBtn.textContent = LANG === 'ar' ? 'EN' : 'ع';
      langBtn.setAttribute('aria-label', LANG === 'ar' ? 'Switch to English' : 'التبديل إلى العربية');
    }
    try { localStorage.setItem('vg-lang', LANG); } catch (e) {}
    if (resplit) resplitAll();
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: LANG } }));
  }

  applyLang(LANG, false);   /* before splitting, so splits use final text */

  if (langBtn) {
    langBtn.addEventListener('click', function () {
      applyLang(LANG === 'ar' ? 'en' : 'ar', true);
      kick();
    });
  }

  /* =======================================================================
     2b. THEME — dark (default) / light

     The stored choice is already applied by the inline <head> script, before
     first paint, so this only wires the button. The logo is an <img>, not a
     background, so its src is swapped here: light mode returns to
     logo-trim.png — the original artwork with the brand's own grey GUARD.
     ======================================================================= */
  var LOGO = { dark: 'assets/logo-dark.png', light: 'assets/logo-trim.png' };
  var PAGE_COLOR = { dark: '#08090B', light: '#F6F7F9' };
  var themeBtn = document.getElementById('theme');
  var THEME = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

  function applyTheme(theme, persist) {
    THEME = theme === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', THEME);

    var src = LOGO[THEME];
    [].slice.call(document.querySelectorAll('.brand__logo, .boot__mark img'))
      .forEach(function (img) { if (img.getAttribute('src') !== src) img.setAttribute('src', src); });

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', PAGE_COLOR[THEME]);

    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', THEME === 'light' ? 'true' : 'false');
      themeBtn.setAttribute('aria-label', THEME === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    }
    if (persist) { try { localStorage.setItem('vg-theme', THEME); } catch (e) {} }
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: THEME } }));
  }

  applyTheme(THEME, false);

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      applyTheme(THEME === 'light' ? 'dark' : 'light', true);
      kick();
    });
  }

  /* =======================================================================
     3. WEIGHTED SMOOTH SCROLL
     Lerps the real scroll position (not a transformed wrapper) so sticky,
     anchors, the scrollbar and find-in-page all keep working. Touch and
     coarse pointers keep native momentum — hijacking it always feels worse
     than the platform default.
     ======================================================================= */
  var smooth = {
    on: !reduce && !coarse,
    target: window.scrollY, current: window.scrollY,
    active: false, lock: false
  };

  /* maxScroll() and its cache now live with the frame scheduler in section 1,
     because "how tall is the page" is asked by the nav progress bar and the
     parallax as well as by this section, and the point of caching it is that
     they all share one answer per frame. */

  if (smooth.on) {
    window.addEventListener('wheel', function (e) {
      if (smooth.lock || document.body.classList.contains('is-menu') || e.ctrlKey) return;
      e.preventDefault();
      var d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
      smooth.target = clamp(smooth.target + d, 0, maxScroll());
      smooth.active = true;
      kick();
    }, { passive: false });

    onFrame(function () {
      if (!smooth.active) return false;
      var diff = smooth.target - smooth.current;
      if (Math.abs(diff) < .4) {
        smooth.current = smooth.target;
        window.scrollTo(0, smooth.current);
        smooth.active = false;
        return false;
      }
      smooth.current += diff * .105;                 // the "weight"
      window.scrollTo(0, smooth.current);
      return true;
    });
  }

  window.addEventListener('scroll', function () {
    if (!smooth.active && !smooth.lock) smooth.target = smooth.current = window.scrollY;
    kick();
  }, { passive: true });

  function scrollToY(to) {
    to = clamp(to, 0, maxScroll());
    if (reduce) { window.scrollTo(0, to); smooth.target = smooth.current = to; return; }
    var from = window.scrollY, dist = to - from;
    if (Math.abs(dist) < 2) return;
    var ms = clamp(420 + Math.abs(dist) * .38, 520, 1500), start = null;
    smooth.lock = true; smooth.active = false;
    requestAnimationFrame(function step(t) {
      if (start === null) start = t;
      var k = clamp((t - start) / ms, 0, 1);
      var y = from + dist * inOutCubic(k);
      window.scrollTo(0, y);
      smooth.target = smooth.current = y;
      if (k < 1) requestAnimationFrame(step);
      else smooth.lock = false;
    });
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href');
    if (!id || id === '#') return;
    var el = document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    closeMenu();
    scrollToY(el.getBoundingClientRect().top + window.scrollY - (id === '#top' ? 0 : 74));
    if (history.replaceState) history.replaceState(null, '', id);
  });

  /* =======================================================================
     4. NAV — stuck state, progress bar, active section, menu

     The floating button in the corner is no longer this file's business: it
     is the assistant now, it is on from first paint rather than fading in
     past the hero, and assistant.js owns it end to end.
     ======================================================================= */
  var nav      = document.getElementById('nav');
  var bar      = document.getElementById('progressBar');
  var burger   = document.getElementById('burger');
  var menu     = document.getElementById('menu');
  var navLinks = [].slice.call(document.querySelectorAll('[data-nav]'));
  var wasStuck = false;

  onFrame(function () {
    var y = window.scrollY, max = maxScroll();
    var stuck = y > 40;
    if (stuck !== wasStuck) { nav.classList.toggle('is-stuck', stuck); wasStuck = stuck; }
    if (bar) bar.style.transform = 'scaleX(' + (max ? y / max : 0) + ')';
    return false;
  });

  if (menu) { menu.removeAttribute('hidden'); menu.setAttribute('inert', ''); }

  function openMenu() {
    document.body.classList.add('is-menu');
    burger.setAttribute('aria-expanded', 'true');
    menu.removeAttribute('inert');
    root.style.overflow = 'hidden';
  }
  function closeMenu() {
    if (!document.body.classList.contains('is-menu')) return;
    document.body.classList.remove('is-menu');
    burger.setAttribute('aria-expanded', 'false');
    menu.setAttribute('inert', '');
    root.style.overflow = '';
  }
  if (burger) {
    burger.addEventListener('click', function () {
      document.body.classList.contains('is-menu') ? closeMenu() : openMenu();
    });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  if ('IntersectionObserver' in window && navLinks.length) {
    var sectionObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        navLinks.forEach(function (l) {
          l.classList.toggle('is-active', l.getAttribute('data-nav') === en.target.id);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    ['categories', 'products', 'how', 'why', 'contact'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) sectionObs.observe(el);
    });
  }

  /* =======================================================================
     5. SPLIT TYPE + REVEALS
     ======================================================================= */
  function splitWords(el) {
    var words = el.textContent.trim().split(/\s+/);
    var frag  = document.createDocumentFragment();
    words.forEach(function (w, i) {
      var outer = document.createElement('span');
      outer.className = 'w';
      var inner = document.createElement('span');
      inner.className = 'wi';
      inner.textContent = w;
      inner.style.setProperty('--d', (i * 38) + 'ms');
      outer.appendChild(inner);
      frag.appendChild(outer);
      if (i < words.length - 1) frag.appendChild(document.createTextNode(' '));
    });
    el.textContent = '';
    el.appendChild(frag);
  }

  var splitEls = [].slice.call(document.querySelectorAll('[data-split]'));
  splitEls.forEach(splitWords);

  /* language swap replaces innerHTML, so the word spans must be rebuilt */
  function resplitAll() {
    splitEls.forEach(function (el) {
      var wasIn = el.classList.contains('is-in');
      splitWords(el);
      if (wasIn) el.classList.add('is-in');
    });
  }

  var heroTitle = document.querySelector('.hero__title');
  var watchSplits = splitEls.filter(function (el) { return el !== heroTitle; });
  var reveals = [].slice.call(document.querySelectorAll('.reveal'));

  if ('IntersectionObserver' in window) {
    var revealObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        revealObs.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: .06 });

    var watched = reveals.concat(watchSplits);
    watched.forEach(function (el) { revealObs.observe(el); });

    onScrollIdle(function () {
      for (var i = watched.length - 1; i >= 0; i--) {
        var el = watched[i];
        if (el.classList.contains('is-in')) { watched.splice(i, 1); continue; }
        if (el.getBoundingClientRect().bottom < 0) {
          el.classList.add('no-anim', 'is-in');
          revealObs.unobserve(el);
          watched.splice(i, 1);
        }
      }
      return watched.length ? null : 'done';
    });
  } else {
    reveals.concat(watchSplits).forEach(function (el) { el.classList.add('is-in'); });
  }

  ['.cats', '.pillars'].forEach(function (sel) {
    var wrap = document.querySelector(sel);
    if (!wrap) return;
    [].slice.call(wrap.children).forEach(function (c, i) {
      c.style.setProperty('--d', (i * 70) + 'ms');
    });
  });

  /* Hero copy is hidden up front and choreographed against the boot
     curtain, so the reveal must be guaranteed: `load` is preferred, with a
     hard timeout behind it so a slow subresource can never strand it. */
  if (!reduce) {
    ['.hero__eyebrow', '.hero__lede', '.hero__actions'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) { el.style.opacity = '0'; el.style.transform = 'translateY(18px)'; }
    });
  }
  var introDone = false;
  function heroIntro() {
    if (introDone) return;
    introDone = true;
    if (heroTitle) heroTitle.classList.add('is-in');
    ['.hero__eyebrow', '.hero__lede', '.hero__actions'].forEach(function (sel, i) {
      var el = document.querySelector(sel);
      if (!el) return;
      var d = i * 75 + 130;
      el.style.transition = 'opacity .9s var(--e-out) ' + d + 'ms, transform .9s var(--e-out) ' + d + 'ms';
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  }
  /* Must land just after the boot curtain clears (.52s delay + .42s fade in
     styles.css). Change one and change the other. */
  var introDelay = reduce ? 0 : 560;
  if (document.readyState === 'complete') setTimeout(heroIntro, introDelay);
  else window.addEventListener('load', function () { setTimeout(heroIntro, introDelay); });
  setTimeout(heroIntro, introDelay + 1100);

  /* =======================================================================
     6. HERO

     Deliberately empty. The hero used to run a scroll-scrubbed canvas here —
     a sensor field that powered on, a scan line that swept it, MOTION and
     VEHICLE reticles that locked on, a link to a phone outline, then a focus
     frame around the whole screen, all driven by scroll position across a
     185vh track. It was removed: the hero is one static screen now, its
     backdrop is the CSS-only .hero__field, and nothing in it responds to the
     wheel. The only hero motion left is the one-time intro fade above, which
     runs on load and never again.
     ======================================================================= */

  /* =======================================================================
     7. HOW TO ORDER — sticky visual follows the step crossing the viewport
     ======================================================================= */
  (function process() {
    var steps = [].slice.call(document.querySelectorAll('.step'));
    var num   = document.getElementById('stepNum');
    var note  = document.getElementById('stepNote');
    var arts  = [].slice.call(document.querySelectorAll('.sv'));
    if (!steps.length) return;

    var NOTES = {
      ar: [
        'قول لنا المكان وعدد النقط، ونرشّح النظام المناسب.',
        'سعر مفصّل لكل قطعة قبل ما تأكّد أي حاجة.',
        'شحن سريع، ودعم معاك لحد ما التطبيق يشتغل.'
      ],
      en: [
        'Tell us the place and the number of points, and we size the system.',
        'An itemised price for every part before anything is confirmed.',
        'Fast shipping, and support with you until the app is running.'
      ]
    };
    var cur = -1;

    function paint() {
      if (note && cur >= 0) note.textContent = NOTES[LANG][cur];
    }
    function set(i) {
      if (i === cur) return;
      cur = i;
      steps.forEach(function (s, k) { s.classList.toggle('is-cur', k === i); });
      arts.forEach(function (a, k)  { a.classList.toggle('is-on',  k === i); });
      if (num) num.textContent = '0' + (i + 1);
      paint();
    }
    set(0);
    document.addEventListener('langchange', paint);

    if (!('IntersectionObserver' in window)) {
      steps.forEach(function (s) { s.classList.add('is-cur'); });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) set(+en.target.getAttribute('data-step'));
      });
    }, { rootMargin: '-42% 0px -42% 0px', threshold: 0 });
    steps.forEach(function (s) { obs.observe(s); });
  })();

  /* =======================================================================
     8. PARALLAX
     ======================================================================= */
  (function parallax() {
    var els = [].slice.call(document.querySelectorAll('[data-parallax]'));
    if (!els.length || reduce) return;

    var live = [];
    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          var i = live.indexOf(en.target);
          if (en.isIntersecting && i < 0) live.push(en.target);
          if (!en.isIntersecting && i >= 0) live.splice(i, 1);
        });
        kick();
      }, { rootMargin: '20% 0px 20% 0px' });
      els.forEach(function (el) { obs.observe(el); });
    } else { live = els; }

    /* READ EVERYTHING, THEN WRITE EVERYTHING

       This loop used to measure one element and immediately restyle it, then
       measure the next. Every write invalidates the layout the next read needs,
       so the browser had to recompute the whole document between each pair —
       N forced layouts per frame for N parallax elements, every frame of every
       scroll, and this runs alongside the smooth-scroll loop that is already
       calling scrollTo on the same frames.

       Splitting the phases costs one array and removes the interleaving: all
       the measuring happens against a layout that is settled, then all the
       writes land together and the browser reflows once. Same maths, same
       output, one layout instead of N.

       offs is allocated once and reused — a per-frame array in a scroll
       handler is garbage the collector has to come back for mid-gesture. */
    var offs = [];
    onFrame(function () {
      if (!live.length) return false;
      var mid = window.innerHeight / 2;
      var i;

      /* phase 1 — read only */
      for (i = 0; i < live.length; i++) {
        var r = live[i].getBoundingClientRect();
        offs[i] = (r.top + r.height / 2 - mid) *
                  (parseFloat(live[i].getAttribute('data-parallax')) || .1);
      }
      /* phase 2 — write only */
      for (i = 0; i < live.length; i++) {
        live[i].style.transform = 'translate3d(0,' + offs[i].toFixed(2) + 'px,0)';
      }
      return false;
    });
  })();

  /* =======================================================================
     9. MISC
     ======================================================================= */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  /* A resize is the one event guaranteed to change the page height, so the
     cached value is dropped outright rather than waiting for the next frame
     to do it. */
  window.addEventListener('resize', function () { invalidateMax(); kick(); }, { passive: true });
  kick();
})();
