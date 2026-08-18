/* /api/chat — the CUSTOMER's side of a live chat.

     POST { action: 'request', name?, phone?, page?, history? }
          ask for a person; returns the session id
     POST { action: 'send', session, body }      say something
     GET  ?session=<id>&after=<iso>              poll for replies

   NO SIGN-IN, AND THE SESSION ID IS THE CREDENTIAL. A customer asking the
   shop a question does not have an account and should not need one. The id
   is 32 hex characters of crypto randomness, it is returned exactly once to
   the browser that created it, and no endpoint a customer can reach will
   ever list one. Whoever holds it owns that conversation and nothing else —
   there is no way to walk from a session id to any other customer, any
   order, or any part of the site.

   WHY THE POLL DRIVES THE ROTATION. Pages has no cron, so the five-minute
   deadline in lib/livechat.js has to be noticed by somebody. The waiting
   customer's own browser is polling every few seconds and is the one party
   guaranteed to still care, so every poll sweeps the queue. It costs one
   indexed SELECT that almost always returns nothing.
*/
import {
  json, handle, readJson, requireSameOrigin, clean, clientIp, ApiError
} from '../../lib/util.js';
import { db, enforceRate } from '../../lib/db.js';
import { randomId, STAFF_DOMAIN } from '../../lib/auth.js';
import { staffRecipients, notify } from '../../lib/notify.js';
import {
  newSessionId, publicSession, publicChatMessage, MAX_CHAT_BODY,
  rotate, expiredSessions, parseOffered, nextAgent,
  eligibleAgents, fallbackAgents, offerTo, OFFER_MINUTES
} from '../../lib/livechat.js';

/* Roll every lapsed offer on to the next person.

   Runs on the customer's poll. Notifying is done here rather than inside
   lib/livechat.js because only the caller knows whether it is on a path
   that can afford to wait — this one cannot, so the writes happen and the
   notifications go out through the same request without being awaited by
   anything the customer is watching. */
async function sweep(d1) {
  const due = await expiredSessions(d1, 10);
  const events = [];
  for (const row of due) {
    const result = await rotate(d1, row, STAFF_DOMAIN);
    events.push({ session: row.id, ...result });
  }
  return events;
}

async function announce(d1, events) {
  for (const e of events) {
    if (e.outcome === 'offered' && e.agent) {
      await notify(d1, [e.agent], {
        kind: 'chat',
        title: 'A customer is waiting',
        body: e.onShift
          ? `Passed to you because it was not picked up. ${OFFER_MINUTES} minutes to answer.`
          : `Nobody is clocked in. ${OFFER_MINUTES} minutes to answer.`,
        link: 'support',
        refId: e.session
      });
    } else if (e.outcome === 'released') {
      /* Everybody has had a turn. One message to the whole team, once —
         see releaseToAll() for why it stops rotating rather than going
         round again. */
      await notify(d1, e.everyone || [], {
        kind: 'chat',
        title: 'A customer is still waiting',
        body: 'Nobody picked this up. It is now open for anyone to take.',
        link: 'support',
        refId: e.session
      });
    }
  }
}

/* ------------------------------------------------------------------ write */
export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const ip = clientIp(request);
  const body = await readJson(request);
  const action = clean(body.action, 20);

  /* ---- ask for a person ---- */
  if (action === 'request') {
    /* Tighter than the assistant's own limit: this one puts a notification
       in front of an employee, so it is the abuse path that costs somebody's
       attention rather than somebody's neurons. */
    await enforceRate(d1, `chatreq:${ip}`, 5, 3600);

    const id = newSessionId();
    const now = new Date().toISOString();
    const name = clean(body.name, 80);
    const phone = clean(body.phone, 40);
    const page = clean(body.page, 200);

    await d1.prepare(
      `INSERT INTO chat_sessions
         (id, name, phone, page, status, offered_ids, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'waiting', '[]', ?5, ?5)`
    ).bind(id, name || null, phone || null, page || null, now).run();

    /* The conversation so far, so whoever picks it up is not asking the
       customer to repeat themselves. Bounded, and only what the browser
       already had — this is the first time any of it is stored. */
    const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
    if (history.length) {
      await d1.batch(history.map((m) => d1.prepare(
        `INSERT INTO chat_messages (id, session_id, role, body, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(
        randomId(12), id,
        m && m.role === 'assistant' ? 'bot' : 'customer',
        clean(m && m.content, MAX_CHAT_BODY) || '…',
        now
      )));
    }

    /* Offer it to the first person on the rota straight away. */
    let pool = await eligibleAgents(d1, STAFF_DOMAIN);
    let onShift = true;
    if (!pool.length) { pool = await fallbackAgents(d1, STAFF_DOMAIN); onShift = false; }
    const agent = nextAgent(pool, []);

    if (agent) {
      await offerTo(d1, { id }, agent, []);
      context.waitUntil(
        notify(d1, [agent], {
          kind: 'chat',
          title: 'A customer wants to talk',
          body: onShift
            ? `${name || 'Someone'} is waiting. ${OFFER_MINUTES} minutes to answer.`
            : `${name || 'Someone'} is waiting and nobody is clocked in. ${OFFER_MINUTES} minutes to answer.`,
          link: 'support',
          refId: id
        }).catch((err) => console.error('chat notify', err && err.message))
      );
    } else {
      /* No staff accounts at all. The customer must not be left believing
         somebody is coming. */
      context.waitUntil(Promise.resolve());
    }

    return json({
      ok: true,
      session: id,
      waiting: true,
      /* Said out loud so the widget can promise it accurately rather than
         hard-coding "5" in a sentence of its own. */
      offerMinutes: OFFER_MINUTES,
      staffed: Boolean(agent)
    }, 201);
  }

  /* ---- say something ---- */
  if (action === 'send') {
    await enforceRate(d1, `chatmsg:${ip}`, 60, 3600);

    const session = clean(body.session, 64);
    const text = clean(body.body, MAX_CHAT_BODY);
    if (!session) throw new ApiError(400, 'missing_field', 'Missing the conversation.', { field: 'session' });
    if (!text) throw new ApiError(400, 'missing_field', 'Write something first.', { field: 'body' });

    const row = await d1.prepare(
      'SELECT id, status, agent_id FROM chat_sessions WHERE id = ?1'
    ).bind(session).first();
    /* Same 404 for "no such id" and "not yours" — there is only one way to
       hold an id, so they are the same case. */
    if (!row) throw new ApiError(404, 'no_session', 'That conversation has ended.');
    if (row.status === 'closed') throw new ApiError(409, 'chat_closed', 'That conversation has been closed.');

    const now = new Date().toISOString();
    await d1.batch([
      d1.prepare(
        `INSERT INTO chat_messages (id, session_id, role, body, created_at)
         VALUES (?1, ?2, 'customer', ?3, ?4)`
      ).bind(randomId(12), session, text, now),
      d1.prepare('UPDATE chat_sessions SET updated_at = ?2 WHERE id = ?1').bind(session, now)
    ]);

    /* Tell the person handling it that something new arrived. Only once
       they have actually taken it — before that the offer notification is
       already sitting in front of somebody. */
    if (row.agent_id && row.status === 'live') {
      context.waitUntil(
        notify(d1, [{ id: row.agent_id }], {
          kind: 'chat',
          title: 'New message from a customer',
          body: text.slice(0, 120),
          link: 'support',
          refId: session
        }).catch((err) => console.error('chat notify', err && err.message))
      );
    }

    return json({ ok: true, at: now });
  }

  throw new ApiError(400, 'bad_action', 'Unknown action.');
});

/* ------------------------------------------------------------------- read */
export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);

  const url = new URL(request.url);
  const session = clean(url.searchParams.get('session'), 64);
  const after = clean(url.searchParams.get('after'), 40);
  if (!session) throw new ApiError(400, 'missing_field', 'Missing the conversation.', { field: 'session' });

  /* The rotation, driven by the person actually waiting. See the header. */
  const events = await sweep(d1);
  if (events.length) {
    context.waitUntil(announce(d1, events).catch((err) => console.error('chat sweep notify', err && err.message)));
  }

  const row = await d1.prepare(
    `SELECT c.*, u.name AS agent_name
       FROM chat_sessions c LEFT JOIN users u ON u.id = c.agent_id
      WHERE c.id = ?1`
  ).bind(session).first();
  if (!row) throw new ApiError(404, 'no_session', 'That conversation has ended.');

  const { results: messages } = await d1.prepare(
    `SELECT m.id, m.role, m.body, m.created_at, u.name AS author_name
       FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.session_id = ?1 AND (?2 = '' OR m.created_at > ?2)
      ORDER BY m.created_at ASC LIMIT 100`
  ).bind(session, after || '').all();

  return json({
    ok: true,
    session: publicSession(row, Date.now()),
    messages: (messages || []).map(publicChatMessage)
  });
});
