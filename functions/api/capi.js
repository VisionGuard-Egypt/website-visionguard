/* POST /api/capi   { event, eventId, sourceUrl, data }

   The Conversions API endpoint, on this site's own domain.

   This is the first-party alternative to Meta's Conversions API Gateway. The
   Gateway is a server you deploy and pay for on your own cloud account; this
   is the same idea — events reaching Meta from a server rather than from the
   browser — running inside the Pages Function that already exists, using the
   access token already configured, with nothing new to maintain.

   What it buys, concretely:

     Ad blockers and Safari's tracking protection stop the browser pixel for
     a large share of real traffic. They cannot stop this, because it is not
     the browser that talks to Meta.

     Match quality. The IP, the user agent and Meta's own _fbp / _fbc cookies
     are read here, server-side, where they cannot be stripped. fbc in
     particular is derived from the fbclid on an ad click and is the
     strongest attribution signal available.

   Every event is ALSO fired by the browser pixel with the same event_id, and
   Meta collapses the pair into one. That is the whole design: two paths, one
   event, so a blocked browser costs the measurement nothing and an unblocked
   one is not counted twice.

   ---------------------------------------------------------------------------
   Why this endpoint is not simply "post anything to Meta"
   ---------------------------------------------------------------------------
   It is public and unauthenticated — it has to be, since it measures visitors
   who are not signed in. So it is written as if hostile input is the norm:

     - same-origin only, so another site cannot drive it
     - the event name must be one this shop actually fires; an allowlist, not
       a passthrough. Otherwise anyone could mint Purchase events into the ad
       account and poison both the reporting and the delivery optimisation
     - `value` is clamped, so a scripted "Purchase, value 10000000" cannot
       skew the numbers
     - rate limited per IP
     - it never accepts an email or phone from the request body. Identifiers
       come from the signed-in session or not at all — otherwise the endpoint
       would happily hash and forward any address anybody typed into it,
       which is a data-laundering hole, not a feature.
*/
import { json, handle, readJson, requireSameOrigin, clean, clientIp } from '../../lib/util.js';
import { db, rateLimit } from '../../lib/db.js';
import { currentUser, cookieValue } from '../../lib/auth.js';
import { sendMetaConversion, fbcFrom } from '../../lib/meta.js';

/* Exactly the events public/track.js fires. Adding one here without adding
   it there (or the reverse) is the bug this list exists to make obvious. */
const ALLOWED = new Set([
  'PageView', 'ViewContent', 'Search', 'AddToCart', 'InitiateCheckout',
  'AddPaymentInfo', 'Purchase', 'CompleteRegistration', 'Lead', 'Contact'
]);

/* A single order in this shop is a few thousand pounds. Anything past this is
   not a real basket, it is someone testing what the endpoint accepts. */
const MAX_VALUE = 2000000;

/* fbcFrom lives in lib/meta.js now — functions/api/orders.js needs the same
   rebuild-from-fbclid rule for its server-side Purchase, and two copies of a
   format string Meta defines is one copy too many. */

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const body = await readJson(request);
  const eventName = clean(body.event, 40);

  /* Answer 204 to everything plausible rather than describing what was wrong.
     This is a measurement endpoint on a public page: it should never become a
     way to probe what the ad account accepts, and a browser has nothing
     useful to do with the answer either way. */
  const drop = () => new Response(null, { status: 204 });
  if (!ALLOWED.has(eventName)) return drop();

  const d1 = await db(env);
  const ip = clientIp(request);

  /* THE LIMITER AND THE SESSION LOOKUP ARE ISSUED TOGETHER
     ------------------------------------------------------
     Neither reads anything the other produces, and this is the hottest
     endpoint on the site — public/track.js mirrors EVERY page view here, so
     each D1 round trip taken off this path is one that every visitor on every
     page is no longer holding a request open for. Awaited in sequence they
     cost two; issued together they cost one.

     The trade is that a rate-limited request now also pays for the session
     read. That is the right side to be wrong on. Being over the limit means
     more than 120 events in ten minutes from a single address — a script, not
     a shopper — while the request that gets the saving is every ordinary one.
     And for a signed-out visitor, which is most of this traffic, currentUser()
     returns on the missing cookie without touching D1 at all, so there is
     nothing extra to pay.

     Generous — a real visit fires several events — but bounded, so one machine
     cannot flood the dataset. Fails open, like every other limiter here:
     losing measurement is better than losing the page.

     Identity, if there is any, comes from the session cookie — never from the
     request body. */
  const [limit, user] = await Promise.all([
    rateLimit(d1, `capi:${ip}`, 120, 600),
    currentUser(context, d1).catch(() => null)     // signed out, or a cookie we cannot read
  ]);
  if (!limit.ok) return drop();

  const data = (body.data && typeof body.data === 'object') ? body.data : {};
  if (data.value !== undefined) {
    const v = Number(data.value);
    data.value = Number.isFinite(v) ? Math.min(Math.max(v, 0), MAX_VALUE) : 0;
  }

  const sourceUrl = clean(body.sourceUrl, 500) || request.headers.get('referer') || '';
  const eventId = clean(body.eventId, 100);
  const value = data.value !== undefined ? Number(data.value) : null;
  const currency = clean(data.currency, 10) || 'EGP';

  /* Which products this event was about.

     Without it the admin can only be told "412 ViewContent events", which is
     a number nobody can act on. With it the same rows answer "3 views of the
     Imou 3MP, 2 purchases of the UNV 2MP" — see the per-product table in
     functions/api/admin/stats.js, which runs json_each over this column.

     That query is why the value is ALWAYS valid JSON or NULL, never a
     half-formed string: json_each on malformed JSON errors, and it would take
     the whole stats endpoint down rather than one table with it. Ids are
     clamped in count and length because this is a public endpoint and the
     body is attacker-controlled. */
  const rawIds = Array.isArray(data.content_ids) ? data.content_ids : [];
  const contentIds = rawIds
    .map((v) => clean(v, 64))
    .filter(Boolean)
    .slice(0, 40);
  const contentName = clean(data.content_name, 120) ||
    /* AddToCart carries the name at the top level; the cart-shaped events
       carry per-line objects instead, so fall back to the first line. */
    (Array.isArray(data.contents) && data.contents.length ? clean(data.contents[0].name, 120) : '');

  const metaEventRow = {
    content_ids: contentIds.length ? JSON.stringify(contentIds) : null,
    content_name: contentName || null,
    id: eventId || `${eventName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    event: eventName,
    event_id: eventId,
    source_url: sourceUrl,
    value: Number.isFinite(value) ? Math.round(value) : null,
    currency,
    user_id: user ? user.id : null,
    external_id: user ? user.id : null,
    email: user ? user.email : null,
    phone: user ? user.phone : null,
    client_ip: ip,
    user_agent: request.headers.get('user-agent') || '',
    created_at: new Date().toISOString()
  };

  /* Written through waitUntil rather than awaited.

     Nothing in the response depends on this row: the handler answers 204 with
     no body whatever happens here, and no reader of meta_events runs inside
     this request. Awaiting it therefore bought nothing and cost a full D1
     write round trip on the response path of the most frequently called
     endpoint on the site. waitUntil keeps the write guaranteed — the isolate
     stays alive until it settles — while letting the visitor's browser go.

     The error handling below is unchanged and still matters; see the note. */
  context.waitUntil(
    d1.prepare(
      `INSERT INTO meta_events
         (id, event, event_id, source_url, value, currency, user_id, external_id, email, phone, client_ip, user_agent, created_at, content_ids, content_name)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
    ).bind(
      metaEventRow.id,
      metaEventRow.event,
      metaEventRow.event_id,
      metaEventRow.source_url,
      metaEventRow.value,
      metaEventRow.currency,
      metaEventRow.user_id,
      metaEventRow.external_id,
      metaEventRow.email,
      metaEventRow.phone,
      metaEventRow.client_ip,
      metaEventRow.user_agent,
      metaEventRow.created_at,
      metaEventRow.content_ids,
      metaEventRow.content_name
    ).run().catch((err) => {
      /* This row is the ONLY source for the admin Performance tab's traffic
         numbers — nothing else writes meta_events. Swallowing the error meant a
         failing insert looked exactly like a quiet week: every figure zero,
         nothing anywhere saying why. Measurement still must not break the page,
         so it stays non-fatal, but it no longer fails invisibly. */
      console.error('meta_events insert failed', eventName, err && err.message);
    })
  );

  /* Fired through waitUntil: the visitor's browser must never wait on
     Meta's API to finish, and a slow or failing Graph call must not turn
     into a slow page. */
  context.waitUntil(
    sendMetaConversion(env, {
      eventName,
      eventId,
      sourceUrl,
      customData: data,
      email: user ? user.email : '',
      phone: user ? user.phone : '',
      /* buildUserData splits this into fn / ln. Only ever present for a
         signed-in customer — an anonymous page view has no name to send, and
         guessing one would be worse than sending nothing.

         `country` is deliberately NOT asserted here. The shop only delivers
         in Egypt, so it is a fair inference for somebody who has ORDERED —
         and sendMetaPurchaseEvent does assert it — but a page view proves
         nothing about where the visitor is. */
      name: user ? user.name : '',
      externalId: user ? user.id : '',
      fbp: cookieValue(request, '_fbp'),
      fbc: fbcFrom(request, sourceUrl),
      clientIp: ip,
      userAgent: request.headers.get('user-agent') || ''
    }).then((res) => {
      if (!res || (res.ok !== true && res.skipped !== true)) {
        console.error('capi', eventName, JSON.stringify(res).slice(0, 300));
      }
    })
  );

  return drop();
});

/* A GET is what you get from pasting the URL into a browser to check the
   endpoint exists. Say so, rather than answering 405. */
export const onRequestGet = handle(async () =>
  json({
    ok: true,
    endpoint: 'Conversions API relay',
    method: 'POST',
    events: Array.from(ALLOWED)
  })
);
