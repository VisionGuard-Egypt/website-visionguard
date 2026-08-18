/* =========================================================================
   /api/orders

   POST  place an order (guest or signed in)
   GET   list the signed-in customer's own orders

   Order of operations on POST is deliberate: validate, re-price from the
   catalogue, write to D1, respond, and only then reach for WhatsApp. The
   customer's confirmation never waits on Meta's API, and a failed
   notification can never lose an order that was already taken.
   ========================================================================= */
import {
  json, handle, readJson, requireSameOrigin, ApiError,
  clean, required, normEmail, normPhoneEg, clientIp
} from '../../lib/util.js';
import { db, enforceRate } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import {
  priceCart, shippingFor, orderNumber, isGovernorate, isPayment,
  DEFAULT_PAYMENT_STATUS, orderMessage, publicOrder
} from '../../lib/orders.js';
import { notifyWhatsApp, recordNotify } from '../../lib/whatsapp.js';
import { STAFF_DOMAIN } from '../../lib/auth.js';
import { staffRecipients, notifyOrder } from '../../lib/notify.js';
import { sendMetaPurchaseEvent, fbcFrom } from '../../lib/meta.js';
import { cookieValue } from '../../lib/auth.js';
import { loadCatalog } from '../../lib/products.js';
import { leadFromOrder } from '../../lib/leads.js';
import { randomId } from '../../lib/auth.js';
import { ipSignal } from '../../lib/coupon.js';
import { resolveDiscount, redeemPromo } from '../../lib/promos.js';

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const ip = clientIp(request);
  await enforceRate(d1, `order:${ip}`, 12, 3600);

  const body = await readJson(request);
  const user = await currentUser(context, d1);

  /* --- who and where --- */
  const name = required(body.name, 'name', 120);
  const phone = normPhoneEg(body.phone, 'phone');
  const phoneAlt = body.phoneAlt ? normPhoneEg(body.phoneAlt, 'phoneAlt', true) : '';
  const email = body.email ? normEmail(body.email) : (user ? user.email : '');

  const governorate = isGovernorate(body.governorate);
  if (!governorate) {
    throw new ApiError(400, 'bad_governorate', 'Choose a governorate from the list.', { field: 'governorate' });
  }

  const address = required(body.address, 'address', 400);
  if (address.length < 8) {
    throw new ApiError(400, 'short_address', 'Give a full address — street, building and floor.', { field: 'address' });
  }

  const notes = clean(body.notes, 600);
  /* There is one method now — the customer pays on WhatsApp after placing the
     order — so anything the browser sends is normalised to it rather than
     rejected. A cached copy of the old checkout still posting `cod` should
     produce an ordinary order, not an error about a payment method the person
     using it was never shown. */
  const payment = isPayment(body.payment);
  const lang = body.lang === 'en' ? 'en' : 'ar';

  if (body.terms !== true) {
    throw new ApiError(400, 'terms_required', 'Please accept the terms and the exchange policy.', { field: 'terms' });
  }

  /* --- what, priced here and only here --- */
  /* Prices come from D1 when the products table has rows, and from
     public/catalog.js if it does not — see lib/products.js. Either way they
     come from the SERVER; the cart only ever supplied ids and quantities. */
  const catalog = await loadCatalog(d1);
  const { items, subtotal } = priceCart(body.cart, catalog.resolve);
  const shipping = shippingFor(env);

  /* --- the discount, decided HERE and nowhere else ---

     /api/coupon answered the same question a moment ago so the cart could
     show a line, and that answer is worth nothing: it was rendered in a
     browser and could say anything by the time it comes back. This runs the
     same resolveDiscount() against the same tables, with a subtotal the
     server built itself out of the catalogue. Exactly the reasoning
     lib/orders.js already applies to prices — the cart supplies ids and
     quantities, never money.

     It covers BOTH kinds of code now: the welcome offer, whose tier is read
     off the account's age, and anything an administrator issued, whose
     window and use count are read off the promos table. An empty code still
     asks "what is this person entitled to", so a customer who types nothing
     keeps getting their welcome discount automatically.

     Silently refused rather than rejected. Somebody whose eligibility
     lapsed between opening the cart and pressing the button — because they
     ordered from another tab, or the code ran out at midnight — should get
     their order, at the honest price, not an error message about a coupon
     they may not remember typing. The confirmation shows what was actually
     charged. */
  let discount = 0;
  let discountCode = null;
  let redeemed = null;
  {
    const verdict = await resolveDiscount(d1, {
      code: body.coupon, user, phone, email, subtotal
    });
    if (verdict.ok && verdict.discount > 0) {
      discount = verdict.discount;
      discountCode = verdict.code;
      /* Only an issued code has a counter to move. */
      if (verdict.kind === 'promo') redeemed = verdict.code;
    } else if (body.coupon && !verdict.ok) {
      console.info('coupon refused', verdict.reason, verdict.matched || '');
    }
  }

  /* Shipping is not discounted: the discount is on what the shop sells, and
     the courier is paid either way. */
  const total = subtotal - discount + shipping;

  const id = orderNumber();
  const createdAt = new Date().toISOString();

  /* payment_status is written as a literal 'pending' for the same reason
     status is written as a literal 'new': neither is ever anything else on a
     brand-new order, and a bind parameter would invite a caller to think it
     had a say. Nothing on this site can take money, so no order can arrive
     paid for. */
  await d1.prepare(
    `INSERT INTO orders
       (id, user_id, name, phone, phone_alt, email, governorate, address, notes,
        payment, payment_status, items, subtotal, shipping, total, currency, status, lang,
        notified, notify_error, ip, created_at, discount_code, discount)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11,?12,?13,?14,'EGP','new',?15,0,NULL,?16,?17,?18,?19)`
  ).bind(
    id, user ? user.id : null, name, phone, phoneAlt || null, email || null,
    governorate, address, notes || null, payment, JSON.stringify(items),
    subtotal, shipping, total, lang, ip, createdAt, discountCode, discount
  ).run();

  /* The code's counter moves only once the order it paid for exists, so a
     failed insert cannot burn a use of a limited code. Awaited rather than
     fired into waitUntil, because a code limited to fifty must not sell
     fifty-one while the counter catches up — but it is wrapped, because an
     order is the thing this shop exists for and a counter is not worth
     failing one over. */
  if (redeemed) {
    try {
      await redeemPromo(d1, redeemed);
    } catch (err) {
      console.error('promo redeem', redeemed, err && err.message);
    }
  }

  /* Several discounted first orders from one address is what somebody
     farming the code looks like. It is also what a family, an office and
     most Egyptian mobile networks look like, so it is REPORTED and never
     enforced — see ipSignal(). Logged after the write so noticing it can
     never cost the order. */
  if (discount > 0) {
    context.waitUntil(
      ipSignal(d1, ip, new Date(Date.now() - 7 * 86400000).toISOString())
        .then((signal) => {
          if (signal.suspicious) {
            console.warn(`coupon: ${signal.count} discounted first orders from ${ip} in 7 days (order ${id})`);
          }
        })
        .catch((err) => console.error('coupon ip signal', err && err.message))
    );
  }

  /* Optional newsletter opt-in taken at checkout. Never blocks the order. */
  if (body.newsletter === true && email) {
    try {
      await d1.prepare(
        `INSERT INTO newsletter (email, name, marketing, source, lang, created_at)
         VALUES (?1, ?2, ?3, 'checkout', ?4, ?5)
         ON CONFLICT(email) DO UPDATE SET
           marketing = MAX(newsletter.marketing, ?3),
           unsub_at  = NULL`
      ).bind(email, name, body.marketing === true ? 1 : 0, lang, createdAt).run();
    } catch (err) {
      console.error('newsletter at checkout', err && err.message);
    }
  }

  const order = {
    id, name, phone, phone_alt: phoneAlt, email, governorate, address, notes,
    payment, payment_status: DEFAULT_PAYMENT_STATUS, items, subtotal, shipping,
    total, currency: 'EGP', status: 'new',
    lang, created_at: createdAt,
    /* Carried on the object so the confirmation, the staff alert and the
       Meta event all describe the same order. `total` is already net of it. */
    discount, discount_code: discountCode
  };

  /* The WhatsApp push is a BACK-OFFICE notification and nothing else. It goes
     to the shop's own number, it is never surfaced to the customer, and the
     message body — which carries the full order and the customer's details —
     is deliberately not returned in this response. From the customer's side
     this is an ordinary online order: they get a number and a confirmation.

     Fired after the write and through waitUntil, so a WhatsApp outage cannot
     slow down or fail an order that has already been taken. */
  const text = orderMessage(order, env);
  /* The two template parameters, in the order the approved template declares
     them: {{1}} the order number, {{2}} the total. They are passed separately
     from `text` because a template cannot carry the full multi-line summary —
     `text` is still used for the plain-text path and for the fallback when a
     template send is rejected. See lib/whatsapp.js. */
  const templateParams = [id, `${total} EGP`];
  context.waitUntil(
    notifyWhatsApp(env, text, null, templateParams).then((result) => recordNotify(d1, id, result))
  );

  /* The same news, in the dashboard.

     Deliberately a SECOND channel rather than a replacement for the WhatsApp
     alert above. They fail in different ways and neither covers the other:
     WhatsApp reaches the owner's phone but is gone once scrolled past and
     depends on Meta's template approval staying valid, while this one is
     still there tomorrow, is visible to the moderators as well, and is the
     only one that survives a WhatsApp outage. An order is the event this
     shop exists for; two records of it is the right number.

     Everyone on the company domain, because in a team of four whoever sees
     it first is the one who acts on it. */
  context.waitUntil(
    staffRecipients(d1, STAFF_DOMAIN)
      .then((staff) => notifyOrder(d1, staff, {
        id, name, governorate, total, paymentStatus: DEFAULT_PAYMENT_STATUS
      }))
      .catch((err) => console.error('order notify', err && err.message))
  );

  /* Every order becomes somebody to follow up with.

     The leads board only ever knew about people an employee typed in by
     hand, which meant the one group most worth calling back — people who
     have actually bought something — was the group it did not contain.

     Keyed on the phone number, so a returning customer lands on the card
     that already exists rather than starting a second one. See
     leadFromOrder() in lib/leads.js for why the lead is `new` rather than
     `won`, and why a repeat order reopens a closed card.

     THROUGH waitUntil, AND IT SWALLOWS ITS OWN ERRORS. The response has
     already been decided by the time this runs. A leads row is bookkeeping;
     an order is the thing this shop exists for, and no amount of
     bookkeeping is worth failing one over. Same reasoning, and the same
     shape, as the two notifications above. */
  context.waitUntil((async () => {
    try {
      const result = await leadFromOrder(d1, order, randomId(12));
      await d1.prepare(
        `INSERT INTO lead_notes (id, lead_id, author_id, body, kind, created_at)
         VALUES (?1, ?2, NULL, ?3, 'order', ?4)`
      ).bind(randomId(12), result.leadId, result.note, createdAt).run();
    } catch (err) {
      console.error('lead from order', err && err.message);
    }
  })());

  /* Advertising measurement, only if the customer allowed it.

     This is the half of consent a browser cannot enforce: the relay below
     runs here, on the server, and reaches Meta whether or not the pixel was
     ever loaded — that is the entire point of it, and it is also why it has
     to be checked here. public/consent.js decides, public/shop.js sends the
     answer as `adConsent`, and a missing or false value means no.

     Defaulting a missing field to "no" is deliberate. An older cached
     shop.js that does not send the field yet will under-report for as long
     as it is cached, which costs some measurement; the other default would
     silently report customers who refused, which costs the promise the
     cookie bar makes. The order itself is unaffected either way. */
  if (body.adConsent === true) {
    const requestUrl = request.url || '';
    context.waitUntil(
      sendMetaPurchaseEvent(env, {
        ...order,
        total,
        value: total,
        subtotal,
        shipping,
        /* THE IDENTIFIERS THAT WERE ALREADY HERE AND WERE NOT BEING SENT.

           Every one of these is in scope at this exact point — the request
           that placed the order — and none of them was reaching Meta. The
           order already carries name and governorate, which buildUserData
           turns into fn / ln / ct; these six are the ones that live on the
           REQUEST rather than on the row, so they have to be lifted out
           here or they are gone by the time lib/meta.js runs.

           _fbp and _fbc are read server-side from the cookie header for the
           same reason the /api/capi relay does it: an ad blocker cannot
           strip what the browser never had to send. fbcFrom() rebuilds the
           click id from fbclid when the pixel was blocked before it could
           set the cookie — which is precisely when this path matters most. */
        userId: user ? user.id : '',
        /* `ip` is the one already resolved at the top of this handler and
           written onto the order row, so the event and the record agree. */
        clientIp: ip,
        userAgent: request.headers.get('user-agent') || '',
        fbp: cookieValue(request, '_fbp'),
        fbc: fbcFrom(request, requestUrl)
      }, requestUrl).then((result) => {
        if (!result || result.ok !== true) {
          console.info('meta purchase skipped or failed', result);
        }
      })
    );
  }

  /* `env` is what puts `payUrl` on the answer: the shop's WhatsApp number is
     server-owned, and the confirmation screen sends the customer there to
     pay. See publicOrder(). */
  return json({ ok: true, order: publicOrder(order, env) }, 201);
});

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  const user = await currentUser(context, d1);
  if (!user) return json({ ok: true, orders: [] });

  const { results } = await d1.prepare(
    `SELECT id, items, subtotal, shipping, total, currency, payment, payment_status,
            status, governorate, lang, created_at
       FROM orders WHERE user_id = ?1
      ORDER BY created_at DESC LIMIT 50`
  ).bind(user.id).all();

  return json({
    ok: true,
    /* Same `env` as the confirmation, and for the same reason: an order that
       has not been paid for yet is one the customer can still settle, and
       their own order list is exactly where they will look for it a day
       later. publicOrder() leaves `payUrl` off the paid ones. */
    orders: (results || []).map((row) => {
      let items = [];
      try { items = JSON.parse(row.items); } catch (e) { /* keep the row usable */ }
      return publicOrder(Object.assign({}, row, { items }), context.env);
    })
  });
});
