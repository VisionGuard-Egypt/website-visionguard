/* /api/admin/catalog — the products table, read and written by an administrator.

   GET                                          every product, ordered as the shop orders them
   POST { action: 'save',   product: {...} }     create or update, by id   (JSON or multipart)
   POST { action: 'delete', id, confirm: true }  remove the row and its image
   POST { action: 'active', id, active: 0|1 }    withdraw without deleting

   ---------------------------------------------------------------------------
   TWO BODY FORMATS, AND WHY BOTH
   ---------------------------------------------------------------------------
   `save` may carry a file, so it arrives as multipart/form-data. `active` and
   `delete` are two fields and arrive as JSON, because that is what the rest of
   this API speaks and what public/account.js already sends.

   The previous version called request.formData() unconditionally, at the top,
   before looking at the action. A JSON body throws there — so the Show/Hide
   toggle and Delete in the admin were broken for every product, and the error
   surfaced as a generic failure with nothing pointing at the cause. It then
   ran required(name) before branching too, so even a correctly-encoded
   multipart `delete` was rejected for having no product name.

   Reading the content type first and validating per action fixes both.

   ---------------------------------------------------------------------------
   IMAGES
   ---------------------------------------------------------------------------
   Uploads go to KV and the row stores a path — see lib/images.js for why that
   is not a base64 data URL in this table any more, and why the file it names
   does not exist on disk.

   ---------------------------------------------------------------------------
   VALIDATION IS NOT OPTIONAL HERE
   ---------------------------------------------------------------------------
   Every row in this table is a price the server will honour: lib/products.js
   reads it and functions/api/orders.js prices from that. A bad row is not a
   display bug, it is money. So ids are slugs, categories must be ones the site
   actually renders, and the price is a whole number of pounds inside a sane
   range — the integer discipline the rest of the schema uses, because floats
   drift and piastres do not exist in this catalogue.

   The id rule matters twice over now: it is the primary key, it appears in
   past orders' line items, AND it is the filename an uploaded image is served
   under. readProduct() is the only way a row reaches the INSERT.
*/
import { json, handle, readJson, requireSameOrigin, ApiError, clean, required } from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';
import { loadCategories } from '../../../lib/categories.js';
import { putImage, deleteImage, MAX_IMAGE_BYTES } from '../../../lib/images.js';

/* The valid categories are ROWS now, not a constant.

   This used to be `CATEGORIES.map(c => c.id)` off the static file, which was
   correct for exactly as long as the categories could not be edited. The
   moment an administrator can add one — see functions/api/admin/categories.js
   — a hardcoded list means the new category exists, appears on the homepage,
   and then rejects every product anybody tries to put in it, with a message
   naming eight ids that do not include the one they just made.

   Read per request rather than cached in module scope for the same reason:
   the categories tab and the catalogue tab are two panels of the same
   screen, and a category added in one has to be usable in the other without
   a deploy. */
const MAX_PRICE = 1000000;

/* Lower-case slug. Primary key, URL component, order line reference, and now
   an image filename — so it has to be stable and boring. */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/* A manually typed image path. Uploads set this themselves; this only exists
   so an administrator can point a product at one of the committed files in
   public/assets/. Relative, no scheme, no protocol-relative "//host" — which
   also means a data: URL can never come back in through this field. */
const IMG_PATH_RE = /^assets\/[a-z0-9][a-z0-9._/-]{0,200}$/i;

/* ---------------------------------------------------------------------------
   Body reading: one shape out, two shapes in.
   --------------------------------------------------------------------------- */
async function readBody(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    const file = form.get('file');
    const fields = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') fields[k] = v;
    }
    return {
      action: clean(fields.action, 20),
      /* The flat form fields ARE the product — account.js appends them one by
         one so a file can ride along in the same request. */
      product: fields,
      id: fields.id,
      active: fields.active,
      confirm: fields.confirm,
      removeImage: fields.removeImage === '1' || fields.removeImage === 'true',
      file: file && typeof file === 'object' && typeof file.arrayBuffer === 'function' ? file : null
    };
  }

  const body = await readJson(request);
  return {
    action: clean(body.action, 20),
    product: body.product || {},
    id: body.id,
    active: body.active,
    confirm: body.confirm,
    removeImage: body.removeImage === true,
    file: null
  };
}

function readProduct(raw, catIds) {
  const p = raw || {};
  const id = clean(p.id, 64).toLowerCase();
  if (!ID_RE.test(id)) {
    throw new ApiError(
      400, 'bad_id',
      'The id must be lower-case letters, numbers and hyphens — for example "unv-2mp".',
      { field: 'id' }
    );
  }

  const cat = clean(p.cat, 32);
  if (!catIds.includes(cat)) {
    throw new ApiError(400, 'bad_cat', `Category must be one of: ${catIds.join(', ')}.`, { field: 'cat' });
  }

  const price = Math.round(Number(p.price));
  if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
    throw new ApiError(400, 'bad_price', `Price must be a whole number of pounds between 0 and ${MAX_PRICE}.`, { field: 'price' });
  }

  const was = Math.round(Number(p.was) || 0);
  if (!Number.isFinite(was) || was < 0 || was > MAX_PRICE) {
    throw new ApiError(400, 'bad_was', 'The "before" price must be a whole number of pounds.', { field: 'was' });
  }
  /* A struck-through price that is not higher than the real one is not a
     discount, it is a lie about one. */
  if (was > 0 && was <= price) {
    throw new ApiError(400, 'bad_was', 'The "before" price has to be higher than the price, or 0 for no discount.', { field: 'was' });
  }

  const sortRaw = Number(p.sort);
  const active = p.active === false || p.active === 0 || p.active === '0' || p.active === 'false' ? 0 : 1;

  return {
    id,
    cat,
    brand: clean(p.brand, 60),
    name: required(p.name, 'name', 120),
    ar: clean(p.ar, 200),
    en: clean(p.en, 200),
    price,
    was,
    sort: Number.isFinite(sortRaw) ? Math.round(sortRaw) : 999,
    active
  };
}

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  await requireAdmin(context, d1);
  const { results } = await d1.prepare(
    `SELECT id, cat, brand, name, ar, en, img, price, was, sort, active, updated_at
       FROM products ORDER BY cat, sort, name`
  ).all();
  /* Hidden ones included: the editor's category dropdown has to be able to
     put a product into a category that is not currently on the homepage.
     Hiding a category is about presentation, not about closing it. */
  const { categories } = await loadCategories(d1, { includeHidden: true });
  return json({
    ok: true,
    categories: categories.map((c) => ({ id: c.id, ar: c.ar, en: c.en, active: c.active })),
    products: results || [],
    limits: { maxImageBytes: MAX_IMAGE_BYTES }
  });
});

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);
  const d1 = await db(env);
  const admin = await requireAdmin(context, d1);
  await enforceRate(d1, `catalog:${admin.id}`, 300, 3600);

  const body = await readBody(request);
  const now = new Date().toISOString();

  /* ---- withdraw / restore ---- */
  if (body.action === 'active') {
    const id = required(body.id, 'id', 64).toLowerCase();
    const active = body.active === true || body.active === 1 || body.active === '1' || body.active === 'true' ? 1 : 0;
    const row = await d1.prepare('SELECT id FROM products WHERE id = ?1').bind(id).first();
    if (!row) throw new ApiError(404, 'no_such_product', 'No product with that id.', { field: 'id' });
    await d1.prepare('UPDATE products SET active = ?1, updated_at = ?2 WHERE id = ?3').bind(active, now, id).run();
    return json({ ok: true, id, active });
  }

  /* ---- delete ---- */
  if (body.action === 'delete') {
    const id = required(body.id, 'id', 64).toLowerCase();
    if (body.confirm !== true && body.confirm !== 'true') {
      throw new ApiError(
        400, 'confirm_required',
        'Send confirm: true to delete. Withdrawing the product instead keeps it out of the shop without removing it.'
      );
    }
    const row = await d1.prepare('SELECT id FROM products WHERE id = ?1').bind(id).first();
    if (!row) throw new ApiError(404, 'no_such_product', 'No product with that id.', { field: 'id' });
    await d1.prepare('DELETE FROM products WHERE id = ?1').bind(id).run();
    /* The row is gone either way; an orphaned image would otherwise sit in KV
       forever and, worse, be served the moment the id was reused. */
    await deleteImage(env, id);
    return json({ ok: true, deleted: id });
  }

  /* ---- create or update ---- */
  if (body.action !== 'save') {
    throw new ApiError(400, 'bad_action', 'action must be save, active or delete.', { field: 'action' });
  }

  /* Read here rather than at module scope so a category created minutes ago
     in the other tab is already valid in this one. Hidden categories count:
     a product may live in one that is not currently on the homepage. */
  const { categories } = await loadCategories(d1, { includeHidden: true });
  const p = readProduct(body.product, categories.map((c) => c.id));

  /* The existing image is the default. Nothing the client sends can replace
     it except an actual upload or an explicit removal — which is what stops
     the img column from becoming free-text again. */
  const existing = await d1.prepare('SELECT img FROM products WHERE id = ?1').bind(p.id).first();
  let img = (existing && existing.img) || '';

  if (body.file) {
    try {
      img = await putImage(env, p.id, body.file);
    } catch (err) {
      const code = err && err.message;
      if (code === 'bad_type') {
        throw new ApiError(400, 'bad_image_type', 'The image must be a JPEG, PNG, WebP, AVIF or GIF. SVG is not accepted.', { field: 'file' });
      }
      if (code === 'too_large') {
        throw new ApiError(413, 'image_too_large', `That image is over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB. Save a smaller copy and upload that.`, { field: 'file' });
      }
      if (code === 'empty_file') {
        throw new ApiError(400, 'empty_image', 'That file is empty.', { field: 'file' });
      }
      if (code === 'no_kv') {
        throw new ApiError(503, 'no_image_store', 'Image storage is not connected. Bind the KV namespace as KV — see wrangler.toml.', { field: 'file' });
      }
      throw err;
    }
  } else if (body.removeImage) {
    await deleteImage(env, p.id);
    /* Cleared rather than left pointing at the path: a committed file of the
       same name would otherwise reappear the moment the KV key went away, and
       "remove" would look like it had done nothing. Empty means imageFor() in
       public/catalog.js falls back to the category picture. */
    img = '';
  } else {
    /* A typed path, for pointing at one of the committed files. Only accepted
       when it looks like a relative asset path. */
    const typed = clean((body.product && body.product.img) || '', 300);
    if (typed && typed !== img) {
      if (!IMG_PATH_RE.test(typed)) {
        throw new ApiError(400, 'bad_image_path', 'The image path must be a relative path inside assets/, or blank. Upload a file instead.', { field: 'img' });
      }
      img = typed;
    }
  }

  await d1.prepare(
    `INSERT INTO products (id, cat, brand, name, ar, en, img, price, was, sort, active, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
     ON CONFLICT(id) DO UPDATE SET
       cat=excluded.cat, brand=excluded.brand, name=excluded.name, ar=excluded.ar,
       en=excluded.en, img=excluded.img, price=excluded.price, was=excluded.was,
       sort=excluded.sort, active=excluded.active, updated_at=excluded.updated_at`
  ).bind(p.id, p.cat, p.brand || null, p.name, p.ar || null, p.en || null,
         img, p.price, p.was, p.sort, p.active, now).run();

  return json({ ok: true, saved: p.id, product: Object.assign({}, p, { img, updated_at: now }) });
});
