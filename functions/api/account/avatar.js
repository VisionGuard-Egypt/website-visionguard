/* POST   /api/account/avatar   multipart, field `image`  — set your picture
   DELETE /api/account/avatar                              — remove it

   Your OWN picture, whoever you signed in as. This is not an admin feature
   and there is deliberately no way to set somebody else's: the row updated is
   always the one the session cookie names.

   WHY THE OLD ONE IS DELETED AFTER THE NEW ONE IS STORED, AND NOT BEFORE.
   Deleting first means a failed upload leaves the customer with no picture
   and no way back. Storing first costs one orphaned KV entry in the window
   where the UPDATE fails, which is a wasted key rather than lost data.

   Uploads are raster only and the extension comes from the content type, not
   the filename — an SVG here would be stored XSS on our own origin with the
   session cookie beside it. See lib/images.js.
*/
import { json, handle, requireSameOrigin, ApiError } from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import { requireUser } from '../../../lib/auth.js';
import { putAvatar, deleteAvatar, MAX_AVATAR_BYTES } from '../../../lib/avatars.js';

/* The messages the two storage failures deserve. A customer who picked a
   4 MB photo needs to be told that, not "upload failed". */
const REASONS = {
  no_kv:      [503, 'no_storage', 'Picture storage is not switched on for this deployment yet.'],
  bad_type:   [400, 'bad_image', 'Use a JPEG, PNG or WebP image.'],
  empty_file: [400, 'bad_image', 'That file was empty.'],
  too_large:  [413, 'image_too_large', `That picture is too large. Keep it under ${Math.round(MAX_AVATAR_BYTES / (1024 * 1024))} MB.`]
};

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const user = await requireUser(context, d1);
  /* Per account rather than per IP: the cost here is KV writes on somebody's
     own row, and a household behind one address is not the attack. */
  await enforceRate(d1, `avatar:${user.id}`, 12, 900);

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    throw new ApiError(400, 'bad_body', 'Could not read the upload.');
  }
  const file = form.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new ApiError(400, 'missing_field', 'Choose a picture first.', { field: 'image' });
  }

  let path;
  try {
    path = await putAvatar(env, file);
  } catch (err) {
    const known = REASONS[err && err.message];
    if (known) throw new ApiError(known[0], known[1], known[2], { field: 'image' });
    console.error('avatar upload', err && err.message);
    throw new ApiError(502, 'upload_failed', 'That picture could not be saved. Try another one.');
  }

  const previous = await d1.prepare('SELECT avatar FROM users WHERE id = ?1').bind(user.id).first();
  await d1.prepare('UPDATE users SET avatar = ?1 WHERE id = ?2').bind(path, user.id).run();

  /* The old bytes, once the row no longer points at them. Through waitUntil
     because nothing the customer is waiting for depends on it, and swallowed
     because a leftover KV entry is untidy, not broken. */
  if (previous && previous.avatar && previous.avatar !== path) {
    context.waitUntil(
      deleteAvatar(env, previous.avatar).catch((e) => console.error('old avatar', e && e.message))
    );
  }

  return json({ ok: true, avatar: path });
});

export const onRequestDelete = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const user = await requireUser(context, d1);

  const row = await d1.prepare('SELECT avatar FROM users WHERE id = ?1').bind(user.id).first();
  await d1.prepare('UPDATE users SET avatar = NULL WHERE id = ?1').bind(user.id).run();

  /* Row first, then bytes: if the delete fails the customer still has no
     picture, which is what they asked for. The reverse order can leave the
     row pointing at nothing. */
  if (row && row.avatar) {
    context.waitUntil(
      deleteAvatar(env, row.avatar).catch((e) => console.error('avatar delete', e && e.message))
    );
  }

  return json({ ok: true, avatar: '' });
});
