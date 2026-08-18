/* =========================================================================
   The categories, read from D1 with public/catalog.js as the fallback.

   Exactly the shape lib/products.js already uses for products, and for the
   same reason: the static file is the seed AND the safety net. If the table
   is empty or a query fails, the site renders the eight categories it has
   always had rather than a homepage with no sections and a shop with no
   filters. Falling back to last-known-good is the safe direction to fail in.

   ---------------------------------------------------------------------------
   WHAT A CATEGORY OWNS, AND WHAT IT DOES NOT
   ---------------------------------------------------------------------------
   A category owns how it is PRESENTED: its two labels, its two blurbs, the
   product whose photograph represents it, where it sits in the order, and
   whether it appears at all.

   It does NOT own which products belong to it. That is products.cat, edited
   in the catalogue tab, and it stays there — one fact, one place. Hiding a
   category here hides the card and the filter chip; it does not withdraw the
   products, which remain reachable by search and by direct link and remain
   perfectly buyable. Withdrawing a product is a different act, and it has its
   own switch.

   ---------------------------------------------------------------------------
   WHY `cover` IS A PRODUCT ID AND NOT A PATH
   ---------------------------------------------------------------------------
   The homepage cards used to hard-code an image path each, so replacing a
   product photo in the admin updated the shop and left the front page showing
   the old picture — nothing linked the two. `cover` names the PRODUCT, and
   the card takes that product's current image, so the two can no longer
   disagree. `img` survives as the fallback for the first paint and for a
   cover that no longer resolves.
   ========================================================================= */
import { CATEGORIES as STATIC_CATEGORIES } from '../public/catalog.js';
import { ApiError, clean } from './util.js';

/* The id is a URL component — shop.html?cat=<id> — and a foreign key from
   every product row, so it is a boring slug and stays one. */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/* Same rule as a product image path in functions/api/admin/catalog.js:
   relative, inside assets/, no scheme and no protocol-relative "//host", so
   a data: URL can never arrive through this field. */
const IMG_PATH_RE = /^assets\/[a-z0-9][a-z0-9._/-]{0,200}$/i;

function rowToCategory(r) {
  return {
    id: r.id,
    ar: r.ar || '',
    en: r.en || '',
    img: r.img || '',
    cover: r.cover || '',
    blurb: { ar: r.blurb_ar || '', en: r.blurb_en || '' },
    sort: Number(r.sort) || 0,
    active: Number(r.active) === 0 ? 0 : 1
  };
}

/* Returns { categories, source }. `source` is reported so a caller can log
   which path was taken — a homepage quietly serving the static list for a
   week because the table was emptied is exactly the kind of thing that
   should be visible. */
export async function loadCategories(d1, { includeHidden = false } = {}) {
  try {
    const { results } = await d1.prepare(
      `SELECT id, ar, en, img, cover, blurb_ar, blurb_en, sort, active
         FROM categories ${includeHidden ? '' : 'WHERE active = 1'}
        ORDER BY sort, id`
    ).all();

    if (results && results.length) {
      return { categories: results.map(rowToCategory), source: 'd1' };
    }
    /* Not an error: a database that has never been seeded. The site works,
       and the admin tab seeds it on first open. */
  } catch (err) {
    console.error('categories: D1 read failed, using public/catalog.js —', err && err.message);
  }

  return {
    categories: STATIC_CATEGORIES.map((c, i) => ({
      id: c.id,
      ar: c.ar,
      en: c.en,
      img: c.img || '',
      cover: c.cover || '',
      blurb: { ar: (c.blurb && c.blurb.ar) || '', en: (c.blurb && c.blurb.en) || '' },
      sort: i * 10,
      active: 1
    })),
    source: 'static'
  };
}

/* Copies public/catalog.js into the table, once. Idempotent by the count
   check AND by the ON CONFLICT: running it twice cannot duplicate a row or
   overwrite an edit an administrator has already made.

   Seeded rather than left empty so the admin tab opens on the eight real
   categories instead of a blank screen with an "add one" button, which would
   invite rebuilding by hand what already exists. */
export async function seedCategories(d1, now) {
  const existing = await d1.prepare('SELECT COUNT(*) AS n FROM categories').first();
  if (existing && Number(existing.n) > 0) return { seeded: 0 };

  const stamp = now || new Date().toISOString();
  const statements = STATIC_CATEGORIES.map((c, i) =>
    d1.prepare(
      `INSERT INTO categories (id, ar, en, img, cover, blurb_ar, blurb_en, sort, active, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9)
       ON CONFLICT(id) DO NOTHING`
    ).bind(
      c.id, c.ar, c.en, c.img || '', c.cover || '',
      (c.blurb && c.blurb.ar) || '', (c.blurb && c.blurb.en) || '',
      i * 10, stamp
    )
  );
  await d1.batch(statements);
  return { seeded: statements.length };
}

/* Validation is not optional here either, though for a different reason than
   the catalogue's: nothing on this table is money, but `id` is a URL
   component and a foreign key that every product row points at, and the two
   labels are rendered on the landing page of the shop. */
export function readCategory(raw) {
  const c = raw || {};
  const id = clean(c.id, 32).toLowerCase();
  if (!ID_RE.test(id)) {
    throw new ApiError(
      400, 'bad_id',
      'The id must be lower-case letters, numbers and hyphens — for example "wireless".',
      { field: 'id' }
    );
  }

  const ar = clean(c.ar, 60);
  const en = clean(c.en, 60);
  /* Both languages, always. A missing one renders as an empty card on
     whichever side of the switch nobody was looking at. */
  if (!ar) throw new ApiError(400, 'bad_label', 'The Arabic name is required.', { field: 'ar' });
  if (!en) throw new ApiError(400, 'bad_label', 'The English name is required.', { field: 'en' });

  const img = clean(c.img, 300);
  if (img && !IMG_PATH_RE.test(img)) {
    throw new ApiError(
      400, 'bad_image_path',
      'The image path must be a relative path inside assets/, or blank.',
      { field: 'img' }
    );
  }

  /* A cover is a product id or nothing. Whether it EXISTS is checked by the
     route, which has the catalogue to hand; the shape is checked here. */
  const cover = clean(c.cover, 64).toLowerCase();
  if (cover && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(cover)) {
    throw new ApiError(400, 'bad_cover', 'The cover must be a product id, or blank.', { field: 'cover' });
  }

  const sortRaw = Number(c.sort);
  return {
    id, ar, en, img, cover,
    blurbAr: clean(c.blurbAr !== undefined ? c.blurbAr : (c.blurb && c.blurb.ar), 400),
    blurbEn: clean(c.blurbEn !== undefined ? c.blurbEn : (c.blurb && c.blurb.en), 400),
    sort: Number.isFinite(sortRaw) ? Math.round(sortRaw) : 999,
    active: c.active === false || c.active === 0 || c.active === '0' || c.active === 'false' ? 0 : 1
  };
}
