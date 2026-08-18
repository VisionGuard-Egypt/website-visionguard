/* /api/support — the EMPLOYEE's side of live chat.

     GET  /api/support                 the queue, my chats, and who answered
                                       how many
     GET  /api/support?session=<id>    one conversation
     POST { action:'accept'|'reply'|'close', session, body? }

   STAFF, not admin. Answering customers is the job — see the same reasoning
   at the top of /api/leads.

   ACCEPTING IS A RACE, AND IT IS SETTLED IN SQL. Two employees can open the
   queue at the same moment and both press Take on the same chat. The UPDATE
   below is conditional on the row still being unclaimed, so exactly one of
   them wins and the other is told, rather than the second silently
   overwriting the first and both of them typing to the same customer.
*/
import {
  json, handle, readJson, requireSameOrigin, clean, ApiError
} from '../../lib/util.js';
import { db, enforceRate } from '../../lib/db.js';
import { requireStaff, randomId, STAFF_DOMAIN } from '../../lib/auth.js';
import { notify } from '../../lib/notify.js';
import {
  publicChatMessage, MAX_CHAT_BODY, OFFER_MINUTES,
  rotate, expiredSessions, secondsLeft, answeredCounts, eligibleAgents
} from '../../lib/livechat.js';

const sinceIso = (days) => new Date(Date.now() - days * 86400000).toISOString();

/* Same sweep as the customer's poll — a dashboard sitting open keeps the
   queue moving even when the customer has stopped polling. */
async function sweep(d1) {
  const due = await expiredSessions(d1, 10);
  const out = [];
  for (const row of due) out.push({ session: row.id, ...(await rotate(d1, row, STAFF_DOMAIN)) });
  return out;
}

/* ------------------------------------------------------------------- read */
export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  const user = await requireStaff(context, d1);

  const url = new URL(request.url);
  const wanted = clean(url.searchParams.get('session'), 64);

  /* ---- one conversation ---- */
  if (wanted) {
    const row = await d1.prepare(
      `SELECT c.*, u.name AS agent_name
         FROM chat_sessions c LEFT JOIN users u ON u.id = c.agent_id
        WHERE c.id = ?1`
    ).bind(wanted).first();
    if (!row) throw new ApiError(404, 'no_session', 'That conversation no longer exists.');

    const { results: messages } = await d1.prepare(
      `SELECT m.id, m.role, m.body, m.created_at, u.name AS author_name
         FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.session_id = ?1
        ORDER BY m.created_at ASC LIMIT 200`
    ).bind(wanted).all();

    return json({
      ok: true,
      chat: {
        id: row.id,
        status: row.status,
        name: row.name || '',
        phone: row.phone || '',
        page: row.page || '',
        agentId: row.agent_id || '',
        agentName: row.agent_name || '',
        /* Mine to answer: either I took it, or it is being offered to me. */
        mine: row.agent_id === user.id,
        offeredToMe: row.offered_to === user.id && row.status === 'waiting',
        secondsLeft: secondsLeft(row.offer_expires_at, Date.now()),
        createdAt: row.created_at
      },
      messages: (messages || []).map(publicChatMessage)
    });
  }

  /* ---- the queue ---- */
  const events = await sweep(d1);
  if (events.length) {
    context.waitUntil((async () => {
      for (const e of events) {
        if (e.outcome === 'offered' && e.agent) {
          await notify(d1, [e.agent], {
            kind: 'chat',
            title: 'A customer is waiting',
            body: `Passed to you. ${OFFER_MINUTES} minutes to answer.`,
            link: 'support',
            refId: e.session
          });
        } else if (e.outcome === 'released') {
          await notify(d1, e.everyone || [], {
            kind: 'chat',
            title: 'A customer is still waiting',
            body: 'Nobody picked this up. It is now open for anyone to take.',
            link: 'support',
            refId: e.session
          });
        }
      }
    })().catch((err) => console.error('support sweep notify', err && err.message)));
  }

  const { results: rows } = await d1.prepare(
    `SELECT c.id, c.name, c.status, c.agent_id, c.offered_to, c.offer_expires_at,
            c.created_at, c.updated_at, u.name AS agent_name,
            (SELECT body FROM chat_messages m WHERE m.session_id = c.id
              ORDER BY m.created_at DESC LIMIT 1) AS last_body
       FROM chat_sessions c LEFT JOIN users u ON u.id = c.agent_id
      WHERE c.status != 'closed'
      ORDER BY c.created_at ASC LIMIT 60`
  ).all();

  const now = Date.now();
  const chats = (rows || []).map((r) => ({
    id: r.id,
    name: r.name || '',
    status: r.status,
    agentId: r.agent_id || '',
    agentName: r.agent_name || '',
    mine: r.agent_id === user.id,
    /* Three states an employee cares about, and they are different jobs:
       it is yours to answer now, it is nobody's and you may take it, or
       somebody else already has it. */
    offeredToMe: r.offered_to === user.id && r.status === 'waiting',
    unclaimed: r.status === 'waiting' && !r.offered_to,
    secondsLeft: secondsLeft(r.offer_expires_at, now),
    last: r.last_body || '',
    createdAt: r.created_at
  }));

  /* Who is on the rota right now, so it is visible WHY a chat went where it
     went — a queue that routes invisibly is one nobody trusts. */
  const onShift = await eligibleAgents(d1, STAFF_DOMAIN);

  return json({
    ok: true,
    offerMinutes: OFFER_MINUTES,
    chats,
    onShift: onShift.map((p) => ({ id: p.id, name: p.name || '', since: p.clock_in })),
    /* "Record each employee answered how many chats." Derived from the rows
       themselves — see answeredCounts() for why there is no counter column. */
    answered: {
      today: await answeredCounts(d1, sinceIso(1)),
      month: await answeredCounts(d1, sinceIso(30))
    }
  });
});

/* ------------------------------------------------------------------ write */
export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const user = await requireStaff(context, d1);
  await enforceRate(d1, `support:${user.id}`, 120, 60);

  const body = await readJson(request);
  const action = clean(body.action, 20);
  const session = clean(body.session, 64);
  if (!session) throw new ApiError(400, 'missing_field', 'Which conversation?', { field: 'session' });

  const now = new Date().toISOString();

  /* ---- take it ---- */
  if (action === 'accept') {
    /* Conditional on nobody having taken it yet. Two people pressing Take at
       the same instant is not hypothetical on a team that all get the same
       notification — one wins here, in SQL, and the loser is told. */
    const res = await d1.prepare(
      `UPDATE chat_sessions
          SET status = 'live', agent_id = ?2, answered_at = ?3,
              offered_to = NULL, offer_expires_at = NULL, updated_at = ?3
        WHERE id = ?1 AND status = 'waiting' AND agent_id IS NULL`
    ).bind(session, user.id, now).run();

    if (!res || !res.meta || !res.meta.changes) {
      const row = await d1.prepare(
        `SELECT c.status, u.name AS agent_name FROM chat_sessions c
           LEFT JOIN users u ON u.id = c.agent_id WHERE c.id = ?1`
      ).bind(session).first();
      if (!row) throw new ApiError(404, 'no_session', 'That conversation no longer exists.');
      throw new ApiError(
        409, 'already_taken',
        row.agent_name ? `${row.agent_name} is already answering this one.` : 'Somebody else took this one.'
      );
    }

    /* Say hello on the employee's behalf so the customer sees the handover
       happen rather than a silent change of tone. */
    await d1.prepare(
      `INSERT INTO chat_messages (id, session_id, role, body, author_id, created_at)
       VALUES (?1, ?2, 'system', ?3, ?4, ?5)`
    ).bind(randomId(12), session, `${user.name} joined the chat`, user.id, now).run();

    return json({ ok: true, status: 'live' });
  }

  /* ---- answer ---- */
  if (action === 'reply') {
    const text = clean(body.body, MAX_CHAT_BODY);
    if (!text) throw new ApiError(400, 'missing_field', 'Write something first.', { field: 'body' });

    const row = await d1.prepare(
      'SELECT status, agent_id FROM chat_sessions WHERE id = ?1'
    ).bind(session).first();
    if (!row) throw new ApiError(404, 'no_session', 'That conversation no longer exists.');
    if (row.status === 'closed') throw new ApiError(409, 'chat_closed', 'That conversation is closed.');
    /* Whoever took it answers it. Not a permissions question so much as a
       "two people typing to one customer" question. */
    if (row.agent_id && row.agent_id !== user.id) {
      throw new ApiError(409, 'not_yours', 'Somebody else is answering this one.');
    }

    await d1.batch([
      d1.prepare(
        `INSERT INTO chat_messages (id, session_id, role, body, author_id, created_at)
         VALUES (?1, ?2, 'agent', ?3, ?4, ?5)`
      ).bind(randomId(12), session, text, user.id, now),
      d1.prepare('UPDATE chat_sessions SET updated_at = ?2 WHERE id = ?1').bind(session, now)
    ]);

    return json({ ok: true, at: now });
  }

  /* ---- done ---- */
  if (action === 'close') {
    await d1.prepare(
      `UPDATE chat_sessions SET status = 'closed', closed_at = ?2, updated_at = ?2
        WHERE id = ?1`
    ).bind(session, now).run();
    return json({ ok: true, status: 'closed' });
  }

  throw new ApiError(400, 'bad_action', 'Unknown action.');
});
