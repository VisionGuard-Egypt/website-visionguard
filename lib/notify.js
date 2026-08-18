/* =========================================================================
   In-app notifications.

   A notification is a record that something happened and a person who should
   know about it. It is delivered by being in the database when they next look
   — there is no push, no email and no WhatsApp here, which is a deliberate
   starting point rather than an oversight: every one of those channels can be
   added later as a second reader of this same table, and none of them can be
   added at all without it.

   THE ONE RULE THIS FILE FOLLOWS
   ------------------------------
   Notifying must never be able to break the thing being notified about. An
   order is taken, a shift is clocked; telling somebody is a consequence, not
   a step. So every function here swallows its own errors and returns a count
   instead of throwing, and every caller invokes it through waitUntil so the
   customer or the employee is never waiting on it. A failed notification
   costs somebody a badge. A notification that can throw costs an order.

   That is also why the failures are LOGGED rather than ignored: the whole
   point of the admin panel's `unnotified` column on orders is that a silent
   delivery failure looks exactly like a quiet week.
   ========================================================================= */
import { randomId } from './auth.js';

/* Kinds are an allowlist so the dashboard can style and group them, and so a
   typo becomes a missing icon rather than a row nobody ever queries. */
export const KINDS = [
  'clock_in',
  'clock_out',
  'order',
  'message',
  'leave_request',
  'leave_decision',
  /* A customer is waiting for a person. The most time-critical kind on the
     list: the others describe something that already happened, this one is
     somebody sitting on the site right now with five minutes on the clock. */
  'chat'
];

/* Where the dashboard should go when one is clicked. Stored per row rather
   than derived from `kind` at render time, so adding a kind needs no change
   in account.js. */
const DEFAULT_LINK = {
  clock_in: 'team',
  clock_out: 'team',
  order: 'manage',
  message: 'inbox',
  leave_request: 'leave',
  leave_decision: 'leave',
  chat: 'support'
};

/* -------------------------------------------------------------------------
   Who gets told

   Staff are accounts on the company domain; administrators are a subset. The
   membership question is answered from the database rather than from
   ADMIN_EMAILS alone, because an account promoted with role='admin' has to
   receive things too — the same two-ways-to-be-an-admin rule lib/auth.js
   already documents.
   ------------------------------------------------------------------------- */
export async function staffRecipients(d1, domain) {
  try {
    const { results } = await d1.prepare(
      `SELECT id, email, name, role FROM users
        WHERE lower(email) LIKE ?1`
    ).bind('%@' + String(domain).toLowerCase()).all();
    return results || [];
  } catch (err) {
    console.error('notify: could not list staff —', err && err.message);
    return [];
  }
}

export function adminsAmong(people, adminEmailList) {
  const allow = new Set((adminEmailList || []).map((e) => String(e).toLowerCase()));
  return people.filter(
    (p) => String(p.role || '').toLowerCase() === 'admin' || allow.has(String(p.email || '').toLowerCase())
  );
}

/* -------------------------------------------------------------------------
   Writing

   One row per recipient, in a single batch. A batch is one round trip for
   the whole fan-out, which matters because this runs on the clock-in path
   that a person is standing there waiting for — even inside waitUntil, four
   sequential inserts is four times the work for no benefit.
   ------------------------------------------------------------------------- */
export async function notify(d1, recipients, event) {
  const people = (recipients || []).filter(Boolean);
  if (!people.length) return 0;

  const kind = KINDS.includes(event.kind) ? event.kind : 'message';
  const link = event.link || DEFAULT_LINK[kind] || 'orders';
  const now = new Date().toISOString();

  try {
    const stmt = d1.prepare(
      `INSERT INTO notifications (id, user_id, kind, title, body, link, ref_id, read_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)`
    );
    await d1.batch(people.map((p) =>
      stmt.bind(
        randomId(12),
        p.id || p,
        kind,
        String(event.title || '').slice(0, 200),
        event.body ? String(event.body).slice(0, 600) : null,
        link,
        event.refId ? String(event.refId).slice(0, 80) : null,
        now
      )
    ));
    return people.length;
  } catch (err) {
    /* Non-fatal by design — see the header. Logged, because a notification
       system that fails quietly is indistinguishable from one with nothing
       to say. */
    console.error('notify: insert failed for', kind, '—', err && err.message);
    return 0;
  }
}

/* -------------------------------------------------------------------------
   The events themselves

   Each one decides its own audience. They are written as separate functions
   rather than one with a switch because the audience is the interesting part
   and it differs: a clock-in goes to the administrators, an order goes to
   everyone who might act on it, and a leave decision goes to one person.
   ------------------------------------------------------------------------- */

/* A shift started or ended.

   Administrators only. Sending it to the whole team would mean two moderators
   being told about each other's hours every morning, which is noise for them
   and an oddly surveillant thing to build for a team of four. The person who
   clocked in is not told either — they just did it. */
export async function notifyClock(d1, admins, actor, action, at) {
  const isIn = action === 'in';
  return notify(d1, admins.filter((a) => a.id !== actor.id), {
    kind: isIn ? 'clock_in' : 'clock_out',
    title: isIn ? `${actor.name} clocked in` : `${actor.name} clocked out`,
    body: at ? `at ${at}` : '',
    refId: actor.id,
    link: 'team'
  });
}

/* A new order. Everyone on the domain, because any of them may be the one to
   pick up the phone — this is a four-person team, not a routed queue. The
   WhatsApp alert in lib/whatsapp.js still fires independently; this is the
   copy that survives a WhatsApp outage and is still there tomorrow. */
export async function notifyOrder(d1, staff, order) {
  /* "Not paid yet" is on the alert rather than a click away because it is
     now the first thing anybody needs to know about a new order: the shop
     takes no cash on delivery, so an order is a promise to pay on WhatsApp
     until somebody confirms the money landed. Omitted for a paid one — a
     notification that says the ordinary case out loud teaches people to stop
     reading it. */
  const unpaid = order.paymentStatus && order.paymentStatus !== 'paid';
  return notify(d1, staff, {
    kind: 'order',
    title: `New order ${order.id}`,
    body: `${order.name} · ${order.governorate} · ${order.total} EGP${unpaid ? ' · not paid yet' : ''}`,
    refId: order.id,
    link: 'manage'
  });
}

/* Somebody asked for time off. Administrators decide, so they are told. */
export async function notifyLeaveRequest(d1, admins, actor, request) {
  const what = request.kind === 'sick' ? 'sick leave' : 'vacation';
  return notify(d1, admins, {
    kind: 'leave_request',
    title: `${actor.name} requested ${what}`,
    body: `${request.start_date} → ${request.end_date} · ${request.days} day${request.days === 1 ? '' : 's'}`,
    refId: request.id,
    link: 'leaveAdmin'
  });
}

/* It was answered. Only the person who asked is told. */
export async function notifyLeaveDecision(d1, userId, request) {
  return notify(d1, [{ id: userId }], {
    kind: 'leave_decision',
    title: `Your ${request.kind === 'sick' ? 'sick leave' : 'vacation'} was ${request.status}`,
    body: `${request.start_date} → ${request.end_date}${request.decision_note ? ' · ' + request.decision_note : ''}`,
    refId: request.id,
    link: 'leave'
  });
}

/* A message arrived. */
export async function notifyMessage(d1, toId, fromName, subject) {
  return notify(d1, [{ id: toId }], {
    kind: 'message',
    title: `Message from ${fromName}`,
    body: String(subject || '').slice(0, 200),
    link: 'inbox'
  });
}
