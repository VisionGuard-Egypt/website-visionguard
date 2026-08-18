/* =========================================================================
   Product images, stored in Workers KV and served from /assets/products/.

   WHY KV AND NOT THE PRODUCT ROW
   ------------------------------
   The previous version base64'd every upload into a data: URL and wrote it
   into products.img. That is what was throwing. D1 has a hard limit of about
   1 MB per row and per statement, and base64 inflates a file by a third — so
   any photo over roughly 750 KB failed the INSERT outright. Worse, the ones
   that fit were then returned on EVERY read: GET /api/admin/catalog selects
   img for all products, so the admin list grew by the full weight of every
   image it had ever stored, and public/catalog.js carried them into the shop.

   KV is the right home and it is already bound. wrangler.toml says it plainly
   — "reads that are identical for every visitor, cached at the edge" — which
   is exactly what a product photo is. Values may be 25 MB (we cap far below
   that), reads are edge-cached, and the bytes never touch a database row that
   something else has to SELECT.

   WHY THERE IS NO FILE ON DISK
   ---------------------------
   The obvious reading of "write a file into public/assets/" cannot be done,
   and it is worth being exact about why rather than quietly doing something
   else: on Cloudflare Pages the static asset bundle is immutable. It is
   uploaded at deploy time and served from the edge; a Worker has no
   filesystem and no write path into it. The only way an upload could become a
   real file is a git commit and a redeploy per image.

   So the URL is real and the file is not. functions/assets/products/[[path]].js
   answers /assets/products/<product-id>.<ext> out of KV, and falls through to
   the genuine static files for the 40-odd images that ship with the repo.
   Nothing else in the codebase has to know the difference: products.img holds
   an ordinary relative path, public/catalog.js imageFor() returns it
   unchanged, and the shop renders a plain <img src>.

   NO SVG
   ------
   SVG is a document, not a picture: it can carry <script>, and this is served
   from the site's own origin, so an SVG upload is a stored-XSS hole with a
   session cookie sitting next to it. The repo's own .svg line drawings are
   fine — they are reviewed files in git, not uploads. Uploads are raster only.
   ========================================================================= */

/* Keyed by product id, which is validated as a slug before it ever reaches
   here — see ID_RE in functions/api/admin/catalog.js. The prefix keeps
   product images in their own namespace inside a KV binding the catalogue
   cache also uses. */
export const IMG_PREFIX = 'product-img:';

/* Raster formats every target browser decodes. The extension is derived from
   the type rather than from the uploaded filename: a filename is attacker-
   controlled text and we are about to put it in a URL. */
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif':  'gif'
};

const EXT_TO_TYPE = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif:  'image/gif'
};

/* 5 MB. KV would take 25, but nothing on this site displays larger than
   about 800px and a 5 MB product photo is a mistake rather than a
   requirement. Rejecting it with a message is kinder than storing it and
   making every visitor download it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function extensionFor(contentType) {
  return TYPES[String(contentType || '').toLowerCase().split(';')[0].trim()] || '';
}

export function typeForExtension(ext) {
  return EXT_TO_TYPE[String(ext || '').toLowerCase()] || '';
}

export function imagePath(id, ext) {
  return `assets/products/${id}.${ext}`;
}

/* The KV key ignores the extension so that replacing a JPEG with a PNG does
   not leave the old one orphaned. One product, one image, one key. */
export function imageKey(id) {
  return IMG_PREFIX + String(id);
}

export function kvOf(env) {
  return (env && env.KV) || null;
}

/* Stores the bytes and returns the relative path to put in products.img.
   Throws a plain Error the caller turns into an ApiError — this module has no
   opinion about HTTP. */
export async function putImage(env, id, file) {
  const kv = kvOf(env);
  if (!kv) throw new Error('no_kv');

  const ext = extensionFor(file.type);
  if (!ext) throw new Error('bad_type');

  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('empty_file');
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('too_large');

  await kv.put(imageKey(id), buf, {
    metadata: {
      ct: EXT_TO_TYPE[ext],
      ext,
      bytes: buf.byteLength,
      updated: new Date().toISOString()
    }
  });

  return imagePath(id, ext);
}

/* Removing an image is not the same as removing the product, and both call
   this. Missing keys delete cleanly, so it is safe to call unconditionally. */
export async function deleteImage(env, id) {
  const kv = kvOf(env);
  if (!kv) return false;
  try {
    await kv.delete(imageKey(id));
    return true;
  } catch (err) {
    console.error('image delete failed', id, err && err.message);
    return false;
  }
}

/* Returns { body, metadata } or null. Used by the asset route. */
export async function getImage(env, id) {
  const kv = kvOf(env);
  if (!kv) return null;
  const res = await kv.getWithMetadata(imageKey(id), { type: 'arrayBuffer' });
  if (!res || !res.value) return null;
  return { body: res.value, metadata: res.metadata || {} };
}
