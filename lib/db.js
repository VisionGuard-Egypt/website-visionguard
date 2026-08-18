/* =========================================================================
   D1 access.

   The schema is applied lazily, once per isolate, so a brand-new database
   works on first request without anyone remembering to run a migration. The
   statements are all IF NOT EXISTS, so this is idempotent and cheap; the
   module-level flag keeps it to one batch per isolate rather than one per
   request.
   ========================================================================= */
import { ApiError } from './util.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     phone TEXT,
     pw_hash TEXT NOT NULL,
     google_sub TEXT,
     firebase_uid TEXT,
     role TEXT NOT NULL DEFAULT 'customer',
     marketing INTEGER NOT NULL DEFAULT 0,
     newsletter INTEGER NOT NULL DEFAULT 0,
     terms_at TEXT,
     lang TEXT NOT NULL DEFAULT 'ar',
     created_at TEXT NOT NULL,
     last_login_at TEXT,
     /* Relative path into /assets/avatars/, or NULL. The bytes live in KV;
        see lib/avatars.js for why the filename is a random token rather
        than the user id. */
     avatar TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY,
     user_id TEXT,
     name TEXT NOT NULL,
     phone TEXT NOT NULL,
     phone_alt TEXT,
     email TEXT,
     governorate TEXT NOT NULL,
     address TEXT NOT NULL,
     notes TEXT,
     payment TEXT NOT NULL DEFAULT 'transfer',
     /* Where the MONEY is: pending | paid | failed. A separate axis from the
        status column, which is where the parcel is — see the note in
        lib/orders.js for why folding the two together does not work. Every
        order starts pending: the shop takes no card and no cash on delivery,
        so nothing is paid for at the moment it is placed — the transfer is
        arranged on WhatsApp afterwards. */
     payment_status TEXT NOT NULL DEFAULT 'pending',
     items TEXT NOT NULL,
     subtotal INTEGER NOT NULL,
     shipping INTEGER NOT NULL DEFAULT 0,
     total INTEGER NOT NULL,
     currency TEXT NOT NULL DEFAULT 'EGP',
     status TEXT NOT NULL DEFAULT 'new',
     lang TEXT NOT NULL DEFAULT 'ar',
     notified INTEGER NOT NULL DEFAULT 0,
     notify_error TEXT,
     ip TEXT,
     created_at TEXT NOT NULL,
     /* The first-order discount, recorded on the order rather than in a
        redemptions table. The order IS the redemption — there is nothing a
        separate table could say that this does not, and one fewer place for
        the two to disagree about whether a code was used. The discount is
        whole EGP and is already subtracted from the total. */
     discount_code TEXT,
     discount INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS attendance (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     work_date TEXT NOT NULL,
     clock_in TEXT NOT NULL,
     clock_out TEXT,
     seconds INTEGER,
     in_ip TEXT,
     out_ip TEXT,
     note TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_att_user_date ON attendance (user_id, work_date DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_att_open ON attendance (user_id) WHERE clock_out IS NULL`,
  `CREATE TABLE IF NOT EXISTS newsletter (
     email TEXT PRIMARY KEY,
     name TEXT,
     marketing INTEGER NOT NULL DEFAULT 0,
     source TEXT,
     lang TEXT NOT NULL DEFAULT 'ar',
     created_at TEXT NOT NULL,
     unsub_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS meta_events (
     id TEXT PRIMARY KEY,
     event TEXT NOT NULL,
     event_id TEXT,
     source_url TEXT,
     value INTEGER,
     currency TEXT,
     user_id TEXT,
     external_id TEXT,
     email TEXT,
     phone TEXT,
     client_ip TEXT,
     user_agent TEXT,
     created_at TEXT NOT NULL,
     /* Which products the event was about, as a JSON array of product ids —
        e.g. ["imou-3mp"]. This is what turns "412 ViewContent events" into
        "3 views of the Imou 3MP", which is the only form of that number
        anyone can act on. Always valid JSON or NULL; functions/api/capi.js
        is the sole writer and guarantees it, because the per-product query
        in admin/stats.js runs json_each over this column. */
     content_ids TEXT,
     /* The product name as it was at the time, so the report can name a
        product that has since been renamed or deleted. */
     content_name TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_meta_events_created ON meta_events (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_meta_events_event ON meta_events (event, created_at DESC)`,
  /* The catalogue. Seeded from public/catalog.js, which stays the fallback
     until every read path is switched over — see lib/products.js. Money is
     whole EGP, as everywhere else in this schema. */
  `CREATE TABLE IF NOT EXISTS products (
     id TEXT PRIMARY KEY,
     cat TEXT NOT NULL,
     brand TEXT,
     name TEXT NOT NULL,
     ar TEXT,
     en TEXT,
     img TEXT,
     price INTEGER NOT NULL,
     was INTEGER NOT NULL DEFAULT 0,
     sort INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_products_cat ON products (cat, sort)`,
  /* How each group of products is PRESENTED — its two labels, its two
     blurbs, the product whose photograph represents it, its position and
     whether it is shown at all.

     It does NOT own which products belong to it: that is products.cat, and
     it stays there. Hiding a category here hides the homepage card and the
     shop's filter chip; the products remain reachable by search and by
     direct link, and remain buyable. Withdrawing a product is a separate
     act with its own switch.

     `cover` is a PRODUCT ID rather than a path, deliberately. The homepage
     cards used to hard-code an image each, so replacing a product photo in
     the admin updated the shop and left the front page on the old picture
     with nothing linking the two. Naming the product means the card takes
     that product's current image and the two cannot disagree. `img` remains
     as the fallback for first paint and for a cover that no longer
     resolves. See lib/categories.js. */
  `CREATE TABLE IF NOT EXISTS categories (
     id TEXT PRIMARY KEY,
     ar TEXT NOT NULL,
     en TEXT NOT NULL,
     img TEXT,
     cover TEXT,
     blurb_ar TEXT,
     blurb_en TEXT,
     sort INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories (sort, id)`,
  `CREATE TABLE IF NOT EXISTS rate (
     k TEXT PRIMARY KEY,
     n INTEGER NOT NULL,
     reset_at INTEGER NOT NULL
   )`,

  /* ---------------------------------------------------------------------
     PROMO CODES an administrator issues by hand.

     Distinct from the welcome offer, which is a rule in lib/coupon.js and
     has no row anywhere: it applies to whoever qualifies and nobody has to
     create it. These are the ones somebody decides on — a campaign for a
     week, or ten per cent for a customer they know.

     THE CODE IS THE PRIMARY KEY, stored normalised (upper case, no spaces),
     so `vip 20` and `VIP20` cannot become two rows that quietly mean
     different things.

     EVERY LIMIT LIVES ON THE ROW. A code will be forwarded, screenshotted
     and posted in a group chat within the hour of being issued — that is
     what codes are for — so what protects the shop is not secrecy but the
     window, the use count and the new-customer check, all of them enforced
     server-side in lib/promos.js against these columns.

     `uses` is a counter, not a log. Who redeemed it is answerable from
     orders.discount_code, which is where the money actually is; a second
     table recording the same event is one more thing to disagree with it.
     --------------------------------------------------------------------- */
  `CREATE TABLE IF NOT EXISTS promos (
     code TEXT PRIMARY KEY,
     /* Exactly one of these is set. Percent is capped in lib/promos.js;
        amount is whole EGP off the subtotal. */
     percent INTEGER NOT NULL DEFAULT 0,
     amount INTEGER NOT NULL DEFAULT 0,
     /* ISO 8601, or NULL for "no bound that side". A code with neither is
        live from the moment it is created until somebody stops it. */
     starts_at TEXT,
     ends_at TEXT,
     /* Whether it is for people who have never ordered — the "for new
        sign-ups" switch on the admin form. Checked against account, phone
        and email, the same three identities the welcome offer uses. */
     new_only INTEGER NOT NULL DEFAULT 1,
     min_subtotal INTEGER NOT NULL DEFAULT 0,
     /* 0 means unlimited. Anything else is a hard stop, enforced in the
        UPDATE that increments the counter so two orders in the same second
        cannot both take the last one. */
     max_uses INTEGER NOT NULL DEFAULT 0,
     uses INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     note TEXT,
     created_by TEXT,
     created_at TEXT NOT NULL
   )`,
  /* The admin list is "newest first"; there will never be enough rows for
     this to matter, and it costs nothing to be right. */
  `CREATE INDEX IF NOT EXISTS idx_promos_created ON promos (created_at DESC)`,

  /* ---------------------------------------------------------------------
     In-app notifications.

     One row per RECIPIENT, not one per event: "someone clocked in" is one
     thing that happened and three people who need telling, and giving each
     of them their own row is what makes "read" mean anything. A shared row
     with a list of who has seen it is the same data with a join and a
     concurrent-update problem attached.

     `link` is where the dashboard should go when the notification is
     clicked, as a tab name. Storing a destination rather than deriving one
     from `kind` means a new kind needs no change on the reading side.
     --------------------------------------------------------------------- */
  `CREATE TABLE IF NOT EXISTS notifications (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT,
     link TEXT,
     ref_id TEXT,
     read_at TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, created_at DESC)`,
  /* The unread badge is the most frequent read on the whole dashboard — it
     runs on every page load for every signed-in member of staff. */
  `CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications (user_id, read_at)`,

  /* ---------------------------------------------------------------------
     Internal messages between the team. Not email: nothing leaves the site,
     which is why there is no provider, no API key and no deliverability to
     worry about. See functions/api/messages.js.
     --------------------------------------------------------------------- */
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     from_id TEXT NOT NULL,
     to_id TEXT NOT NULL,
     subject TEXT,
     body TEXT NOT NULL,
     read_at TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_msg_to ON messages (to_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_from ON messages (from_id, created_at DESC)`,

  /* ---------------------------------------------------------------------
     Sick leave and vacation requests. One table, two kinds — see lib/leave.js
     for why they are counted the same way and capped differently.

     `days` is STORED rather than recomputed from the dates on read. The
     number of days a request cost is a fact about the moment it was made,
     and it is what the balance is summed from; recomputing it later would
     silently restate somebody's history if the counting rule ever changed.

     `cert_key` is a KV key, not a URL. A sick note is medical information
     about an employee, so the bytes live behind an endpoint that checks who
     is asking — see functions/api/leave/certificate.js. There is
     deliberately no public path to them, unlike product images.
     --------------------------------------------------------------------- */
  `CREATE TABLE IF NOT EXISTS leave_requests (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     start_date TEXT NOT NULL,
     end_date TEXT NOT NULL,
     days INTEGER NOT NULL,
     note TEXT,
     cert_key TEXT,
     cert_name TEXT,
     cert_type TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     decided_by TEXT,
     decided_at TEXT,
     decision_note TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests (user_id, start_date DESC)`,
  /* The administrator's queue: everything still pending, oldest first. */
  `CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests (status, created_at)`,

  /* ---------------------------------------------------------------------
     LEADS — people who have not ordered yet, or have and are being looked
     after.

     Deliberately NOT the users table. A `users` row is an account with a
     password and a session; a lead is somebody who rang up, and most of them
     will never have an account. Forcing them into `users` would mean either
     inventing credentials nobody asked for or filling that table with rows
     that can never sign in — and either way the sign-in path would then have
     to defend against them.

     `phone` is the identity in practice, because it is the one thing every
     caller gives and the thing an order is chased on. It is stored in the
     same normalised E.164-without-plus form lib/util.js produces for orders,
     so a lead and their order can actually be matched to each other rather
     than merely looking similar.
     --------------------------------------------------------------------- */
  `CREATE TABLE IF NOT EXISTS leads (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     phone TEXT NOT NULL,
     email TEXT,
     governorate TEXT,
     source TEXT,
     status TEXT NOT NULL DEFAULT 'new',
     interest TEXT,
     order_id TEXT,
     owner_id TEXT,
     created_by TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT
   )`,
  /* The board is read by status, newest first, which is exactly how it is
     drawn on screen. */
  `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status, updated_at DESC)`,
  /* Looking somebody up by the number they are calling from is the single
     most common thing anyone will do with this table. */
  `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone)`,

  /* Notes are APPENDED, never overwritten.

     "Update the customer's note" could have been one editable column, and
     that is the version that loses information: two people looking after the
     same customer would take turns erasing each other, and nobody could tell
     what was said when, or by whom. A timeline costs one more table and
     answers "what happened with this person" — which is the only question a
     leads centre exists to answer. */
  `CREATE TABLE IF NOT EXISTS lead_notes (
     id TEXT PRIMARY KEY,
     lead_id TEXT NOT NULL,
     author_id TEXT,
     body TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'note',
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_lead_notes ON lead_notes (lead_id, created_at DESC)`,

  /* ---------------------------------------------------------------------
     LIVE CHAT — when the assistant is not enough and a person is wanted.

     The bot in functions/api/assist.js is stateless on purpose: the browser
     keeps the thread and nothing is stored. A human handover cannot work
     that way — two people need to see the same conversation from two
     devices — so the moment a customer asks for a person, the thread gets a
     row here and carries on server-side.

     `id` IS THE CAPABILITY. A customer is not signed in and has no account,
     so the session id is what proves the browser owns the conversation. It
     is 32 hex characters from crypto.getRandomValues, it is never listed by
     any endpoint a customer can reach, and it is the only thing that
     authorises reading or writing the thread. Treat it like a password: it
     must never be logged or put in a URL that could be shared.

     THE ROTATION LIVES IN COLUMNS, NOT IN A TIMER. Cloudflare Pages has no
     scheduled handler, so there is nothing to run a five-minute alarm.
     `offer_expires_at` is a DEADLINE instead: any request that touches the
     queue rolls expired offers on to the next employee. Both sides poll
     while a chat is waiting, so the deadline is evaluated far more often
     than once a minute without a single background job existing.

     `offered_ids` is the JSON list of everyone already asked, which is what
     stops the rotation handing the same chat back to somebody who has
     already let it lapse.
     --------------------------------------------------------------------- */
  `CREATE TABLE IF NOT EXISTS chat_sessions (
     id TEXT PRIMARY KEY,
     name TEXT,
     phone TEXT,
     page TEXT,
     status TEXT NOT NULL DEFAULT 'waiting',
     agent_id TEXT,
     offered_to TEXT,
     offer_expires_at TEXT,
     offered_ids TEXT NOT NULL DEFAULT '[]',
     lead_id TEXT,
     answered_at TEXT,
     closed_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT
   )`,
  /* The queue sweep: everything still waiting, oldest first. */
  `CREATE INDEX IF NOT EXISTS idx_chat_waiting ON chat_sessions (status, created_at)`,
  /* "How many did each of us answer" — see /api/support?stats=1. */
  `CREATE INDEX IF NOT EXISTS idx_chat_agent ON chat_sessions (agent_id, answered_at)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     role TEXT NOT NULL,
     body TEXT NOT NULL,
     author_id TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages ON chat_messages (session_id, created_at)`
];

/* dm_threads and dm_messages — the Meta social inbox — were added here and
   then removed again. They are deliberately NOT dropped: a DROP TABLE in this
   list would run against every database that has them, and they may hold real
   conversations on a deployment that ran the version in between. An unused
   table costs nothing; deleting messages to tidy a schema is not a trade
   worth making. They are gone from EXPECTED_TABLES, so schemaReady() no
   longer looks for them.

   NOTE that the `messages` table above is a different thing entirely and
   stays: that is internal mail between employees, it never leaves the site,
   and it needs no Meta token of any kind. Only the Meta half went. */

/* Statements that change a table that already exists. The DDL above is all
   CREATE ... IF NOT EXISTS, which is idempotent but also inert: it will not
   add a column to a `users` table that was created before that column
   existed. These run after it, each one allowed to fail.

   "allowed to fail" is the whole design. SQLite has no ADD COLUMN IF NOT
   EXISTS, so the second time this runs it errors with "duplicate column
   name" — which means the migration is already applied, which is success.
   Anything else is logged and skipped rather than taking the site down,
   because a Worker that cannot boot is worse than one missing a column. */
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN google_sub TEXT`,
  /* NULLs do not collide in a SQLite unique index, so password-only accounts
     are unaffected; this only stops one Google identity being attached to
     two rows. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users (google_sub)`,
  /* Firebase Auth is the credential authority; this is the join to it. Same
     reasoning as google_sub: the uid is stable, an email address is not, so
     the uid is what gets stored and indexed. */
  `ALTER TABLE users ADD COLUMN firebase_uid TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase ON users (firebase_uid)`,
  /* Per-product event counting. meta_events predates these two, so every
     database that already has the table needs them added rather than created
     — and EXPECTED_META_EVENT_COLUMNS below has to list them, or schemaReady()
     answers "ready" and this never runs. */
  `ALTER TABLE meta_events ADD COLUMN content_ids TEXT`,
  `ALTER TABLE meta_events ADD COLUMN content_name TEXT`,
  /* Whether this person has allowed desktop notifications, as the BROWSER
     last reported it: 'granted', 'denied' or 'default'.

     Recorded server-side rather than left in the browser because the point of
     it is the question "who on the team has not turned these on yet", and
     that is a question about people, not about one device's localStorage. It
     is a report of a browser state, never the thing that grants it — see the
     note in public/account-staff.js about why permission cannot be forced. */
  `ALTER TABLE users ADD COLUMN push_optin TEXT`,
  `ALTER TABLE users ADD COLUMN push_optin_at TEXT`,
  /* The first-order discount. Every existing order predates it, and NOT NULL
     DEFAULT 0 is what makes that mean "no discount" rather than NULL — the
     eligibility query in lib/coupon.js counts `discount > 0`, and NULL would
     silently never match. */
  `ALTER TABLE orders ADD COLUMN discount_code TEXT`,
  `ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0`,
  /* Payment state, added when cash on delivery was withdrawn. Every order
     that predates it was a cash-on-delivery order that has either been
     delivered and paid for or cancelled, and neither of those is 'pending' —
     but 'pending' is still the honest default here, because this migration
     cannot tell which. The back office can correct any that matter; guessing
     'paid' would silently assert money arrived that nobody checked for. */
  `ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending'`,
  /* Profile pictures. Every existing account predates them and NULL is the
     correct "no picture" — the account page draws initials for it. */
  `ALTER TABLE users ADD COLUMN avatar TEXT`
];

async function migrate(d1) {
  for (const sql of MIGRATIONS) {
    try {
      await d1.prepare(sql).run();
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (/duplicate column name/i.test(msg)) continue;   // already applied
      console.error('migration skipped:', sql.slice(0, 60), msg);
    }
  }
}

/* -------------------------------------------------------------------------
   Is the schema already there?

   WHY THIS EXISTS. The DDL above is idempotent, so running it on every cold
   isolate is harmless — but it is not free. It is 8 statements plus up to 5
   migrations, and a Worker isolate is created per burst of traffic, not per
   deploy. Under load that meant every new isolate spent thirteen D1 round
   trips before it could answer the request it was actually woken for, on all
   eleven endpoints that touch the database. Measured against production at
   100 concurrent requests, /api/auth/me had a p95 of 2.2s while a static
   asset over the same burst stayed at 0.38s.

   So the healing is kept and the cost is not: one statement establishes
   whether anything needs doing, and the thirteen only run against a database
   that genuinely lacks something.

   The check has to cover BOTH halves or it is worse than useless. Looking
   only for tables would pass a database created before firebase_uid existed
   — every table present, one column missing — and skip the migration that
   adds it, which is a broken sign-in that heals itself in staging and not in
   production. So it counts tables and the columns the migrations add, in a
   single round trip.

   Adding a table or a migration means adding it here too. That coupling is
   the price of the check, and it is why both lists are written out rather
   than derived. */
const EXPECTED_TABLES = [
  'users', 'orders', 'attendance', 'newsletter', 'rate', 'products', 'meta_events',
  /* Adding a table above WITHOUT adding it here is the failure this list
     exists to prevent: schemaReady() would keep answering "yes" on a database
     that predates it, the DDL batch would never run, and the new feature
     would fail on production and nowhere else. */
  'notifications', 'messages', 'leave_requests', 'leads', 'lead_notes',
  'chat_sessions', 'chat_messages',
  /* Admin-issued discount codes. Listed here for the reason the comment
     above gives: without it schemaReady() answers "yes" on every database
     that predates the table, the DDL never runs, and the promos tab fails
     on production and nowhere else. */
  'promos',
  /* Presentation of the product groups — see the DDL above. Listed here for
     exactly the reason the comment two lines up gives: without it,
     schemaReady() would answer yes on every database that predates the
     table, migrate() would never run, and the categories tab would fail on
     production and nowhere else. */
  'categories'
];
const EXPECTED_USER_COLUMNS = ['google_sub', 'firebase_uid', 'push_optin', 'push_optin_at', 'avatar'];
/* Every table a migration adds a column to needs its own line here. Miss one
   and the failure is the quiet kind this check was built to prevent: the
   table exists, the users columns exist, so schemaReady() says yes, migrate()
   never runs, and the new column is missing forever on exactly the databases
   that already had data — production, and nowhere else. */
const EXPECTED_META_EVENT_COLUMNS = ['content_ids', 'content_name'];
/* The orders table gained two columns for the first-order discount. Without
   this line the trap above fires exactly as described: every table present,
   the users and meta_events columns present, so schemaReady() answers yes,
   migrate() never runs, and checkout writes to a discount column that does
   not exist — on production, and nowhere else, because a fresh database gets
   them from the DDL. */
const EXPECTED_ORDER_COLUMNS = ['discount_code', 'discount', 'payment_status'];

async function schemaReady(d1) {
  try {
    const row = await d1.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sqlite_master
           WHERE type = 'table' AND name IN (${EXPECTED_TABLES.map((n) => `'${n}'`).join(',')})) AS tables,
         (SELECT COUNT(*) FROM pragma_table_info('users')
           WHERE name IN (${EXPECTED_USER_COLUMNS.map((n) => `'${n}'`).join(',')})) AS cols,
         (SELECT COUNT(*) FROM pragma_table_info('meta_events')
           WHERE name IN (${EXPECTED_META_EVENT_COLUMNS.map((n) => `'${n}'`).join(',')})) AS eventCols,
         (SELECT COUNT(*) FROM pragma_table_info('orders')
           WHERE name IN (${EXPECTED_ORDER_COLUMNS.map((n) => `'${n}'`).join(',')})) AS orderCols`
    ).first();
    return !!row &&
      row.tables === EXPECTED_TABLES.length &&
      row.cols === EXPECTED_USER_COLUMNS.length &&
      row.eventCols === EXPECTED_META_EVENT_COLUMNS.length &&
      row.orderCols === EXPECTED_ORDER_COLUMNS.length;
  } catch (err) {
    /* A brand-new database has no sqlite_master rows to read and pragma on a
       missing table can throw. Either way the answer is "not ready". */
    return false;
  }
}

let ready = null;

export function getDb(env) {
  if (!env || !env.DB) {
    throw new ApiError(
      503, 'no_database',
      'The database is not connected yet. Create a D1 database and bind it as DB — see README.'
    );
  }
  return env.DB;
}

export async function db(env) {
  const d1 = getDb(env);
  if (!ready) {
    ready = (async () => {
      /* The common case, and the whole point: one round trip, then straight
         on to the query this request was actually made for. */
      if (await schemaReady(d1)) return;
      await d1.batch(DDL.map((sql) => d1.prepare(sql)));
      await migrate(d1);
    })().catch((err) => { ready = null; throw err; });
  }
  await ready;
  return d1;
}

/* -------------------------------------------------------------------------
   Fixed-window rate limit.

   Keyed by action + identity (IP, or email for credential stuffing). Fails
   OPEN: if the counter itself errors we would rather take the request than
   lock every customer out of checkout because one table misbehaved.
   ------------------------------------------------------------------------- */
export async function rateLimit(d1, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const reset = now + windowSec;
  try {
    const row = await d1.prepare(
      `INSERT INTO rate (k, n, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(k) DO UPDATE SET
         n        = CASE WHEN rate.reset_at <= ?3 THEN 1   ELSE rate.n + 1     END,
         reset_at = CASE WHEN rate.reset_at <= ?3 THEN ?2  ELSE rate.reset_at  END
       RETURNING n, reset_at`
    ).bind(key, reset, now).first();
    if (!row) return { ok: true, retryAfter: 0 };
    return { ok: row.n <= max, retryAfter: Math.max(1, row.reset_at - now) };
  } catch (err) {
    console.error('rateLimit', err && err.message);
    return { ok: true, retryAfter: 0 };
  }
}

export async function enforceRate(d1, key, max, windowSec) {
  const r = await rateLimit(d1, key, max, windowSec);
  if (!r.ok) {
    throw new ApiError(
      429, 'rate_limited',
      'Too many attempts. Please wait a moment and try again.',
      { retryAfter: r.retryAfter }
    );
  }
}
