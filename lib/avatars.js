/* =========================================================================
   Profile pictures, in Workers KV, served from /assets/avatars/.

   The same shape as lib/images.js and for the same reasons — KV is bound,
   values are edge-cached, and Pages has no writable filesystem so an upload
   can never become a real file. Read the header of that file for the long
   version; this one only documents where a face differs from a product photo.

   THE URL IS KEYED ON A RANDOM TOKEN, NOT ON THE USER ID.

   /assets/avatars/<user-id>.jpg would have been simpler and it leaks two
   things. Anyone holding a user id could fetch that person's face, and —
   worse — a 200 rather than a 404 confirms an account exists, which turns
   the avatar route into an oracle for enumerating customers.

   So the row stores a token that has nothing to do with the id, the KV key
   is derived from the token, and the URL is unguessable. Replacing a picture
   mints a NEW token, which is also how deletion works properly: the old URL
   stops resolving immediately instead of living on in every cache that saw
   it. A URL nobody can guess needs no auth check on read, which keeps it
   edge-cacheable like any other image.

   SMALLER THAN A PRODUCT PHOTO. Nothing displays an avatar above 160px, and
   a customer photographing themselves on a modern phone will hand us 4 MB
   without noticing. The cap is lower because the picture is smaller, not
   because the storage is tighter.
   ========================================================================= */
import { extensionFor, typeForExtension, kvOf } from './images.js';
import { randomId } from './auth.js';

export const AVATAR_PREFIX = 'avatar:';

/* 3 MB. See the note above — this is a 160px circle, not a catalogue shot. */
export const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

export const avatarKey = (token) => AVATAR_PREFIX + String(token);
export const avatarPath = (token, ext) => `assets/avatars/${token}.${ext}`;

/* The token out of a stored path, for deleting the old KV entry when a
   picture is replaced. Returns '' for anything that is not one of ours —
   the column is written only by this module, but a hand-edited row must not
   turn into a KV key built from arbitrary text. */
export function tokenFromPath(path) {
  const m = /^assets\/avatars\/([a-f0-9]{16,64})\.[a-z0-9]+$/i.exec(String(path || ''));
  return m ? m[1] : '';
}

/* Stores the bytes and returns the relative path for users.avatar.

   Throws a plain Error the caller turns into an ApiError; this module has no
   opinion about HTTP, exactly as lib/images.js has none. */
export async function putAvatar(env, file) {
  const kv = kvOf(env);
  if (!kv) throw new Error('no_kv');

  /* Raster only, and the extension comes from the CONTENT TYPE rather than
     the filename — see the SVG note in lib/images.js. An SVG avatar would be
     stored XSS served from our own origin with the session cookie beside it. */
  const ext = extensionFor(file.type);
  if (!ext) throw new Error('bad_type');

  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('empty_file');
  if (buf.byteLength > MAX_AVATAR_BYTES) throw new Error('too_large');

  const token = randomId(16);
  await kv.put(avatarKey(token), buf, {
    metadata: {
      ct: typeForExtension(ext),
      ext,
      bytes: buf.byteLength,
      updated: new Date().toISOString()
    }
  });
  return avatarPath(token, ext);
}

/* Safe to call with anything, including an empty column. */
export async function deleteAvatar(env, path) {
  const kv = kvOf(env);
  const token = tokenFromPath(path);
  if (!kv || !token) return false;
  try {
    await kv.delete(avatarKey(token));
    return true;
  } catch (err) {
    console.error('avatar delete failed', err && err.message);
    return false;
  }
}

export async function getAvatar(env, token) {
  const kv = kvOf(env);
  if (!kv || !/^[a-f0-9]{16,64}$/i.test(String(token || ''))) return null;
  const res = await kv.getWithMetadata(avatarKey(token), { type: 'arrayBuffer' });
  if (!res || !res.value) return null;
  return { body: res.value, metadata: res.metadata || {} };
}
