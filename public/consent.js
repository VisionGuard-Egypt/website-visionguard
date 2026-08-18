/* =========================================================================
   Vision Guard — consent.js
   The cookie bar, and the switch every marketing tag hangs off.

   LOAD ORDER IS LOAD-BEARING. This file must come before pixel.js in the
   <head> of every page that has one. Both are `defer`, so they run in
   document order after parsing: this one publishes window.vgConsent, pixel.js
   waits on it. Swap the two tags and the pixel refuses to load at all — by
   design, see the note in pixel.js. A page with no pixel can still include
   this file; the bar and the settings link work on their own.

   A classic script, not a module, for the same reason track.js is one:
   index.html's main.js is a classic script and could not import a module.
   Everything is published on window instead.

   WHAT COUNTS AS ESSENTIAL
   ------------------------
   Nothing here gates the things the shop cannot work without, and none of
   them are advertising:

     vg_session   signed, HttpOnly, set by the server — without it there is
                  no sign-in at all
     vg-lang      language, vg-theme theme, vg-cart the basket — all local
                  storage on the visitor's own device, never sent anywhere

   The only thing this file switches on and off is the Meta pixel and the
   Conversions API relay that mirrors it.

   TWO REGIMES, CHOSEN PER VISITOR
   -------------------------------
   /api/geo answers with the regime for this visitor's country (see that
   file for why the answer cannot come baked into the HTML):

     optin   EU/EEA/UK/CH. Nothing loads until Accept is clicked. Reject and
             Accept are the same size and weight, because a Reject that is
             harder to find than Accept is not a choice.
     notice  everywhere else, Egypt included. The pixel runs as before and
             the bar says so, with the same off switch a click away.

   COST OF THE REGION LOOKUP
   -------------------------
   None for a returning visitor: a stored decision is applied synchronously
   from localStorage and no request is made. On a first visit it is one
   same-origin edge request, cached in sessionStorage for the rest of the
   session. If it fails — offline, blocked, Function not deployed — the
   timezone is used as a fallback signal, and anything in Europe/* is treated
   as opt-in. That errs toward asking someone who did not need to be asked,
   which is the harmless direction.
   ========================================================================= */
(function () {
  'use strict';

  var STORE_KEY  = 'vg-consent';        // the decision, kept across visits
  var REGIME_KEY = 'vg-consent-regime'; // the region answer, kept per session
  var VERSION    = 1;                   /* bump only if the categories change
                                           meaning — it re-asks everyone. */

  /* ---------------------------------------------------------------------
     Storage. Every access is wrapped: Safari in private mode throws on
     localStorage, and a thrown error here would take the page's whole
     script with it.
     --------------------------------------------------------------------- */
  function readDecision() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== VERSION) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function writeDecision(marketing, regime) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: VERSION,
        marketing: marketing ? 1 : 0,
        regime: regime || 'notice',
        ts: new Date().toISOString()
      }));
    } catch (e) { /* private mode: the choice holds for this page only */ }
  }

  /* ---------------------------------------------------------------------
     State
     --------------------------------------------------------------------- */
  var stored    = readDecision();
  var decided   = !!stored;
  var marketing = decided ? stored.marketing === 1 : false;
  var regime    = decided ? stored.regime : '';
  var waiting   = [];   // callbacks registered before consent was granted

  function grant() {
    if (marketing) return;
    marketing = true;
    var queue = waiting;
    waiting = [];
    queue.forEach(function (fn) {
      try { fn(); } catch (e) { /* one broken tag must not stop the others */ }
    });
  }

  /* Meta's own cookies, dropped by fbevents.js once it has run. Revoking
     after the fact cannot unload a script that is already in the page, but it
     can stop every future event (track.js checks on each fire) and clear the
     identifiers left behind — which is the part that actually persists. */
  function clearMetaCookies() {
    var names = ['_fbp', '_fbc'];
    var host = location.hostname;
    var domains = ['', host, '.' + host];
    /* also the registrable domain, since fbevents sets it there */
    var parts = host.split('.');
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
    names.forEach(function (name) {
      domains.forEach(function (d) {
        try {
          document.cookie = name + '=; max-age=0; path=/' + (d ? '; domain=' + d : '');
        } catch (e) { /* nothing to do about a cookie we cannot touch */ }
      });
    });
  }

  /* ---------------------------------------------------------------------
     Public API — what pixel.js, track.js and the footer link use.
     --------------------------------------------------------------------- */
  window.vgConsent = {
    /* Current answer. track.js calls this on every event. */
    marketing: function () { return marketing; },

    /* Run fn once, as soon as marketing is allowed — now if it already is,
       later if the visitor accepts, never if they refuse. This is how a tag
       is wired up; nothing should read .marketing() to decide whether to
       load, because that answer can change after the page has settled. */
    onMarketing: function (fn) {
      if (typeof fn !== 'function') return;
      if (marketing) { try { fn(); } catch (e) {} return; }
      waiting.push(fn);
    },

    /* The visitor's answer. Persisted, applied, and the bar closes.

       Refusing clears Meta's identifiers unconditionally, not only when this
       session had granted consent first. They outlive a session: a visitor
       who accepted last week, came back, and refused this time has a state
       where marketing is already false and an _fbp cookie is still sitting
       in the browser. Clearing on every refusal costs nothing and is the
       only version that matches what section 6 of the privacy policy
       promises. */
    set: function (allow) {
      writeDecision(allow, regime || 'notice');
      decided = true;
      if (allow) {
        grant();
      } else {
        marketing = false;
        clearMetaCookies();
      }
      close();
    },

    /* Reopen the bar so a decision can be changed. Wired to the "Cookie
       settings" link in every footer — being able to withdraw consent as
       easily as it was given is the whole point of having asked. */
    open: function () {
      resolveRegime(function (r) { render(r); openBar(); });
    },

    regime: function () { return regime; }
  };

  /* ---------------------------------------------------------------------
     Which regime applies

     sessionStorage rather than localStorage: a country can change between
     visits (travel, a VPN switched on) and a stale "notice" cached for weeks
     would be exactly the wrong answer for the visitor it is wrong about.
     --------------------------------------------------------------------- */
  function timezoneFallback() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      return /^Europe\//.test(tz) ? 'optin' : 'notice';
    } catch (e) {
      /* No Intl at all is an ancient browser, not a European one. */
      return 'notice';
    }
  }

  function resolveRegime(done) {
    if (regime) return done(regime);

    var cached;
    try { cached = sessionStorage.getItem(REGIME_KEY); } catch (e) {}
    if (cached === 'optin' || cached === 'notice') {
      regime = cached;
      return done(regime);
    }

    var settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      regime = value;
      try { sessionStorage.setItem(REGIME_KEY, value); } catch (e) {}
      done(value);
    }

    /* A hung request must not leave the pixel waiting forever on a page it
       was allowed to run on. Two seconds, then fall back. */
    var timer = setTimeout(function () { settle(timezoneFallback()); }, 2000);

    try {
      fetch('/api/geo', { credentials: 'same-origin' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          clearTimeout(timer);
          settle(data && data.regime === 'optin' ? 'optin' : 'notice');
        })
        .catch(function () {
          clearTimeout(timer);
          settle(timezoneFallback());
        });
    } catch (e) {
      clearTimeout(timer);
      settle(timezoneFallback());
    }
  }

  /* ---------------------------------------------------------------------
     Copy

     Arabic is the source language of this site and English is the
     translation, the same way round as every data-en attribute in the
     markup. The bar is built in JavaScript rather than written into eight
     HTML files, so its strings live here instead — but it re-renders on the
     same `langchange` event site.js and main.js already dispatch, so it
     switches language with everything else.

     NO VENDOR NAMES AND NO JARGON IN HERE. The bar says what happens in the
     customer's terms — "we measure how well our ads work" — and never names
     the provider, the pixel, or a cookie. Naming a vendor on a shopfront tells
     a customer nothing they can act on and reads as something to be wary of,
     which is the opposite of what a consent notice is for.

     It is also not a legal shortcut: GDPR Art. 13(1)(e) asks for the
     recipients "or CATEGORIES of recipients", so a plain description is a
     valid disclosure on its own. Section 6 of privacy.html carries the fuller
     version in the same plain language, one click away through the link
     below — the layered notice the transparency guidelines actually ask for.
     If you ever add a second measurement provider, this copy does not change. */
  var COPY = {
    optin: {
      ar: {
        title: 'الخصوصية واختيارك',
        body: 'بنستخدم كوكيز أساسية عشان الموقع والسلة وتسجيل الدخول يشتغلوا. وبموافقتك بس، بنقيس كمان أداء إعلاناتنا. لو رفضت، مابنقيسش أي حاجة.',
        accept: 'أوافق',
        reject: 'أرفض',
        link: 'سياسة الخصوصية'
      },
      en: {
        title: 'Privacy and your choice',
        body: 'We use essential cookies to run the site, your cart and your sign-in. Only with your consent, we also measure how well our ads work. Refuse and we measure nothing.',
        accept: 'Accept',
        reject: 'Reject',
        link: 'Privacy policy'
      }
    },
    notice: {
      ar: {
        title: 'الكوكيز والقياس',
        body: 'بنستخدم كوكيز أساسية عشان الموقع والسلة وتسجيل الدخول يشتغلوا، وبنقيس أداء إعلاناتنا. تقدر توقف القياس ده في أي وقت.',
        accept: 'تمام',
        reject: 'أوقف القياس',
        link: 'سياسة الخصوصية'
      },
      en: {
        title: 'Cookies and measurement',
        body: 'We use essential cookies to run the site, your cart and your sign-in, and we measure how well our ads work. You can turn that measurement off at any time.',
        accept: 'Got it',
        reject: 'Turn off measurement',
        link: 'Privacy policy'
      }
    }
  };

  function lang() {
    try { return localStorage.getItem('vg-lang') === 'en' ? 'en' : 'ar'; } catch (e) { return 'ar'; }
  }

  /* ---------------------------------------------------------------------
     The bar
     --------------------------------------------------------------------- */
  var bar, titleEl, bodyEl, acceptEl, rejectEl, linkEl, shown = false;

  /* privacy.html sits at the site root next to every page that loads this,
     so a relative href is correct from all of them. #cookies is section 6. */
  var PRIVACY_HREF = 'privacy.html#cookies';

  function build() {
    if (bar) return;

    bar = document.createElement('aside');
    bar.className = 'cookiebar';
    bar.id = 'cookiebar';
    /* Not a dialog and not modal: it must never trap focus or block the page,
       because on the notice side there is nothing to decide before browsing,
       and on the opt-in side a wall would be pressure, not a choice. */
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Cookies');

    var box = document.createElement('div');
    box.className = 'cookiebar__in';

    var text = document.createElement('div');
    text.className = 'cookiebar__text';
    titleEl = document.createElement('p');
    titleEl.className = 'cookiebar__title';
    bodyEl = document.createElement('p');
    bodyEl.className = 'cookiebar__body';
    linkEl = document.createElement('a');
    linkEl.className = 'cookiebar__link';
    linkEl.href = PRIVACY_HREF;
    bodyEl.appendChild(document.createTextNode(' '));
    bodyEl.appendChild(linkEl);
    text.appendChild(titleEl);
    text.appendChild(bodyEl);

    var actions = document.createElement('div');
    actions.className = 'cookiebar__actions';

    /* Reject first in the DOM so it is first in the tab order, and styled at
       the same size as Accept. Both regimes get both buttons. */
    rejectEl = document.createElement('button');
    rejectEl.type = 'button';
    rejectEl.className = 'btn btn--sm btn--ghost';
    rejectEl.addEventListener('click', function () { window.vgConsent.set(false); });

    acceptEl = document.createElement('button');
    acceptEl.type = 'button';
    acceptEl.className = 'btn btn--sm';
    acceptEl.addEventListener('click', function () { window.vgConsent.set(true); });

    actions.appendChild(rejectEl);
    actions.appendChild(acceptEl);

    box.appendChild(text);
    box.appendChild(actions);
    bar.appendChild(box);
    document.body.appendChild(bar);
  }

  function render(which) {
    if (!bar) return;
    var copy = COPY[which === 'optin' ? 'optin' : 'notice'][lang()];
    titleEl.textContent = copy.title;
    bodyEl.firstChild.nodeValue = copy.body + ' ';
    linkEl.textContent = copy.link;
    acceptEl.textContent = copy.accept;
    rejectEl.textContent = copy.reject;
  }

  /* The bar is pinned to the bottom, and so are the checkout bar and the
     toast. Publishing its height lets those offset by it instead of guessing
     a gap — the same contract .cobar already uses with --cobar-h. */
  function publishHeight() {
    try {
      document.body.style.setProperty(
        '--cookiebar-h', shown ? bar.offsetHeight + 'px' : '0px'
      );
    } catch (e) {}
  }

  function openBar() {
    build();
    shown = true;
    /* Force a reflow so the entry transition runs on a freshly inserted
       node, the same trick site.js uses for a repeated toast. */
    void bar.offsetWidth;
    bar.classList.add('is-on');
    publishHeight();
  }

  function close() {
    if (!bar) return;
    shown = false;
    bar.classList.remove('is-on');
    publishHeight();
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  function boot() {
    if (decided) {
      /* Returning visitor: apply and stay out of the way. No bar, no
         request, no delay before the pixel. */
      if (marketing) grant();
      return;
    }

    resolveRegime(function (which) {
      if (which === 'notice') {
        /* Implied consent: measurement runs and the bar says so. The
           decision is only written when the visitor acknowledges it, so the
           bar keeps appearing until someone actually reads it. */
        grant();
      }
      build();
      render(which);
      openBar();
    });
  }

  /* document.body has to exist before the bar can be appended. This file is
     `defer`, so parsing is finished by the time it runs — but the region
     lookup is async and resolveRegime can call back either way, so the guard
     is cheap insurance rather than dead code. */
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  /* Language: site.js and main.js both dispatch this after swapping every
     data-en node, so the bar changes with the rest of the page. */
  document.addEventListener('langchange', function () {
    if (bar) render(regime);
  });

  /* The bar wraps to two lines on a narrow screen, so its height is not
     constant. Re-publish it rather than let the toast sit under it. */
  window.addEventListener('resize', function () { if (shown) publishHeight(); }, { passive: true });

  /* Every footer carries `data-consent="open"`. Delegated so it works on
     pages whose footer is rendered by JavaScript, and on the ones where it
     is static markup. */
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-consent="open"]');
    if (!el) return;
    e.preventDefault();
    window.vgConsent.open();
  });
})();
