/* =========================================================================
   Leads.

   A lead is somebody who has been in touch and has not necessarily bought
   anything. Most of them will never have an account, which is precisely why
   they are not `users` rows — see the note on the table in lib/db.js.

   WHAT THIS FILE IS FOR
   ---------------------
   The shapes and the rules, with no HTTP in them, so they can be tested
   without a request. functions/api/leads.js turns the reasons below into
   ApiErrors; the same split lib/leave.js uses.
   ========================================================================= */

/* The pipeline, in order. Order matters: the board draws the columns in this
   sequence, and `won`/`lost` being last is what puts the finished ones at the
   end rather than in the middle of the live work. */
export const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'];

/* Statuses that mean the lead is finished with, either way. Used to keep them
   out of the default board without deleting anything — a lost lead is the
   most useful record there is when the same number rings again. */
export const CLOSED_STATUSES = ['won', 'lost'];

/* Where they came from. An open text field would give five spellings of
   "instagram" within a month, and then the question "which channel is
   working" becomes unanswerable — which is the main question this list
   exists to make answerable. `other` is there so nobody has to lie. */
export const LEAD_SOURCES = ['whatsapp', 'phone', 'instagram', 'facebook', 'website', 'walk_in', 'referral', 'other'];

/* A note is either something a person typed, or a record of something the
   system did. Both go in the same timeline because reading it as one story is
   the point; `kind` is what lets the two be told apart when drawing it. */
export const NOTE_KINDS = ['note', 'status', 'order', 'created'];

export const MAX_NOTE = 2000;

export const isStatus = (v) => LEAD_STATUSES.includes(v);
export const isSource = (v) => LEAD_SOURCES.includes(v);

/* What the browser is allowed to see. Built explicitly rather than by
   spreading the row, so a column added later is not published by accident —
   the same reason publicOrder() in lib/orders.js is written out. */
export function publicLead(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email || '',
    governorate: row.governorate || '',
    source: row.source || '',
    status: row.status,
    interest: row.interest || '',
    orderId: row.order_id || '',
    ownerId: row.owner_id || '',
    ownerName: row.owner_name || '',
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    /* Filled in by the endpoint when a single lead is opened. */
    notes: Array.isArray(row.notes) ? row.notes : undefined,
    noteCount: typeof row.note_count === 'number' ? row.note_count : undefined
  };
}

export function publicNote(row) {
  return {
    id: row.id,
    body: row.body,
    kind: row.kind || 'note',
    authorId: row.author_id || '',
    authorName: row.author_name || '',
    createdAt: row.created_at
  };
}

/* The sentence written into the timeline when something changes.

   Composed here rather than at the call site so every one of them reads the
   same way, and so the timeline stays legible when it is the only record of
   who did what. */
export function statusNote(from, to, byName) {
  return `${byName || 'Someone'} moved this from ${from} to ${to}`;
}

export function orderNote(orderId, byName) {
  return `${byName || 'Someone'} linked order ${orderId}`;
}

export function confirmNote(orderId, status, byName) {
  return `${byName || 'Someone'} set order ${orderId} to ${status}`;
}

/* Money is the one thing on this timeline somebody will be asked to account
   for later, so the line says who recorded it as well as what it says now.
   "It says paid and nobody knows who marked it paid" is exactly the argument
   this note exists to prevent. */
export function paymentNote(orderId, status, byName) {
  return `${byName || 'Someone'} marked order ${orderId} as ${status}`;
}

/* =========================================================================
   EVERY ORDER BECOMES A LEAD

   Somebody who has just spent money is the single most valuable person to
   follow up with, and until now an order left no trace on the board at all —
   the leads centre only knew about people an employee had typed in by hand.
   So every checkout now writes one, and the board becomes the whole list of
   people to talk to rather than the subset somebody remembered to add.

   THE PHONE IS THE IDENTITY, as it is everywhere else in this table. A
   returning customer must not become a second row: two employees would then
   be looking after the same person from two different cards, each unaware of
   the other's notes — which is exactly the failure the duplicate check in
   /api/leads was built to prevent, and it would be silly to reintroduce it
   from the back door.

   THE LEAD IS 'new', NOT 'won'. `won` is a closed status: it drops off the
   default board, which is the opposite of what "so we can follow up" asks
   for. It becomes `won` when an employee confirms the order, which is
   already what /api/leads does.

   A REORDER REOPENS A CLOSED LEAD. Somebody marked `lost` who has just
   bought something is the most interesting row on the board, and leaving
   them closed is how that gets missed.
   ========================================================================= */

/* The timeline line. Pure, so the wording is pinned by a test rather than by
   whoever reads the board next. */
export function orderLeadNote(orderId, total, currency) {
  const money = Number(total) || 0;
  return `Ordered ${orderId} — ${money} ${currency || 'EGP'} from the website`;
}

/* Whether an order should reopen the lead it landed on. */
export const reopensLead = (status) => CLOSED_STATUSES.includes(status);

/* Writes the lead and its note. Returns what happened, for the log.

   NEVER THROWS AT THE CALL SITE — see functions/api/orders.js, which invokes
   this through waitUntil with its own catch. An order is the thing this shop
   exists for and a bookkeeping row must never be able to cost one. The
   caller owns that guarantee; this function is free to be ordinary. */
export async function leadFromOrder(d1, order, newId) {
  const now = new Date().toISOString();
  const note = orderLeadNote(order.id, order.total, order.currency);

  const existing = await d1.prepare(
    'SELECT id, status, order_id FROM leads WHERE phone = ?1 LIMIT 1'
  ).bind(order.phone).first();

  if (existing) {
    await d1.prepare(
      `UPDATE leads
          SET status     = CASE WHEN status IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(',')})
                                THEN 'new' ELSE status END,
              /* The newest order wins the link: it is the one being chased. */
              order_id   = ?2,
              /* Only fill blanks. An employee who corrected a misspelled name
                 or picked a governorate by hand must not be overwritten by
                 whatever the checkout form happened to contain. */
              email      = COALESCE(NULLIF(email, ''), ?3),
              governorate= COALESCE(NULLIF(governorate, ''), ?4),
              updated_at = ?5
        WHERE id = ?1`
    ).bind(existing.id, order.id, order.email || null, order.governorate || null, now).run();
    return { leadId: existing.id, created: false, reopened: reopensLead(existing.status), note };
  }

  await d1.prepare(
    `INSERT INTO leads
       (id, name, phone, email, governorate, source, status, interest,
        order_id, owner_id, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'website', 'new', NULL, ?6, NULL, NULL, ?7, ?7)`
  ).bind(newId, order.name, order.phone, order.email || null, order.governorate || null, order.id, now).run();

  return { leadId: newId, created: true, reopened: false, note };
}
