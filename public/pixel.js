/* =========================================================================
   Vision Guard — pixel.js
   Meta Pixel base code.

   This is Meta's own snippet, moved out of the page on purpose.

   The CSP allows exactly one inline <script>, pinned by SHA-256 hash — the
   no-js/js class swap that has to run before first paint. Pasting the pixel
   inline would need a second hash, and that hash breaks on any whitespace
   change, in a way that fails silently: the pixel simply stops loading and
   nothing says so. An external file needs no hash at all, because
   `script-src 'self'` already covers it.

   PIXEL_ID is public. It ships in the page of every site running a pixel and
   identifies the ad account's dataset, nothing more. It is NOT an access
   token: the token belongs in the META_ACCESS_TOKEN secret, is read only by
   lib/meta.js on the server, and must never appear in anything served to a
   browser.

   Purchase events are NOT fired from here. They are sent twice, on purpose:
   once from the browser in shop.js when an order completes, and once from
   the server in functions/api/orders.js through the Conversions API. Meta
   deduplicates them. The server copy is the one that survives ad blockers
   and Safari, which is most of the traffic this shop actually gets.

   NOTHING BELOW RUNS WITHOUT CONSENT
   ----------------------------------
   consent.js decides, per visitor, whether marketing measurement is allowed
   at all — see that file for the two regimes. The whole loader is wrapped in
   its callback, so where consent is required and not given, fbevents.js is
   never requested: no third-party script, no cookie, no beacon. Where the
   regime is a notice rather than a question, the callback fires immediately
   and this behaves exactly as it did before.

   The <script src="consent.js"> tag MUST come before this one in the page.
   Both are `defer`, so document order is execution order. If it is missing or
   ordered after this file, window.vgConsent does not exist yet, and the
   pixel deliberately does not load: a missing consent layer must fail toward
   not tracking, never toward tracking anyway. The console.error is there
   because that failure is otherwise completely silent.
   ========================================================================= */
(function () {
  'use strict';

  var PIXEL_ID = '3744427775716864';

  function boot() {
    /* Meta's loader, verbatim apart from formatting. */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

    /* Published so track.js can re-init with Advanced Matching data once a
       customer identifies themselves. Meta's API for that is a second init
       with the same pixel id and a user-data object. */
    window.__vgPixelId = PIXEL_ID;

    fbq('init', PIXEL_ID);

    /* PageView stays in the base code, where Meta's documentation puts it and
       where it belongs: it must fire even if track.js never loads. Moving it
       out made the site's most basic measurement depend on a second file.

       What it needs in addition is an event id, so the server copy that
       track.js sends to /api/capi can carry the SAME one and Meta collapses
       the pair instead of counting the visit twice. The id is generated here,
       used here, and left on window for track.js to pick up. If track.js never
       arrives, this is simply an ordinary PageView with an id nobody else
       used, which costs nothing. */
    var pageViewId;
    try {
      pageViewId = (crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'pv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    } catch (e) {
      pageViewId = 'pv' + Date.now().toString(36);
    }
    window.__vgPageViewId = pageViewId;

    fbq('track', 'PageView', {}, { eventID: pageViewId });
  }

  if (window.vgConsent && typeof window.vgConsent.onMarketing === 'function') {
    window.vgConsent.onMarketing(boot);
  } else if (window.console && console.error) {
    console.error('pixel.js: consent.js did not load, or loaded after this file. ' +
                  'The pixel stays off. Check the <script> order in <head>.');
  }
})();
