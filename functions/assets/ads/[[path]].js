/* GET /assets/ads/<name>.<ext>

   Serves ad creatives an administrator uploaded, out of KV, at a URL
   indistinguishable from the committed files sitting next to them — which is
   the whole point, because these URLs get pasted into Ads Manager and Meta
   fetches them like any other image.

   THIS ROUTE SHADOWS A REAL DIRECTORY, ON PURPOSE, exactly as
   functions/assets/products/[[path]].js does. public/assets/ads/ holds the
   pack that ships with the repo; a Pages Function claims its whole prefix, so
   this handler sees requests for those too and hands them straight back to
   the static server with context.next(). Only names that have actually been
   uploaded are answered from KV.

   That ordering also means an upload can REPLACE a shipped creative by using
   its name — which is the only way to change one without a deploy, and is
   worth having on the day an ad is running with a typo in it.

   CACHING. The committed files carry the immutable one-year header from
   public/_headers, because their names never change content. Uploads cannot:
   replacing one keeps the name, so a year of immutable would strand the old
   bytes in every cache including Meta's. They get five minutes and an ETag.
*/
import { getAd, typeForExtension } from '../../../lib/ads.js';

/* Pages answers an unmatched path by serving index.html with a 200. On an
   image URL that is worse than a 404: Meta's fetcher would accept 26 KB of
   homepage HTML as the creative and fail somewhere less obvious. An image
   request that resolves to HTML did not find an image. */
async function assetOr404(next) {
  const res = await next();
  const type = res.headers.get('content-type') || '';
  if (type.toLowerCase().startsWith('text/html')) {
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
  return res;
}

/* Same shape the upload endpoint validates on write, so a crafted path
   cannot probe unrelated KV keys. Anything else goes to the static server. */
const FILE_RE = /^([a-z0-9][a-z0-9-]{1,63})\.([a-z0-9]{2,4})$/;

/* Names with no upload are remembered briefly so the ten committed files do
   not each cost a KV read on every impression — the same optimisation, and
   the same reasoning, as the products route. Only the ABSENCE is cached, so
   a newly uploaded creative can be delayed by at most a minute and an
   existing one can never be served stale. */
const NO_UPLOAD_TTL_MS = 60_000;
const NO_UPLOAD_MAX = 256;
const noUpload = new Map();

function knownAbsent(name) {
  const at = noUpload.get(name);
  if (at === undefined) return false;
  if (Date.now() - at < NO_UPLOAD_TTL_MS) return true;
  noUpload.delete(name);
  return false;
}

function rememberAbsent(name) {
  if (noUpload.size >= NO_UPLOAD_MAX) noUpload.clear();
  noUpload.set(name, Date.now());
}

export const onRequestGet = async (context) => {
  const { params, env, request, next } = context;

  const parts = Array.isArray(params.path) ? params.path : [params.path];
  if (parts.length !== 1 || !parts[0]) return assetOr404(next);

  const match = FILE_RE.exec(String(parts[0]).toLowerCase());
  if (!match) return assetOr404(next);

  const [, name, ext] = match;
  if (knownAbsent(name)) return assetOr404(next);

  let stored;
  try {
    stored = await getAd(env, name);
  } catch (err) {
    /* KV unreachable is not a reason to 500 an ad that may well be a
       committed file. Deliberately not remembered as absent: a failed read
       means we do not know. */
    console.error('ad read failed', name, err && err.message);
    return assetOr404(next);
  }
  if (!stored) {
    rememberAbsent(name);
    return assetOr404(next);
  }

  const meta = stored.metadata || {};
  const contentType = meta.ct || typeForExtension(ext) || 'application/octet-stream';
  const etag = `"${name}-${meta.updated || meta.bytes || '0'}"`;

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': 'public, max-age=300, must-revalidate' }
    });
  }

  return new Response(stored.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=300, must-revalidate',
      etag,
      'x-content-type-options': 'nosniff',
      /* Meta fetches these from its own servers when a creative is built by
         URL, so the response has to be readable cross-origin. There is
         nothing private in an advertisement. */
      'access-control-allow-origin': '*'
    }
  });
};
