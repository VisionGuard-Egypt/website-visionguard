/* /api/admin/meta-catalog — push the products table into the Meta catalogue.

   GET                        what is configured, and what WOULD be sent
   POST { action: 'sync' }    actually send it

   ---------------------------------------------------------------------------
   WHY THE GET IS A DRY RUN AND NOT JUST A STATUS
   ---------------------------------------------------------------------------
   The failure this is built against is not "the request errored". It is a
   sync that returns 200 and quietly puts the wrong thing in the catalogue —
   the purchase price instead of the selling price, links on the wrong host,
   rows Meta will refuse for having an SVG where a photograph belongs. None
   of those raise anything.

   So the GET returns the actual first rows that would be sent, together with
   every warning lib/metafeed.js can already produce about them. Looking
   before pressing is cheap; unpicking a catalogue that has been advertising
   the wrong price is not.

   ---------------------------------------------------------------------------
   THE SPREADSHEET IS STILL THERE
   ---------------------------------------------------------------------------
   /api/admin/export?kind=catalog is unchanged and is the fallback whenever
   this is not configured — see the header of lib/metacatalog.js. Nothing
   here removes a way of working that already works.

   ---------------------------------------------------------------------------
   NOTHING HERE THROWS ON MISSING CONFIGURATION
   ---------------------------------------------------------------------------
   Same rule as /api/marketing. An unconfigured deployment answers with
   `configured: false` and the name of what is missing, because a 500 on an
   admin screen is indistinguishable from a broken site. And as everywhere
   else in this project: setting a variable in the Pages dashboard is not
   enough on its own, because Pages binds variables to a DEPLOYMENT. Redeploy
   after adding the token or this keeps reporting it missing.
*/
import { json, handle, readJson, requireSameOrigin, ApiError } from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';
import { catalogStatus, buildBatches, syncCatalog } from '../../../lib/metacatalog.js';

/* Every row, active and withdrawn alike. A withdrawn product is not skipped:
   catalogRow() maps active = 0 to "out of stock", which is what keeps the
   item's id, its history and its ad performance while stopping it being
   sellable. Skipping it would leave Meta advertising it as in stock. */
const PRODUCTS_SQL = `SELECT id, cat, brand, name, ar, en, img, price, was, sort, active
                        FROM products ORDER BY cat, sort, name`;

/* The origin every image_link and link is built on. SITE_ORIGIN wins when it
   is set — see lib/metacatalog.js and functions/api/admin/export.js for why
   the two hosts this site answers on make that matter — and the admin's own
   origin is the fallback, which is right locally. */
const originFor = (env, url) => String(env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');

/* Bounded because each call is a full table scan plus a write to Meta, and
   Meta rate limits batch uploads per catalogue hard enough (error 80014)
   that an impatient double-press should not be what discovers the limit. */
const SYNC_PER_HOUR = 20;

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  await requireAdmin(context, d1);

  const url = new URL(request.url);
  const origin = originFor(env, url);
  const { results } = await d1.prepare(PRODUCTS_SQL).all();
  const products = results || [];

  const { requests, batches, warnings } = buildBatches(products, origin);
  const status = catalogStatus(env);

  return json({
    ok: true,
    /* `configured` is the token and nothing else. The catalogue id has a
       default (it names a destination, not a secret), so the only thing that
       can actually be missing is the credential. */
    configured: status.token && status.catalog,
    setup: status,
    origin,
    counts: {
      products: products.length,
      requests: requests.length,
      batches: batches.length
    },
    /* Ours, before Meta ever sees the rows — a missing image or an SVG is a
       rejection that can be predicted rather than discovered. */
    warnings,
    /* Enough to check the shape of, not the whole catalogue: this is for
       eyeballing that the price column and the host are right. */
    preview: requests.slice(0, 3).map((r) => r.data)
  });
});

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);
  const d1 = await db(env);
  const admin = await requireAdmin(context, d1);

  const body = await readJson(request);
  if (body && body.action && body.action !== 'sync') {
    throw new ApiError(400, 'bad_action', 'action must be sync.', { field: 'action' });
  }

  await enforceRate(d1, `metacatalog:${admin.id}`, SYNC_PER_HOUR, 3600);

  const url = new URL(request.url);
  const origin = originFor(env, url);
  const { results } = await d1.prepare(PRODUCTS_SQL).all();

  const result = await syncCatalog(env, results || [], origin);

  /* Not configured is a 200 with configured:false, not an error. The panel
     renders the same "switch it on" screen the marketing tab does, and an
     administrator who has not generated the token yet has not done anything
     wrong. */
  if (result.skipped) {
    return json({
      ok: false,
      configured: false,
      reason: result.reason,
      setup: result.status,
      message: 'No catalogue token set. Generate a System User token with catalog_management, set META_CATALOG_TOKEN, and redeploy.'
    });
  }

  /* A refusal from Meta IS an error worth a non-200 — a bad token or a
     missing scope is not a state the panel should render as success — but
     the body still carries what landed before it stopped. */
  if (!result.ok) {
    return json({ ok: false, configured: true, ...result }, 502);
  }

  return json({ ok: true, configured: true, ...result });
});
