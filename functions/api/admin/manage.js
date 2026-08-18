/* POST /api/admin/manage   { entity, action, ... }

   The administrator's write operations. Everything that changes an order or
   an account goes through here, admin-only, so there is one file to read when
   asking "what can an admin actually do".

   entity: 'order'  action: 'status'    { id, status }
                    action: 'payment'   { id, paymentStatus }
                    action: 'cancel'    { id }                 reversible
                    action: 'delete'    { id, confirm: true }  permanent

   entity: 'user'   action: 'create'    { email, name, phone? }
                    action: 'reset'     { email }
                    action: 'terminate' { id, confirm: true }

   ---------------------------------------------------------------------------
   Three rules that are not negotiable, and why
   ---------------------------------------------------------------------------
   1. ORDERS ARE NOT CASUALLY DELETABLE. public/privacy.html tells customers
      their orders are "kept as long as the law requires for commercial and
      tax records". A delete button that quietly contradicts that is both a
      broken promise and a hole in the accounts. So `cancel` is the ordinary
      action and is reversible; `delete` is separate, needs confirm:true, and
      is meant for test rows and mistakes.

   2. TERMINATING A PERSON DOES NOT DESTROY THEIR ORDERS. The account row goes
      and the personal details ON the orders are overwritten, so the record of
      the transaction survives for the books without the customer's name,
      address, phone and email surviving with it. Deleting the orders instead
      would mean the shop could not account for money it took.

   3. AN ADMIN CANNOT REMOVE AN ADMIN, INCLUDING THEMSELVES. One mis-click
      otherwise leaves nobody able to reach the timesheets, and there is no
      route back through the UI.
*/
import {
  json, handle, readJson, requireSameOrigin, ApiError,
  clean, required, normEmail, normPhoneEg
} from '../../../lib/util.js';
import { db, enforceRate } from '../../../lib/db.js';
import {
  requireAdmin, isAdminUser, isStaffEmail, adminEmails,
  randomId, GOOGLE_ONLY_PW, STAFF_DOMAIN, hashPassword, checkPasswordStrength
} from '../../../lib/auth.js';
import { PAYMENT_STATUSES, isPaymentStatus } from '../../../lib/orders.js';

const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'done', 'cancelled'];

/* Firebase holds the passwords, so a reset is Firebase's to send. This is the
   same public Web API key that ships in public/firebase-auth.js — it
   identifies the project and authorises nothing on its own. Using the REST
   endpoint means no service-account key has to exist anywhere. */
const FIREBASE_API_KEY = 'AIzaSyAhtUvqMWOeeL6zh-Dn4-NhIux3vFFKnZQ';

async function sendPasswordReset(email) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email })
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = (body.error && body.error.message) || 'unknown';
    /* EMAIL_NOT_FOUND means the address has no Firebase account — which for
       a staff member usually means they have not registered yet, not that
       anything is broken. Say so rather than reporting a failure. */
    if (reason === 'EMAIL_NOT_FOUND') return { ok: false, code: 'not_registered' };
    return { ok: false, code: reason };
  }
  return { ok: true };
}

/* GET /api/admin/manage?entity=orders|users&q=&limit=

   The lists the dashboard acts on. Same file as the writes on purpose: what
   an admin can see and what an admin can change belong in one place, so
   neither drifts from the other.

   Bounded by LIMIT and searchable, because "show me every order" stops being
   a sensible request the moment the shop is busy. */
export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  await requireAdmin(context, d1);

  const url = new URL(request.url);
  const entity = clean(url.searchParams.get('entity'), 20) || 'orders';
  const q = clean(url.searchParams.get('q'), 60);
  const asked = parseInt(url.searchParams.get('limit') || '50', 10);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 200) : 50;
  const like = `%${q.toLowerCase()}%`;

  if (entity === 'orders') {
    const { results } = q
      ? await d1.prepare(
          `SELECT id, created_at, name, phone, governorate, total, status, payment,
                  payment_status, notified
             FROM orders
            WHERE lower(id) LIKE ?1 OR lower(name) LIKE ?1 OR phone LIKE ?1
            ORDER BY created_at DESC LIMIT ?2`
        ).bind(like, limit).all()
      : await d1.prepare(
          `SELECT id, created_at, name, phone, governorate, total, status, payment,
                  payment_status, notified
             FROM orders ORDER BY created_at DESC LIMIT ?1`
        ).bind(limit).all();
    /* The payment vocabulary travels with the list so the table's dropdown
       is built from what this endpoint accepts rather than from a copy of it
       kept in the browser. */
    return json({ ok: true, entity, limit, orders: results || [], paymentStatuses: PAYMENT_STATUSES });
  }

  if (entity === 'users') {
    const { results } = q
      ? await d1.prepare(
          `SELECT id, email, name, phone, role, created_at, last_login_at
             FROM users WHERE lower(email) LIKE ?1 OR lower(name) LIKE ?1
            ORDER BY created_at DESC LIMIT ?2`
        ).bind(like, limit).all()
      : await d1.prepare(
          `SELECT id, email, name, phone, role, created_at, last_login_at
             FROM users ORDER BY created_at DESC LIMIT ?1`
        ).bind(limit).all();
    /* The admin flag is computed, not stored — ADMIN_EMAILS can confer it
       without the role column saying so, and the UI must grey out the
       terminate button for exactly the accounts the API will refuse. */
    return json({
      ok: true, entity, limit,
      users: (results || []).map((u) => Object.assign({}, u, { admin: isAdminUser(env, u) }))
    });
  }

  throw new ApiError(400, 'bad_entity', 'entity must be orders or users.', { field: 'entity' });
});

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;
  requireSameOrigin(request);

  const d1 = await db(env);
  const admin = await requireAdmin(context, d1);
  await enforceRate(d1, `admin:${admin.id}`, 200, 3600);

  const body = await readJson(request);
  const entity = clean(body.entity, 20);
  const action = clean(body.action, 20);

  /* ---------------------------------------------------------------- orders */
  if (entity === 'order') {
    const id = required(body.id, 'id', 40);
    const row = await d1.prepare(
      'SELECT id, status, payment_status, user_id FROM orders WHERE id = ?1'
    ).bind(id).first();
    if (!row) throw new ApiError(404, 'no_such_order', 'No order with that number.', { field: 'id' });

    if (action === 'status' || action === 'cancel') {
      const status = action === 'cancel' ? 'cancelled' : clean(body.status, 20);
      if (!ORDER_STATUSES.includes(status)) {
        throw new ApiError(400, 'bad_status', `Status must be one of: ${ORDER_STATUSES.join(', ')}.`, { field: 'status' });
      }
      await d1.prepare('UPDATE orders SET status = ?1 WHERE id = ?2').bind(status, id).run();
      return json({ ok: true, order: { id, status, was: row.status } });
    }

    /* Where the money is. The same write an employee can make from the leads
       board — see /api/leads — and it is here as well because this table is
       where an administrator looks at the whole day at once, and having to
       open a lead to record a payment they can see on this screen is the
       kind of detour that gets skipped. */
    if (action === 'payment') {
      const paymentStatus = clean(body.paymentStatus, 20);
      if (!isPaymentStatus(paymentStatus)) {
        throw new ApiError(400, 'bad_payment_status',
          `Payment status must be one of: ${PAYMENT_STATUSES.join(', ')}.`,
          { field: 'paymentStatus', allowed: PAYMENT_STATUSES });
      }
      await d1.prepare('UPDATE orders SET payment_status = ?1 WHERE id = ?2').bind(paymentStatus, id).run();
      return json({ ok: true, order: { id, paymentStatus, was: row.payment_status } });
    }

    if (action === 'delete') {
      if (body.confirm !== true) {
        throw new ApiError(
          400, 'confirm_required',
          'Deleting an order is permanent and removes it from your commercial records. Cancel it instead, or send confirm: true.'
        );
      }
      await d1.prepare('DELETE FROM orders WHERE id = ?1').bind(id).run();
      return json({ ok: true, deleted: id });
    }

    throw new ApiError(400, 'bad_action', 'action must be status, payment, cancel or delete.', { field: 'action' });
  }

  /* ----------------------------------------------------------------- users */
  if (entity === 'user') {
    if (action === 'create') {
      const email = normEmail(body.email);
      /* Staff only. This endpoint exists to add colleagues, not to mint
         customer accounts — those come from Firebase sign-up. */
      if (!isStaffEmail(email)) {
        throw new ApiError(400, 'not_staff_email', `Staff addresses must end in @${STAFF_DOMAIN}.`, { field: 'email' });
      }
      /* Administrator addresses stay out of band — scripts/create-admin.mjs
         only, exactly as /api/auth/signup and /api/auth/firebase enforce. */
      if (adminEmails(env).includes(email)) {
        throw new ApiError(409, 'email_taken', 'An account already exists with that email.', { field: 'email' });
      }

      const name = required(body.name, 'name', 120);
      const phone = body.phone ? normPhoneEg(body.phone, 'phone', true) : '';
      const existing = await d1.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
      if (existing) throw new ApiError(409, 'email_taken', 'An account already exists with that email.', { field: 'email' });

      const id = randomId(16);
      const now = new Date().toISOString();
      /* GOOGLE_ONLY_PW: this row has no local password and never can be
         signed into with one. The employee sets their own password by
         registering the address in Firebase, and the verified-email rule in
         /api/auth/firebase attaches them to this row. */
      await d1.prepare(
        `INSERT INTO users (id, email, name, phone, pw_hash, role, marketing, newsletter, terms_at, lang, created_at)
         VALUES (?1,?2,?3,?4,?5,'staff',0,0,?6,'ar',?6)`
      ).bind(id, email, name, phone || null, GOOGLE_ONLY_PW, now).run();

      /* Best effort: if they already exist in Firebase this sends them a
         "set your password" email immediately. If they do not, they simply
         sign up themselves. Either way the D1 row is created. */
      const reset = await sendPasswordReset(email);

      return json({
        ok: true,
        created: true,
        user: { id, email, name, role: 'staff' },
        invite: reset.ok ? 'reset_email_sent' : reset.code
      }, 201);
    }

    if (action === 'reset') {
      const email = normEmail(body.email);
      const row = await d1.prepare('SELECT id, email FROM users WHERE email = ?1').bind(email).first();
      if (!row) throw new ApiError(404, 'no_such_user', 'No account with that email.', { field: 'email' });
      const reset = await sendPasswordReset(email);
      if (!reset.ok && reset.code === 'not_registered') {
        return json({
          ok: true, sent: false, code: 'not_registered',
          message: 'That address has no password yet — they need to create one from the sign-in page first.'
        });
      }
      if (!reset.ok) throw new ApiError(502, 'reset_failed', `Could not send the reset email (${reset.code}).`);
      return json({ ok: true, sent: true, email });
    }

    if (action === 'password') {
      const email = normEmail(body.email);
      const row = await d1.prepare('SELECT id, email FROM users WHERE email = ?1').bind(email).first();
      if (!row) throw new ApiError(404, 'no_such_user', 'No account with that email.', { field: 'email' });
      const password = required(body.password, 'password', 200);
      checkPasswordStrength(password);
      const pwHash = await hashPassword(env, password);
      await d1.prepare('UPDATE users SET pw_hash = ?1 WHERE email = ?2').bind(pwHash, email).run();
      return json({ ok: true, updated: true, email });
    }

    if (action === 'terminate') {
      const id = required(body.id, 'id', 64);
      const row = await d1.prepare('SELECT id, email, name, role FROM users WHERE id = ?1').bind(id).first();
      if (!row) throw new ApiError(404, 'no_such_user', 'No account with that id.', { field: 'id' });

      if (row.id === admin.id) {
        throw new ApiError(400, 'cannot_remove_self', 'You cannot terminate the account you are signed in with.');
      }
      if (isAdminUser(env, row)) {
        throw new ApiError(
          403, 'cannot_remove_admin',
          'Administrator accounts cannot be removed here — otherwise a mis-click can leave nobody able to reach the timesheets.'
        );
      }
      if (body.confirm !== true) {
        throw new ApiError(400, 'confirm_required', 'Send confirm: true to terminate this account.');
      }

      /* Orders are kept and anonymised — see rule 2 in the header. The
         transaction survives for the books; the person does not survive on
         it. */
      const now = new Date().toISOString();
      await d1.prepare(
        `UPDATE orders
            SET user_id = NULL, name = 'Removed account', phone = '', phone_alt = NULL,
                email = NULL, address = 'removed', notes = NULL
          WHERE user_id = ?1`
      ).bind(id).run();
      await d1.prepare('DELETE FROM attendance WHERE user_id = ?1').bind(id).run();
      if (row.email) {
        await d1.prepare('UPDATE newsletter SET unsub_at = ?1, marketing = 0 WHERE email = ?2')
          .bind(now, row.email).run();
      }
      await d1.prepare('DELETE FROM users WHERE id = ?1').bind(id).run();

      return json({
        ok: true,
        terminated: { id, email: row.email, name: row.name },
        note: 'Orders kept and anonymised for the commercial record. Firebase credentials, if any, must be removed in the Firebase console.'
      });
    }

    throw new ApiError(400, 'bad_action', 'action must be create, reset or terminate.', { field: 'action' });
  }

  throw new ApiError(400, 'bad_entity', 'entity must be order or user.', { field: 'entity' });
});
