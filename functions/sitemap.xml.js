/* GET /sitemap.xml — the site's index for search engines.

   ---------------------------------------------------------------------------
   WHY THIS IS A FUNCTION AND NOT A FILE IN public/
   ---------------------------------------------------------------------------
   A static sitemap.xml would list sixty products that are edited from the
   admin panel, and nothing would ever regenerate it — there is no build step
   in this repository. It would be wrong the first time somebody added a
   product and would stay wrong silently, which is the same class of problem
   as the static catalogue drifting away from D1.

   Reading the products table means the sitemap is right by construction. If
   D1 is unavailable it still answers with the nine fixed pages rather than
   failing: a partial sitemap is useful, and a 500 on /sitemap.xml is a thing
   Search Console reports as an error against the whole site.

   ---------------------------------------------------------------------------
   WHAT IS DELIBERATELY NOT IN IT
   ---------------------------------------------------------------------------
   /account is a signed-in dashboard and carries noindex, so listing it would
   be asking a crawler to index a page we have told it to ignore. Withdrawn
   products (active = 0) are excluded for the same reason a withdrawn product
   cannot be bought.

   No <changefreq> or <priority>. Google has said publicly it ignores both,
   and a number nobody reads is a number that will eventually be wrong.
   <lastmod> IS included for products, because products.updated_at is a real
   date this system actually maintains — see functions/api/admin/catalog.js,
   which writes it on every save.
*/
import { db } from '../lib/db.js';

/* The pages that exist regardless of what is in the database. Paths are the
   extensionless form Pages actually serves — /shop, not /shop.html — because
   that is what a crawler will follow from the site's own links, and listing
   the other form would advertise a URL that 308s. */
const STATIC_PATHS = ['/', '/shop', '/game', '/privacy', '/terms', '/refund', '/shipping'];

/* Five characters XML reserves. A product id is a validated slug so it cannot
   contain any of them today, but a sitemap that breaks on one bad row takes
   the whole file down with it. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function onRequestGet(context) {
  const { request, env } = context;

  /* Same reasoning as the catalogue export: the live site answers on both
     visionguardeg.com and www.visionguardeg.com, and a sitemap that lists one
     host while the canonicals name another is a contradiction a crawler has
     to resolve on its own. SITE_ORIGIN pins it; see .dev.vars.example. */
  const origin = String(env.SITE_ORIGIN || new URL(request.url).origin).replace(/\/+$/, '');

  const urls = STATIC_PATHS.map((p) => ({ loc: origin + p, lastmod: '' }));

  try {
    const d1 = await db(env);
    const { results } = await d1.prepare(
      `SELECT id, updated_at FROM products WHERE active = 1 ORDER BY cat, sort, name`
    ).all();

    for (const row of results || []) {
      urls.push({
        loc: `${origin}/product?id=${encodeURIComponent(row.id)}`,
        /* Sitemaps want W3C datetime; the column is already an ISO string, so
           the date half of it is valid as-is. A malformed value is dropped
           rather than emitted — an invalid lastmod invalidates the entry. */
        lastmod: /^\d{4}-\d{2}-\d{2}/.test(String(row.updated_at || ''))
          ? String(row.updated_at).slice(0, 10)
          : ''
      });
    }
  } catch (err) {
    /* Logged, not thrown. The seven fixed pages are still worth serving. */
    console.error('sitemap: products unavailable —', err && err.message);
  }

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) =>
      '  <url><loc>' + esc(u.loc) + '</loc>' +
      (u.lastmod ? '<lastmod>' + esc(u.lastmod) + '</lastmod>' : '') +
      '</url>'
    ).join('\n') +
    '\n</urlset>\n';

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      /* An hour at the edge. The catalogue changes rarely and a crawler that
         reads a slightly stale sitemap loses nothing; hammering D1 on every
         bot request gains nothing either. */
      'cache-control': 'public, max-age=3600, must-revalidate'
    }
  });
}
