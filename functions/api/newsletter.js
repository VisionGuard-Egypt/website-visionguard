/* POST /api/newsletter  { email, name?, marketing?, source?, lang? }
   Standalone subscribe, for people who want the list without an account.
   Answers the same way whether the address was new or already there —
   a subscribe endpoint that reports "already subscribed" is an address
   checker for anyone who wants one. */
import {
  json, handle, readJson, requireSameOrigin, clean, normEmail, clientIp
} from '../../lib/util.js';
import { db, enforceRate } from '../../lib/db.js';

const SOURCES = ['footer', 'signup', 'checkout', 'shop', 'account'];

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  await enforceRate(d1, `news:${clientIp(request)}`, 10, 3600);

  const body = await readJson(request);
  const email = normEmail(body.email);
  const name = clean(body.name, 120);
  const marketing = body.marketing === true ? 1 : 0;
  const source = SOURCES.includes(body.source) ? body.source : 'footer';
  const lang = body.lang === 'en' ? 'en' : 'ar';
  const now = new Date().toISOString();

  await d1.prepare(
    `INSERT INTO newsletter (email, name, marketing, source, lang, created_at)
     VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(email) DO UPDATE SET
       name      = COALESCE(NULLIF(?2, ''), newsletter.name),
       marketing = MAX(newsletter.marketing, ?3),
       lang      = ?5,
       unsub_at  = NULL`
  ).bind(email, name, marketing, source, lang, now).run();

  return json({ ok: true });
});
