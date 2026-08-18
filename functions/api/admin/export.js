/* /api/admin/export — the admin panel's two spreadsheet downloads.

   GET /api/admin/export?kind=catalog   the Meta product feed
   GET /api/admin/export?kind=data      orders, customers and events

   Both answer a real .xlsx built by lib/xlsx.js. Column shaping is in
   lib/metafeed.js — read the header of that file before changing a price
   column, it explains which of the shop's two numbers is the selling price
   and why cost never appears here.

   ---------------------------------------------------------------------------
   WHY THIS IS A GET, WHEN EVERY OTHER ADMIN WRITE IS A POST
   ---------------------------------------------------------------------------
   A download has to be reachable by navigation — the browser needs to handle
   Content-Disposition itself, which it will not do for a fetch() response
   without staging the whole file in memory and synthesising a blob URL. So
   this is a GET, which is also honest: it changes nothing.

   That means requireSameOrigin() does not apply (it guards mutations, and a
   GET carrying no side effect is not the CSRF target). requireAdmin() still
   does, and it is what actually protects the data: the data export carries
   customer names, addresses and phone numbers.

   ---------------------------------------------------------------------------
   NO-STORE IS NOT OPTIONAL
   ---------------------------------------------------------------------------
   A catalogue is public information. An order list is not. Both are served
   no-store so that neither the edge nor a shared browser cache keeps a copy
   of a spreadsheet full of customer addresses behind a URL that no longer
   requires the cookie that produced it.
*/
import { handle, ApiError, cairoDate } from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';
import { buildWorkbook, XLSX_CONTENT_TYPE, attachment } from '../../../lib/xlsx.js';
import {
  catalogSheet, conversionSheet, audienceSheet, orderSheet, eventSheet
} from '../../../lib/metafeed.js';

/* Generous, because a spreadsheet is a thing a person clicks twice when the
   first click seems not to have done anything — but bounded, because each
   call is a full table scan and a workbook built in memory. */
const RATE_PER_HOUR = 60;

function xlsx(bytes, filename) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': XLSX_CONTENT_TYPE,
      'content-disposition': attachment(filename),
      'content-length': String(bytes.length),
      'cache-control': 'no-store'
    }
  });
}

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  const admin = await requireAdmin(context, d1);
  await enforceRate(d1, `export:${admin.id}`, RATE_PER_HOUR, 3600);

  const url = new URL(request.url);
  const kind = (url.searchParams.get('kind') || '').toLowerCase();
  const today = cairoDate();

  /* The origin every image_link and link in the feed is built on.

     Defaults to the host the administrator is actually on, which is right
     everywhere without configuration — including `wrangler pages dev`, where
     a feed full of visionguardeg.com URLs would be a lie about what was
     tested. But the live site answers on BOTH visionguardeg.com and
     www.visionguardeg.com with no redirect between them, so which one ends
     up in the feed would otherwise depend on how the admin happened to
     navigate. Meta treats those as two different product URLs. SITE_ORIGIN
     pins it; see .dev.vars.example. */
  const origin = String(env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');

  /* ---- the product feed ---- */
  if (kind === 'catalog') {
    const { results } = await d1.prepare(
      `SELECT id, cat, brand, name, ar, en, img, price, was, active
         FROM products ORDER BY cat, sort, name`
    ).all();

    const sheet = catalogSheet(results || [], origin);
    const bytes = buildWorkbook([{ name: sheet.name, columns: sheet.columns, rows: sheet.rows }]);

    const res = xlsx(bytes, `VG_Meta_Catalog_${today}.xlsx`);
    res.headers.set('x-vg-rows', String(sheet.rows.length));

    /* The rows Meta will refuse are worth knowing about before the upload,
       not after — and a download has no body left to say it in, so they ride
       on a header.

       PERCENT-ENCODED, because an HTTP header value is bytes and a reader is
       entitled to treat them as latin-1. The first version of this sent the
       text raw and the em dash in "image is an SVG — Meta accepts JPEG or
       PNG only" arrived in the panel as "â". Every message here is written
       in English ASCII today, but the panel is a bilingual surface and the
       next warning added will not be. The client decodes it. */
    if (sheet.warnings.length) {
      const MAX = 6;
      const shown = sheet.warnings.slice(0, MAX);
      if (sheet.warnings.length > MAX) {
        shown.push(`and ${sheet.warnings.length - MAX} more`);
      }
      res.headers.set('x-vg-warnings', encodeURIComponent(shown.join('; ')));
    }
    return res;
  }

  /* ---- orders, customers, events ---- */
  if (kind === 'data') {
    const [orders, users, newsletter, events] = await Promise.all([
      d1.prepare(
        `SELECT id, created_at, status, name, phone, email, governorate, address,
                items, subtotal, shipping, total, currency, payment, payment_status,
                discount, discount_code
           FROM orders ORDER BY created_at DESC`
      ).all(),
      d1.prepare(
        `SELECT email, name, phone, marketing FROM users WHERE role = 'customer'`
      ).all(),
      d1.prepare(
        `SELECT email, name, marketing, unsub_at FROM newsletter`
      ).all(),
      /* substr rather than date() so a NULL or a malformed created_at groups
         into something visible instead of vanishing from the report. */
      d1.prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                event,
                COUNT(*)                        AS n,
                COUNT(DISTINCT COALESCE(external_id, client_ip)) AS people,
                COALESCE(SUM(value), 0)         AS value
           FROM meta_events
          GROUP BY day, event
          ORDER BY day DESC, n DESC`
      ).all()
    ]);

    const o = orders.results || [];
    const bytes = buildWorkbook([
      conversionSheet(o),
      audienceSheet({ users: users.results || [], newsletter: newsletter.results || [], orders: o }),
      orderSheet(o),
      eventSheet(events.results || [])
    ]);

    const res = xlsx(bytes, `VG_Meta_Data_${today}.xlsx`);
    res.headers.set('x-vg-rows', String(o.length));
    return res;
  }

  throw new ApiError(400, 'bad_kind', 'kind must be "catalog" or "data".', { field: 'kind' });
});
