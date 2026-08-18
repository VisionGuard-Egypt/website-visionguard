/* =========================================================================
   Vision Guard — track.js
   Meta Pixel standard events, in one place.

   pixel.js loads the pixel and fires PageView. This file is everything else:
   the shop's actual events, the shapes Meta expects them in, and the guards
   that stop one customer action being counted as several.

   A classic script, not a module, on purpose. index.html's main.js is a
   classic script too, and a module could not be imported from it — so this
   publishes window.vgTrack and every page uses it the same way, whether its
   own code is a module or not.

   WHICH EVENTS THIS SHOP ACTUALLY HAS
   -----------------------------------
   Meta publishes seventeen standard events. Firing ones that do not
   correspond to something a customer really did is not neutral: it trains
   the ad delivery model on fiction and it makes the funnel in Ads Manager
   lie to you. So the shop fires eight, and the other nine are deliberately
   absent — there is no wishlist, nothing to donate to, no appointments, no
   free trial, no paid subscription, no application to submit, no product
   configurator, and no branch finder. If any of those ever exist, add them
   here.

     PageView             every page (pixel.js)
     ViewContent          a category listing is opened
     Search               the catalogue search is used
     AddToCart            a unit is added to the cart
     InitiateCheckout     the checkout view is opened
     AddPaymentInfo       a payment method is chosen
     Purchase             an order is placed
     CompleteRegistration an account is created
     Lead                 someone opts into the mailing list
     Contact              a phone / WhatsApp / email link is used

   DEDUPLICATION
   -------------
   Purchase is sent twice on purpose — from the browser here, and from the
   server through the Conversions API in functions/api/orders.js. The server
   copy is the one that survives ad blockers and Safari, which is most of
   this shop's traffic. Meta collapses the pair into one conversion ONLY if
   both carry the same event_id. Both now send the order number. Without
   that, every order is counted twice and the revenue in Ads Manager is
   double the real figure.

   CONSENT
   -------
   Both halves are gated, and it has to be both. Gating only the pixel would
   leave /api/capi relaying the same events from the server, which is the
   path a visitor cannot block from their own browser — and the one they were
   promised was off. So allowed() is checked on every single event, not once
   at load: consent can be withdrawn from the footer link at any point in a
   session, and the next event after that must not go anywhere.

   Nothing is queued while consent is absent. An event describes something a
   visitor did at a moment; replaying a page's worth of them after a late
   Accept would report a history they did not agree to be watched through.
   The only thing that fires on a grant is the PageView for the page they are
   on, which is true at the moment it is sent.
   ========================================================================= */
(function () {
  'use strict';

  var CURRENCY = 'EGP';

  /* consent.js publishes this. Missing means it never loaded, and the same
     rule as pixel.js applies: no consent layer, no measurement. */
  function allowed() {
    return !!(window.vgConsent && window.vgConsent.marketing());
  }

  /* Server-side events: ON.

     The Conversions API secret is already configured for this Pages project,
     so the relay stays enabled permanently. The endpoint and lib/meta.js are
     intact; the browser now mirrors each event to /api/capi as designed, and
     Meta collapses that server copy with the matching browser event id.

     The browser pixel is not replaced by this and it never was: it belongs
     to Events Manager, not to the app. All ten events and Advanced Matching
     carry on exactly as before. The only new behavior is that the server-side
     copy now reaches Meta even when the browser pixel is blocked. */
  var CAPI_ENABLED = true;

  /* Every event gets an id, and the same id goes to both paths — the browser
     pixel and /api/capi. Meta collapses the pair into one event. Without it
     the server copy would double every number instead of rescuing the
     blocked ones. */
  function eventId() {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* older browser */ }
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* The server copy.

     keepalive so it still completes when fired from a click that navigates
     away — without it, Contact and Purchase would be the two events most
     likely to be lost, which are the two that matter most.

     Failure is silent by design: this is measurement, and a visitor must
     never see a broken page because an analytics call did not land. */
  function mirror(name, params, id) {
    if (!CAPI_ENABLED || !allowed()) return;
    try {
      fetch('/api/capi', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify({
          event: name,
          eventId: id,
          sourceUrl: location.href,
          data: params || {}
        })
      }).catch(function () {});
    } catch (e) { /* no fetch, or blocked: the pixel path may still work */ }
  }

  /* An ad blocker, a tracking-protection setting or a failed CDN load all end
     with fbq missing. The pixel call has to be a no-op then — but the server
     copy is fired regardless, and that is the entire point: it is the path
     that survives exactly the conditions that kill the pixel. */
  function fire(name, params, options) {
    if (!allowed()) return false;
    var id = (options && options.eventID) || eventId();
    mirror(name, params, id);
    try {
      if (typeof window.fbq !== 'function') return false;
      window.fbq('track', name, params || {}, { eventID: id });
      return true;
    } catch (e) {
      /* Never rethrow into a click handler that is trying to sell something. */
      if (window.console && console.info) console.info('pixel event skipped', name, e && e.message);
      return false;
    }
  }

  /* Some events describe a state rather than an action — opening a category,
     picking a payment method — and a customer who clicks back and forth
     should not generate ten of them. Keyed per page load. */
  var seen = {};
  function fireOnce(key, name, params, options) {
    /* The consent check comes BEFORE the key is marked. Marking first would
       burn the one shot on an event that was never sent, so a visitor who
       accepts halfway down a page would never get the events for what they
       do afterwards on it. */
    if (!allowed() || seen[key]) return false;
    seen[key] = true;
    return fire(name, params, options);
  }

  /* Meta wants cart contents in a specific shape, and getting it wrong means
     the events arrive but carry nothing usable for a catalogue or for
     dynamic ads. lines: [{ id, qty, unit }] */
  function contentsOf(lines) {
    return (lines || []).map(function (l) {
      return {
        id: String(l.id),
        quantity: Number(l.qty) || 0,
        item_price: Number(l.unit) || 0
      };
    });
  }

  function valueOf(lines) {
    return (lines || []).reduce(function (sum, l) {
      return sum + (Number(l.unit) || 0) * (Number(l.qty) || 0);
    }, 0);
  }

  /* ---------------------------------------------------------------------
     Advanced Matching.

     An event Meta cannot attribute to a person is worth far less than one it
     can. Server events already carry hashed identifiers; the browser pixel
     carried none, so events from customers we DO know matched to fewer
     people than they should have. This closes that.

     Everything is SHA-256'd here, in the browser, before it is handed to
     fbq. Meta's library would accept raw values and hash them itself, which
     is documented and permitted — but then the raw address is sitting in a
     third-party script's arguments on the page, and there is no reason to
     put it there when WebCrypto is two lines. What leaves the browser is an
     irreversible fingerprint Meta can match against its own hashes.

     Normalisation matters as much as the hash: Meta hashes ITS copy of a
     lowercased, trimmed address and a digits-only phone. Hash anything else
     and the fingerprints never line up, so the matching silently does
     nothing at all.
     --------------------------------------------------------------------- */
  async function sha256Hex(value) {
    var bytes = new TextEncoder().encode(String(value));
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map.call(new Uint8Array(digest),
      function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  async function identify(user) {
    try {
      if (!allowed()) return false;
      if (typeof window.fbq !== 'function' || !window.__vgPixelId) return false;
      if (!crypto || !crypto.subtle) return false;   // needs a secure context
      var data = {};
      if (user.email) data.em = await sha256Hex(String(user.email).trim().toLowerCase());
      if (user.phone) {
        var digits = String(user.phone).replace(/\D/g, '');
        if (digits) data.ph = await sha256Hex(digits);
      }
      /* Our own stable id for the person. Meta matches it across sessions
         and devices without it ever meaning anything outside this shop. */
      if (user.externalId) data.external_id = await sha256Hex(String(user.externalId));
      if (!Object.keys(data).length) return false;

      /* A second init with the same pixel id is how Meta's API attaches user
         data to everything fired afterwards. It does not create a second
         pixel and does not re-fire PageView. */
      window.fbq('init', window.__vgPixelId, data);
      return true;
    } catch (e) {
      if (window.console && console.info) console.info('advanced matching skipped', e && e.message);
      return false;
    }
  }

  window.vgTrack = {
    identify: identify,
    currency: CURRENCY,
    fire: fire,
    fireOnce: fireOnce,

    viewCategory: function (category, lines) {
      fireOnce('cat:' + category, 'ViewContent', {
        content_type: 'product_group',
        content_category: category,
        content_ids: (lines || []).map(function (l) { return String(l.id); }),
        currency: CURRENCY
      });
    },

    /* A single product's own page.

       Distinct from viewCategory on purpose. A category listing names every
       product in it, so counting those as views of each one turns "opened the
       Analog page" into a view of all fourteen analog cameras — which is what
       made the per-product numbers in the admin meaningless. This is one
       product, deliberately opened, and it is the event the "Events by
       product" table is really reporting.

       content_type 'product' rather than 'product_group' is also what Meta's
       catalogue and dynamic ads match on. */
    viewProduct: function (product) {
      if (!product || !product.id) return;
      fireOnce('prod:' + product.id, 'ViewContent', {
        content_type: 'product',
        content_ids: [String(product.id)],
        content_name: product.name || '',
        content_category: product.cat || '',
        value: Number(product.price) || 0,
        currency: CURRENCY
      });
    },

    search: function (queryText) {
      fire('Search', { search_string: String(queryText).slice(0, 100), content_category: 'catalogue' });
    },

    addToCart: function (line) {
      fire('AddToCart', {
        content_type: 'product',
        content_ids: [String(line.id)],
        content_name: line.name || '',
        contents: contentsOf([line]),
        value: (Number(line.unit) || 0) * (Number(line.qty) || 1),
        currency: CURRENCY
      });
    },

    initiateCheckout: function (lines) {
      fire('InitiateCheckout', {
        content_type: 'product',
        content_ids: (lines || []).map(function (l) { return String(l.id); }),
        contents: contentsOf(lines),
        num_items: (lines || []).reduce(function (n, l) { return n + (Number(l.qty) || 0); }, 0),
        value: valueOf(lines),
        currency: CURRENCY
      });
    },

    addPaymentInfo: function (method, lines) {
      fireOnce('pay:' + method, 'AddPaymentInfo', {
        content_category: method,
        contents: contentsOf(lines),
        value: valueOf(lines),
        currency: CURRENCY
      });
    },

    /* orderId is the deduplication key. It is the same string the server
       sends as event_id, and it is unique per order by construction. */
    purchase: function (orderId, lines, total) {
      fire('Purchase', {
        content_type: 'product',
        content_ids: (lines || []).map(function (l) { return String(l.id); }),
        contents: contentsOf(lines),
        num_items: (lines || []).reduce(function (n, l) { return n + (Number(l.qty) || 0); }, 0),
        value: Number(total) || 0,
        currency: CURRENCY
      }, { eventID: String(orderId) });
    },

    completeRegistration: function (method, userId) {
      fire('CompleteRegistration', {
        content_name: 'account',
        status: true,
        registration_method: method || 'email',
        currency: CURRENCY
      }, userId ? { eventID: 'reg:' + userId } : undefined);
    },

    lead: function (source) {
      fireOnce('lead:' + source, 'Lead', { content_name: 'newsletter', content_category: source, currency: CURRENCY });
    }
  };

  /* PageView: the pixel half is fired by pixel.js, as Meta's documentation
     specifies ("the page view event is included as part of your pixel base
     code") and so that it still happens if this file never loads. Only the
     server half is sent here, reusing the id pixel.js left behind so Meta
     deduplicates the pair.

     If pixel.js was blocked there is no id to reuse — and no pixel PageView
     to deduplicate against either — so a fresh one is generated and the
     server copy stands alone. That is exactly the visitor this endpoint
     exists to recover.

     Registered through consent rather than fired outright, so on a first
     visit it goes when the region lookup settles, and on an opt-in visit it
     goes only if Accept is clicked. consent.js drains its waiting list in
     registration order and pixel.js registered first — from the tag order in
     <head> — so __vgPageViewId is already set by the time this runs and the
     two copies still carry one id between them. */
  if (window.vgConsent && typeof window.vgConsent.onMarketing === 'function') {
    window.vgConsent.onMarketing(function () {
      mirror('PageView', {}, window.__vgPageViewId || eventId());
    });
  }

  /* -----------------------------------------------------------------------
     Contact, wired here rather than in each page.

     Every page carries the same phone and WhatsApp links in its nav strip,
     menu and footer, and re-wiring them four times is how one page quietly
     stops reporting. One delegated listener covers all of them, on whatever
     page this file is loaded into.

     Once per destination type per page: a customer who taps WhatsApp, comes
     back and taps it again has not contacted you twice.
     ----------------------------------------------------------------------- */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var kind = /^tel:/i.test(href) ? 'phone'
             : /wa\.me|whatsapp/i.test(href) ? 'whatsapp'
             : /^mailto:/i.test(href) ? 'email'
             : '';
    if (!kind) return;
    fireOnce('contact:' + kind, 'Contact', { content_category: kind });
  }, true);
})();
