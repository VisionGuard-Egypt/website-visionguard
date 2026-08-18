/* =========================================================================
   The first-order discount.

   ONE SHARED CODE, ELIGIBILITY PER ACCOUNT. There is a single code —
   WELCOME5 — and it is not a secret. Anybody can type it, print it, or
   post it in a group chat, and it still cannot be used twice, because what
   is checked is not the code but the `orders` table: has this person
   completed an order before?

   That is why per-user generated codes were not worth the machinery. A
   unique code per account is a second thing to store, mail, expire and
   support, and it buys nothing here — a leaked unique code is exactly as
   abusable as a leaked shared one once the eligibility check is the real
   control. Keep the control, drop the machinery.

   NOTHING THE BROWSER SENDS IS TRUSTED. /api/coupon exists so the cart can
   SHOW the discount before checkout, and its answer is advisory. The number
   that is charged is recomputed inside functions/api/orders.js from the
   server's own view of the catalogue and the orders table, in the same
   breath as the prices — exactly as lib/orders.js already refuses to trust
   a cart's prices.

   MONEY IS WHOLE EGYPTIAN POUNDS, as everywhere else in this schema, and
   the discount rounds DOWN. Rounding a discount up means charging less than
   the arithmetic says, which is a slow leak nobody would ever notice.
   ========================================================================= */

/* -------------------------------------------------------------------------
   IT IS TWO OFFERS, AND IT RUNS OUT.

   Ten per cent on the first day, five for the four after it, nothing on the
   sixth. The steeper number is there for the hour somebody is actually
   deciding — the day they signed up — and the gentler one keeps the week
   worth coming back for rather than ending the conversation at midnight.

   ORDER MATTERS. The list is read top down and the FIRST tier whose window
   still covers the account is the one that applies, so the tiers must run
   from shortest window to longest. Adding a middle tier is one line here and
   nothing anywhere else.

   MEASURED FROM users.created_at — a welcome offer, so it is measured from
   the welcome. Not a campaign with an end date: somebody who signs up next
   month gets their own day one, and there is no date in here for anybody to
   forget to move.

   TO THE HOUR, not in calendar days. Calendar days would hand somebody who
   signed up at eleven at night one hour of the ten per cent while the person
   who signed up at breakfast got a whole day, for no reason either of them
   could see. This way "you have today" and "you have five days" are true of
   everybody, and there is no timezone in arithmetic about money.

   The clock is the account row, which nothing in the product can change — a
   customer editing their profile cannot reset it, which is what makes this
   an expiry rather than a suggestion.
   ------------------------------------------------------------------------- */
export const WELCOME_TIERS = [
  { code: 'WELCOME10', percent: 10, hours: 24 },
  { code: 'WELCOME5', percent: 5, hours: 120 }
];

/* The headline offer — what a brand-new account gets, and what the signup
   popup announces. */
export const WELCOME_CODE = WELCOME_TIERS[0].code;
export const WELCOME_PERCENT = WELCOME_TIERS[0].percent;

/* The whole window, from the last tier. Everything below measures against
   this, so extending the offer means editing the tier and nothing else. */
export const WELCOME_WINDOW_MS = WELCOME_TIERS[WELCOME_TIERS.length - 1].hours * 3600000;
export const WELCOME_DAYS = Math.round(WELCOME_WINDOW_MS / 86400000);

/* Milliseconds since the account was created, or NaN if it cannot be read.
   NaN is load-bearing: see withinWelcomeWindow. */
function ageOf(createdAt, now) {
  const born = Date.parse(createdAt);
  if (!Number.isFinite(born)) return NaN;
  const at = now instanceof Date ? now.getTime() : (Number.isFinite(now) ? now : Date.now());
  return at - born;
}

/* When the offer runs out, as an ISO string, or '' if the account's date is
   unreadable. Published so the cart can say it rather than count it. */
export function welcomeExpiresAt(createdAt) {
  const born = Date.parse(createdAt);
  return Number.isFinite(born) ? new Date(born + WELCOME_WINDOW_MS).toISOString() : '';
}

/* Whole days remaining, rounded UP, so the last day reads "1 day left"
   rather than "0". Zero means it is over. */
export function welcomeDaysLeft(createdAt, now) {
  const age = ageOf(createdAt, now);
  if (!Number.isFinite(age)) return 0;
  const left = WELCOME_WINDOW_MS - age;
  return left <= 0 ? 0 : Math.ceil(left / 86400000);
}

/* FAILS CLOSED on a date it cannot read. `created_at` is NOT NULL and is
   written as an ISO string by the signup path, so an unparseable one is
   corrupt data rather than a state the product produces — and between
   refusing a discount somebody can ask for and handing out an offer that
   never expires, the refusable one is the mistake to make.

   A date in the FUTURE is inside the window: a clock skew of a few seconds
   between the signup write and this read must not expire an offer the
   customer has not had a moment to use. */
export function withinWelcomeWindow(createdAt, now) {
  return welcomeTierFor(createdAt, now) !== null;
}

/* WHICH OFFER THIS ACCOUNT IS ON, or null once they are all past.

   The first tier that still covers the account's age wins, which is why the
   list runs shortest window first: a two-hour-old account matches the
   24-hour tier before the 120-hour one and gets the ten. */
export function welcomeTierFor(createdAt, now) {
  const age = ageOf(createdAt, now);
  if (!Number.isFinite(age)) return null;
  for (const tier of WELCOME_TIERS) {
    if (age < tier.hours * 3600000) return tier;
  }
  return null;
}

/* When the CURRENT tier stops — which is not when the offer stops, and the
   difference is the whole point of the first day. Used to say "ten per cent
   until tonight, five after that". '' when nothing applies. */
export function welcomeTierEndsAt(createdAt, now) {
  const tier = welcomeTierFor(createdAt, now);
  const born = Date.parse(createdAt);
  if (!tier || !Number.isFinite(born)) return '';
  return new Date(born + tier.hours * 3600000).toISOString();
}

/* Everything the popup and the cart need to describe the offer in one read,
   so neither of them does this arithmetic itself. */
export function welcomeTerms(createdAt, now) {
  const tier = welcomeTierFor(createdAt, now);
  return {
    tiers: WELCOME_TIERS.map((t) => ({ code: t.code, percent: t.percent, hours: t.hours })),
    days: WELCOME_DAYS,
    code: tier ? tier.code : '',
    percent: tier ? tier.percent : 0,
    /* What comes after today, when there is one. The popup says both. */
    nextPercent: tier && tier !== WELCOME_TIERS[WELCOME_TIERS.length - 1]
      ? WELCOME_TIERS[WELCOME_TIERS.indexOf(tier) + 1].percent
      : 0,
    daysLeft: welcomeDaysLeft(createdAt, now),
    tierEndsAt: welcomeTierEndsAt(createdAt, now),
    expiresAt: welcomeExpiresAt(createdAt)
  };
}

/* Typed by a person, so it arrives with spaces, mixed case, and Arabic
   digits nobody meant to type. Normalised to one canonical form before it
   is compared to anything. */
export function normaliseCode(input) {
  return String(input === null || input === undefined ? '' : input)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/* ANY of the tier codes. Which one was typed does not decide what they get —
   the account's age does — so somebody typing WELCOME10 on day three is
   given the five per cent they are entitled to rather than an error. The
   code is how they ask; the tier is the answer. */
export function isWelcomeCode(input) {
  const code = normaliseCode(input);
  return WELCOME_TIERS.some((t) => t.code === code);
}

/* The discount on a subtotal, in whole pounds, never more than the subtotal
   itself and never negative. */
export function discountFor(subtotal, percent) {
  const base = Number(subtotal);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const pct = Number.isFinite(Number(percent)) ? Number(percent) : WELCOME_PERCENT;
  if (pct <= 0) return 0;
  return Math.max(0, Math.min(Math.floor((base * pct) / 100), Math.floor(base)));
}

/* -------------------------------------------------------------------------
   Why somebody cannot have it

   Returned as a stable reason code rather than a boolean, because "you have
   ordered before" and "sign in first" need completely different things from
   the customer and a bare `false` makes the checkout say the wrong one.
   ------------------------------------------------------------------------- */
export const INELIGIBLE = {
  BAD_CODE: 'bad_code',
  NOT_SIGNED_IN: 'not_signed_in',
  ALREADY_ORDERED: 'already_ordered',
  /* The five days are up. Its own reason, not folded into ALREADY_ORDERED,
     because the two need opposite things said to the customer: one has had
     their discount, the other never used it and is owed a straight answer
     about why it is gone. */
  EXPIRED: 'expired'
};

/* -------------------------------------------------------------------------
   Has this person bought from us before?

   THREE IDENTITIES, NOT ONE. The account is the obvious one and the weakest:
   making a second account costs nothing. The phone number is the real
   identity of a cash-on-delivery customer — it is how the order is
   confirmed, it is normalised to one form by lib/util.js, and a courier
   cannot deliver to a number nobody answers. Email is the third.

   Any of the three having ordered before is disqualifying. That is what
   makes "sign up again with the same phone" not work, which is the abuse
   this would otherwise invite.

   CANCELLED ORDERS DO NOT COUNT as having ordered. Somebody whose first
   order was cancelled has not had the discount, and refusing it then would
   punish them for something the shop did — only an administrator can cancel
   an order (see /api/leads), so this cannot be self-served into a loop.
   ------------------------------------------------------------------------- */
export async function hasOrderedBefore(d1, { userId, phone, email }) {
  const row = await d1.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN user_id = ?1 THEN 1 ELSE 0 END), 0) AS by_account,
       COALESCE(SUM(CASE WHEN phone   = ?2 THEN 1 ELSE 0 END), 0) AS by_phone,
       COALESCE(SUM(CASE WHEN ?3 != '' AND lower(email) = ?3 THEN 1 ELSE 0 END), 0) AS by_email
     FROM orders
    WHERE status != 'cancelled'`
  ).bind(userId || '', phone || '', String(email || '').toLowerCase()).first();

  const byAccount = Number(row && row.by_account) || 0;
  const byPhone = Number(row && row.by_phone) || 0;
  const byEmail = Number(row && row.by_email) || 0;

  return {
    before: byAccount + byPhone + byEmail > 0,
    /* Which one matched, for the log. A run of "phone" matches from
       different accounts is somebody working through the signup form, and
       that is worth being able to see. */
    matched: byAccount ? 'account' : byPhone ? 'phone' : byEmail ? 'email' : ''
  };
}

/* -------------------------------------------------------------------------
   A signal, not a rule

   Several first orders from one address in a short window is what a person
   farming the discount looks like. It is ALSO what a family, an office, a
   university hall and most of Egyptian mobile CGNAT look like, so it is
   reported and never enforced: blocking on it would refuse real customers
   for living together, and the phone check above already stops the actual
   abuse.

   Surfaced so a pattern can be noticed by somebody who can judge it.
   ------------------------------------------------------------------------- */
export async function ipSignal(d1, ip, sinceIso) {
  if (!ip) return { count: 0, suspicious: false };
  const row = await d1.prepare(
    `SELECT COUNT(*) AS n FROM orders
      WHERE ip = ?1 AND discount > 0 AND created_at >= ?2 AND status != 'cancelled'`
  ).bind(ip, sinceIso).first();
  const count = Number(row && row.n) || 0;
  return { count, suspicious: count >= 3 };
}

/* -------------------------------------------------------------------------
   The whole decision, in one place.

   Used by /api/coupon to answer "may I show this?" and by /api/orders to
   decide what is actually charged. One function, so the cart and the
   checkout can never disagree about the answer.
   ------------------------------------------------------------------------- */
export async function evaluateCoupon(d1, { code, user, phone, email, subtotal, now }) {
  if (!isWelcomeCode(code)) {
    return { ok: false, reason: INELIGIBLE.BAD_CODE, discount: 0 };
  }
  /* A signup coupon needs a signup. It is also the cheapest abuse control
     there is: a guest checkout has no identity to have used it before. */
  if (!user || !user.id) {
    return { ok: false, reason: INELIGIBLE.NOT_SIGNED_IN, discount: 0 };
  }

  /* Before the database read, not after: an expired offer is decided from
     the account row already in hand, and there is no reason to ask D1 about
     an order history that cannot change the answer.

     THE TIER IS READ FROM THE ACCOUNT, NOT FROM THE CODE. Somebody who
     typed WELCOME10 on their third day is entitled to five per cent, and
     five per cent is what they get — an error would be technically correct
     and useless to them. */
  const tier = welcomeTierFor(user.created_at, now);
  if (!tier) {
    return {
      ok: false, reason: INELIGIBLE.EXPIRED, discount: 0,
      expiresAt: welcomeExpiresAt(user.created_at)
    };
  }

  const seen = await hasOrderedBefore(d1, { userId: user.id, phone, email });
  if (seen.before) {
    return { ok: false, reason: INELIGIBLE.ALREADY_ORDERED, discount: 0, matched: seen.matched };
  }

  return {
    ok: true,
    code: tier.code,
    percent: tier.percent,
    discount: discountFor(subtotal, tier.percent),
    /* Published so the cart can say how long is left without doing the
       arithmetic itself — and so it says the same thing this function
       decided, rather than a second opinion about the same account.
       `tierEndsAt` is when the ten becomes a five; `expiresAt` is when it
       all stops. */
    tierEndsAt: welcomeTierEndsAt(user.created_at, now),
    expiresAt: welcomeExpiresAt(user.created_at),
    daysLeft: welcomeDaysLeft(user.created_at, now)
  };
}
