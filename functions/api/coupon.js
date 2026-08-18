/* GET /api/coupon?code=WELCOME5&subtotal=1234

   "May I show this discount, and how much is it?"

   ADVISORY ONLY. Nothing here charges anybody. The cart calls it so the
   checkout summary can show a line before the order is placed, and
   functions/api/orders.js recomputes the whole decision from scratch when
   the order actually arrives — same function, same table, its own copy of
   the subtotal built from the server's catalogue. A browser that lies to
   this endpoint, or replays a stale answer, changes nothing about what it
   is charged.

   `subtotal` is taken from the query only to render a number. The one that
   is charged comes from priceCart().
*/
import { json, handle, clean, ApiError } from '../../lib/util.js';
import { db } from '../../lib/db.js';
import { currentUser } from '../../lib/auth.js';
import { normPhoneEg } from '../../lib/util.js';
import {
  welcomeTerms, WELCOME_CODE, WELCOME_PERCENT, WELCOME_DAYS, INELIGIBLE
} from '../../lib/coupon.js';
import { resolveDiscount } from '../../lib/promos.js';

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);
  const user = await currentUser(context, d1);

  const url = new URL(request.url);
  const code = clean(url.searchParams.get('code'), 40);
  const subtotal = Math.max(0, parseInt(url.searchParams.get('subtotal') || '0', 10) || 0);

  /* The phone typed into the checkout form, if there is one yet. It is the
     identity that actually matters for a cash-on-delivery shop, so an
     answer that ignores it would promise a discount the checkout then
     refuses — which is worse than not offering it. Invalid or absent is
     fine; the account and email still decide. */
  let phone = '';
  try {
    phone = normPhoneEg(url.searchParams.get('phone') || '', 'phone', true);
  } catch (e) { /* not a usable number yet — keep going */ }

  /* One resolver for both kinds of code — the welcome offer and anything an
     administrator issued — so the cart cannot show a line the order refuses.
     An empty `code` means "whatever this person is entitled to". */
  const result = await resolveDiscount(d1, {
    code,
    user,
    phone,
    email: user ? user.email : clean(url.searchParams.get('email'), 254),
    subtotal
  });

  /* The offer as it stands for THIS account, whatever the answer was: the
     percentage today, what it drops to tomorrow, and when it ends. The
     signup popup is drawn from this, and so is the checkout's countdown. */
  const terms = welcomeTerms(user && user.created_at, undefined);

  if (result.ok) {
    return json({
      ok: true, eligible: true,
      kind: result.kind,
      code: result.code, percent: result.percent, discount: result.discount,
      /* A flat-amount code has no percentage to show; the cart prints the
         pounds instead. */
      amount: result.amount || 0,
      /* How long is left on it. The cart shows this rather than counting for
         itself, so the screen and the decision come from one clock. */
      days: WELCOME_DAYS,
      daysLeft: result.daysLeft || terms.daysLeft,
      expiresAt: result.expiresAt || result.endsAt || '',
      /* When today's ten per cent becomes five. Empty on an issued code,
         which has one rate for its whole life. */
      tierEndsAt: result.tierEndsAt || '',
      nextPercent: result.kind === 'welcome' ? terms.nextPercent : 0
    });
  }

  /* 200 with eligible:false, not an error. "You have ordered with us
     before" is a perfectly normal answer to a perfectly normal question,
     and making the cart handle it through a catch block is how a checkout
     ends up showing a red box to a returning customer for no reason. */
  return json({
    ok: true, eligible: false,
    kind: result.kind,
    reason: result.reason,
    /* What was ASKED FOR stays on the answer when it was an issued code, so
       the checkout can say "PARTY20 is not valid" rather than talking about
       the welcome offer the customer never mentioned. */
    code: result.kind === 'promo' ? result.code : WELCOME_CODE,
    percent: result.kind === 'promo' ? 0 : (terms.percent || WELCOME_PERCENT),
    days: WELCOME_DAYS,
    discount: 0,
    minSubtotal: result.minSubtotal || 0,
    /* Whether it is worth offering at all. A signed-out visitor CAN have it
       — they just have to sign in first — while somebody who has already
       ordered never can, and telling them to sign in would be a lie.

       An EXPIRED offer is the same kind of lie in the other direction: the
       account exists and has never ordered, so every other check passes and
       an older cart would happily show "sign in and save 5%" to somebody
       whose five days ran out last week. */
    canSignInFor: result.reason === INELIGIBLE.NOT_SIGNED_IN,
    expired: result.reason === INELIGIBLE.EXPIRED,
    expiresAt: result.expiresAt || ''
  });
});
