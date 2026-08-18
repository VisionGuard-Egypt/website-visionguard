/* =========================================================================
   The catalogue, read from D1 with public/catalog.js as the fallback.

   This is the file that decides what a product costs. functions/api/orders.js
   prices every line through it, so a row here is money — which is why the
   fallback exists and why it is a fallback rather than a default.

   WHY A FALLBACK AT ALL. The products table is seeded from catalog.js and was
   verified identical row by row. If a query fails, or the table is somehow
   empty, pricing from the static file is exactly the behaviour the shop had
   before D1 was involved — correct, just not editable. The alternative is a
   checkout that returns "unknown_product" for everything, which turns a
   database hiccup into a shop that cannot sell anything. Falling back to
   last-known-good prices is the safe direction to fail in.

   WHAT IS NEVER TRUSTED. The cart from the browser is a list of {id, qty}.
   Prices come from here and only here. That is what makes a tampered cart
   worthless, and it does not change by moving the source into a database —
   it is the reason the resolver is passed INTO priceCart rather than the
   cart carrying prices.

   `active = 0` products are excluded: a withdrawn product cannot be bought,
   even by someone who kept its id from an old page.
   ========================================================================= */
import { PRODUCTS as STATIC_PRODUCTS, findProduct as staticFind } from '../public/catalog.js';

function rowToProduct(r) {
  return {
    id: r.id,
    cat: r.cat,
    brand: r.brand || '',
    name: r.name,
    ar: r.ar || '',
    en: r.en || '',
    img: r.img || '',
    price: Number(r.price) || 0,
    was: Number(r.was) || 0
  };
}

/* Returns { products, resolve, source }.

   `source` is reported so the caller can log which path was taken — a shop
   silently serving stale static prices for a week is exactly the kind of
   thing that should be visible. */
export async function loadCatalog(d1) {
  try {
    const { results } = await d1.prepare(
      `SELECT id, cat, brand, name, ar, en, img, price, was
         FROM products WHERE active = 1 ORDER BY cat, sort, name`
    ).all();

    if (results && results.length) {
      const products = results.map(rowToProduct);
      const byId = new Map(products.map((p) => [p.id, p]));
      return {
        products,
        resolve: (id) => byId.get(String(id)) || null,
        source: 'd1'
      };
    }
    console.error('catalog: products table is empty — pricing from public/catalog.js');
  } catch (err) {
    console.error('catalog: D1 read failed, pricing from public/catalog.js —', err && err.message);
  }

  return {
    products: STATIC_PRODUCTS,
    resolve: (id) => staticFind(id),
    source: 'static'
  };
}
