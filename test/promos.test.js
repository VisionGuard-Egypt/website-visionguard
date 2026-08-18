/* =========================================================================
   Promo codes — the ones an administrator issues.

   A code is a string that will be in a group chat within the hour, so none
   of these tests are about keeping it secret. They are about the limits that
   travel WITH it: the window it lives in, the number of uses, the minimum
   basket, and whether it is for people who have never ordered. Each of those
   is the only thing standing between "ten per cent for a week" and "ten per
   cent forever, for everybody".

   No test framework and no new dependency — node:test ships with Node.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discountOf, promoUsable, publicPromo, resolveDiscount, redeemPromo,
  PROMO_REFUSED, MAX_PERCENT
} from '../lib/promos.js';

const HOUR = 3600000;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/* A stored code, with the shape the table gives it. */
function promo(over) {
  return Object.assign({
    code: 'PARTY20',
    percent: 20,
    amount: 0,
    starts_at: null,
    ends_at: null,
    new_only: 0,
    min_subtotal: 0,
    max_uses: 0,
    uses: 0,
    active: 1,
    note: null,
    created_by: 'u-admin',
    created_at: iso(Date.now() - DAY)
  }, over);
}

/* D1 stand-in: answers the promo lookup with `row`, and the order-history
   aggregate with `ordered`. */
function fakeDb(row, ordered) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const entry = { sql, binds: null };
      const runner = {
        async first() {
          calls.push(Object.assign({ op: 'first' }, entry));
          if (/FROM promos/.test(sql)) return row;
          if (/by_account/.test(sql)) {
            return { by_account: ordered ? 1 : 0, by_phone: 0, by_email: 0 };
          }
          return null;
        },
        async run() {
          calls.push(Object.assign({ op: 'run' }, entry));
          return { meta: { changes: 1 } };
        }
      };
      return Object.assign({ bind(...b) { entry.binds = b; return runner; } }, runner);
    }
  };
}

const USER = { id: 'u-1', email: 'mona@example.com', created_at: iso(Date.now() - 30 * DAY) };

/* -------------------------------------------------------------------------
   The arithmetic
   ------------------------------------------------------------------------- */
test('a percentage comes off in whole pounds, rounded down', () => {
  assert.equal(discountOf(2750, { percent: 20 }), 550);
  assert.equal(discountOf(1999, { percent: 20 }), 399);   // not 399.8
  assert.equal(discountOf(4, { percent: 20 }), 0);        // 0.8 is nothing
});

test('a flat amount comes off as written', () => {
  assert.equal(discountOf(2750, { amount: 250 }), 250);
  assert.equal(discountOf(2750, { amount: 0 }), 0);
});

test('a discount can never exceed the order or go negative', () => {
  assert.equal(discountOf(500, { amount: 900 }), 500, 'a total must not go below zero');
  assert.equal(discountOf(500, { percent: 200 }), Math.floor(500 * MAX_PERCENT / 100));
  assert.equal(discountOf(-500, { percent: 20 }), 0);
  assert.equal(discountOf(0, { amount: 100 }), 0);
  assert.equal(discountOf('rubbish', { percent: 20 }), 0);
});

test('the percentage cap holds even if a bad row reaches it', () => {
  /* The endpoint refuses anything over MAX_PERCENT, but a row edited by hand
     in the database must not be able to hand out a free order either. */
  assert.equal(discountOf(1000, { percent: 100 }), MAX_PERCENT * 10);
});

/* -------------------------------------------------------------------------
   The limits that travel with the code
   ------------------------------------------------------------------------- */
test('a plain live code is usable', () => {
  assert.equal(promoUsable(promo()).ok, true);
});

test('a code nobody issued is not a code', () => {
  assert.equal(promoUsable(null).reason, PROMO_REFUSED.UNKNOWN);
});

test('a switched-off code refuses, whatever its window says', () => {
  assert.equal(promoUsable(promo({ active: 0 })).reason, PROMO_REFUSED.INACTIVE);
});

test('a window that has not opened and one that has closed are different answers', () => {
  const soon = promo({ starts_at: iso(Date.now() + DAY) });
  assert.equal(promoUsable(soon).reason, PROMO_REFUSED.NOT_STARTED,
    'somebody holding a card for a sale that starts tomorrow needs telling that');

  const over = promo({ ends_at: iso(Date.now() - HOUR) });
  assert.equal(promoUsable(over).reason, PROMO_REFUSED.EXPIRED);
});

test('the window is inclusive at the start and exclusive at the end', () => {
  const now = Date.now();
  assert.equal(promoUsable(promo({ starts_at: iso(now) }), { at: now }).ok, true);
  assert.equal(promoUsable(promo({ ends_at: iso(now) }), { at: now }).reason,
    PROMO_REFUSED.EXPIRED, 'a code that ends at nine is over at nine');
});

test('a code with no bounds is live until somebody stops it', () => {
  assert.equal(promoUsable(promo({ starts_at: null, ends_at: null })).ok, true);
});

test('an unreadable bound is treated as no bound, not as closed', () => {
  /* These are written by the admin form, which sends ISO or nothing. A bad
     value means the column is empty, and refusing every customer over a
     malformed date would be a worse failure than ignoring it. */
  assert.equal(promoUsable(promo({ starts_at: 'nonsense', ends_at: 'nonsense' })).ok, true);
});

test('a code runs out of uses', () => {
  assert.equal(promoUsable(promo({ max_uses: 50, uses: 49 })).ok, true, 'the fiftieth is allowed');
  assert.equal(promoUsable(promo({ max_uses: 50, uses: 50 })).reason, PROMO_REFUSED.USED_UP);
  assert.equal(promoUsable(promo({ max_uses: 0, uses: 9999 })).ok, true, '0 means unlimited');
});

test('a minimum basket is checked against the subtotal', () => {
  const row = promo({ min_subtotal: 3000 });
  assert.equal(promoUsable(row, { subtotal: 2999 }).reason, PROMO_REFUSED.BELOW_MIN);
  assert.equal(promoUsable(row, { subtotal: 3000 }).ok, true);
  /* And it says the figure, so the checkout can name it rather than saying
     "not valid" to somebody 30 pounds short. */
  assert.equal(promoUsable(row, { subtotal: 10 }).minSubtotal, 3000);
});

/* -------------------------------------------------------------------------
   Who the code is for
   ------------------------------------------------------------------------- */
test('a new-customers-only code refuses somebody who has ordered before', async () => {
  const r = await resolveDiscount(fakeDb(promo({ new_only: 1 }), true), {
    code: 'PARTY20', user: USER, phone: '201012345678', email: USER.email, subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PROMO_REFUSED.NOT_NEW);
});

test('a new-customers-only code cannot be used by a guest at all', async () => {
  /* There is no identity to check, so "new customer" is unanswerable. */
  const r = await resolveDiscount(fakeDb(promo({ new_only: 1 }), false), {
    code: 'PARTY20', user: null, phone: '201012345678', email: '', subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PROMO_REFUSED.NOT_SIGNED_IN);
});

test('an open code works for a returning customer', async () => {
  const r = await resolveDiscount(fakeDb(promo({ new_only: 0 }), true), {
    code: 'PARTY20', user: USER, phone: '201012345678', email: USER.email, subtotal: 2750
  });
  assert.equal(r.ok, true);
  assert.equal(r.discount, 550);
  assert.equal(r.code, 'PARTY20');
  assert.equal(r.kind, 'promo');
});

/* -------------------------------------------------------------------------
   The resolver — one answer for both kinds of code
   ------------------------------------------------------------------------- */
test('an empty code still asks about the welcome offer', async () => {
  /* This is how the cart asks before anybody types anything: "what is this
     person entitled to". A brand-new account gets its ten per cent without
     the browser having to know the code. */
  const fresh = { id: 'u-2', email: 'new@example.com', created_at: new Date().toISOString() };
  const r = await resolveDiscount(fakeDb(null, false), {
    code: '', user: fresh, phone: '201012345678', email: fresh.email, subtotal: 2750
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'welcome');
  assert.equal(r.percent, 10);
});

test('a welcome code never reaches the promos table', async () => {
  const db = fakeDb(null, false);
  const fresh = { id: 'u-3', email: 'new@example.com', created_at: new Date().toISOString() };
  await resolveDiscount(db, {
    code: 'WELCOME10', user: fresh, phone: '2010', email: fresh.email, subtotal: 1000
  });
  assert.equal(db.calls.filter((c) => /FROM promos/.test(c.sql)).length, 0);
});

test('an unknown code is refused rather than quietly ignored', async () => {
  const r = await resolveDiscount(fakeDb(null, false), {
    code: 'NOPE', user: USER, phone: '2010', email: USER.email, subtotal: 2750
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PROMO_REFUSED.UNKNOWN);
  assert.equal(r.discount, 0);
});

/* -------------------------------------------------------------------------
   Counting a redemption
   ------------------------------------------------------------------------- */
test('the count and the limit move in ONE statement', async () => {
  /* Read-then-write would let two orders placed in the same second both see
     "49 of 50" and both decide they are the fiftieth. The condition rides on
     the UPDATE so the database settles it. */
  const db = fakeDb(promo(), false);
  await redeemPromo(db, 'party20');
  const call = db.calls.find((c) => /UPDATE promos/.test(c.sql));
  assert.ok(call, 'expected an UPDATE');
  assert.match(call.sql, /uses = uses \+ 1/);
  assert.match(call.sql, /max_uses = 0 OR uses < max_uses/);
  assert.deepEqual(call.binds, ['PARTY20'], 'and it is normalised on the way in');
});

test('an empty code redeems nothing', async () => {
  const db = fakeDb(promo(), false);
  assert.equal(await redeemPromo(db, ''), false);
  assert.equal(db.calls.length, 0);
});

/* -------------------------------------------------------------------------
   What the browser is told
   ------------------------------------------------------------------------- */
test('the public shape carries the limits and not the author', () => {
  const out = publicPromo(promo({ note: 'ramadan', created_by: 'u-admin' }));
  assert.equal(out.code, 'PARTY20');
  assert.equal(out.percent, 20);
  assert.equal(out.uses, 0);
  assert.equal(out.note, 'ramadan');
  assert.equal(out.createdBy, undefined, 'not published');
});
