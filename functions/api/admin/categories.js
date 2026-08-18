/* /api/admin/categories — the product groups, as an administrator sees them.

   GET                                        every category, hidden ones included
   POST { action: 'save',   category: {...} }  create or update, by id
   POST { action: 'active', id, active: 0|1 }  hide or show without deleting
   POST { action: 'order',  ids: [...] }       reorder in one write
   POST { action: 'delete', id, confirm: true } remove — refused while in use

   ---------------------------------------------------------------------------
   WHY DELETE IS THE ONLY DESTRUCTIVE VERB AND WHY IT REFUSES
   ---------------------------------------------------------------------------
   Every product carries products.cat pointing at one of these ids. SQLite
   here has no foreign key enforcing that, so deleting a category that still
   has products in it does not fail — it orphans them: they vanish from the
   shop's filters, they stop appearing on the homepage, and they are still
   in the table being priced and sold. That is the worst kind of bug, because
   the catalogue looks fine and the shop is quietly missing stock.

   So delete counts the products first and refuses while any remain, naming
   the number. Hiding is offered instead, and hiding is almost always what
   was actually wanted: it removes the card and the chip and leaves every
   product buyable by search and by direct link.

   ---------------------------------------------------------------------------
   THE COVER IS CHECKED AGAINST THE CATALOGUE, NOT JUST THE REGEX
   ---------------------------------------------------------------------------
   readCategory() validates that a cover LOOKS like a product id. Only this
   route can know whether it IS one, because only this route has the products
   table. A cover naming a product that does not exist is not an error the
   customer ever sees — the card silently falls back to `img` — which is
   exactly why it has to be caught at the moment somebody types it, rather
   than discovered later by wondering why an edit did nothing.
*/
import { json, handle, readJson, requireSameOrigin, ApiError, clean, required } from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';
import { loadCategories, seedCategories, readCategory } from '../../../lib/categories.js';

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  await requireAdmin(context, d1);

  /* First open on a database that predates the table copies public/catalog.js
     into it, so the tab shows the eight real categories rather than a blank
     screen inviting somebody to retype what already exists. Idempotent. */
  const seed = await seedCategories(d1);

  const { categories, source } = await loadCategories(d1, { includeHidden: true });

  /* The product count per category, for the delete guard and so the tab can
     say what each group actually holds. One grouped read rather than one per
     category. */
  const counts = {};
  try {
    const { results } = await d1.prepare(
      `SELECT cat, COUNT(*) AS n FROM products GROUP BY cat`
    ).all();
    for (const row of results || []) counts[row.cat] = Number(row.n) || 0;
  } catch (e) { /* the tab still works without the counts */ }

  /* Products, so the cover can be chosen from a list rather than typed. */
  let products = [];
  try {
    const { results } = await d1.prepare(
      `SELECT id, cat, name, img FROM products ORDER BY cat, sort, name`
    ).all();
    products = results || [];
  } catch (e) { /* as above */ }

  return json({
    ok: true,
    seeded: seed.seeded,
    source,
    categories: categories.map((c) => Object.assign({}, c, { products: counts[c.id] || 0 })),
    products
  });
});

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);
  const d1 = await db(env);
  const admin = await requireAdmin(context, d1);
  await enforceRate(d1, `categories:${admin.id}`, 200, 3600);

  const body = await readJson(request);
  const action = clean(body.action, 20);
  const now = new Date().toISOString();

  /* ---- hide / show ---- */
  if (action === 'active') {
    const id = required(body.id, 'id', 32).toLowerCase();
    const active = body.active === true || body.active === 1 || body.active === '1' || body.active === 'true' ? 1 : 0;
    const row = await d1.prepare('SELECT id FROM categories WHERE id = ?1').bind(id).first();
    if (!row) throw new ApiError(404, 'no_such_category', 'No category with that id.', { field: 'id' });
    await d1.prepare('UPDATE categories SET active = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(active, now, id).run();
    return json({ ok: true, id, active });
  }

  /* ---- reorder ---- */
  if (action === 'order') {
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => clean(v, 32).toLowerCase()).filter(Boolean) : [];
    if (!ids.length) throw new ApiError(400, 'bad_order', 'Send the ids in their new order.', { field: 'ids' });
    /* Spaced by ten so a later single insert can slot between two without
       rewriting the whole list. */
    await d1.batch(ids.map((id, i) =>
      d1.prepare('UPDATE categories SET sort = ?1, updated_at = ?2 WHERE id = ?3').bind(i * 10, now, id)
    ));
    return json({ ok: true, ordered: ids.length });
  }

  /* ---- delete ---- */
  if (action === 'delete') {
    const id = required(body.id, 'id', 32).toLowerCase();
    if (body.confirm !== true && body.confirm !== 'true') {
      throw new ApiError(
        400, 'confirm_required',
        'Send confirm: true to delete. Hiding the category instead keeps its products on sale.'
      );
    }
    const row = await d1.prepare('SELECT id FROM categories WHERE id = ?1').bind(id).first();
    if (!row) throw new ApiError(404, 'no_such_category', 'No category with that id.', { field: 'id' });

    /* The guard described at the top of this file. */
    const used = await d1.prepare('SELECT COUNT(*) AS n FROM products WHERE cat = ?1').bind(id).first();
    const n = Number(used && used.n) || 0;
    if (n > 0) {
      throw new ApiError(
        409, 'category_in_use',
        `${n} product${n === 1 ? '' : 's'} still belong to this category. Move them to another category first, or hide this one instead — hiding keeps them on sale.`,
        { field: 'id', products: n }
      );
    }

    await d1.prepare('DELETE FROM categories WHERE id = ?1').bind(id).run();
    return json({ ok: true, deleted: id });
  }

  /* ---- create or update ---- */
  if (action !== 'save') {
    throw new ApiError(400, 'bad_action', 'action must be save, active, order or delete.', { field: 'action' });
  }

  const c = readCategory(body.category);

  /* A cover that does not resolve fails silently at render time — the card
     falls back to `img` and the administrator is left wondering why their
     edit did nothing. Caught here instead, while they are still looking at
     the field. */
  if (c.cover) {
    const product = await d1.prepare('SELECT id, cat FROM products WHERE id = ?1').bind(c.cover).first();
    if (!product) {
      throw new ApiError(400, 'no_such_product', `There is no product with the id "${c.cover}".`, { field: 'cover' });
    }
    /* Not fatal — a cross-category cover is a strange choice rather than a
       broken one, and there are legitimate cases — but it is almost always a
       mistake, so it is refused with a message that says how to proceed. */
    if (product.cat !== c.id) {
      throw new ApiError(
        400, 'cover_wrong_category',
        `"${c.cover}" is in the "${product.cat}" category. Pick a product from this category so the picture matches what the card is advertising.`,
        { field: 'cover' }
      );
    }
  }

  await d1.prepare(
    `INSERT INTO categories (id, ar, en, img, cover, blurb_ar, blurb_en, sort, active, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
     ON CONFLICT(id) DO UPDATE SET
       ar=excluded.ar, en=excluded.en, img=excluded.img, cover=excluded.cover,
       blurb_ar=excluded.blurb_ar, blurb_en=excluded.blurb_en,
       sort=excluded.sort, active=excluded.active, updated_at=excluded.updated_at`
  ).bind(c.id, c.ar, c.en, c.img, c.cover, c.blurbAr, c.blurbEn, c.sort, c.active, now).run();

  return json({ ok: true, saved: c.id, category: Object.assign({}, c, { updated_at: now }) });
});
