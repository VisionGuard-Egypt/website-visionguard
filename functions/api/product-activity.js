/* GET /api/product-activity?id=<product-id>

   How much genuine interest a product has had recently, for the social-proof
   line on its page: "12 people viewed this in the last 24 hours".

   ---------------------------------------------------------------------------
   WHY THESE NUMBERS ARE REAL
   ---------------------------------------------------------------------------
   The obvious way to build this badge is to invent it — pick a number between
   80 and 150, reshuffle it every few seconds, print "103 people are viewing
   this item". Plenty of shops do. It is not built that way here, for reasons
   that are practical before they are anything else:

     It is specifically illegal in markets this site already serves. The shop
     shows an opt-in cookie bar to EU, EEA, UK and Swiss visitors, which means
     it knowingly takes their traffic. Fabricated urgency and false "others
     are viewing" claims are on the EU Unfair Commercial Practices Directive's
     Annex I blacklist and are named outright in the UK's DMCC Act 2024 —
     banned per se, no proof of harm needed. Egypt's Consumer Protection Law
     181/2018 prohibits misleading commercial statements too.

     A made-up number cannot be defended and cannot be explained. If anyone
     asks where 103 came from, there is no answer that is not "we made it up",
     and that is a bad position for a shop whose whole pitch is that it is a
     real business with a real address and a phone number that answers.

     It also poisons your own data. The moment the badge is fiction, nobody on
     the team can trust any number on the site, including the ones that are
     true.

   The real figures are usually good enough. A product with genuine traffic
   gets a genuine badge; one without stays quiet, which is honest and costs
   nothing, because a badge reading "2 people viewed this" persuades no one
   anyway — see MIN_VIEWERS below.

   ---------------------------------------------------------------------------
   ADMIN NUMBERS ARE UNAFFECTED
   ---------------------------------------------------------------------------
   This endpoint only READS meta_events. It writes nothing, so nothing it does
   can appear in the admin Performance tab. The admin and the shopper are
   looking at the same underlying events; the shopper just sees a rounded
   count for one product.
*/
import { json, handle, clean } from '../../lib/util.js';
import { db } from '../../lib/db.js';

/* Below this, say nothing. A badge that reads "3 people viewed this" is worse
   than no badge: it reads as "nobody wants this". Silence is the honest and
   the more persuasive option for a quiet product. */
const MIN_VIEWERS = 5;

const WINDOW_HOURS = 24;
/* "Right now" is a 20-minute window. A visitor who opened the page ten
   minutes ago and left it in a tab is, for the purpose of this badge,
   still looking at it. */
const NOW_MINUTES = 20;

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = clean(url.searchParams.get('id') || '', 64).toLowerCase();

  const quiet = () => json(
    { ok: true, id, viewers: 0, views: 0, purchases: 0, show: false },
    200,
    /* Short public cache: this is identical for every visitor looking at the
       same product, so the edge can serve it and the database is hit once a
       minute per product rather than once per pageview. */
    { 'cache-control': 'public, max-age=60' }
  );

  if (!ID_RE.test(id)) return quiet();

  const sinceViews = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const sinceNow = new Date(Date.now() - NOW_MINUTES * 60 * 1000).toISOString();
  const sincePurchases = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

  let row;
  try {
    const d1 = await db(env);
    /* One round trip. json_each expands content_ids, which capi.js guarantees
       is valid JSON or NULL. Distinct client_ip rather than row count: three
       page refreshes by one person is one person. */
    row = await d1.prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN m.created_at >= ?2 AND m.event = 'ViewContent'
                             THEN m.client_ip END)                       AS viewers_now,
         COUNT(DISTINCT CASE WHEN m.created_at >= ?3 AND m.event = 'ViewContent'
                             THEN m.client_ip END)                       AS viewers_day,
         COUNT(DISTINCT CASE WHEN m.created_at >= ?4 AND m.event = 'Purchase'
                             THEN m.id END)                              AS purchases
       FROM meta_events m
       JOIN json_each(m.content_ids) je
      WHERE je.value = ?1
        AND m.content_ids IS NOT NULL
        AND m.created_at >= ?4`
    ).bind(id, sinceNow, sinceViews, sincePurchases).first();
  } catch (err) {
    /* A missing column on an un-migrated database, or no JSON1 — either way
       a shop page must not fail because a badge could not be computed. */
    console.error('product-activity failed', id, err && err.message);
    return quiet();
  }

  const viewersNow = Number(row && row.viewers_now) || 0;
  const viewersDay = Number(row && row.viewers_day) || 0;
  const purchases = Number(row && row.purchases) || 0;

  return json({
    ok: true,
    id,
    /* People whose ViewContent landed inside the last NOW_MINUTES. */
    viewers: viewersNow,
    /* Distinct people over the last day. This is the number the badge
       normally shows, because it is the one that is usually non-trivial. */
    views: viewersDay,
    purchases,
    windowHours: WINDOW_HOURS,
    /* The client does not decide whether it is worth showing — this does, so
       the threshold lives in one place. */
    show: viewersDay >= MIN_VIEWERS || purchases > 0
  }, 200, { 'cache-control': 'public, max-age=60' });
});
