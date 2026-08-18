/* GET /api/auth/me — who the cookie belongs to, or null. Answers 200 with
   user:null rather than 401 so the page can boot without treating "signed
   out" as an error. */
import { json, handle } from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { currentUser, publicUser, isAdminUser } from '../../../lib/auth.js';
import { insightsStatus } from '../../../lib/insights.js';

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  const user = await currentUser(context, d1);
  if (!user) return json({ ok: true, user: null });

  const body = { ok: true, user: publicUser(user, context.env) };

  /* Whether the Meta connection is switched on, for the banner the
     administrator sees on the dashboard.

     ADMIN ONLY, and not because it is sensitive — insightsStatus returns
     booleans, never a token — but because it is nobody else's business which
     integrations the owner has finished setting up.

     It rides on THIS response rather than having an endpoint of its own
     because the page already fetches it on every sign-in, and the whole
     status is four reads off `env` with no network and no database behind
     them. A separate call would double the sign-in cost of the one page an
     administrator opens most. */
  if (isAdminUser(context.env, user)) {
    body.metaSetup = insightsStatus(context.env);
  }

  return json(body);
});
