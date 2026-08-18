/* POST /api/account/preferences
   { name?, phone?, marketing?, newsletter?, lang? }

   Consent has to be as easy to withdraw as it was to give, so unticking the
   newsletter box here also stamps unsub_at on the mailing list row rather
   than only flipping a flag on the account. */
import {
  json, handle, readJson, requireSameOrigin, clean, normPhoneEg
} from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { requireUser, publicUser } from '../../../lib/auth.js';

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const user = await requireUser(context, d1);
  const body = await readJson(request);

  const name = body.name !== undefined ? (clean(body.name, 120) || user.name) : user.name;
  const phone = body.phone !== undefined
    ? (body.phone ? normPhoneEg(body.phone, 'phone', true) : '')
    : (user.phone || '');
  const marketing = body.marketing !== undefined ? (body.marketing === true ? 1 : 0) : (user.marketing ? 1 : 0);
  const newsletter = body.newsletter !== undefined ? (body.newsletter === true ? 1 : 0) : (user.newsletter ? 1 : 0);
  const lang = body.lang === 'en' ? 'en' : body.lang === 'ar' ? 'ar' : (user.lang || 'ar');

  await d1.prepare(
    `UPDATE users SET name = ?1, phone = ?2, marketing = ?3, newsletter = ?4, lang = ?5
      WHERE id = ?6`
  ).bind(name, phone || null, marketing, newsletter, lang, user.id).run();

  const now = new Date().toISOString();
  try {
    if (newsletter) {
      await d1.prepare(
        `INSERT INTO newsletter (email, name, marketing, source, lang, created_at)
         VALUES (?1,?2,?3,'account',?4,?5)
         ON CONFLICT(email) DO UPDATE SET
           name = ?2, marketing = ?3, lang = ?4, unsub_at = NULL`
      ).bind(user.email, name, marketing, lang, now).run();
    } else {
      await d1.prepare(
        'UPDATE newsletter SET unsub_at = ?1, marketing = 0 WHERE email = ?2'
      ).bind(now, user.email).run();
    }
  } catch (err) {
    console.error('newsletter preferences', err && err.message);
  }

  return json({
    ok: true,
    user: publicUser(Object.assign({}, user, { name, phone, marketing, newsletter, lang }), context.env)
  });
});
