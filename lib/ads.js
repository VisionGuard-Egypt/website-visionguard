/* =========================================================================
   AD CREATIVES — the images that go into Ads Manager, served from
   /assets/ads/ so a campaign can be built by pasting a URL.

   TWO SOURCES, ONE URL PREFIX, and the difference is worth being exact about
   because it decides what the admin can delete.

   THE PACK IS IN THE REPO. public/assets/ads/ holds the creatives that ship
   with the site. They are ordinary static files: cached immutably by
   public/_headers, versioned by git, and impossible to remove from a browser
   — on Cloudflare Pages the static bundle is uploaded at deploy time and a
   Worker has no write path into it. Deleting one is a commit.

   UPLOADS LIVE IN KV, exactly as product photos do — see lib/images.js for
   the longer argument about why KV and not a database row. An upload is
   answered by functions/assets/ads/[[path]].js at the same /assets/ads/
   prefix, so both kinds of creative have URLs of the same shape and Ads
   Manager cannot tell them apart. Those the admin CAN delete.

   THE MANIFEST is what lets the tab list the shipped pack at all. A Worker
   cannot enumerate the static bundle, so public/assets/ads/index.json names
   what is in it. A file added to the directory without a manifest entry
   still serves perfectly; it just does not appear in the tab. That is the
   one drift this design accepts, and it is documented on the file itself.

   NO SVG, for the reason lib/images.js gives: an SVG is a document that can
   carry script, served from this origin, next to a session cookie. Uploads
   are raster only.
   ========================================================================= */

/* Its own KV namespace, beside product-img:. One prefix per kind of thing
   means listing one never walks the other. */
export const AD_PREFIX = 'ad-img:';

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const EXT_TO_TYPE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
};

/* 8 MB. Larger than the 5 MB product cap on purpose: an ad creative is a
   full-bleed 1080x1920 export and the ones in this pack are already 1.8 MB
   each, so the product limit would refuse work the owner has actually made.
   Meta's own ceiling is 30 MB, KV's is 25; this is the smallest number that
   does not get in the way. */
export const MAX_AD_BYTES = 8 * 1024 * 1024;

/* The name IS the URL, so it is validated as strictly as a product id and
   for the same reason: whatever passes here ends up in a public path and in
   a KV key. Lower case, digits and hyphens; no dots, no spaces, no slashes,
   nothing that could climb out of the prefix.

   It must also START and END alphanumeric. A trailing hyphen is harmless in
   a URL and simply looks like a mistake in a list of filenames somebody is
   pasting into Ads Manager — and since slugifyName() never produces one, the
   only way to get one is to type it. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export const isAdName = (name) => NAME_RE.test(String(name || ''));

export function extensionFor(contentType) {
  return TYPES[String(contentType || '').toLowerCase().split(';')[0].trim()] || '';
}

export function typeForExtension(ext) {
  return EXT_TO_TYPE[String(ext || '').toLowerCase()] || '';
}

export const adKey = (name) => AD_PREFIX + String(name);
export const adPath = (name, ext) => `assets/ads/${name}.${ext}`;

export function kvOf(env) {
  return (env && env.KV) || null;
}

/* Turns whatever a person typed into a usable name: lower case, spaces and
   punctuation to hyphens, no leading or trailing hyphen. An empty result is
   the caller's problem — this does not invent one, because a generated name
   is a URL nobody can guess or remember. */
export function slugifyName(input) {
  const out = String(input === null || input === undefined ? '' : input)
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')      // drop a file extension if present
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');                  // the slice can leave one behind

  /* NEVER EMITS SOMETHING isAdName WOULD REFUSE. If it did, an upload would
     fail validation after the file had already been read and the person
     would be told their name was wrong when they never typed one. Too short
     to be a name is the same answer as no name at all. */
  return out.length >= 2 ? out : '';
}

/* Stores the bytes. Returns { name, ext, path, bytes } for the caller to
   hand back to the browser. Throws plain Errors the endpoint turns into
   ApiErrors — this module has no opinion about HTTP. */
export async function putAd(env, name, file) {
  const kv = kvOf(env);
  if (!kv) throw new Error('no_kv');
  if (!isAdName(name)) throw new Error('bad_name');

  const ext = extensionFor(file && file.type);
  if (!ext) throw new Error('bad_type');

  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('empty_file');
  if (buf.byteLength > MAX_AD_BYTES) throw new Error('too_large');

  await kv.put(adKey(name), buf, {
    metadata: {
      ct: EXT_TO_TYPE[ext],
      ext,
      bytes: buf.byteLength,
      updated: new Date().toISOString()
    }
  });

  return { name, ext, path: adPath(name, ext), bytes: buf.byteLength };
}

export async function deleteAd(env, name) {
  const kv = kvOf(env);
  if (!kv || !isAdName(name)) return false;
  try {
    await kv.delete(adKey(name));
    return true;
  } catch (err) {
    console.error('ad delete failed', name, err && err.message);
    return false;
  }
}

export async function getAd(env, name) {
  const kv = kvOf(env);
  if (!kv) return null;
  const res = await kv.getWithMetadata(adKey(name), { type: 'arrayBuffer' });
  if (!res || !res.value) return null;
  return { body: res.value, metadata: res.metadata || {} };
}

/* Everything uploaded, newest first. KV list returns keys with the metadata
   written at put() time, so this needs no reads — which is what makes a tab
   that lists twenty creatives one round trip rather than twenty. */
export async function listAds(env) {
  const kv = kvOf(env);
  if (!kv) return [];
  const out = [];
  let cursor;
  /* Paged, because KV list caps at 1000 keys and an unbounded loop over a
     prefix somebody could grow is not something to write once and forget. */
  do {
    const page = await kv.list({ prefix: AD_PREFIX, cursor, limit: 200 });
    for (const key of page.keys || []) {
      const name = String(key.name).slice(AD_PREFIX.length);
      const meta = key.metadata || {};
      out.push({
        name,
        ext: meta.ext || 'png',
        path: adPath(name, meta.ext || 'png'),
        bytes: Number(meta.bytes) || 0,
        updated: meta.updated || '',
        source: 'upload'
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return out;
}
