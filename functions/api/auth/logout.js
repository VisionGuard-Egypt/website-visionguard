/* POST /api/auth/logout — clears the cookie on this device. See the note in
   lib/auth.js about what a stateless session does and does not let you do. */
import { json, handle, requireSameOrigin } from '../../../lib/util.js';
import { sessionCookie } from '../../../lib/auth.js';

export const onRequestPost = handle(async ({ request }) => {
  requireSameOrigin(request);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '') });
});
