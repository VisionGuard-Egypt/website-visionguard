/* =========================================================================
   Vision Guard — promo.js
   The "try the coverage planner" bar, on every page.

   A classic script, not a module, for the same reason consent.js is one:
   index.html's main.js is a classic script and could not import a module, so
   anything that has to run on EVERY page has to be loadable by both halves of
   the site.

   RULES IT FOLLOWS, BECAUSE A PROMO THAT IGNORES THEM IS AN ANNOYANCE
   -------------------------------------------------------------------
   - Dismissed once, gone for the session. sessionStorage, not localStorage:
     a new visit is a fair second chance to notice a new feature, and a
     permanent hide would mean nobody who dismissed it on day one ever hears
     about it again.
   - Never on the planner itself, and never on checkout. Advertising a thing
     to someone already using it is noise; advertising anything to someone
     mid-purchase is worse than noise.
   - Not a modal, nothing blocked, no auto-focus. It sits in a corner and can
     be ignored forever.
   - It waits for the cookie bar. Two bars stacked on a first visit is how a
     site looks desperate — see the delay in show().
   ========================================================================= */
(function () {
  'use strict';

  var KEY = 'vg-promo-planner';
  var HREF = 'game.html';

  /* Pages that must never show it. */
  var path = location.pathname.replace(/\/+$/, '');
  var page = path.slice(path.lastIndexOf('/') + 1) || 'index';
  if (page === 'game' || page === 'game.html') return;
  /* Mid-checkout is not the moment. shop.js puts #checkout on the URL when
     the checkout view is open. */
  if (location.hash === '#checkout') return;

  try { if (sessionStorage.getItem(KEY) === 'x') return; } catch (e) {}

  function lang() {
    try { return localStorage.getItem('vg-lang') === 'en' ? 'en' : 'ar'; } catch (e) { return 'ar'; }
  }

  var COPY = {
    ar: {
      title: 'جرّب مخطّط التغطية',
      body: 'صمّم نظام المراقبة بتاعك وشوف هيغطي إيه — قبل ما تشتري.',
      cta: 'يلا نجرّب',
      close: 'إغلاق'
    },
    en: {
      title: 'Try the coverage planner',
      body: 'Design your camera setup and see what it would actually cover — before you buy.',
      cta: 'Try it',
      close: 'Dismiss'
    }
  };

  var box, titleEl, bodyEl, ctaEl, closeEl;

  function build() {
    box = document.createElement('aside');
    box.className = 'promo';
    box.id = 'promo';
    box.setAttribute('role', 'complementary');

    var inner = document.createElement('div');
    inner.className = 'promo__in';

    var icon = document.createElement('span');
    icon.className = 'promo__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '🎮';

    var text = document.createElement('div');
    text.className = 'promo__text';
    titleEl = document.createElement('p');
    titleEl.className = 'promo__title';
    bodyEl = document.createElement('p');
    bodyEl.className = 'promo__body';
    text.appendChild(titleEl);
    text.appendChild(bodyEl);

    ctaEl = document.createElement('a');
    ctaEl.className = 'btn btn--sm promo__cta';
    ctaEl.href = HREF;

    closeEl = document.createElement('button');
    closeEl.type = 'button';
    closeEl.className = 'promo__x';
    closeEl.innerHTML = '&times;';
    closeEl.addEventListener('click', dismiss);

    inner.appendChild(icon);
    inner.appendChild(text);
    inner.appendChild(ctaEl);
    inner.appendChild(closeEl);
    box.appendChild(inner);
    document.body.appendChild(box);

    /* Following the link is as good as dismissing it. */
    ctaEl.addEventListener('click', function () {
      try { sessionStorage.setItem(KEY, 'x'); } catch (e) {}
    });
  }

  function render() {
    if (!box) return;
    var c = COPY[lang()];
    titleEl.textContent = c.title;
    bodyEl.textContent = c.body;
    ctaEl.textContent = c.cta;
    closeEl.setAttribute('aria-label', c.close);
  }

  function dismiss() {
    try { sessionStorage.setItem(KEY, 'x'); } catch (e) {}
    if (box) box.classList.remove('is-on');
    stopTracking();
  }

  /* -----------------------------------------------------------------------
     HANGING IT OFF THE PLANNER BUTTON ITSELF

     It points at the thing it is advertising: the "المخطّط" / "Planner" link
     in the nav. The tail lands under that link and the card grows out of it,
     so the promotion and its destination are visibly the same thing.

     WHICH ELEMENT, THOUGH. The planner link only exists in the nav above
     900px — below that .nav__links is display:none and the planner lives
     inside the burger menu, which is shut. So the target is:

       1. the nav's planner link, when it is actually laid out,
       2. otherwise the burger, because that IS the way to the planner on
          that layout — the same reasoning as before, one step removed,
       3. otherwise the nav's inline-end corner.

     Everything is measured rather than hard-coded, because a fixed offset is
     wrong somewhere: some pages carry a contact strip above the nav and some
     do not, the nav is sticky so it moves until the header sticks, and the
     link's own position depends on how wide the other nav items render in
     the current language.

     The three custom properties written here are all the stylesheet needs;
     no presentation decisions are made in this file.
     ----------------------------------------------------------------------- */
  var tracking = false;
  var queued = false;

  /* Laid out and visible. offsetParent is null for display:none and for any
     hidden ancestor, which is exactly the .nav__links case below 900px. */
  function visible(el) {
    return el && el.offsetParent !== null;
  }

  function targetEl() {
    var links = document.querySelector('.nav__links');
    var planner = links && links.querySelector('a[href^="game"]');
    if (visible(planner)) return planner;

    var burger = document.getElementById('burger');
    if (visible(burger)) return burger;

    return document.querySelector('.nav__end') || document.querySelector('.nav');
  }

  /* Where the tail sits inside the card when nothing is in the way, measured
     from the card's inline-end edge. The card is placed so this lands on the
     button; if that would push it off screen the card is clamped and the tail
     slides along to keep pointing at the button anyway. */
  var TAIL_REST = 26;
  var TAIL_MIN = 16;

  function anchor() {
    if (!box) return;
    var target = targetEl();
    if (!target) return;

    /* All reads first, then all writes — interleaving them forces a synchronous
       layout on every scroll frame. */
    var r = target.getBoundingClientRect();
    if (!r.width && !r.height) return;

    var bar = target.closest ? target.closest('.nav') : null;
    var barBottom = bar ? bar.getBoundingClientRect().bottom : r.bottom;
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var w = box.offsetWidth || 320;

    var rtl = document.documentElement.getAttribute('dir') === 'rtl';

    /* Distance from the viewport's inline-end edge to the CENTRE of the
       button. Working in the inline axis means one calculation serves Arabic
       and English instead of two that can disagree. */
    var centre = r.left + r.width / 2;
    var fromEnd = rtl ? centre : (vw - centre);

    /* Rounded HERE, before the tail is derived from it. Deriving the tail
       from the unrounded value and then writing a rounded card position puts
       the two a pixel or two out of step, which is enough to see on an 11px
       diamond. */
    var end = Math.round(Math.min(Math.max(8, fromEnd - TAIL_REST), Math.max(8, vw - w - 8)));

    /* The tail follows the card to wherever it actually fitted, so it keeps
       pointing at the button even when the card had to be nudged. Kept to a
       tenth of a pixel rather than rounded: the diamond is centred with a
       half-pixel offset in CSS, so a whole-pixel tail cannot sit exactly on
       an odd-width link. */
    var tail = Math.min(Math.max(TAIL_MIN, fromEnd - end), Math.max(TAIL_MIN, w - TAIL_MIN));
    tail = Math.round(tail * 10) / 10;

    box.style.setProperty('--promo-top', Math.round(barBottom + 10) + 'px');
    box.style.setProperty('--promo-end', end + 'px');
    box.style.setProperty('--promo-tail', tail + 'px');
    /* transform-origin takes no logical keyword for this, so the tail's
       position is converted to a physical distance from the card's left edge
       — the point the card should appear to grow out of. */
    box.style.setProperty('--promo-origin', Math.round(rtl ? tail : (w - tail)) + 'px');
  }

  /* rAF-throttled: this runs on scroll, and doing layout reads on every
     scroll event is how a page starts to stutter on a phone. */
  function reanchor() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; anchor(); });
  }

  function startTracking() {
    if (tracking) return;
    tracking = true;
    window.addEventListener('resize', reanchor, { passive: true });
    window.addEventListener('scroll', reanchor, { passive: true });
  }

  function stopTracking() {
    if (!tracking) return;
    tracking = false;
    window.removeEventListener('resize', reanchor);
    window.removeEventListener('scroll', reanchor);
  }

  function show() {
    build();
    render();
    anchor();
    startTracking();
    void box.offsetWidth;
    box.classList.add('is-on');
  }

  function boot() {
    /* Hold back while the cookie bar is up — it is the one thing on screen
       that genuinely needs answering first, and stacking a promotion under it
       makes both look like clutter. consent.js hides its bar as soon as a
       decision exists, so on every visit after the first this is immediate. */
    var waited = 0;
    (function wait() {
      var barUp = document.querySelector('.cookiebar.is-on');
      if (!barUp || waited > 20000) return void setTimeout(show, barUp ? 0 : 1200);
      waited += 600;
      setTimeout(wait, 600);
    })();
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  document.addEventListener('langchange', render);
})();
