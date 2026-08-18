/* GET /api/marketing?days=30

   What the marketing actually did — the organic half for every employee, the
   money half for administrators only.

   WHY THIS IS NOT PART OF /api/admin/stats
   ----------------------------------------
   That endpoint reads D1 and nothing else, which is why it always works and
   is fast. This one reaches out to Meta over the network, three times, to a
   rate-limited API that can be slow, misconfigured or missing scopes. Folding
   it into the admin dashboard would make the shop's own numbers depend on
   Facebook being up, and would put ad spend behind the admin check while
   employees have no way to see the organic reach they are judged on.

   THE PERMISSION SPLIT
   --------------------
     staff  — Page and Instagram: reach, impressions, followers, profile
              views. Organic effort, which is what an employee affects.
     admin  — all of the above, plus ad spend, plus the one number neither
              Meta nor the existing dashboard can produce alone.

   THAT ONE NUMBER. Meta reports pixel-attributed revenue, which under-reports
   — ad blockers and iOS strip a real share of Purchase events, and lib/meta.js
   exists precisely because of it. D1 holds every order that actually
   completed, attributed to nobody. Putting Meta's SPEND next to D1's REVENUE
   over the same window gives return on ad spend computed from money that
   really arrived, rather than from Meta's estimate of it. Both are reported,
   labelled as what they are, because they disagree by design and a dashboard
   that shows one unlabelled number is choosing which lie to tell.

   IT IS ALWAYS SAFE TO OPEN. Nothing here throws on missing configuration:
   an unconfigured deployment answers with `configured: false` and the reason,
   the same way the assistant answers when its binding is absent. The tab
   ships inert and lights up once the ids and the token are set.

   SETTING THEM IS NOT ENOUGH ON ITS OWN — REDEPLOY AFTERWARDS. Pages binds
   variables to a deployment, not to the project, so a secret added today is
   invisible to a deployment made yesterday: `npx wrangler pages deploy
   --branch=main`. Cloudflare's own words are that secrets must be set
   "before a deployment that uses those secrets". Without that step this
   endpoint keeps answering `configured: false` about a variable the
   dashboard clearly shows, which is a confusing half-hour.
*/
import { json, handle } from '../../lib/util.js';
import { db } from '../../lib/db.js';
import { requireStaff, isAdminUser } from '../../lib/auth.js';
import {
  insightsStatus,
  fetchPageInsights,
  fetchIgInsights,
  fetchAdInsights,
  fetchCampaignInsights
} from '../../lib/insights.js';
import { fetchConnection } from '../../lib/metaconnection.js';

const sinceIso = (days) => new Date(Date.now() - days * 86400000).toISOString();

export const onRequestGet = handle(async (context) => {
  const { request, env } = context;
  const d1 = await db(env);

  /* Staff, not admin. The ads half is gated separately below — see `admin`.
     requireStaff already requires a signed-in company address, so a customer
     never reaches any of this. */
  const user = await requireStaff(context, d1);
  const admin = isAdminUser(env, user);

  const url = new URL(request.url);
  const requested = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 365) : 30;

  /* WHY THESE GO OUT TOGETHER
     Three independent HTTP calls to Meta, each of which can take a second.
     Awaited in sequence the tab would take three; issued together it takes
     the slowest one. None of them reads another's result.

     Promise.all and not allSettled, deliberately: every one of these
     functions already absorbs its own failure and resolves to a shaped
     `{ ok: false, error }`. If one ever throws instead, that is a bug in
     lib/insights.js and it should be loud rather than quietly missing. */
  const wantAds = admin;
  const [page, instagram, ads, campaigns, connection] = await Promise.all([
    fetchPageInsights(env, days),
    fetchIgInsights(env, days),
    wantAds ? fetchAdInsights(env, days) : Promise.resolve({ ok: false, configured: false, hidden: true }),
    wantAds ? fetchCampaignInsights(env, days, 10) : Promise.resolve({ ok: false, configured: false, hidden: true }),
    /* WHAT ARE WE CONNECTED TO, AND IS IT FIRING.

       Deliberately NOT gated on `admin`, unlike spend. Every value it returns
       is an identifier or a timestamp — a Page id is in the URL of every post
       that Page has made, and a pixel id ships in the markup of every page on
       this site. Nothing here is a credential, and the panel is most useful to
       whoever notices the numbers look wrong first, which is not always the
       administrator. The ad account id is the one exception and is passed
       through the same admin flag as the spend above. */
    fetchConnection(env, { admin })
  ]);

  /* The shop's own revenue over the same window, for the ROAS above. Admin
     only — an employee has no business seeing turnover, and computing it for
     them would put it in a response they can read. */
  let shop = null;
  if (admin) {
    const row = await d1.prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
         FROM orders
        WHERE created_at >= ?1 AND status != 'cancelled'`
    ).bind(sinceIso(days)).first();
    shop = {
      orders: Number(row && row.orders) || 0,
      revenue: Number(row && row.revenue) || 0
    };
  }

  /* Return on ad spend, from money that actually arrived.

     null rather than 0 when there is no spend: dividing revenue by zero spend
     is not "infinite return", it is a question that was not asked. The tab
     shows a dash. */
  let roas = null;
  if (admin && ads.ok && shop && ads.spend > 0) {
    roas = {
      real: Number((shop.revenue / ads.spend).toFixed(2)),
      /* Meta's own, for comparison. The gap between the two is the share of
         conversions the pixel never saw — worth looking at on its own. */
      meta: ads.metaRevenue > 0 ? Number((ads.metaRevenue / ads.spend).toFixed(2)) : null,
      spend: ads.spend,
      realRevenue: shop.revenue,
      metaRevenue: ads.metaRevenue
    };
  }

  return json({
    ok: true,
    range: { days, from: sinceIso(days), to: new Date().toISOString() },
    admin,
    /* Which pieces are switched on, so the tab can say what is missing by
       name instead of showing an empty panel and leaving the administrator
       to guess. */
    setup: insightsStatus(env),
    /* The App, Page, pixel and catalogue this deployment actually talks to,
       plus whether the pixel has fired recently from the browser and from the
       server. Ids and timestamps only — never a token. */
    connection,
    page,
    instagram,
    /* Present but flagged `hidden` for a non-admin, rather than absent: the
       client renders on shape, and a missing key there is the failure mode
       that took the performance panel down before (see perfShape). */
    ads,
    campaigns,
    shop,
    roas
  });
});
