/* =========================================================================
   What an order costs.

   This is the file to be strictest about. priceCart() is the only thing
   standing between a cart that arrived from a browser and the total a
   customer is charged, and lib/orders.js says so in its own header: the
   client's prices are never used, everything is rebuilt from the catalogue
   on the server. These tests pin that promise down.

   No test framework and no new dependency — node:test ships with Node.
   Run them with `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  priceCart, MAX_LINES, MAX_QTY, shippingFor, isGovernorate,
  PAYMENTS, isPayment, paymentLabel,
  PAYMENT_STATUSES, isPaymentStatus, awaitingPayment,
  paymentMessage, paymentWaLink, publicOrder,
  merchantWa, contactWa, PUBLIC_WA
} from '../lib/orders.js';

/* A tiny fixed catalogue, so a price change in the real one cannot make these
   fail for a reason that has nothing to do with the logic under test. */
const CATALOG = {
  a: { id: 'a', name: 'Cam A', cat: 'ip', ar: 'أ', en: 'A', price: 100 },
  b: { id: 'b', name: 'Cam B', cat: 'ip', ar: 'ب', en: 'B', price: 250 }
};
const resolve = (id) => CATALOG[id] || null;

const codeOf = (fn) => {
  try { fn(); } catch (e) { return e.code; }
  return null;
};

test('prices a single line from the catalogue, not from the cart', () => {
  /* The cart claims the product costs 1 pound. It does not. */
  const { items, subtotal } = priceCart([{ id: 'a', qty: 2, price: 1, unit: 1, line: 2 }], resolve);
  assert.equal(items.length, 1);
  assert.equal(items[0].unit, 100);
  assert.equal(items[0].line, 200);
  assert.equal(subtotal, 200);
});

test('adds several lines up', () => {
  const { subtotal } = priceCart([{ id: 'a', qty: 1 }, { id: 'b', qty: 3 }], resolve);
  assert.equal(subtotal, 100 + 750);
});

test('merges duplicate ids into one line', () => {
  const { items } = priceCart([{ id: 'a', qty: 2 }, { id: 'a', qty: 3 }], resolve);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 5);
  assert.equal(items[0].line, 500);
});

test('caps a merged quantity at MAX_QTY rather than letting it through', () => {
  /* Two lines that are each individually legal but together exceed the cap.
     The cap has to apply to the merged total or it is trivially bypassed. */
  const { items } = priceCart([{ id: 'a', qty: 60 }, { id: 'a', qty: 60 }], resolve);
  assert.equal(items[0].qty, MAX_QTY);
  assert.equal(items[0].line, MAX_QTY * 100);
});

test('keeps the order the lines arrived in', () => {
  const { items } = priceCart([{ id: 'b', qty: 1 }, { id: 'a', qty: 1 }], resolve);
  assert.deepEqual(items.map((i) => i.id), ['b', 'a']);
});

test('carries the catalogue name and specs onto the line', () => {
  const { items } = priceCart([{ id: 'b', qty: 1 }], resolve);
  assert.equal(items[0].name, 'Cam B');
  assert.equal(items[0].cat, 'ip');
  assert.equal(items[0].specAr, 'ب');
  assert.equal(items[0].specEn, 'B');
});

test('refuses a product the catalogue cannot resolve', () => {
  assert.equal(codeOf(() => priceCart([{ id: 'nope', qty: 1 }], resolve)), 'unknown_product');
});

test('refuses an empty cart, and a cart of nothing but junk', () => {
  assert.equal(codeOf(() => priceCart([], resolve)), 'empty_cart');
  assert.equal(codeOf(() => priceCart([null, 5, 'x'], resolve)), 'empty_cart');
});

test('refuses a cart that is not an array', () => {
  assert.equal(codeOf(() => priceCart(null, resolve)), 'empty_cart');
  assert.equal(codeOf(() => priceCart({ id: 'a', qty: 1 }, resolve)), 'empty_cart');
});

test('refuses quantities that are not a whole number of at least one', () => {
  for (const qty of [0, -1, 'x', null, undefined, NaN]) {
    assert.equal(codeOf(() => priceCart([{ id: 'a', qty }], resolve)), 'bad_qty', `qty ${qty}`);
  }
});

test('refuses a single line over MAX_QTY', () => {
  assert.equal(codeOf(() => priceCart([{ id: 'a', qty: MAX_QTY + 1 }], resolve)), 'bad_qty');
});

test('refuses more distinct products than MAX_LINES', () => {
  const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => ({ id: 'a' + i, qty: 1 }));
  assert.equal(codeOf(() => priceCart(many, resolve)), 'too_many_lines');
});

test('skips junk entries but still prices the real ones beside them', () => {
  const { items, subtotal } = priceCart([null, { id: 'a', qty: 1 }, 'x'], resolve);
  assert.equal(items.length, 1);
  assert.equal(subtotal, 100);
});

test('a fractional quantity is floored, not rounded up', () => {
  const { items } = priceCart([{ id: 'a', qty: 2.9 }], resolve);
  assert.equal(items[0].qty, 2);
});

/* -------------------------------------------------------------------------
   Shipping and governorate
   ------------------------------------------------------------------------- */
test('shipping is zero unless SHIPPING_FLAT says otherwise', () => {
  assert.equal(shippingFor({}), 0);
  assert.equal(shippingFor({ SHIPPING_FLAT: '50' }), 50);
});

test('a nonsense or out-of-range SHIPPING_FLAT falls back to zero', () => {
  for (const v of ['abc', '-5', '999999999', '', undefined]) {
    assert.equal(shippingFor({ SHIPPING_FLAT: v }), 0, `SHIPPING_FLAT=${v}`);
  }
});

test('only a governorate on the published list is accepted', () => {
  assert.equal(isGovernorate('لا يوجد'), '');
  assert.equal(isGovernorate(''), '');
  assert.equal(isGovernorate('Cairo'), 'Cairo');
  assert.equal(isGovernorate('القاهرة'), 'القاهرة');
});

/* =========================================================================
   HOW AN ORDER IS PAID FOR

   Cash on delivery is gone. An order is placed unpaid and settled on
   WhatsApp, and these pin the two halves of that: nothing can be written
   with the withdrawn method, and nothing published to a browser claims an
   order was paid for when nobody has said it was.
   ========================================================================= */
test('transfer is the only payment method, and cash on delivery is gone', () => {
  assert.deepEqual(PAYMENTS, ['transfer']);
  assert.ok(!PAYMENTS.includes('cod'));
});

test('a browser sending the withdrawn method gets the one that exists', () => {
  /* A cached copy of the old checkout still posts payment: 'cod'. That must
     produce an ordinary transfer order rather than an error about a choice
     the person using it was never shown. */
  assert.equal(isPayment('cod'), 'transfer');
  assert.equal(isPayment(''), 'transfer');
  assert.equal(isPayment(undefined), 'transfer');
  assert.equal(isPayment('transfer'), 'transfer');
});

test('cash on delivery keeps its label, so historical orders still read', () => {
  /* The rows written before this change are in D1 for good. Dropping the
     label would show the back office a blank payment method on every one. */
  assert.match(paymentLabel('cod', 'en'), /Cash on delivery/);
  assert.match(paymentLabel('transfer', 'en'), /InstaPay or e-wallet/);
  assert.match(paymentLabel('transfer', 'ar'), /إنستاباي/);
  /* Anything unrecognised reads as the method the shop actually uses, not as
     a blank. */
  assert.match(paymentLabel('nonsense', 'en'), /InstaPay or e-wallet/);
});

test('an order is paid, waiting, or failed — and nothing else', () => {
  assert.deepEqual(PAYMENT_STATUSES, ['pending', 'paid', 'failed']);
  for (const s of PAYMENT_STATUSES) assert.ok(isPaymentStatus(s), s);
  for (const s of ['', 'refunded', 'PAID', undefined, null]) assert.ok(!isPaymentStatus(s), String(s));
});

test('only a paid order stops owing money', () => {
  assert.equal(awaitingPayment('pending'), true);
  /* A transfer that did not land is a reason to try again, not a closed
     door — so the pay link stays on offer. */
  assert.equal(awaitingPayment('failed'), true);
  assert.equal(awaitingPayment('paid'), false);
});

const ORDER = {
  id: 'VG-260810-A1B2', total: 4500, shipping: 0, subtotal: 4500,
  currency: 'EGP', payment: 'whatsapp', payment_status: 'pending',
  status: 'new', governorate: 'Cairo', lang: 'ar', items: [],
  /* The things the customer's message must never carry. */
  name: 'Mona Adel', phone: '201012345678', address: '5 Somewhere Street, floor 3',
  phone_alt: '201099998888', email: 'mona@example.com', notes: 'ring twice'
};

test('the customer’s WhatsApp message carries the order and the amount', () => {
  const ar = paymentMessage(ORDER, 'ar');
  const en = paymentMessage(ORDER, 'en');
  for (const body of [ar, en]) {
    assert.ok(body.includes('VG-260810-A1B2'), 'the order number');
    assert.ok(body.includes('4,500'), 'the amount owed');
  }
  assert.match(en, /Hello Vision Guard/);
});

test('the customer’s message carries nothing else about them', () => {
  /* It opens in THEIR WhatsApp, on a screen somebody else can be looking at.
     The back-office summary — address, second number, notes — belongs to
     orderMessage() and stays there. */
  const body = paymentMessage(ORDER, 'ar') + paymentMessage(ORDER, 'en');
  for (const secret of [ORDER.address, ORDER.phone_alt, ORDER.email, ORDER.notes]) {
    assert.ok(!body.includes(secret), `leaked ${secret}`);
  }
});

test('the pay link points at the number published across the site', () => {
  const url = paymentWaLink(ORDER, {}, 'en');
  assert.ok(url.startsWith(`https://wa.me/${PUBLIC_WA}?text=`), url);
  assert.ok(decodeURIComponent(url).includes('VG-260810-A1B2'));
});

test('THE ALERTS NUMBER NEVER BECOMES THE CUSTOMER’S NUMBER', () => {
  /* WHATSAPP_TO is where the shop's own order alerts go, and it is routinely
     somebody's personal phone. If the customer-facing link inherited it, every
     buyer would be messaging that phone. The two are resolved separately and
     this is the assertion that keeps them that way. */
  const env = { WHATSAPP_TO: '201000000001' };
  assert.equal(merchantWa(env), '201000000001', 'alerts still follow WHATSAPP_TO');
  assert.equal(contactWa(env), PUBLIC_WA, 'customers do not');
  assert.ok(paymentWaLink(ORDER, env, 'en').startsWith(`https://wa.me/${PUBLIC_WA}?`));
});

test('the published number can be moved, but only on purpose', () => {
  /* One variable, named for what it is, and normalised the same way every
     other Egyptian number in this codebase is. */
  assert.equal(contactWa({ PUBLIC_WHATSAPP: '01012345678' }), '201012345678');
  assert.equal(contactWa({ CONTACT_WHATSAPP: '+20 101 234 5678' }), '201012345678');
  assert.equal(contactWa({ PUBLIC_WHATSAPP: '   ' }), PUBLIC_WA, 'blank falls back');
  assert.equal(contactWa({}), PUBLIC_WA);
  assert.equal(contactWa(null), PUBLIC_WA);
});

test('publicOrder offers a way to pay only while payment is owed', () => {
  const env = { WHATSAPP_TO: '201105006854' };
  assert.equal(publicOrder(ORDER, env).paymentStatus, 'pending');
  assert.ok(publicOrder(ORDER, env).payUrl, 'pending orders can be paid');
  assert.ok(publicOrder({ ...ORDER, payment_status: 'failed' }, env).payUrl, 'a failed transfer can be retried');
  assert.equal(publicOrder({ ...ORDER, payment_status: 'paid' }, env).payUrl, undefined,
    'a paid order must not offer a pay button — that is how somebody pays twice');
  /* No env, no link: a caller that cannot name the shop's number must not
     guess at one. */
  assert.equal(publicOrder(ORDER).payUrl, undefined);
});

test('an order row with no payment state reads as pending', () => {
  /* Every order placed before the column existed. NULL must mean "nobody has
     said the money arrived", never "paid". */
  assert.equal(publicOrder({ id: 'VG-1', total: 10, items: [] }).paymentStatus, 'pending');
});
