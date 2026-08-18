/* =========================================================================
   Vision Guard — worklink.js
   The "Work" link in the main nav, for @visionguardeg.com accounts only.

   A top-level nav item beside Shop and Planner — NOT something inside the
   account page. Employees and administrators browse the shop like everybody
   else, and getting back to a timesheet or the catalogue editor meant going
   to Account first and then hunting for the right workspace. Both the
   employee tabs and the admin tabs sit behind this one link.

   A CLASSIC SCRIPT, NOT A MODULE, and that is not a style choice. The
   landing page's chrome is main.js, a classic script that never calls
   initChrome() — so a module could not reach index.html, which is the page
   an employee is most likely to be on. consent.js and promo.js are classic
   scripts for exactly this reason; see the note at the top of promo.js.

   INJECTED RATHER THAN MARKED UP. Nine pages each carry the nav twice — the
   bar and the burger menu — so hard-coding it would be eighteen copies of a
   link that most visitors must never see, kept in step by hand. Adding a
   page still needs the <script> tag, and nothing else.

   ---------------------------------------------------------------------------
   HOW IT KNOWS, AND THE BUG THAT SHAPED IT
   ---------------------------------------------------------------------------
   The first version read a localStorage flag and nothing else. account.js
   wrote that flag on sign-in — which meant a member of staff who was ALREADY
   signed in, browsing the shop, never saw the link at all. The flag only
   appeared if they happened to open the account page again afterwards. The
   feature looked completely broken to the one person it was built for, and
   it was: the answer lived in a place nobody had a reason to visit.

   So this resolves the question itself:

     1. A stored answer paints immediately — no request, no flash, and it is
        what makes every page after the first one free.
     2. If this session has not asked the server yet, it asks ONCE, caches
        the answer, and repaints. One small request per visitor per session,
        not per page.
     3. account.js still writes the answer the moment it knows it, so signing
        in or out updates the link without waiting for anything.

   A `storage` event repaints other open tabs, so signing out in one does not
   leave the link sitting in another.

   IT IS A HINT, NOT A PERMISSION. Forging the flag draws a link and nothing
   more; it does not sign anyone in. Every endpoint behind the account page
   re-checks the session server-side — lib/auth.js, requireStaff and
   requireAdmin. The worst a stale flag can do is offer a link that lands on
   the sign-in form, which is also how it corrects itself.

   The keys are spelled out here rather than imported for the same reason the
   file is a classic script: there is nothing to import from. `vg-lang` is
   already duplicated across this boundary in consent.js and promo.js.
   ========================================================================= */
(function () {
  'use strict';

  var HINT = 'vg-staff';          // localStorage: '1' | '0', the durable answer
  var ASKED = 'vg-staff-asked';   // sessionStorage: already asked the server
  var HREF = 'account.html#work';
  var COPY = { ar: 'الشغل', en: 'Work' };

  function get(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function set(store, key, value) {
    try { store.setItem(key, value); } catch (e) { /* private mode */ }
  }

  function lang() {
    return get(localStorage, 'vg-lang') === 'en' ? 'en' : 'ar';
  }
  function label() { return COPY[lang()]; }

  /* ---- drawing ---- */

  /* The horizontal bar, above 900px. Placed after the Planner so the two
     destinations that are whole applications sit together and the page
     anchors that follow keep their order. */
  function addToBar() {
    var links = document.querySelector('.nav__links');
    if (!links || links.querySelector('.navlink-work')) return;

    var a = document.createElement('a');
    a.className = 'navlink-work';
    a.href = HREF;
    a.textContent = label();

    var planner = links.querySelector('a[href^="game"]');
    if (planner && planner.nextSibling) links.insertBefore(a, planner.nextSibling);
    else links.appendChild(a);
  }

  /* The burger menu, below 900px — where .nav__links is display:none.
     Without this the link would disappear on exactly the phones the staff
     are holding. */
  function addToMenu() {
    var menu = document.querySelector('.menu__inner');
    if (!menu || menu.querySelector('.navlink-work')) return;

    var a = document.createElement('a');
    a.className = 'navlink-work';
    a.href = HREF;

    /* Numbered like its neighbours, counted from the last one rather than
       assumed — the pages do not all list the same items. */
    var nums = menu.querySelectorAll('a > i');
    var n = nums.length ? (parseInt(nums[nums.length - 1].textContent, 10) || nums.length) + 1 : 1;
    var i = document.createElement('i');
    i.textContent = (n < 10 ? '0' : '') + n;

    var span = document.createElement('span');
    span.textContent = label();

    a.appendChild(i);
    a.appendChild(span);

    /* Before the footer block, which is the phone numbers and stays last. */
    var foot = menu.querySelector('.menu__foot');
    if (foot) menu.insertBefore(a, foot);
    else menu.appendChild(a);
  }

  function remove() {
    var all = document.querySelectorAll('.navlink-work');
    for (var i = 0; i < all.length; i++) all[i].parentNode.removeChild(all[i]);
  }

  /* Draws or removes to match `on`. Called again whenever the answer changes,
     so it has to be able to undo itself. */
  function paint(on) {
    if (!document.body) return;
    if (!on) return remove();
    addToBar();
    addToMenu();
  }

  /* Language. data-en cannot swap a node that did not exist when the page was
     parsed, so this redraws itself. Both halves of the site dispatch the
     event — site.js for the module pages, main.js for the landing page. */
  function relabel() {
    var text = label();
    var all = document.querySelectorAll('.navlink-work');
    for (var i = 0; i < all.length; i++) {
      var span = all[i].querySelector('span');
      if (span) span.textContent = text;
      else all[i].textContent = text;
    }
  }

  /* ---- deciding ---- */

  function ask() {
    if (get(sessionStorage, ASKED) === '1') return;
    /* Marked before the request, not after: two pages opened at once should
       not both ask, and a failed request should not retry on every page of
       the visit. */
    set(sessionStorage, ASKED, '1');

    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var staff = !!(data && data.user && data.user.staff);
        set(localStorage, HINT, staff ? '1' : '0');
        paint(staff);
      })
      .catch(function () {
        /* Offline or the API is down. Leave the stored answer alone — it is
           the best information available — and let the next session ask. */
        try { sessionStorage.removeItem(ASKED); } catch (e) {}
      });
  }

  function boot() {
    paint(get(localStorage, HINT) === '1');
    ask();
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  document.addEventListener('langchange', relabel);

  /* Another tab signed in or out. localStorage fires this everywhere except
     the tab that made the change, which is exactly the tab that already
     repainted itself. */
  window.addEventListener('storage', function (e) {
    if (e && e.key === HINT) paint(e.newValue === '1');
  });
})();
