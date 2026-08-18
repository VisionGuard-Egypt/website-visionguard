/* GET /product?id=<slug> — the product page, with its markup filled in on the
   server before the HTML leaves the building.

   ---------------------------------------------------------------------------
   WHY THIS EXISTS: META'S CRAWLER DOES NOT RUN JAVASCRIPT
   ---------------------------------------------------------------------------
   public/product.html is a shell. Everything a shopper sees — the name, the
   price, the photograph — is fetched by product.js and written into the DOM
   after load. A browser is fine with that. A crawler is not.

   Fetched as facebookexternalhit, every product URL on this site returned the
   SAME page: title "المنتج | Vision Guard", og:url "/product" with no id, and
   no price, no product name, no availability anywhere in the bytes. Sixty
   products, one indistinguishable document.

   That matters the moment the website is added as a data source for a Meta
   catalogue, because that is exactly what Meta does: it crawls the product
   URLs and reads the markup. With the shell alone it would ingest nothing, or
   ingest one bogus item sixty times.

   So this route intercepts the page and rewrites the head from the products
   table before serving it. The body is untouched — product.js still renders
   the page for humans exactly as before, and this adds no work to that path.

   ---------------------------------------------------------------------------
   THE ONE FIELD THAT MUST NOT DRIFT
   ---------------------------------------------------------------------------
   product:retailer_item_id is the id Meta stores for the item, and it has to
   equal the content_ids the pixel sends or the catalogue and the events
   describe different things — dynamic ads then retarget nobody, silently.
   public/track.js sends the D1 slug (viewProduct -> content_ids: [product.id]),
   so this sends the D1 slug. Same reasoning as lib/metafeed.js, which is the
   other half of this: the spreadsheet export and this page must agree.

   Both microdata-style og:product tags AND a JSON-LD Product block are
   emitted. Meta reads either; Google prefers JSON-LD. Writing both costs a few
   hundred bytes and removes a whole class of "why did it not pick this up".
*/
import { db } from '../lib/db.js';

const CURRENCY = 'EGP';

/* Attribute-safe. The catalogue is administrator-entered text that lands in
   an HTML attribute, so this is not optional. */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* JSON-LD sits inside a <script> element, where the escaping rules are not
   HTML's. JSON.stringify handles the quoting; the only real hazard is a
   literal "</script>" inside a value ending the block early. */
function jsonLd(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

/* Rewrites one <meta content="..."> in place. Used rather than deleting and
   re-appending so the tags stay where the page author put them. */
class SetContent {
  constructor(value) { this.value = value; }
  element(el) { el.setAttribute('content', this.value); }
}

class SetAttr {
  constructor(name, value) { this.name = name; this.value = value; }
  element(el) { el.setAttribute(this.name, this.value); }
}

class SetText {
  constructor(value) { this.value = value; }
  element(el) { el.setInnerContent(this.value); }
}

class Remove {
  element(el) { el.remove(); }
}

class AppendHead {
  constructor(html) { this.html = html; }
  element(el) { el.append(this.html, { html: true }); }
}

export async function onRequestGet(context) {
  const { request, env } = context;

  /* The static shell first. Everything below only edits it. */
  const res = await context.next();

  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return res;

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim().toLowerCase();

  /* Same origin pinning as the sitemap and the catalogue export: the site
     answers on two hostnames and the canonical names the apex. */
  const origin = String(env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');

  /* /product with no id is a real page — the shop links to it — but it
     describes no product, so it must not claim to be one. */
  if (!id) {
    return new HTMLRewriter()
      .on('head', new AppendHead('<meta name="robots" content="noindex, follow">'))
      .transform(res);
  }

  let product = null;
  try {
    const d1 = await db(env);
    product = await d1.prepare(
      `SELECT id, cat, brand, name, ar, en, img, price, was, active
         FROM products WHERE id = ?1`
    ).bind(id).first();
  } catch (err) {
    /* A database hiccup must not take the product page down. The shell still
       renders — product.js reads /api/catalog itself — it simply goes out
       without the enriched markup this time. */
    console.error('product markup: lookup failed —', err && err.message);
    return res;
  }

  /* An id that matches nothing. The page handles it client-side; what must
     not happen is a crawler indexing it or a catalogue ingesting it. */
  if (!product) {
    return new HTMLRewriter()
      .on('head', new AppendHead('<meta name="robots" content="noindex, follow">'))
      .transform(res);
  }

  const name = String(product.name || '').trim();
  const description = String(product.en || product.ar || name).trim();
  const brand = String(product.brand || '').trim() || 'Vision Guard';
  const link = `${origin}/product?id=${encodeURIComponent(product.id)}`;
  const img = String(product.img || '').trim();
  const image = img ? `${origin}/${img.replace(/^\/+/, '')}` : `${origin}/assets/og-card.jpg`;
  const availability = Number(product.active) === 0 ? 'out of stock' : 'in stock';

  /* Same orientation as lib/metafeed.js, and for the same reason: `was` is
     validated as strictly greater than price, so a discounted product lists
     at `was` and sells at `price`. Meta refuses a sale price above the
     price. */
  const discounted = Number(product.was) > 0;
  const listPrice = discounted ? Number(product.was) : Number(product.price);
  const salePrice = discounted ? Number(product.price) : null;

  const title = `${name} | Vision Guard`;

  const tags = [
    `<meta property="product:retailer_item_id" content="${esc(product.id)}">`,
    `<meta property="product:price:amount" content="${listPrice}">`,
    `<meta property="product:price:currency" content="${CURRENCY}">`,
    `<meta property="product:availability" content="${availability}">`,
    `<meta property="product:condition" content="new">`,
    `<meta property="product:brand" content="${esc(brand)}">`,
    `<meta property="product:category" content="${esc(product.cat || '')}">`
  ];
  if (salePrice !== null) {
    tags.push(`<meta property="product:sale_price:amount" content="${salePrice}">`);
    tags.push(`<meta property="product:sale_price:currency" content="${CURRENCY}">`);
  }

  /* Google and Meta both read this; it also carries the price precisely
     rather than as a string a parser has to guess at. */
  tags.push(
    '<script type="application/ld+json">' +
    jsonLd({
      '@context': 'https://schema.org/',
      '@type': 'Product',
      name,
      description,
      image: [image],
      sku: product.id,
      brand: { '@type': 'Brand', name: brand },
      offers: {
        '@type': 'Offer',
        url: link,
        priceCurrency: CURRENCY,
        price: salePrice !== null ? salePrice : listPrice,
        itemCondition: 'https://schema.org/NewCondition',
        availability: availability === 'in stock'
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock'
      }
    }) +
    '</script>'
  );

  return new HTMLRewriter()
    .on('title', new SetText(title))
    .on('meta[name="description"]', new SetContent(description))
    .on('link[rel="canonical"]', new SetAttr('href', link))
    /* website -> product. Meta keys the whole object off this. */
    .on('meta[property="og:type"]', new SetContent('product'))
    .on('meta[property="og:title"]', new SetContent(title))
    .on('meta[property="og:description"]', new SetContent(description))
    .on('meta[property="og:url"]', new SetContent(link))
    .on('meta[property="og:image"]', new SetContent(image))
    .on('meta[property="og:image:alt"]', new SetContent(name))
    /* The 1200x630 on the page belongs to the share card, not to a product
       photograph — leaving them would be stating the wrong dimensions. */
    .on('meta[property="og:image:width"]', new Remove())
    .on('meta[property="og:image:height"]', new Remove())
    .on('head', new AppendHead(tags.join('')))
    .transform(res);
}
