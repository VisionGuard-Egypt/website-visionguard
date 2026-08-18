/* GET  /api/messages?box=inbox|sent    the caller's own messages
   POST /api/messages                   { to, subject, body }  — send
        /api/messages                   { read: [id, ...] }    — mark read

   Internal messages between the team. Nothing leaves the site: there is no
   mail provider, no API key and no deliverability problem, because this is
   not email — it is a table with an inbox drawn on top of it.

   WHO MAY WRITE TO WHOM
   ---------------------
   Any staff account to any other staff account, both directions. The
   requirement was "admin can send to employees and vice versa", and for a
   team of four a directory this small does not need routing rules on top.
   What it does need is the recipient being CHECKED — see the lookup below.
   A message addressed to a customer id would otherwise be delivered into an
   inbox that account can never open, which is a message silently lost rather
   than refused.
*/
import {
  json, handle, readJson, requireSameOrigin, ApiError, clean
} from '../../lib/util.js';
import { db, enforceRate } from '../../lib/db.js';
import { requireStaff, randomId, isStaffEmail } from '../../lib/auth.js';
import { notifyMessage } from '../../lib/notify.js';

const PAGE = 50;
const MAX_SUBJECT = 140;
const MAX_BODY = 4000;

export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  const user = await requireStaff(context, d1);

  const box = new URL(context.request.url).searchParams.get('box') === 'sent' ? 'sent' : 'inbox';
  const mineIs = box === 'sent' ? 'm.from_id' : 'm.to_id';
  const otherIs = box === 'sent' ? 'm.to_id' : 'm.from_id';

  /* Joined to users so the list can show a name. LEFT JOIN, not INNER: an
     account that has since been removed must not make its old messages
     disappear from the other person's inbox. */
  const { results } = await d1.prepare(
    `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
            m.from_id, m.to_id,
            u.name AS other_name, u.email AS other_email
       FROM messages m
       LEFT JOIN users u ON u.id = ${otherIs}
      WHERE ${mineIs} = ?1
      ORDER BY m.created_at DESC
      LIMIT ${PAGE}`
  ).bind(user.id).all();

  const unread = await d1.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE to_id = ?1 AND read_at IS NULL`
  ).bind(user.id).first();

  return json({
    ok: true,
    box,
    unread: Number(unread && unread.n) || 0,
    messages: (results || []).map((m) => ({
      id: m.id,
      subject: m.subject || '',
      body: m.body,
      read: !!m.read_at,
      createdAt: m.created_at,
      mine: m.from_id === user.id,
      who: { name: m.other_name || 'Removed account', email: m.other_email || '' }
    }))
  });
});

/* Who a message may be addressed to. Used by the compose box to fill its
   picker, so the only addresses offered are ones that can actually receive. */
export const onRequestOptions = handle(async (context) => {
  const d1 = await db(context.env);
  const user = await requireStaff(context, d1);
  const { results } = await d1.prepare(
    `SELECT id, name, email, role FROM users
      WHERE id != ?1 AND lower(email) LIKE ?2
      ORDER BY name`
  ).bind(user.id, '%@visionguardeg.com').all();
  return json({ ok: true, people: results || [] });
});

export const onRequestPost = handle(async (context) => {
  const { request } = context;
  requireSameOrigin(request);

  const d1 = await db(context.env);
  const user = await requireStaff(context, d1);
  const body = await readJson(request);

  /* ---- marking read ---- */
  if (Array.isArray(body.read)) {
    const ids = body.read.filter((v) => typeof v === 'string').slice(0, PAGE);
    if (ids.length) {
      const holes = ids.map((_, i) => `?${i + 3}`).join(',');
      await d1.prepare(
        `UPDATE messages SET read_at = ?1
          WHERE to_id = ?2 AND read_at IS NULL AND id IN (${holes})`
      ).bind(new Date().toISOString(), user.id, ...ids).run();
    }
    return json({ ok: true });
  }

  /* ---- sending ---- */
  await enforceRate(d1, `msg:${user.id}`, 60, 3600);

  const toId = clean(body.to, 64);
  if (!toId) throw new ApiError(400, 'no_recipient', 'Choose who to send it to.', { field: 'to' });
  if (toId === user.id) {
    throw new ApiError(400, 'self_message', 'You cannot send a message to yourself.', { field: 'to' });
  }

  const messageBody = clean(body.body, MAX_BODY);
  if (!messageBody) throw new ApiError(400, 'empty_message', 'Write something first.', { field: 'body' });
  const subject = clean(body.subject, MAX_SUBJECT);

  /* The recipient has to exist AND be staff. Checked against the database
     rather than trusted from the form: the picker only offers colleagues, but
     the form is not the security boundary — this is. */
  const to = await d1.prepare('SELECT id, name, email FROM users WHERE id = ?1').bind(toId).first();
  if (!to || !isStaffEmail(to.email)) {
    throw new ApiError(400, 'bad_recipient', 'That person is not on the team.', { field: 'to' });
  }

  const id = randomId(12);
  const now = new Date().toISOString();
  await d1.prepare(
    `INSERT INTO messages (id, from_id, to_id, subject, body, read_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`
  ).bind(id, user.id, to.id, subject || null, messageBody, now).run();

  /* The badge, after the message is safely stored. Through waitUntil so a
     notification problem cannot fail a message that was already sent. */
  context.waitUntil(
    notifyMessage(d1, to.id, user.name, subject || messageBody.slice(0, 80))
      .catch((err) => console.error('message notify', err && err.message))
  );

  return json({ ok: true, id, createdAt: now }, 201);
});
