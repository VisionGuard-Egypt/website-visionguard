/* =========================================================================
   Live chat — handing a customer from the assistant to a person.

   THE RULE, AS ASKED FOR
   ----------------------
   A customer talking to the bot asks for a human. One employee is offered
   the chat, not all of them. They have five minutes to pick it up. If they
   do not, it moves to the next employee, and so on down the list. Only
   people who are actually on shift are in the list. Each employee's answered
   count is kept, so it is visible who is carrying the queue.

   WHY ONE AT A TIME. Telling everybody at once is how a queue of four people
   produces four notifications and nobody moving, because each of them
   assumes one of the others has it. Offering it to one person makes it
   somebody's job, and the deadline is what stops that being a way to lose a
   customer.

   THERE IS NO TIMER, AND THERE CANNOT BE ONE
   ------------------------------------------
   Cloudflare Pages has no scheduled handler — no cron, no alarm, no
   durable object here. So the five minutes is not something that fires; it
   is a DEADLINE that gets noticed. `offer_expires_at` is written when the
   offer is made, and sweepExpired() below rolls anything past its deadline
   on to the next person. Every request that touches the queue calls it:
   the customer's widget polling for a reply, a staff dashboard opening the
   tab, another customer asking for help. A waiting customer's own browser
   polls every few seconds, which means the deadline on their chat is
   evaluated constantly, by the one party guaranteed to still be present.

   The consequence to be honest about: if nobody is polling at all — no
   staff dashboards open and the customer has closed their tab — an expired
   offer sits until the next request arrives. Nobody is waiting on it at
   that moment either, so the delay costs nothing real, and it is the price
   of not needing a background worker.
   ========================================================================= */
import { randomId } from './auth.js';

/* Five minutes, as specified. Exported so the UI can say so out loud rather
   than hard-coding the same number in a sentence somewhere. */
export const OFFER_MINUTES = 5;
const OFFER_MS = OFFER_MINUTES * 60000;

export const CHAT_STATUSES = ['waiting', 'live', 'closed'];
export const MAX_CHAT_BODY = 1500;

/* -------------------------------------------------------------------------
   Pure rotation logic
   ------------------------------------------------------------------------- */

/* The next person to ask.

   `eligible` is the on-shift list in a stable order; `offeredIds` is
   everybody who has already had their turn on THIS chat. Returns null when
   the list is exhausted, which is a real state and not an error — see
   sweepExpired().

   Skipping people already offered is the whole point. Without it a two-person
   shift hands the same chat back and forth every five minutes forever, and
   the customer waits through all of it. */
export function nextAgent(eligible, offeredIds) {
  const seen = new Set(offeredIds || []);
  for (const person of eligible || []) {
    if (!seen.has(person.id)) return person;
  }
  return null;
}

export const offerExpiry = (fromMs) => new Date((fromMs || Date.now()) + OFFER_MS).toISOString();

export function isOfferExpired(expiresAt, nowMs) {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return true;
  return t <= (nowMs || Date.now());
}

/* Seconds left on an offer, for the badge on the employee's screen. Never
   negative: a countdown that goes past zero into minus numbers reads as
   broken rather than as expired. */
export function secondsLeft(expiresAt, nowMs) {
  if (!expiresAt) return 0;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((t - (nowMs || Date.now())) / 1000));
}

export function parseOffered(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    /* A corrupt column must not stop the rotation — treating it as "nobody
       has been asked yet" costs at worst one repeated offer. */
    return [];
  }
}

export const newSessionId = () => randomId(16);   // 32 hex chars

/* What a customer's browser is allowed to see about its own session. The id
   is deliberately absent: the browser already has it, and echoing a
   capability back in every response is how it ends up in a log. */
export function publicSession(row, nowMs) {
  return {
    status: row.status,
    /* The employee's name once somebody has it, so the customer knows they
       are talking to a person and which one. Never their email or id. */
    agentName: row.agent_name || '',
    waitingSince: row.created_at,
    /* Only meaningful while waiting, and it is about the CUSTOMER's wait,
       not the employee's deadline — a customer being shown "4:58 left" would
       reasonably think it was a countdown to being abandoned. */
    queued: row.status === 'waiting',
    answeredAt: row.answered_at || null,
    closed: row.status === 'closed'
  };
}

export function publicChatMessage(row) {
  return {
    id: row.id,
    role: row.role,                        // customer | agent | bot | system
    body: row.body,
    authorName: row.author_name || '',
    at: row.created_at
  };
}

/* -------------------------------------------------------------------------
   Who is available

   ON SHIFT, not merely signed in. Sessions here are stateless signed cookies
   with no server-side record, so "logged in right now" is not a question
   this system can actually answer — a cookie exists on a laptop that was
   shut hours ago. Attendance is the explicit "I am working" signal an
   employee gives on purpose, it is already recorded, and it is the closest
   honest match for "whoever is on".

   Ordered by clock-in, longest-on-shift first, tie-broken by id so the
   rotation is stable within a shift and does not depend on row order.
   ------------------------------------------------------------------------- */
export async function eligibleAgents(d1, staffDomain) {
  const { results } = await d1.prepare(
    `SELECT u.id, u.name, u.email, a.clock_in
       FROM attendance a
       JOIN users u ON u.id = a.user_id
      WHERE a.clock_out IS NULL
        AND lower(u.email) LIKE ?1
      ORDER BY a.clock_in ASC, u.id ASC`
  ).bind('%@' + String(staffDomain).toLowerCase()).all();
  return results || [];
}

/* Nobody clocked in is not a dead end. The customer asked for a person and
   somebody has to be told, so the whole team becomes the list — they are
   simply not on shift, which the notification says. Better a message to an
   employee at home than a customer waiting for a rota that is empty. */
export async function fallbackAgents(d1, staffDomain) {
  const { results } = await d1.prepare(
    `SELECT id, name, email FROM users
      WHERE lower(email) LIKE ?1
      ORDER BY id ASC`
  ).bind('%@' + String(staffDomain).toLowerCase()).all();
  return results || [];
}

/* -------------------------------------------------------------------------
   How many each person answered

   Derived, not counted into a column. A stored counter is a second copy of
   the truth that drifts the first time a row is edited by hand, and this
   query is a single index scan over a table that will hold hundreds of rows,
   not millions.
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   Making an offer, and rolling it on when it lapses
   ------------------------------------------------------------------------- */

/* Hand the chat to one person and start their five minutes. */
export async function offerTo(d1, session, agent, offered) {
  const now = Date.now();
  const expires = offerExpiry(now);
  const list = Array.from(new Set([...(offered || []), agent.id]));
  await d1.prepare(
    `UPDATE chat_sessions
        SET offered_to = ?2, offer_expires_at = ?3, offered_ids = ?4, updated_at = ?5
      WHERE id = ?1 AND status = 'waiting'`
  ).bind(session.id, agent.id, expires, JSON.stringify(list), new Date(now).toISOString()).run();
  return { agent, expires };
}

/* Everybody on the rota has had their turn and nobody took it.

   The chat does NOT keep rotating. Going round the same three people every
   five minutes is a machine pestering a team that has already shown it
   cannot take the chat, and it never escalates. Instead the offer is
   dropped, the chat becomes unclaimed — visible to everyone, grabbable by
   anyone — and the whole team is told once. That is a state a human can
   act on, and it stops being the software's problem. */
export async function releaseToAll(d1, session) {
  await d1.prepare(
    `UPDATE chat_sessions
        SET offered_to = NULL, offer_expires_at = NULL, updated_at = ?2
      WHERE id = ?1 AND status = 'waiting'`
  ).bind(session.id, new Date().toISOString()).run();
}

/* Pass one waiting chat to the next person, or release it.

   Returns what happened so the caller can notify — this function does no
   notifying itself, because it runs inside a sweep that may touch several
   sessions and the caller decides how much of that to do inside waitUntil. */
export async function rotate(d1, session, staffDomain) {
  const offered = parseOffered(session.offered_ids);

  let pool = await eligibleAgents(d1, staffDomain);
  let onShift = true;
  if (!pool.length) {
    pool = await fallbackAgents(d1, staffDomain);
    onShift = false;
  }

  const agent = nextAgent(pool, offered);
  if (!agent) {
    await releaseToAll(d1, session);
    return { outcome: 'released', agent: null, everyone: pool };
  }

  const { expires } = await offerTo(d1, session, agent, offered);
  return { outcome: 'offered', agent, expires, onShift };
}

/* Everything whose five minutes has run out.

   Bounded, because this runs on the customer's polling path: a queue that
   has somehow grown to hundreds must not turn one poll into hundreds of
   writes. Whatever is left is picked up by the next request, which is
   moments away. */
export async function expiredSessions(d1, limit) {
  const { results } = await d1.prepare(
    `SELECT id, offered_ids, offer_expires_at
       FROM chat_sessions
      WHERE status = 'waiting'
        AND offer_expires_at IS NOT NULL
        AND offer_expires_at <= ?1
      ORDER BY created_at ASC
      LIMIT ?2`
  ).bind(new Date().toISOString(), Math.min(Math.max(limit || 10, 1), 25)).all();
  return results || [];
}

export async function answeredCounts(d1, sinceIso) {
  const { results } = await d1.prepare(
    `SELECT c.agent_id AS id, u.name AS name, COUNT(*) AS n
       FROM chat_sessions c
       JOIN users u ON u.id = c.agent_id
      WHERE c.agent_id IS NOT NULL
        AND c.answered_at IS NOT NULL
        AND c.answered_at >= ?1
      GROUP BY c.agent_id
      ORDER BY n DESC`
  ).bind(sinceIso).all();
  return (results || []).map((r) => ({ id: r.id, name: r.name || '', answered: Number(r.n) || 0 }));
}
