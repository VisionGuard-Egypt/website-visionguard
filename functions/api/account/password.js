/* POST /api/account/password  { current, next }

   Change your own password. Anybody signed in, not just staff — but it is
   employees who actually need it, because a customer can use the reset
   email from the sign-in page and an employee changing a password they
   already know should not have to go via their inbox.

   THIS IS THE BREAK-GLASS HALF, and it mirrors /api/auth/login exactly.
   Firebase owns almost every credential on this site, and a Firebase
   password cannot be changed from here: setting one server-side needs a
   service-account key, which this project deliberately does not hold. So
   the browser tries Firebase first (reauthenticate + updatePassword, see
   changePassword in public/firebase-auth.js) and falls back to this
   endpoint, which is the only way to change the pw_hash in D1 — the
   administrator seeded by scripts/create-admin.mjs, and anybody else who
   ever gets a local hash.

   An account Firebase created carries the GOOGLE_ONLY_PW sentinel and can
   never verify against it (see lib/auth.js), so such a request is refused
   here with a message that says where the password actually lives rather
   than "wrong password", which would send somebody debugging the wrong end.

   THE CURRENT PASSWORD IS REQUIRED, and not as ceremony. A session cookie
   is thirty days long and survives a shared or stolen laptop; without this
   check, anyone who sat down at an unlocked machine could lock the real
   owner out of their own account permanently.
*/
import { json, handle, readJson, requireSameOrigin, ApiError } from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import {
  requireUser, verifyPassword, hashPassword, checkPasswordStrength,
  GOOGLE_ONLY_PW, secretOf
} from '../../../lib/auth.js';

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);
  secretOf(env);

  const d1 = await db(env);
  const user = await requireUser(context, d1);

  /* Guessing the current password is the attack this stops, and the attacker
     here is already holding a session — so the bucket is the account, not
     the address. */
  await enforceRate(d1, `pw:${user.id}`, 10, 900);

  const body = await readJson(request);
  const current = typeof body.current === 'string' ? body.current : '';
  const next = typeof body.next === 'string' ? body.next : '';

  const row = await d1.prepare('SELECT pw_hash FROM users WHERE id = ?1').bind(user.id).first();
  if (!row) throw new ApiError(404, 'no_user', 'That account no longer exists.');

  /* Firebase's, not ours. Said plainly, because the honest answer is "this
     is not where your password is kept" and the alternative is somebody
     typing their correct password repeatedly into a form that cannot ever
     accept it. */
  if (!row.pw_hash || row.pw_hash === GOOGLE_ONLY_PW) {
    throw new ApiError(
      409, 'password_elsewhere',
      'This account signs in through Google or Firebase, so its password is not stored here. Use “Forgot your password?” on the sign-in page.'
    );
  }

  if (!(await verifyPassword(env, current, row.pw_hash))) {
    throw new ApiError(401, 'bad_current', 'Your current password is not right.', { field: 'current' });
  }

  /* The same rule the sign-up form promises, enforced in the same place it
     is enforced there. */
  checkPasswordStrength(next);
  if (next === current) {
    throw new ApiError(400, 'same_password', 'That is the password you already have.', { field: 'next' });
  }

  await d1.prepare('UPDATE users SET pw_hash = ?1 WHERE id = ?2')
    .bind(await hashPassword(env, next), user.id).run();

  /* The session cookie is NOT rotated, deliberately. It is signed with
     SESSION_SECRET and carries only the user id and an expiry — it is not
     derived from the password, so an old one is neither invalidated nor
     made more dangerous by this change. Rotating it would sign the person
     out of the tab they are standing in front of for no gain. Sessions on
     other devices run to their thirty days either way; that is a property
     of stateless sessions and is documented in lib/auth.js. */
  return json({ ok: true });
});
