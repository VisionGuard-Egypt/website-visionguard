/* =========================================================================
   The two Meta-shaped exports: the catalogue feed, and the data export.

   Row shaping lives here rather than in the route so it can be tested
   without a Request, a D1 binding or an admin session — see
   test/metafeed.test.js. The route reads the database and calls these; these
   know nothing about HTTP.

   ---------------------------------------------------------------------------
   WHICH NUMBER IS THE PRICE — read this before touching the price columns
   ---------------------------------------------------------------------------
   The supplied VG_Meta_Catalog.xlsx has, on all 64 rows, a `sale_price`
   exactly 25% ABOVE `price`. That looks like an error and is not: the shop
   buys at cost and resells at cost + 25%, so that sheet's `price` column is
   the PURCHASE price and its `sale_price` column is the retail price. Of the
   five rows in it whose link resolves to a product that actually exists,
   all five have sale_price equal to the live shop price, and none has
   `price` equal to it.

   Two consequences, both deliberate:

   1. This export NEVER emits cost. It reads products.price out of D1 — the
      selling price, the one functions/api/orders.js charges — and puts that
      in Meta's `price`. public/catalog.js already says the purchase-price
      column "must never be" in a file served to the browser; a public
      product feed is the same rule with a bigger audience. Publishing it
      would hand every competitor the shop's margin.

   2. `sale_price` is therefore EMPTY unless a product carries a real `was`.
      Meta reads sale_price as the discounted price, so it must be lower than
      price or the feed is rejected. The catalogue's own `was` column is
      already validated as strictly greater than `price`
      (functions/api/admin/catalog.js), which is the same relationship the
      other way up — so a discounted product maps price <- was and
      sale_price <- price, and an undiscounted one leaves the column blank.
      Every product has was = 0 today, so today the column is blank
      throughout. That is correct, not missing.

   ---------------------------------------------------------------------------
   WHY `id` IS THE SLUG AND NOT THE VG-UNI-CAM-0001 CODE
   ---------------------------------------------------------------------------
   The supplied sheet numbers products VG-UNI-CAM-0001. Nothing else in the
   system has ever heard of those codes, and 59 of its 64 rows link to a
   product id that does not exist in the shop.

   Meta matches a catalogue entry to a pixel event by comparing the feed's
   `id` against the event's `content_ids`. public/track.js sends the D1 slug
   — `content_ids: [String(product.id)]` — so the feed has to send the slug
   too. Anything else produces a catalogue that loads without error and never
   matches a single ViewContent or AddToCart, which is a failure that looks
   exactly like success right up until the retargeting spend is wasted.
   ========================================================================= */
import { cityEn, splitName } from './meta.js';

/* Meta wants "<amount> <ISO currency>". The catalogue stores whole pounds —
   the integer discipline described in functions/api/admin/catalog.js — so
   this never has to reason about piastres. */
function money(amount) {
  return `${Number(amount)} EGP`;
}

/* cityEn and splitName come from lib/meta.js rather than living here twice.

   Both surfaces are Meta surfaces — this file builds the offline-conversion
   upload, that one builds the Conversions API payload — and both have to
   translate an Arabic governorate to a Latin city and split a name the same
   way. Two copies of that would drift, and the failure would be silent on
   the side nobody was looking at. */

/* Stored as E.164 without the plus (see normPhoneEg). Meta's matcher wants
   the plus. */
function phoneE164(stored) {
  const d = String(stored || '').replace(/\D/g, '');
  return d ? '+' + d : '';
}

function parseItems(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

/* -------------------------------------------------------------------------
   1. The catalogue feed

   Column order is the supplied workbook's, exactly, because that is the
   mapping the shop's Meta catalogue is already configured against.
   ------------------------------------------------------------------------- */
export const CATALOG_COLUMNS = [
  { header: 'id',           width: 24, center: true },
  { header: 'image_link',   width: 62 },
  { header: 'description',  width: 44 },
  { header: 'title',        width: 38 },
  { header: 'price',        width: 14, center: true },
  { header: 'link',         width: 52 },
  { header: 'availability', width: 14, center: true },
  { header: 'condition',    width: 12, center: true },
  { header: 'brand',        width: 20, center: true },
  { header: 'sale_price',   width: 14, center: true }
];

/* One product, shaped for Meta, as NAMED FIELDS.

   This is the single source of truth for what a Vision Guard product looks
   like to Meta, and it exists as its own function because there are now two
   consumers of it that must not drift:

     catalogSheet()      below — the .xlsx an administrator downloads and
                         uploads by hand
     productItem()       lib/metacatalog.js — the same row pushed straight to
                         the catalogue over the Batch API

   The header of this file already argues the case for not writing that
   mapping twice (see the note on cityEn and splitName), and it applies with
   more force here: the two paths write to the SAME catalogue. If the
   spreadsheet said "in stock" where the API said "out of stock", whichever
   ran last would win and no error would be raised anywhere. Field names are
   Meta's own, so the object can be handed to the Batch API as-is.

   Warnings ride along per row rather than being collected here, because the
   spreadsheet reports them once at the end and the API reports them per
   item. Same text either way. */
export function catalogRow(p, base) {
  const discounted = Number(p.was) > 0;

  /* was is validated as strictly greater than price, so this orientation
     is the only one that can satisfy Meta's sale_price <= price. */
  const listPrice = discounted ? Number(p.was) : Number(p.price);
  const salePrice = discounted ? Number(p.price) : null;

  const warnings = [];
  const img = String(p.img || '').trim();
  if (!img) {
    /* Meta will not create a product without an image, so it is worth
       naming the row rather than shipping one that silently vanishes. */
    warnings.push(`${p.id}: no image — Meta will reject this row`);
  } else if (/\.svg$/i.test(img)) {
    /* An SVG is a document, not a photograph, and Meta's catalogue will
       not take one. This is not hypothetical: public/catalog.js ships line
       drawings for the commodity parts — coax, connectors, the rack, the
       junction box — precisely so they cannot be mistaken for a photo of a
       branded product. Every one of those rows is a silent rejection at
       upload time unless somebody is told first. */
    warnings.push(`${p.id}: image is an SVG — Meta accepts JPEG or PNG only`);
  }

  const description = String(p.en || p.ar || p.name || '').trim();
  if (!description) warnings.push(`${p.id}: no description`);

  return {
    id: p.id,
    image_link: img ? `${base}/${img.replace(/^\/+/, '')}` : '',
    description,
    title: String(p.name || '').trim(),
    price: money(listPrice),
    link: `${base}/product?id=${encodeURIComponent(p.id)}`,
    availability: Number(p.active) === 0 ? 'out of stock' : 'in stock',
    condition: 'new',
    brand: String(p.brand || '').trim() || 'Vision Guard',
    sale_price: salePrice === null ? '' : money(salePrice),
    warnings
  };
}

export function catalogSheet(products, origin) {
  const base = String(origin || '').replace(/\/+$/, '');
  const rows = [];
  const warnings = [];

  for (const p of products || []) {
    const r = catalogRow(p, base);
    warnings.push(...r.warnings);
    /* Column order is CATALOG_COLUMNS', which is the supplied workbook's.
       Driven off the header names rather than repeated by hand, so adding a
       column to the constant cannot leave this list one short. */
    rows.push(CATALOG_COLUMNS.map((c) => r[c.header]));
  }

  return { name: 'Worksheet', columns: CATALOG_COLUMNS, rows, warnings };
}

/* -------------------------------------------------------------------------
   2a. Offline conversions

   One row per order that represents a sale. Meta's offline event upload maps
   these columns directly; event_time goes out as ISO 8601 UTC, which its
   uploader accepts and a human can also read, unlike a Unix timestamp.

   Cancelled orders are excluded — uploading them would report revenue that
   was never taken. Everything else is included: this shop is cash on
   delivery, so an order is the conversion event, and the Orders sheet
   carries the status for anyone who wants to filter harder.
   ------------------------------------------------------------------------- */
export const CONVERSION_COLUMNS = [
  { header: 'event_name',        width: 14, center: true },
  { header: 'event_time',        width: 24 },
  { header: 'order_id',          width: 20, center: true },
  { header: 'value',             width: 12, center: true },
  { header: 'currency',          width: 10, center: true },
  { header: 'email',             width: 30 },
  { header: 'phone',             width: 18 },
  { header: 'fn',                width: 16 },
  { header: 'ln',                width: 18 },
  { header: 'ct',                width: 18 },
  { header: 'country',           width: 10, center: true },
  { header: 'content_ids',       width: 40 },
  { header: 'content_type',      width: 14, center: true },
  { header: 'num_items',         width: 11, center: true },
  { header: 'delivery_category', width: 18, center: true }
];

export function conversionSheet(orders) {
  const rows = [];
  for (const o of orders || []) {
    if (String(o.status) === 'cancelled') continue;
    const items = parseItems(o.items);
    const { fn, ln } = splitName(o.name);
    rows.push([
      'Purchase',
      o.created_at,
      o.id,
      { v: Number(o.total) || 0, number: true },
      o.currency || 'EGP',
      String(o.email || '').toLowerCase(),
      phoneE164(o.phone),
      fn,
      ln,
      cityEn(o.governorate),
      'EG',
      items.map((i) => i.id).join(','),
      'product',
      { v: items.reduce((n, i) => n + (Number(i.qty) || 0), 0), number: true },
      'home_delivery'
    ]);
  }
  return { name: 'Offline Conversions', columns: CONVERSION_COLUMNS, rows };
}

/* -------------------------------------------------------------------------
   2b. Customer list — for a Custom Audience

   CONSENT IS THE FILTER HERE, and it is the difference between this sheet
   and the one above. An offline conversion is measurement of a sale that
   happened. A customer list is uploaded to build an advertising audience,
   which is a different thing to do with somebody's phone number — so this
   sheet carries only people who ticked the marketing box, which the schema
   records on both users.marketing and newsletter.marketing.

   A customer is identified by email where there is one and by phone
   otherwise, so the same person arriving through both an order and the
   newsletter is one row.
   ------------------------------------------------------------------------- */
export const AUDIENCE_COLUMNS = [
  { header: 'email',   width: 32 },
  { header: 'phone',   width: 18 },
  { header: 'fn',      width: 16 },
  { header: 'ln',      width: 18 },
  { header: 'ct',      width: 18 },
  { header: 'country', width: 10, center: true },
  { header: 'value',   width: 12, center: true }
];

export function audienceSheet({ users, newsletter, orders }) {
  const byKey = new Map();

  function upsert(key, record) {
    if (!key) return;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, record);
      return;
    }
    /* Later sources fill gaps but never overwrite something already known —
       an order carries a real posted address, a newsletter row does not. */
    for (const field of ['email', 'phone', 'fn', 'ln', 'ct']) {
      if (!existing[field] && record[field]) existing[field] = record[field];
    }
    existing.value += record.value;
  }

  for (const u of users || []) {
    if (Number(u.marketing) !== 1) continue;
    const { fn, ln } = splitName(u.name);
    const email = String(u.email || '').toLowerCase();
    upsert(email || phoneE164(u.phone), {
      email, phone: phoneE164(u.phone), fn, ln, ct: '', value: 0
    });
  }

  for (const n of newsletter || []) {
    if (Number(n.marketing) !== 1) continue;
    if (n.unsub_at) continue;
    const { fn, ln } = splitName(n.name);
    const email = String(n.email || '').toLowerCase();
    upsert(email, { email, phone: '', fn, ln, ct: '', value: 0 });
  }

  /* Orders only top up people already on the list — being a customer is not
     itself a marketing consent, but it is the best address and city we hold
     for someone who did consent, and the lifetime value Meta wants. */
  for (const o of orders || []) {
    if (String(o.status) === 'cancelled') continue;
    const email = String(o.email || '').toLowerCase();
    const key = email && byKey.has(email) ? email
              : byKey.has(phoneE164(o.phone)) ? phoneE164(o.phone)
              : '';
    if (!key) continue;
    const rec = byKey.get(key);
    if (!rec.phone) rec.phone = phoneE164(o.phone);
    if (!rec.ct) rec.ct = cityEn(o.governorate);
    rec.value += Number(o.total) || 0;
  }

  const rows = [...byKey.values()].map((r) => [
    r.email, r.phone, r.fn, r.ln, r.ct, 'EG', { v: r.value, number: true }
  ]);

  return { name: 'Customer List', columns: AUDIENCE_COLUMNS, rows };
}

/* -------------------------------------------------------------------------
   2c. Orders — the shop's own record, not a Meta shape

   Everything the offline-conversion sheet drops for being none of Meta's
   business: status, address, the discount that was applied, the line items
   in words. This is the sheet an administrator actually reads.
   ------------------------------------------------------------------------- */
export const ORDER_COLUMNS = [
  { header: 'order_id',      width: 20, center: true },
  { header: 'placed_at',     width: 24 },
  { header: 'status',        width: 12, center: true },
  { header: 'customer',      width: 24 },
  { header: 'phone',         width: 16 },
  { header: 'email',         width: 30 },
  { header: 'governorate',   width: 18 },
  { header: 'address',       width: 44 },
  { header: 'items',         width: 54 },
  { header: 'subtotal',      width: 12, center: true },
  { header: 'discount_code', width: 14, center: true },
  { header: 'discount',      width: 11, center: true },
  { header: 'shipping',      width: 11, center: true },
  { header: 'total',         width: 12, center: true },
  { header: 'currency',      width: 10, center: true },
  { header: 'payment',       width: 12, center: true },
  /* Whether the money arrived. Appended rather than slotted beside `status`
     so every existing column keeps its index — the tests address these rows
     positionally, and so does anyone with a saved spreadsheet formula. */
  { header: 'payment_status', width: 16, center: true }
];

export function orderSheet(orders) {
  const rows = (orders || []).map((o) => {
    const items = parseItems(o.items);
    return [
      o.id,
      o.created_at,
      o.status,
      o.name,
      phoneE164(o.phone),
      String(o.email || '').toLowerCase(),
      cityEn(o.governorate),
      o.address,
      items.map((i) => `${i.qty}× ${i.name || i.id}`).join(', '),
      { v: Number(o.subtotal) || 0, number: true },
      o.discount_code || '',
      { v: Number(o.discount) || 0, number: true },
      { v: Number(o.shipping) || 0, number: true },
      { v: Number(o.total) || 0, number: true },
      o.currency || 'EGP',
      /* A row written before the shop stopped taking cash on delivery has
         its own method on it; only a row missing the column entirely falls
         back, and transfer is the only method there is now. */
      o.payment || 'transfer',
      /* NULL means the order predates the column, which reads as pending —
         never as paid. See the migration note in lib/db.js. */
      o.payment_status || 'pending'
    ];
  });
  return { name: 'Orders', columns: ORDER_COLUMNS, rows };
}

/* -------------------------------------------------------------------------
   2d. Daily events — the performance half of the ask

   meta_events already stores every event the relay sent, so a day/event
   pivot is the site's traffic and funnel in Meta's own vocabulary, next to
   the orders those events led to.
   ------------------------------------------------------------------------- */
export const EVENT_COLUMNS = [
  { header: 'date',     width: 14, center: true },
  { header: 'event',    width: 22 },
  { header: 'count',    width: 11, center: true },
  { header: 'people',   width: 11, center: true },
  { header: 'value',    width: 12, center: true },
  { header: 'currency', width: 10, center: true }
];

export function eventSheet(rows) {
  return {
    name: 'Daily Events',
    columns: EVENT_COLUMNS,
    rows: (rows || []).map((r) => [
      r.day,
      r.event,
      { v: Number(r.n) || 0, number: true },
      { v: Number(r.people) || 0, number: true },
      { v: Number(r.value) || 0, number: true },
      'EGP'
    ])
  };
}

export const _internals = { splitName, phoneE164, cityEn, money, parseItems };
