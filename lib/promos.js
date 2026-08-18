/* =========================================================================
   PROMO CODES — the ones a person issues, as opposed to the welcome offer.

   The welcome discount in lib/coupon.js is a rule: it applies to whoever
   qualifies, it needs nobody's attention, and it cannot be handed out. These
   are the other kind — a code the owner creates on a Tuesday because a
   campaign starts, or because somebody they know is on the phone.

   WHAT MAKES THIS SAFE IS THE SAME THING THAT MAKES THE WELCOME OFFER SAFE:
   the code is not the control. A code is a string that will end up in a
   group chat within the hour, so every stored code carries its own limits —
   a window it lives in, a number of uses, whether it is for people who have
   never ordered — and they are checked HERE, on the server, against the same
   tables the order is written to. Nothing a browser sends decides anything.

   MONEY IS WHOLE EGYPTIAN POUNDS and the discount rounds DOWN, as everywhere
   else. A code is either a percentage or a flat amount, never both: two
   fields that could each be set is two ways to describe one discount and a
   question about which wins.

   WHY THE RESOLVER LIVES HERE and not in lib/coupon.js: this module already
   imports that one, and the resolver has to try both kinds. Keeping it here
   means the dependency runs one way — promos know about the welcome offer,
   the welcome offer knows nothing about promos.
   ========================================================================= */
import {
  normaliseCode, isWelcomeCode, evaluateCoupon, hasOrderedBefore,
  INELIGIBLE, WELCOME_CODE
} from './coupon.js';

/* A hundred per cent off is a free order, and it is far more often a typo
   than a decision. The cap is not a policy about generosity — an admin who
   really means it can write a flat amount equal to the subtotal — it is a
   guard against a slipped keystroke costing an order. */
export const MAX_PERCENT = 90;

/* Long enough to be unguessable if somebody wants that, short enough to read
   down a phone. Codes are stored normalised, so `vip 20` and `VIP20` are the
   same row and cannot both exist. */
export const MAX_CODE = 32;
export const MAX_NOTE = 200;

/* Why a code did not apply. Every one of these is shown to somebody — the
   customer who typed it, or the admin who issued it — so they are distinct
   where the remedy is distinct. "Not started" and "expired" look the same to
   a validator and completely different to a person holding a card. */
export const PROMO_REFUSED = {
  UNKNOWN: 'unknown_code',
  INACTIVE: 'code_inactive',
  NOT_STARTED: 'code_not_started',
  EXPIRED: 'code_expired',
  USED_UP: 'code_used_up',
  BELOW_MIN: 'below_minimum',
  NOT_NEW: 'not_a_new_customer',
  NOT_SIGNED_IN: INELIGIBLE.NOT_SIGNED_IN
};

/* -------------------------------------------------------------------------
   The arithmetic, in one place for both kinds of code.

   Rounds DOWN and never exceeds the subtotal. Rounding a discount up charges
   less than the arithmetic says, every time, forever, and nobody would ever
   notice; a discount larger than the order would make a total go negative.
   ------------------------------------------------------------------------- */
export function discountOf(subtotal, { percent, amount }) {
  const base = Math.floor(Number(subtotal));
  if (!Number.isFinite(base) || base <= 0) return 0;

  const pct = Math.floor(Number(percent) || 0);
  const flat = Math.floor(Number(amount) || 0);

  const off = pct > 0 ? Math.floor((base * Math.min(pct, MAX_PERCENT)) / 100) : flat;
  return Math.max(0, Math.min(off, base));
}

/* -------------------------------------------------------------------------
   Is this code usable, by this person, right now?

   `now` is injectable so the windows can be tested without waiting a day. It
   is NOT a way for a caller to reopen a closed window: every caller inside
   the product passes nothing and gets the real clock, and the one that could
   pass something — an HTTP handler — never does.
   ------------------------------------------------------------------------- */
export function promoUsable(row, { subtotal, at } = {}) {
  if (!row) return { ok: false, reason: PROMO_REFUSED.UNKNOWN };
  if (!row.active) return { ok: false, reason: PROMO_REFUSED.INACTIVE };

  const now = at instanceof Date ? at.getTime() : (Number.isFinite(at) ? at : Date.now());

  /* An unparseable bound is treated as no bound rather than as "closed":
     these are written by the admin form, which sends ISO or nothing, so a
     bad value means the column is empty. */
  const starts = Date.parse(row.starts_at);
  if (Number.isFinite(starts) && now < starts) {
    return { ok: false, reason: PROMO_REFUSED.NOT_STARTED, startsAt: row.starts_at };
  }
  const ends = Date.parse(row.ends_at);
  if (Number.isFinite(ends) && now >= ends) {
    return { ok: false, reason: PROMO_REFUSED.EXPIRED, endsAt: row.ends_at };
  }

  const max = Number(row.max_uses) || 0;
  if (max > 0 && (Number(row.uses) || 0) >= max) {
    return { ok: false, reason: PROMO_REFUSED.USED_UP };
  }

  const min = Number(row.min_subtotal) || 0;
  if (min > 0 && Math.floor(Number(subtotal) || 0) < min) {
    return { ok: false, reason: PROMO_REFUSED.BELOW_MIN, minSubtotal: min };
  }

  return { ok: true };
}

/* What the browser is allowed to see about a code. Written out rather than
   spread, so a column added later is not published by accident — the same
   reasoning as publicOrder() and publicLead(). */
export function publicPromo(row) {
  return {
    code: row.code,
    percent: Number(row.percent) || 0,
    amount: Number(row.amount) || 0,
    startsAt: row.starts_at || '',
    endsAt: row.ends_at || '',
    newOnly: !!row.new_only,
    minSubtotal: Number(row.min_subtotal) || 0,
    maxUses: Number(row.max_uses) || 0,
    uses: Number(row.uses) || 0,
    active: !!row.active,
    note: row.note || '',
    createdAt: row.created_at
  };
}

export function getPromo(d1, code) {
  return d1.prepare('SELECT * FROM promos WHERE code = ?1').bind(normaliseCode(code)).first();
}

/* -------------------------------------------------------------------------
   Somebody used it.

   Counted with an UPDATE that carries its own condition rather than a read
   followed by a write: two orders placed in the same second must not both
   see uses = 4 on a code limited to 5 and both decide they are the fifth.
   A code with no limit is still counted, because "how many people used it"
   is the question the admin panel exists to answer.
   ------------------------------------------------------------------------- */
export async function redeemPromo(d1, code) {
  const normalised = normaliseCode(code);
  if (!normalised) return false;
  const res = await d1.prepare(
    `UPDATE promos
        SET uses = uses + 1
      WHERE code = ?1
        AND active = 1
        AND (max_uses = 0 OR uses < max_uses)`
  ).bind(normalised).run();
  return !!(res && res.meta && res.meta.changes);
}

/* -------------------------------------------------------------------------
   THE ONE ENTRY POINT

   /api/coupon asks it so the cart can show a line; /api/orders asks it again
   when the order arrives and charges what it says. One function, so the two
   can never disagree — the same guarantee lib/coupon.js already made, now
   covering issued codes as well.

   An EMPTY code is not an error. It means "whatever this person is entitled
   to", which is how the cart asks before anybody types anything, and the
   answer is the welcome offer or nothing.
   ------------------------------------------------------------------------- */
export async function resolveDiscount(d1, { code, user, phone, email, subtotal, now }) {
  const typed = normaliseCode(code);

  /* The welcome offer owns its own codes. Asked for by name, or — far more
     often — asked for by saying nothing at all, because the checkout box is
     empty and the customer expects their discount anyway.

     An empty code is turned into the headline welcome code rather than
     passed through: evaluateCoupon() answers "is THIS code valid", and the
     honest answer for an empty string is no. Deciding that "nothing typed"
     means "the welcome offer" is this function's job, and doing it here is
     what keeps that meaning in one place. */
  if (!typed || isWelcomeCode(typed)) {
    const verdict = await evaluateCoupon(d1, {
      code: typed || WELCOME_CODE, user, phone, email, subtotal, now
    });
    return { ...verdict, kind: 'welcome' };
  }

  /* ---- an issued code ---- */
  const row = await getPromo(d1, typed);
  const usable = promoUsable(row, { subtotal, at: now });
  if (!usable.ok) {
    return { ok: false, kind: 'promo', code: typed, discount: 0, ...usable };
  }

  /* `new_only` is checked against the SAME three identities the welcome
     offer uses — account, phone, email — because a code meant for new
     customers is worth exactly as much as that check is. A guest cannot
     satisfy it: there is no identity to check. */
  if (row.new_only) {
    if (!user || !user.id) {
      return { ok: false, kind: 'promo', code: typed, discount: 0, reason: PROMO_REFUSED.NOT_SIGNED_IN };
    }
    const seen = await hasOrderedBefore(d1, { userId: user.id, phone, email });
    if (seen.before) {
      return {
        ok: false, kind: 'promo', code: typed, discount: 0,
        reason: PROMO_REFUSED.NOT_NEW, matched: seen.matched
      };
    }
  }

  return {
    ok: true,
    kind: 'promo',
    code: row.code,
    percent: Number(row.percent) || 0,
    amount: Number(row.amount) || 0,
    discount: discountOf(subtotal, row),
    endsAt: row.ends_at || ''
  };
}
