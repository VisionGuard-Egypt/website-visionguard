/* GET /api/catalog — the same list the shop page imports, for anyone who
   would rather read it as JSON (a price feed, a spreadsheet, a second front
   end). Served from the identical module the checkout prices against, so it
   can never disagree with what an order actually costs. */
import { GOVERNORATES, imageFor } from '../../public/catalog.js';
import { json, handle } from '../../lib/util.js';
import { shippingFor } from '../../lib/orders.js';
import { db } from '../../lib/db.js';
import { loadCatalog } from '../../lib/products.js';
import { loadCategories } from '../../lib/categories.js';

/* The only endpoint here whose response is identical for every visitor and
   contains nothing personal, so it is the only one that may be cached.
   lib/util.js sends `no-store` on every JSON response by default — correct
   for a cart, a session or an attendance record, and pure waste for a fixed
   price list that changes when someone edits catalog.js and deploys.

   Ten seconds at the edge, with a thirty-second stale window on top. That is
   deliberately much shorter than the five minutes public/catalog.js carries
   in _headers, and the asymmetry is the point: this feed is what the shop
   page corrects itself from after first paint (see liveCatalog() in
   public/shop.js), so an admin's price edit has to surface here quickly even
   while the cached module is still the old one. The static file is the
   fallback; this is the correction, so it is the one that stays fresh.

   s-maxage lets Cloudflare's edge answer it without waking a Function at all;
   stale-while-revalidate means the one request that finds it expired still
   gets an instant answer while the refresh happens behind it. */
export const onRequestGet = handle(async ({ env }) => {
  const d1 = await db(env);
  /* Both reads on one connection, and both with the same static fallback —
     see lib/products.js and lib/categories.js. `categories` used to be the
     imported constant, which meant the homepage cards and the shop's filter
     chips could not be edited without a deploy. They are rows now, and this
     is the feed both pages correct themselves from after first paint.

     HIDDEN CATEGORIES ARE NOT IN THIS RESPONSE. loadCategories defaults to
     active only, and this is the public feed — a category an administrator
     has hidden must not come back as a filter chip. The admin tab asks for
     them explicitly with includeHidden. */
  const [catalog, cats] = await Promise.all([
    loadCatalog(d1),
    loadCategories(d1)
  ]);

  return json({
    ok: true,
    currency: 'EGP',
    shipping: shippingFor(env),
    categories: cats.categories,
    categorySource: cats.source,
    governorates: GOVERNORATES,
    source: catalog.source,
    products: catalog.products.map((p) => Object.assign({}, p, { image: imageFor(p) }))
  }, 200, {
    'cache-control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30'
  });
});
