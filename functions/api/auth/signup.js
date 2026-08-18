/* POST /api/auth/signup

   CLOSED. Registration moved to Firebase Auth: the browser creates the
   credential there and posts the resulting ID token to /api/auth/firebase,
   which verifies it and creates the D1 record — including the same consent
   handling this endpoint used to do (terms stamped only when the box was
   actually ticked, newsletter written through to the mailing list, marketing
   kept separate, administrator addresses refused).

   It could not be left working. It writes a pw_hash that Firebase knows
   nothing about, so any account created through it would be one the sign-in
   form can no longer sign into: an account that exists, can have orders
   placed against it, and locks its owner out.

   It answers rather than 404s because a browser holding a cached copy of the
   old account.js would otherwise fail with nothing to explain it, on the one
   action a new customer is trying to take.

   /api/auth/login is deliberately still live — see the note in that file.
*/
import { json, handle, ApiError } from '../../../lib/util.js';

export const onRequestPost = handle(async () => {
  throw new ApiError(
    410, 'signup_moved',
    'Account creation has moved. Please refresh the page and sign up again.'
  );
});

/* A GET is what someone gets by pasting the URL into a browser while working
   out why their sign-up failed. Answer it plainly instead of with a 405. */
export const onRequestGet = handle(async () =>
  json({ ok: false, code: 'signup_moved', message: 'Sign-up is handled by /api/auth/firebase.' }, 410)
);
