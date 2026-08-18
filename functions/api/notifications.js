/* GET  /api/notifications?since=<iso>   the caller's own notifications
   POST /api/notifications               { read: [id, ...] } or { readAll: true }

   Staff only, and scoped to the caller in the SQL rather than filtered after
   the fact — every statement here carries `user_id = ?`, so there is no shape
   of request that returns somebody else's notifications. That matters more
   than usual on this table: it carries who clocked in and when.
*/
import { json, handle, readJson, requireSameOrigin, ApiError } from '../../lib/util.js';
import { db } from '../../lib/db.js';
import { requireStaff } from '../../lib/auth.js';

/* The dashboard shows a badge and a short list, not an archive. Anything
   older than this is history nobody scrolls to, and leaving it unbounded
   makes the list slower every week it runs. */
const PAGE = 40;

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  const user = await requireStaff(context, d1);

  const [list, count] = await Promise.all([
    d1.prepare(
      `SELECT id, kind, title, body, link, ref_id, read_at, created_at
         FROM notifications
        WHERE user_id = ?1
        ORDER BY created_at DESC
        LIMIT ${PAGE}`
    ).bind(user.id).all(),
    /* Counted separately rather than derived from the page above: the badge
       has to be right even when there are more unread than fit in one page,
       which is exactly the situation where being wrong is noticed. */
    d1.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL`
    ).bind(user.id).first()
  ]);

  return json({
    ok: true,
    unread: Number(count && count.n) || 0,
    notifications: (list.results || []).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body || '',
      link: r.link || '',
      refId: r.ref_id || '',
      read: !!r.read_at,
      createdAt: r.created_at
    }))
  });
});

export const onRequestPost = handle(async (context) => {
  const { request } = context;
  requireSameOrigin(request);

  const d1 = await db(context.env);
  const user = await requireStaff(context, d1);
  const body = await readJson(request);
  const now = new Date().toISOString();

  if (body.readAll === true) {
    await d1.prepare(
      `UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL`
    ).bind(now, user.id).run();
    return json({ ok: true, unread: 0 });
  }

  const ids = Array.isArray(body.read) ? body.read.filter((v) => typeof v === 'string').slice(0, PAGE) : [];
  if (!ids.length) {
    throw new ApiError(400, 'nothing_to_mark', 'Send an id list, or readAll.');
  }

  /* Bound placeholders rather than an interpolated list — these ids come from
     a request body. The user_id predicate is what makes marking somebody
     else's notification read impossible even with a valid id. */
  const holes = ids.map((_, i) => `?${i + 3}`).join(',');
  await d1.prepare(
    `UPDATE notifications SET read_at = ?1
      WHERE user_id = ?2 AND read_at IS NULL AND id IN (${holes})`
  ).bind(now, user.id, ...ids).run();

  const count = await d1.prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL`
  ).bind(user.id).first();

  return json({ ok: true, unread: Number(count && count.n) || 0 });
});
