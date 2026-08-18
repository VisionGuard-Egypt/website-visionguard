/* =========================================================================
   Order pricing, numbering and the message that lands on WhatsApp.

   The one rule here: the client's prices are never used. The cart that
   arrives is a list of {id, qty}; everything else — name, unit price, line
   total, order total — is rebuilt from public/catalog.js on the server. A
   tampered cart cannot change what an order costs.
   ========================================================================= */
import { PRODUCTS, findProduct, GOVERNORATES } from '../public/catalog.js';
import { ApiError, clean, cairoDate, cairoStamp, displayPhoneEg, normPhoneEg } from './util.js';

export const MAX_LINES = 40;
export const MAX_QTY = 99;

/* THE NUMBER PUBLISHED ACROSS THE SITE — the strip, both footers, the menu,
   the assistant's answers. One literal, so "the number we use everywhere" is
   a fact about the code rather than a thing to check page by page. */
export const PUBLIC_WA = '201105006854';

/* The default is the WhatsApp number already published across the site.
   Any of these variables overrides it without touching code. MY_PHONE_NUMBER
   is in the list because that is the name the secret was actually created
   under in the Pages dashboard. */
export const DEFAULT_MERCHANT_WA = PUBLIC_WA;

export function merchantWa(env) {
  const raw = clean(
    (env && (env.WHATSAPP_TO || env.MERCHANT_WHATSAPP || env.MY_PHONE_NUMBER)) || '', 20
  );
  if (!raw) return DEFAULT_MERCHANT_WA;

  /* Run it through the same normaliser the checkout form uses. A number
     stored as 01105006854 or +20 110 500 6854 is what a person naturally
     types, and every one of those is rejected by Meta, which wants bare
     international digits — 201105006854. Stripping non-digits alone is not
     enough: it would happily hand Meta a leading 0 and the send would fail
     with an unhelpful "invalid recipient". */
  try {
    return normPhoneEg(raw, 'whatsapp_to', false);
  } catch (e) {
    /* Not an Egyptian mobile — could legitimately be a foreign number. Fall
       back to digits-only rather than refusing to notify at all. */
    const digits = raw.replace(/\D/g, '');
    return digits || DEFAULT_MERCHANT_WA;
  }
}

/* -------------------------------------------------------------------------
   WHERE THE CUSTOMER IS SENT, which is a different question from where the
   shop's alerts go — and getting the two confused is how a customer ends up
   messaging somebody's private phone.

   merchantWa() above answers "who gets told about a new order". That is an
   INTERNAL destination: WHATSAPP_TO is routinely set to the owner's own
   number, or to whichever phone is on the desk this month, and it is nobody's
   published contact.

   This one answers "which number does the customer tap", and its default is
   the number printed in the strip, the menu, both footers and the assistant's
   answers. It deliberately does NOT fall back to WHATSAPP_TO: an alerts
   variable set for the back office must never silently redirect customers.
   Override it with PUBLIC_WHATSAPP only, and only to a number the shop is
   happy to publish.
   ------------------------------------------------------------------------- */
export function contactWa(env) {
  const raw = clean((env && (env.PUBLIC_WHATSAPP || env.CONTACT_WHATSAPP)) || '', 20);
  if (!raw) return PUBLIC_WA;
  try {
    return normPhoneEg(raw, 'public_whatsapp', false);
  } catch (e) {
    const digits = raw.replace(/\D/g, '');
    return digits || PUBLIC_WA;
  }
}

/* Unambiguous alphabet: no O/0, no I/1. These numbers get read aloud down a
   phone line. */
const ALPHABET = '23456789ACDEFGHJKLMNPQRSTUVWXYZ';

export function orderNumber(date) {
  const ymd = cairoDate(date).slice(2).replace(/-/g, '');   // 260731
  const rand = crypto.getRandomValues(new Uint8Array(4));
  let tail = '';
  for (let i = 0; i < 4; i++) tail += ALPHABET[rand[i] % ALPHABET.length];
  return `VG-${ymd}-${tail}`;
}

/* -------------------------------------------------------------------------
   Pricing
   ------------------------------------------------------------------------- */
/* The resolver is how a price gets into this function, and the only how.
   It is passed in rather than imported so the SOURCE of prices can change
   — static file, database — without this file, which is the thing that
   actually enforces pricing, having to care. It defaults to the static
   catalogue so any caller not yet updated still prices correctly rather
   than silently pricing everything at zero. */
export function priceCart(cart, resolve) {
  const lookup = typeof resolve === "function" ? resolve : findProduct;
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new ApiError(400, 'empty_cart', 'Your cart is empty.');
  }
  if (cart.length > MAX_LINES) {
    throw new ApiError(400, 'too_many_lines', `An order can hold at most ${MAX_LINES} different products.`);
  }

  /* Each entry carries the product that was resolved for it, not just the
     quantity. The price is therefore read from ONE lookup per id: `resolve`
     is a closure over whatever the caller chose as the source — a D1 result
     set today — and looking the same id up twice is how two reads of that
     source could disagree about what a line costs. */
  const merged = new Map();
  for (const raw of cart) {
    if (!raw || typeof raw !== 'object') continue;
    const id = clean(raw.id, 64);
    const product = lookup(id);
    if (!product) {
      throw new ApiError(400, 'unknown_product', 'One of the products is no longer available.', { id });
    }
    const qty = Math.floor(Number(raw.qty));
    if (!Number.isFinite(qty) || qty < 1) {
      throw new ApiError(400, 'bad_qty', 'Quantity must be a whole number of at least 1.', { id });
    }
    if (qty > MAX_QTY) {
      throw new ApiError(400, 'bad_qty', `Maximum ${MAX_QTY} per product. For more, message us on WhatsApp.`, { id });
    }
    const seen = merged.get(id);
    if (seen) seen.qty += qty;
    else merged.set(id, { product, qty });
  }

  if (merged.size === 0) throw new ApiError(400, 'empty_cart', 'Your cart is empty.');

  const items = [];
  let subtotal = 0;
  for (const { product: p, qty: qtyRaw } of merged.values()) {
    const qty = Math.min(qtyRaw, MAX_QTY);
    const line = p.price * qty;
    subtotal += line;
    items.push({
      id: p.id,
      name: p.name,
      cat: p.cat,
      specAr: p.ar,
      specEn: p.en,
      qty,
      unit: p.price,
      line
    });
  }
  return { items, subtotal };
}

/* Shipping is quoted per governorate at confirmation rather than guessed
   here — the store publishes no shipping table, and inventing one would put
   a wrong number in front of a customer. Set SHIPPING_FLAT to a whole number
   of pounds if you want a fixed fee applied instead. */
export function shippingFor(env) {
  const n = parseInt((env && env.SHIPPING_FLAT) || '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : 0;
}

export function isGovernorate(value) {
  const v = clean(value, 60);
  return GOVERNORATES.some((g) => g.ar === v || g.en === v) ? v : '';
}

/* -------------------------------------------------------------------------
   HOW AN ORDER IS PAID

   TRANSFER, and nothing else — InstaPay or an e-wallet. Cash on delivery is
   withdrawn, so the two-way choice this list used to hold is now a one-way
   fact: the order is placed UNPAID, the customer is taken to the shop's own
   WhatsApp, the transfer details are sent there, and the purchase is
   complete when the money arrives.

   `cod` stays in the label table below and NOT in this list. The distinction
   is the whole point: the list is what a NEW order may be written with, the
   table is what ANY order is displayed as — including the hundreds already in
   D1 from when the shop still took cash. Dropping its label would leave the
   back office showing a blank payment method on every historical row.

   No third code was invented for "pays on WhatsApp". WhatsApp is where the
   conversation happens, not a way of paying; the money still moves by
   transfer, and naming the channel instead of the instrument would make the
   payment column answer a question nobody asks of it.
   ------------------------------------------------------------------------- */
export const PAYMENTS = ['transfer'];
export const DEFAULT_PAYMENT = 'transfer';

const PAYMENT_LABEL = {
  transfer: { ar: 'تحويل إنستاباي أو محفظة إلكترونية', en: 'InstaPay or e-wallet transfer' },
  /* Historical only — see above. */
  cod:      { ar: 'الدفع عند الاستلام (طلب قديم)', en: 'Cash on delivery (legacy)' }
};

export function paymentLabel(code, lang) {
  const l = PAYMENT_LABEL[code] || PAYMENT_LABEL[DEFAULT_PAYMENT];
  return lang === 'en' ? l.en : l.ar;
}

export function isPayment(value) {
  return PAYMENTS.includes(value) ? value : DEFAULT_PAYMENT;
}

/* -------------------------------------------------------------------------
   WHERE THE MONEY IS

   A SECOND axis, deliberately not folded into `status`. `status` answers
   "where is the parcel" — new, confirmed, shipped, done, cancelled — and the
   money now moves before any of that rather than with the courier at the end
   of it. One column cannot hold both without inventing statuses like
   "confirmed but unpaid" and "shipped and paid", which is every combination
   of two things written out by hand and gets forgotten the first time a
   third value is added to either side.

   So: three values, one question each.
     pending — placed, not paid for yet. Every order starts here.
     paid    — the money arrived. Set by a person who checked, never by the
               site: nothing here talks to a bank.
     failed  — the transfer was attempted and did not land, or the customer
               went quiet. Distinct from `pending` because it is a thing that
               HAPPENED and somebody has to ring them about it, where pending
               is merely waiting.
   ------------------------------------------------------------------------- */
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed'];
export const DEFAULT_PAYMENT_STATUS = 'pending';

export const isPaymentStatus = (v) => PAYMENT_STATUSES.includes(v);

const PAYMENT_STATUS_LABEL = {
  pending: { ar: 'لسه ما اتدفعش', en: 'Awaiting payment' },
  paid:    { ar: 'اتدفع', en: 'Paid' },
  failed:  { ar: 'الدفع فشل', en: 'Payment failed' }
};

export function paymentStatusLabel(code, lang) {
  const l = PAYMENT_STATUS_LABEL[code] || PAYMENT_STATUS_LABEL[DEFAULT_PAYMENT_STATUS];
  return lang === 'en' ? l.en : l.ar;
}

/* An order that still owes money is one somebody should be able to pay for
   with one tap, however long ago they placed it. `failed` counts: a transfer
   that did not land is a reason to try again, not a closed door. */
export const awaitingPayment = (status) => status !== 'paid';

/* -------------------------------------------------------------------------
   The WhatsApp body

   Plain text, Arabic-first, ordered so the first two lines are what you need
   at a glance on a phone lock screen: what it is, and its number.
   ------------------------------------------------------------------------- */
export function orderMessage(order, env) {
  const money = (n) => `${Number(n).toLocaleString('en-US')} ج.م`;
  const lines = [];

  lines.push('🔔 طلب جديد من الموقع — Vision Guard');
  lines.push(`رقم الطلب: ${order.id}`);
  lines.push(`الوقت: ${cairoStamp(new Date(order.created_at))}`);
  lines.push('');
  lines.push(`الاسم: ${order.name}`);
  lines.push(`الموبايل: ${displayPhoneEg(order.phone)}`);
  if (order.phone_alt) lines.push(`موبايل بديل: ${displayPhoneEg(order.phone_alt)}`);
  if (order.email) lines.push(`الإيميل: ${order.email}`);
  lines.push(`المحافظة: ${order.governorate}`);
  lines.push(`العنوان: ${order.address}`);
  lines.push(`طريقة الدفع: ${paymentLabel(order.payment, 'ar')}`);
  /* The line that changed the job. Under cash on delivery every order was
     paid for by definition and there was nothing to say; now the first
     question about a new order is whether the money arrived, so it is
     answered on the alert rather than a login away. */
  lines.push(`حالة الدفع: ${paymentStatusLabel(order.payment_status || order.paymentStatus, 'ar')}`);
  lines.push('');
  lines.push('المنتجات:');
  for (const it of order.items) {
    lines.push(`• ${it.name} × ${it.qty} — ${money(it.line)}`);
  }
  lines.push('');
  lines.push(`الإجمالي: ${money(order.subtotal)}`);
  /* Whoever rings this customer has to know why the total is less than the
     items add up to, or the first thing they do is query it. */
  const discount = Number(order.discount) || 0;
  if (discount > 0) {
    lines.push(`خصم أول طلب (${order.discount_code || order.discountCode || ''}): −${money(discount)}`);
  }
  lines.push(
    order.shipping > 0
      ? `الشحن: ${money(order.shipping)}`
      : 'الشحن: يتحدد حسب المحافظة ويتأكد مع العميل'
  );
  if (order.shipping > 0 || discount > 0) lines.push(`المطلوب دفعه: ${money(order.total)}`);
  if (order.notes) {
    lines.push('');
    lines.push(`ملاحظات العميل: ${order.notes}`);
  }
  lines.push('');
  lines.push(`رد على العميل: https://wa.me/${order.phone}`);

  return lines.join('\n');
}

/* Back-office only: a one-tap link that opens the order summary in the shop's
   own WhatsApp. It is NOT returned to the customer — the message body carries
   their full details and the internal summary. Kept for an admin view or a
   manual re-send. */
export function orderWaLink(order, env) {
  return `https://wa.me/${merchantWa(env)}?text=${encodeURIComponent(orderMessage(order, env))}`;
}

/* -------------------------------------------------------------------------
   THE CUSTOMER'S MESSAGE

   A different body from orderMessage() above, and that is the point rather
   than duplication: this one is opened in the CUSTOMER's WhatsApp and is
   therefore theirs to read, edit and send. It carries the order number and
   what is owed, and nothing else — no address, no second phone number, no
   internal summary. Somebody standing behind them in a queue can see this
   screen.

   Deliberately written as the customer speaking, not as the shop: it is
   about to be sent BY them, so a message that reads like a receipt from the
   shop would be strange in their own outbox. Short enough to survive being
   quoted back in a reply, which is how these threads actually read.
   ------------------------------------------------------------------------- */
export function paymentMessage(order, lang) {
  const total = Number(order.total).toLocaleString('en-US');
  if (lang === 'en') {
    return [
      `Hello Vision Guard — I have just placed order ${order.id}.`,
      `Total: ${total} EGP${Number(order.shipping) > 0 ? '' : ' (before shipping)'}.`,
      'Please send me the InstaPay or wallet details so I can complete the transfer.'
    ].join('\n');
  }
  return [
    `أهلاً Vision Guard — لسه عامل طلب رقم ${order.id}.`,
    `الإجمالي: ${total} ج.م${Number(order.shipping) > 0 ? '' : ' (قبل الشحن)'}.`,
    'ابعتوا لي بيانات الإنستاباي أو المحفظة عشان أعمل التحويل.'
  ].join('\n');
}

/* The link on the pending-order screen and in the customer's order list.

   contactWa(), NOT merchantWa(): this is the number the customer taps, and it
   has to be the one published on every page of the site. See the note above
   contactWa for why the alerts destination is deliberately not consulted. */
export function paymentWaLink(order, env, lang) {
  const text = paymentMessage(order, lang || order.lang);
  return `https://wa.me/${contactWa(env)}?text=${encodeURIComponent(text)}`;
}

/* `env` is optional and is what turns on `payUrl`: a caller that has one is
   able to name the shop's WhatsApp number, and one that does not simply
   omits the field rather than guessing at it. `payUrl` is present only while
   the order still owes money — a paid order does not need a pay button, and
   showing one is how somebody pays twice. */
export function publicOrder(order, env) {
  const paymentStatus = order.payment_status || order.paymentStatus || DEFAULT_PAYMENT_STATUS;
  const out = {
    id: order.id,
    items: order.items,
    subtotal: order.subtotal,
    /* Whole EGP, already subtracted from `total`. Published so the
       confirmation screen can show WHAT the customer saved rather than a
       total that mysteriously fails to match the subtotal. */
    discount: Number(order.discount) || 0,
    discountCode: order.discount_code || order.discountCode || '',
    shipping: order.shipping,
    total: order.total,
    currency: order.currency || 'EGP',
    payment: order.payment,
    paymentStatus,
    status: order.status || 'new',
    governorate: order.governorate,
    createdAt: order.created_at
  };
  if (env && awaitingPayment(paymentStatus)) out.payUrl = paymentWaLink(order, env);
  return out;
}

export const CATALOG_SIZE = PRODUCTS.length;
