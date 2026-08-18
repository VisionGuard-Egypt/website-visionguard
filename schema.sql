-- =========================================================================
-- Vision Guard — D1 schema
--
-- You do not have to run this by hand: lib/db.js applies the same statements
-- once per Worker isolate, so a fresh database heals itself on first request.
-- It is kept here so the shape is reviewable, and so you can run it against a
-- new database up front:
--
--   npx wrangler d1 execute visionguard --remote --file=./schema.sql
--
-- Money is stored in whole Egyptian pounds as INTEGER. The catalogue has no
-- piastres in it, and integers cannot drift the way floats do.
-- =========================================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,          -- always lowercased before write
  name          TEXT NOT NULL,
  phone         TEXT,                          -- E.164 without '+', e.g. 201012345678
  pw_hash       TEXT NOT NULL,                 -- pbkdf2$<iters>$<saltB64>$<hashB64>,
                                               -- or the GOOGLE_ONLY_PW sentinel for an
                                               -- account that only signs in with Google
  google_sub    TEXT,                          -- Google's stable account id; NULL until linked
  firebase_uid  TEXT,                          -- Firebase Auth uid — the credential authority.
                                               -- Stable for the life of the account; an email
                                               -- address is not, so this is the join key.
  role          TEXT NOT NULL DEFAULT 'customer',  -- 'customer' | 'staff' | 'admin'
                                               -- 'admin' additionally reads every
                                               -- employee's attendance. Created only by
                                               -- scripts/create-admin.mjs; the signup form
                                               -- refuses the administrator addresses.
  marketing     INTEGER NOT NULL DEFAULT 0,
  newsletter    INTEGER NOT NULL DEFAULT 0,
  terms_at      TEXT,                          -- when the required consent was given
  lang          TEXT NOT NULL DEFAULT 'ar',
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  -- Relative path into /assets/avatars/, or NULL. The bytes are in KV and the
  -- filename is a random token rather than the user id, so the URL is
  -- unguessable and cannot be used to confirm an account exists.
  avatar        TEXT
);
-- One Google identity, one account. NULLs do not collide in SQLite, so every
-- password-only account is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users (google_sub);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase ON users (firebase_uid);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,               -- human order number, e.g. VG-260731-K3QX
  user_id      TEXT,                           -- null for guest checkout
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  phone_alt    TEXT,
  email        TEXT,
  governorate  TEXT NOT NULL,
  address      TEXT NOT NULL,
  notes        TEXT,
  payment      TEXT NOT NULL DEFAULT 'transfer', -- 'transfer' only; 'cod' on legacy rows
  -- Where the MONEY is, as opposed to `status`, which is where the parcel is.
  -- The shop takes no card and no cash on delivery: an order is placed unpaid
  -- and the customer settles it on WhatsApp, so every row starts 'pending' and
  -- a person moves it to 'paid' or 'failed'.
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  items        TEXT NOT NULL,                  -- JSON array, priced server-side
  subtotal     INTEGER NOT NULL,
  shipping     INTEGER NOT NULL DEFAULT 0,     -- 0 = quoted on confirmation
  total        INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'EGP',
  status       TEXT NOT NULL DEFAULT 'new',    -- new | confirmed | shipped | done | cancelled
  lang         TEXT NOT NULL DEFAULT 'ar',
  notified     INTEGER NOT NULL DEFAULT 0,     -- 1 once WhatsApp accepted it
  notify_error TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL,
  -- The first-order discount, recorded on the order rather than in a
  -- redemptions table: the order IS the redemption. `discount` is whole EGP
  -- and is ALREADY subtracted from `total`, so total = subtotal - discount
  -- + shipping and no reader has to know the rule to get the right number.
  discount_code TEXT,                          -- 'WELCOME5', or NULL. Older rows may say 'WELCOME10'.
  discount      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);

-- One row per shift. A day can hold several — a break is a clock-out and a
-- clock-in, and the day's total is the sum of its rows.
CREATE TABLE IF NOT EXISTS attendance (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  work_date  TEXT NOT NULL,                    -- YYYY-MM-DD, Africa/Cairo, day the shift STARTED
  clock_in   TEXT NOT NULL,                    -- ISO 8601 UTC
  clock_out  TEXT,                             -- null while the shift is open
  seconds    INTEGER,                          -- filled on clock-out
  in_ip      TEXT,
  out_ip     TEXT,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_user_date ON attendance (user_id, work_date DESC);
-- At most one open shift per employee. A partial index is the cheapest way to
-- make a double clock-in impossible at the storage layer rather than only in
-- the handler.
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_open ON attendance (user_id) WHERE clock_out IS NULL;

CREATE TABLE IF NOT EXISTS newsletter (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  marketing  INTEGER NOT NULL DEFAULT 0,
  source     TEXT,                             -- 'signup' | 'footer' | 'checkout'
  lang       TEXT NOT NULL DEFAULT 'ar',
  created_at TEXT NOT NULL,
  unsub_at   TEXT
);

-- Event telemetry, used to power the admin performance panel. The event
-- relay already sends the payload to Meta; this table keeps the same event
-- record locally so admins can see network traffic, visitor counts and the
-- event mix without inventing a second tracking system.
CREATE TABLE IF NOT EXISTS meta_events (
  id           TEXT PRIMARY KEY,
  event        TEXT NOT NULL,
  event_id     TEXT,
  source_url   TEXT,
  value        INTEGER,
  currency     TEXT,
  user_id      TEXT,
  external_id  TEXT,
  email        TEXT,
  phone        TEXT,
  client_ip    TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_events_created ON meta_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meta_events_event ON meta_events (event, created_at DESC);

-- Fixed-window counters for login/signup/order abuse. Rows are self-expiring:
-- an entry whose reset_at has passed is reset in place on next use.
CREATE TABLE IF NOT EXISTS rate (
  k        TEXT PRIMARY KEY,
  n        INTEGER NOT NULL,
  reset_at INTEGER NOT NULL                    -- unix seconds
);
