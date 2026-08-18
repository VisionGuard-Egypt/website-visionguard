/* =========================================================================
   The first-order discount.

   This decides what people pay, so the tests are about the two ways it can
   be wrong in opposite directions: charging a returning customer less than
   they owe, and refusing a genuine first order.

   The abuse case is the one to be strictest about. A shared code is only
   safe because eligibility is checked against the orders table, so the
   check has to hold on the PHONE — signing up again with a fresh email is
   free, and buying another SIM is not.

   No test framework and no new dependency — node:test ships with Node.
   Run them with `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseCode, isWelcomeCode, discountFor, evaluateCoupon, hasOrderedBefore,
  withinWelcomeWindow, welcomeDaysLeft, welcomeExpiresAt,
  welcomeTierFor, welcomeTerms, WELCOME_TIERS,
  WELCOME_CODE, WELCOME_PERCENT, WELCOME_DAYS, INELIGIBLE
} from '../lib/coupon.js';

/* A D1 stand-in whose single aggregate row is whatever the test supplies. */
function fakeDb(counts) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return {
            async first() {
              return {
                by_account: (counts && counts.account) || 0,
                by_phone: (counts && counts.phone) || 0,
                by_email: (counts && counts.email) || 0,
                n: (counts && counts.n) || 0
              };
            }
          };
        }
      };
    }
  };
}

/* Signed up a moment ago, so the five-day window is open. Every test that
   is not ABOUT the window uses this, and would otherwise be measuring the
   wrong thing the day someone changes WELCOME_DAYS. */
const USER = { id: 'u-1', email: 'mona@example.com', created_at: new Date().toISOString() };

/* The same person, six days later — the offer has run out. */
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const LAPSED = { id: 'u-1', email: 'mona@example.com', created_at: daysAgo(6) };
const NEW_CUSTOMER = fakeDb({ account: 0, phone: 0, email: 0 });

/* -------------------------------------------------------------------------
   The code itself
   ------------------------------------------------------------------------- */
test('the code is recognised however a person types it', () => {
  for (const typed of ['WELCOME5', 'welcome5', ' Welcome5 ', 'WELCOME 5', 'wELcome5']) {
    assert.equal(isWelcomeCode(typed), true, `${typed} should be accepted`);
  }
  /* Both tiers are real codes. Which one a person types does not decide what
     they get — their account's age does. */
  for (const typed of ['WELCOME10', 'welcome10', ' Welcome 10 ']) {
    assert.equal(isWelcomeCode(typed), true, `${typed} should be accepted`);
  }
});

test('anything else is not the code', () => {
  for (const typed of ['', null, undefined, 'WELCOME', 'WELCOME50', 'WELCOMES', 'WELCOME15']) {
    assert.equal(isWelcomeCode(typed), false, `${JSON.stringify(typed)} must be refused`);
  }
});

test('normalising never throws on rubbish', () => {
  assert.equal(normaliseCode(null), '');
  assert.equal(normaliseCode(undefined), '');
  assert.equal(normaliseCode(12345), '12345');
});

/* -------------------------------------------------------------------------
   The arithmetic

   Whole pounds, rounded DOWN. Rounding a discount up charges less than the
   arithmetic says, every time, forever, and nobody would ever notice.
   ------------------------------------------------------------------------- */
test('five per cent, rounded down to whole pounds', () => {
  assert.equal(discountFor(1000, 5), 50);
  assert.equal(discountFor(2750, 5), 137);       // not 137.5, and not 138
  assert.equal(discountFor(1999, 5), 99);        // not 99.95
  assert.equal(discountFor(19, 5), 0);           // 0.95 rounds to nothing
});

test('the discount can never exceed the subtotal or go negative', () => {
  assert.equal(discountFor(100, 500), 100);
  assert.equal(discountFor(0, 5), 0);
  assert.equal(discountFor(-500, 5), 0);
  assert.equal(discountFor(1000, -5), 0);
});

test('a nonsense subtotal is worth no discount, not NaN', () => {
  assert.equal(discountFor(null, 5), 0);
  assert.equal(discountFor('abc', 5), 0);
  assert.equal(discountFor(undefined, 5), 0);
});

/* -------------------------------------------------------------------------
   Who may have it
   ------------------------------------------------------------------------- */
test('a customer who signed up today gets the headline ten per cent', async () => {
  const r = await evaluateCoupon(NEW_CUSTOMER, {
    code: 'WELCOME5', user: USER, phone: '201012345678', email: USER.email, subtotal: 2750
  });
  assert.equal(r.ok, true);
  assert.equal(r.discount, 275, '10% of 2750');
  assert.equal(r.code, WELCOME_CODE);
  assert.equal(r.percent, WELCOME_PERCENT);
  /* They asked with the five per cent code and were given the ten they are
     entitled to. The code is how you ask; the tier is the answer. */
  assert.equal(r.code, 'WELCOME10');
});

test('a guest gets nothing, and is told to sign in rather than refused', async () => {
  /* The distinction matters on screen: this person CAN have the discount,
     they just have to sign in. Telling them they are ineligible is a lie. */
  const r = await evaluateCoupon(NEW_CUSTOMER, {
    code: 'WELCOME5', user: null, phone: '201012345678', email: '', subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INELIGIBLE.NOT_SIGNED_IN);
  assert.equal(r.discount, 0);
});

test('the wrong code is refused before anything else is checked', async () => {
  const r = await evaluateCoupon(NEW_CUSTOMER, {
    code: 'FREESTUFF', user: USER, phone: '201012345678', email: USER.email, subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INELIGIBLE.BAD_CODE);
});

test('somebody who has ordered on this account is refused', async () => {
  const r = await evaluateCoupon(fakeDb({ account: 1 }), {
    code: 'WELCOME5', user: USER, phone: '201012345678', email: USER.email, subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INELIGIBLE.ALREADY_ORDERED);
  assert.equal(r.matched, 'account');
  assert.equal(r.discount, 0);
});

test('A NEW ACCOUNT WITH THE SAME PHONE IS REFUSED', async () => {
  /* The abuse this whole design exists to stop. A fresh email costs
     nothing; the number the courier rings does not. */
  const r = await evaluateCoupon(fakeDb({ account: 0, phone: 1 }), {
    code: 'WELCOME5',
    user: { id: 'u-brand-new', email: 'mona2@example.com', created_at: new Date().toISOString() },
    phone: '201012345678', email: 'mona2@example.com', subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INELIGIBLE.ALREADY_ORDERED);
  assert.equal(r.matched, 'phone');
});

test('a new account with the same email is refused too', async () => {
  const r = await evaluateCoupon(fakeDb({ account: 0, phone: 0, email: 1 }), {
    code: 'WELCOME5',
    user: { id: 'u-brand-new', email: 'mona@example.com', created_at: new Date().toISOString() },
    phone: '201099999999', email: 'mona@example.com', subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.matched, 'email');
});

/* -------------------------------------------------------------------------
   The query behind it
   ------------------------------------------------------------------------- */
test('cancelled orders do not count as having ordered', async () => {
  /* Somebody whose first order was cancelled has not had the discount, and
     refusing them would punish them for something the shop did. Only an
     administrator can cancel, so this cannot be self-served into a loop. */
  const db = fakeDb({ account: 0 });
  await hasOrderedBefore(db, { userId: 'u-1', phone: '2010', email: 'a@b.c' });
  assert.match(db.calls[0].sql, /status != 'cancelled'/);
});

test('all three identities are checked in one round trip', async () => {
  const db = fakeDb({});
  await hasOrderedBefore(db, { userId: 'u-1', phone: '201012345678', email: 'Mona@Example.com' });
  const call = db.calls[0];
  assert.match(call.sql, /by_account/);
  assert.match(call.sql, /by_phone/);
  assert.match(call.sql, /by_email/);
  assert.equal(db.calls.length, 1, 'one query, not three');
  /* Email is lowercased before it is bound, because the column is not. */
  assert.deepEqual(call.binds, ['u-1', '201012345678', 'mona@example.com']);
});

test('a missing phone or email cannot match every row', async () => {
  /* An empty string must not equal an empty column and sweep up every guest
     order ever placed. The email arm guards on ?3 != '' for exactly this;
     phone is NOT NULL on the table so it can never be blank. */
  const db = fakeDb({});
  await hasOrderedBefore(db, { userId: '', phone: '', email: '' });
  assert.match(db.calls[0].sql, /\?3 != ''/);
});

/* -------------------------------------------------------------------------
   AND IT RUNS OUT — five days from the day the account was created.

   This is money with a deadline on it, which is the combination that goes
   wrong quietly: an off-by-one here either keeps paying out an offer that
   ended, or takes it away from somebody on the day they were promised it.
   ------------------------------------------------------------------------- */
const HOUR = 3600000;
const DAY = 86400000;
const at = (ms) => new Date(Date.now() - ms).toISOString();

test('the welcome window is five days', () => {
  assert.equal(WELCOME_DAYS, 5);
});

test('the window is open from signup until the fifth day is up', () => {
  assert.equal(withinWelcomeWindow(at(0)), true, 'the moment they join');
  assert.equal(withinWelcomeWindow(at(4 * DAY)), true, 'day four');
  assert.equal(withinWelcomeWindow(at(5 * DAY - HOUR)), true, 'an hour short of five days');
  assert.equal(withinWelcomeWindow(at(5 * DAY + 1000)), false, 'just past five days');
  assert.equal(withinWelcomeWindow(at(30 * DAY)), false, 'a month later');
});

test('a clock skew into the future does not expire a brand-new account', () => {
  /* The signup write and this read can disagree by a second or two. Treating
     that as expired would take the offer away from somebody who has not had
     a moment to use it. */
  const future = new Date(Date.now() + 30000).toISOString();
  assert.equal(withinWelcomeWindow(future), true);
});

test('an unreadable signup date fails CLOSED', () => {
  /* created_at is NOT NULL and written as ISO by the signup path, so this is
     corrupt data rather than a state the product makes. Between refusing a
     discount somebody can ask about and handing out one that never expires,
     this is the mistake to make. */
  for (const bad of ['', null, undefined, 'not a date', 0]) {
    assert.equal(withinWelcomeWindow(bad), false, String(bad));
  }
});

test('days left counts down and never goes negative', () => {
  assert.equal(welcomeDaysLeft(at(0)), 5);
  assert.equal(welcomeDaysLeft(at(DAY)), 4);
  /* Rounded UP, so the final day reads "1 day left" rather than "0". */
  assert.equal(welcomeDaysLeft(at(5 * DAY - HOUR)), 1);
  assert.equal(welcomeDaysLeft(at(5 * DAY + HOUR)), 0);
  assert.equal(welcomeDaysLeft(at(90 * DAY)), 0);
  assert.equal(welcomeDaysLeft('rubbish'), 0);
});

test('the expiry date is five days after signup, to the millisecond', () => {
  const born = '2026-08-10T09:00:00.000Z';
  assert.equal(welcomeExpiresAt(born), '2026-08-15T09:00:00.000Z');
  assert.equal(welcomeExpiresAt('rubbish'), '');
});

test('a first-time customer whose five days are up is refused', async () => {
  const r = await evaluateCoupon(NEW_CUSTOMER, {
    code: 'WELCOME5', user: LAPSED, phone: '201012345678', email: LAPSED.email, subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INELIGIBLE.EXPIRED);
  assert.equal(r.discount, 0);
  /* Its own reason, not ALREADY_ORDERED: this person never used it, and the
     checkout has to be able to say so. */
  assert.notEqual(r.reason, INELIGIBLE.ALREADY_ORDERED);
});

test('an expired offer is decided without asking the database', async () => {
  /* The account row already answers it. A round trip to D1 could not change
     the answer, so it is not made. */
  const db = fakeDb({ account: 0 });
  await evaluateCoupon(db, {
    code: 'WELCOME5', user: LAPSED, phone: '201012345678', email: LAPSED.email, subtotal: 2750
  });
  assert.equal(db.calls.length, 0);
});

test('an eligible answer says how long is left', async () => {
  const r = await evaluateCoupon(NEW_CUSTOMER, {
    code: 'WELCOME5', user: USER, phone: '201012345678', email: USER.email, subtotal: 2750
  });
  assert.equal(r.ok, true);
  assert.equal(r.daysLeft, WELCOME_DAYS);
  assert.equal(r.expiresAt, welcomeExpiresAt(USER.created_at));
});

test('the deadline is the account, not the clock the caller passes', async () => {
  /* `now` is injectable so these tests can travel in time; it must not be a
     way for a caller to reopen a closed window by lying about the date. The
     account's created_at is what moves the deadline, and nothing on the
     request can set that. */
  const r = await evaluateCoupon(NEW_CUSTOMER, {
    code: 'WELCOME5', user: LAPSED, phone: '201012345678', email: LAPSED.email,
    subtotal: 2750, now: Date.now() + 365 * DAY
  });
  assert.equal(r.ok, false, 'further into the future is still expired');
});

/* -------------------------------------------------------------------------
   TWO OFFERS, NOT ONE — ten per cent on day one, five for the four after.

   The seam between the tiers is where this can go wrong in both directions
   at once: an hour of ten per cent too many is money out of the till, an
   hour too few is a customer told a number that was true when they read it.
   ------------------------------------------------------------------------- */
test('the tiers are ten today and five for the rest of the five days', () => {
  assert.deepEqual(WELCOME_TIERS.map((t) => [t.code, t.percent, t.hours]), [
    ['WELCOME10', 10, 24],
    ['WELCOME5', 5, 120]
  ]);
  assert.equal(WELCOME_DAYS, 5, 'the whole window still reads as five days');
});

test('the tiers are listed shortest window first, or the first one never wins', () => {
  /* welcomeTierFor takes the first tier that covers the account, so a longer
     window listed above a shorter one would swallow it and the ten per cent
     would never be handed out. */
  const hours = WELCOME_TIERS.map((t) => t.hours);
  assert.deepEqual(hours, [...hours].sort((a, b) => a - b));
});

test('day one is ten per cent, and the hour after it is five', () => {
  assert.equal(welcomeTierFor(at(0)).percent, 10, 'the moment they join');
  assert.equal(welcomeTierFor(at(23 * HOUR)).percent, 10, 'twenty-three hours in');
  assert.equal(welcomeTierFor(at(24 * HOUR - 1000)).percent, 10, 'a second short of a day');
  assert.equal(welcomeTierFor(at(24 * HOUR + 1000)).percent, 5, 'a second past it');
  assert.equal(welcomeTierFor(at(4 * DAY)).percent, 5, 'day four');
  assert.equal(welcomeTierFor(at(5 * DAY - HOUR)).percent, 5, 'the last hour');
  assert.equal(welcomeTierFor(at(5 * DAY + 1000)), null, 'and then nothing');
});

test('an unreadable signup date is on no tier at all', () => {
  for (const bad of ['', null, undefined, 'not a date']) {
    assert.equal(welcomeTierFor(bad), null, String(bad));
  }
});

test('a day-three customer typing WELCOME10 is given the five they are owed', async () => {
  /* Not an error. They asked for a discount they are not on any more, and
     the honest answer is the one they ARE on — refusing would be technically
     correct and useless to them. */
  const day3 = { id: 'u-9', email: 'later@example.com', created_at: daysAgo(3) };
  const r = await evaluateCoupon(NEW_CUSTOMER, {
    code: 'WELCOME10', user: day3, phone: '201012345678', email: day3.email, subtotal: 2750
  });
  assert.equal(r.ok, true);
  assert.equal(r.percent, 5);
  assert.equal(r.code, 'WELCOME5');
  assert.equal(r.discount, 137);
});

test('the terms say what today is worth and what tomorrow is worth', () => {
  const fresh = welcomeTerms(at(0));
  assert.equal(fresh.percent, 10);
  assert.equal(fresh.nextPercent, 5, 'so the popup can say both numbers');
  assert.equal(fresh.daysLeft, 5);
  assert.ok(fresh.tierEndsAt, 'and when the ten stops');

  const later = welcomeTerms(at(2 * DAY));
  assert.equal(later.percent, 5);
  assert.equal(later.nextPercent, 0, 'there is nothing after the last tier');

  const done = welcomeTerms(at(9 * DAY));
  assert.equal(done.percent, 0);
  assert.equal(done.code, '');
});
