/* GET /assets/avatars/<token>.<ext>

   A customer's profile picture, out of KV. The same shape as the product
   image route beside it; read that file's header for why an upload is served
   by a Function rather than existing as a file.

   NO AUTH CHECK, AND THAT IS DELIBERATE. The token in the path is sixteen
   random bytes with no relationship to the user id, minted on upload and
   replaced whenever the picture changes — see lib/avatars.js. An unguessable
   URL is what makes this safe to serve without a session, and serving it
   without a session is what lets the edge cache it like any other image.

   Keying on the user id instead would have made the route an oracle: a 200
   rather than a 404 would confirm an account exists, which is a customer
   list anybody could enumerate.

   THERE IS NO STATIC FALLBACK. Unlike product images, no avatar ships with
   the repo, so anything not in KV is a 404 rather than a fall-through. The
   account page draws initials when there is no picture; it never requests a
   URL it does not have.
*/
import { getAvatar, tokenFromPath } from '../../../lib/avatars.js';

const FILE_RE = /^([a-f0-9]{16,64})\.([a-z0-9]{2,4})$/i;

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  const m = FILE_RE.exec(file);

  const miss = () => new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });

  if (!m) return miss();

  let hit;
  try {
    hit = await getAvatar(context.env, m[1]);
  } catch (err) {
    console.error('avatar read failed', err && err.message);
    return miss();
  }
  if (!hit) return miss();

  const meta = hit.metadata || {};
  const etag = `"${m[1]}-${meta.bytes || hit.body.byteLength}"`;
  if (context.request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  return new Response(hit.body, {
    headers: {
      'content-type': meta.ct || 'application/octet-stream',
      /* The token changes whenever the picture does, so this URL's bytes can
         never change — it is safe to cache hard and for a long time. A new
         picture is a new URL, which is the whole point of the token. */
      'cache-control': 'public, max-age=31536000, immutable',
      etag,
      /* A face is not something to let another site frame or sniff. */
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-site'
    }
  });
}
