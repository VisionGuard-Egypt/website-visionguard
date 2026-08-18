/* POST /api/notify-optin   { state: 'granted' | 'denied' | 'default' }
   GET  /api/notify-optin   who on the team has turned them on (admin only)

   WHAT THIS IS, AND WHAT IT IS NOT
   --------------------------------
   It is a REPORT of what the browser said, not the thing that grants
   anything. A site cannot make somebody accept notifications — the dialog is
   the browser's, the answer is the person's, and once it is refused the site
   cannot ask again at all. That is a deliberate browser protection and there
   is no way around it, so "mandatory" is enforced where it actually can be:
   the dashboard keeps asking, and this endpoint records who has said yes so
   the owner can see who has not.

   The value is written by public/account-staff.js from Notification.permission
   after every prompt, so it reflects the last known truth for that person on
   that browser rather than an intention recorded once.
*/
import { json, handle, readJson, requireSameOrigin, ApiError, clean } from '../../lib/util.js';
import { db } from '../../lib/db.js';
import { requireStaff, requireAdmin, STAFF_DOMAIN } from '../../lib/auth.js';

const STATES = ['granted', 'denied', 'default', 'unsupported'];

export const onRequestPost = handle(async (context) => {
  requireSameOrigin(context.request);
  const d1 = await db(context.env);
  const user = await requireStaff(context, d1);

  const state = clean((await readJson(context.request)).state, 20);
  if (!STATES.includes(state)) {
    throw new ApiError(400, 'bad_state', 'Unknown permission state.', { field: 'state' });
  }

  await d1.prepare('UPDATE users SET push_optin = ?1, push_optin_at = ?2 WHERE id = ?3')
    .bind(state, new Date().toISOString(), user.id).run();

  return json({ ok: true, state });
});

/* The owner's view: who has these on. The point of recording it at all — a
   team where one person quietly refused is a team where one person is not
   getting told about orders, and nothing else would ever surface that. */
export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  await requireAdmin(context, d1);

  const { results } = await d1.prepare(
    `SELECT id, name, email, role, push_optin, push_optin_at
       FROM users
      WHERE lower(email) LIKE ?1
      ORDER BY name`
  ).bind('%@' + STAFF_DOMAIN.toLowerCase()).all();

  return json({
    ok: true,
    people: (results || []).map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      state: p.push_optin || 'default',
      since: p.push_optin_at || ''
    }))
  });
});
