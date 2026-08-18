/* =========================================================================
   /api/admin/promos — the owner's discount desk. ADMINISTRATORS ONLY.

   GET                          every code, newest first
   POST action: 'create'        issue one
   POST action: 'update'        change its window, its limit, or switch it off
   POST action: 'delete'        remove a code nobody has used
   POST action: 'discount-order' take money off ONE existing order

   TWO DIFFERENT JOBS, AND THEY ARE DELIBERATELY BOTH HERE.

   A code is for people you have not met: a campaign, a week, a hundred uses,
   handed out and typed at checkout. `discount-order` is for the customer on
   the phone right now — somebody the owner knows, an order already placed,
   and no code to invent, publish, remember to expire, or explain to the next
   person who finds it in a group chat. Issuing a code to give one person ten
   per cent is how a shop ends up with forty live codes and no idea which are
   safe to delete.

   WHY THIS IS ADMIN-ONLY when the leads board is open to every employee:
   everything an employee does there records what happened — a status, a
   note, a payment somebody watched arrive. This decides what a customer
   pays. It is the same line /api/admin/manage draws around cancelling and
   deleting an order, drawn in the same place and for the same reason.
   ========================================================================= */
import {
  json, handle, readJson, requireSameOrigin, ApiError, clean, required
} from '../../../lib/util.js';
import { db } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';
import { normaliseCode, isWelcomeCode } from '../../../lib/coupon.js';
import {
  MAX_PERCENT, MAX_CODE, MAX_NOTE, publicPromo, getPromo, discountOf
} from '../../../lib/promos.js';

/* Letters and digits only. A code travels by voice down a phone line and by
   thumb into a checkout box on a bus; a hyphen or an underscore is one more
   thing to get wrong, and a code with a space in it is two codes to
   whoever is typing it. */
const CODE_SHAPE = /^[A-Z0-9]{3,32}$/;

/* An ISO timestamp from the admin form's datetime-local input, or ''. The
   browser sends local time without a zone; the form converts to ISO before
   sending, so anything unparseable here is a bug or a hand-built request and
   is refused rather than quietly stored as "no bound". */
function whenOrNull(value, field) {
  const raw = clean(value, 40);
  if (!raw) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    throw new ApiError(400, 'bad_date', 'That date could not be read.', { field });
  }
  return new Date(at).toISOString();
}

const intIn = (value, min, max, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/* ------------------------------------------------------------------ read */
export const onRequestGet = handle(async (context) => {
  const d1 = await db(context.env);
  await requireAdmin(context, d1);

  const { results } = await d1.prepare(
    'SELECT * FROM promos ORDER BY created_at DESC LIMIT 200'
  ).all();

  return json({
    ok: true,
    promos: (results || []).map(publicPromo),
    maxPercent: MAX_PERCENT
  });
});

/* ----------------------------------------------------------------- write */
export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const admin = await requireAdmin(context, d1);
  const body = await readJson(request);
  const action = clean(body.action, 20) || 'create';

  /* ---- take money off one order that already exists ----

     No code, no row in promos, nothing to expire. The discount is written
     straight onto the order and the total is recomputed from the subtotal,
     so applying it twice REPLACES rather than stacks — an admin who types
     15 and means 20 can just type 20. */
  if (action === 'discount-order') {
    const orderId = required(body.orderId, 'orderId', 40);
    const order = await d1.prepare(
      'SELECT id, subtotal, shipping, discount, status FROM orders WHERE id = ?1'
    ).bind(orderId).first();
    if (!order) throw new ApiError(404, 'no_such_order', 'No order with that number.', { field: 'orderId' });

    const percent = intIn(body.percent, 0, MAX_PERCENT, 0);
    const amount = intIn(body.amount, 0, 10000000, 0);
    if (percent <= 0 && amount <= 0) {
      throw new ApiError(400, 'no_discount',
        `Give a percentage (1–${MAX_PERCENT}) or an amount in pounds.`, { field: 'percent' });
    }
    if (percent > 0 && amount > 0) {
      throw new ApiError(400, 'one_or_other',
        'A discount is either a percentage or an amount, not both.', { field: 'percent' });
    }

    const discount = discountOf(order.subtotal, { percent, amount });
    /* Recomputed from the subtotal every time, never from the current total,
       so a second edit cannot compound the first. */
    const total = Number(order.subtotal) - discount + Number(order.shipping || 0);

    /* The label the order carries afterwards. It says a person did this,
       because the alternative is a total that disagrees with the subtotal
       and nothing anywhere explaining why. */
    const label = clean(body.label, MAX_CODE).toUpperCase() || 'ADMIN';

    await d1.prepare(
      'UPDATE orders SET discount = ?1, discount_code = ?2, total = ?3 WHERE id = ?4'
    ).bind(discount, discount > 0 ? label : null, total, order.id).run();

    console.info(`order discount: ${order.id} -${discount} EGP by ${admin.email}`);
    return json({ ok: true, order: { id: order.id, discount, total, code: label } });
  }

  /* Everything below is about a code. */
  const code = normaliseCode(body.code);

  if (action === 'create') {
    if (!CODE_SHAPE.test(code)) {
      throw new ApiError(400, 'bad_code',
        'A code is 3 to 32 letters and digits — no spaces or punctuation.', { field: 'code' });
    }
    /* WELCOME10 and WELCOME5 are decided by lib/coupon.js from the age of
       the account, not from a row. A stored code by the same name would be
       shadowed by that rule and would silently never apply, which is worse
       than refusing it here. */
    if (isWelcomeCode(code)) {
      throw new ApiError(409, 'reserved_code',
        'That name belongs to the automatic welcome offer. Pick another.', { field: 'code' });
    }
    const existing = await getPromo(d1, code);
    if (existing) {
      throw new ApiError(409, 'code_exists', 'That code already exists.', { field: 'code' });
    }

    const percent = intIn(body.percent, 0, MAX_PERCENT, 0);
    const amount = intIn(body.amount, 0, 10000000, 0);
    if (percent <= 0 && amount <= 0) {
      throw new ApiError(400, 'no_discount',
        `Give a percentage (1–${MAX_PERCENT}) or an amount in pounds.`, { field: 'percent' });
    }
    if (percent > 0 && amount > 0) {
      throw new ApiError(400, 'one_or_other',
        'A code is either a percentage or an amount, not both.', { field: 'percent' });
    }

    const startsAt = whenOrNull(body.startsAt, 'startsAt');
    const endsAt = whenOrNull(body.endsAt, 'endsAt');
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new ApiError(400, 'bad_window', 'The end has to come after the start.', { field: 'endsAt' });
    }

    await d1.prepare(
      `INSERT INTO promos
         (code, percent, amount, starts_at, ends_at, new_only, min_subtotal,
          max_uses, uses, active, note, created_by, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,1,?9,?10,?11)`
    ).bind(
      code, percent, amount, startsAt, endsAt,
      body.newOnly === false ? 0 : 1,
      intIn(body.minSubtotal, 0, 10000000, 0),
      intIn(body.maxUses, 0, 1000000, 0),
      clean(body.note, MAX_NOTE) || null,
      admin.id,
      new Date().toISOString()
    ).run();

    return json({ ok: true, code }, 201);
  }

  const row = await getPromo(d1, code);
  if (!row) throw new ApiError(404, 'no_such_code', 'No code by that name.', { field: 'code' });

  /* ---- switch it off, move its window, change its limit ----
     Deliberately not "edit everything": the percentage a code was issued at
     stays what it was issued at, because orders already carry it. To change
     the rate, stop this one and issue another. */
  if (action === 'update') {
    const startsAt = body.startsAt === undefined ? row.starts_at : whenOrNull(body.startsAt, 'startsAt');
    const endsAt = body.endsAt === undefined ? row.ends_at : whenOrNull(body.endsAt, 'endsAt');
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new ApiError(400, 'bad_window', 'The end has to come after the start.', { field: 'endsAt' });
    }

    await d1.prepare(
      `UPDATE promos
          SET starts_at = ?1, ends_at = ?2, active = ?3, max_uses = ?4,
              min_subtotal = ?5, new_only = ?6, note = ?7
        WHERE code = ?8`
    ).bind(
      startsAt, endsAt,
      body.active === undefined ? row.active : (body.active ? 1 : 0),
      body.maxUses === undefined ? row.max_uses : intIn(body.maxUses, 0, 1000000, 0),
      body.minSubtotal === undefined ? row.min_subtotal : intIn(body.minSubtotal, 0, 10000000, 0),
      body.newOnly === undefined ? row.new_only : (body.newOnly ? 1 : 0),
      body.note === undefined ? row.note : (clean(body.note, MAX_NOTE) || null),
      code
    ).run();

    return json({ ok: true, code });
  }

  /* ---- delete ----
     Only one nobody has used. A code with redemptions behind it is the
     explanation for discounts on real orders, and deleting it turns those
     into totals that disagree with their subtotals for no visible reason.
     Switching it off does everything deleting would, and keeps the record. */
  if (action === 'delete') {
    if ((Number(row.uses) || 0) > 0) {
      throw new ApiError(409, 'code_used',
        'That code has been used on real orders. Switch it off instead — deleting it would leave those orders unexplained.',
        { uses: Number(row.uses) || 0 });
    }
    await d1.prepare('DELETE FROM promos WHERE code = ?1').bind(code).run();
    return json({ ok: true, deleted: code });
  }

  throw new ApiError(400, 'bad_action',
    'action must be create, update, delete or discount-order.', { field: 'action' });
});
